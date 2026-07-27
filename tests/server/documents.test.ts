import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentListResponseSchema,
  errorResponseSchema,
  savedDocumentSchema,
} from '@internship-agent/shared';
import {
  PDF_BASE64,
  authHeaders,
  createTestServer,
  documentUploadBody,
  type TestServer,
} from './helpers.js';
import {
  documentFileName,
  resolveInsideRoot,
  sanitizeFileName,
  PathOutsideRootError,
} from '../../agent-server/src/security/paths.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function post(body: Record<string, unknown>) {
  return server!.app.inject({
    method: 'POST',
    url: '/documents',
    headers: authHeaders,
    payload: body,
  });
}

function list() {
  return server!.app.inject({ method: 'GET', url: '/documents', headers: authHeaders });
}

async function listDocuments() {
  return documentListResponseSchema.parse((await list()).json<{ data: unknown }>().data);
}

describe('document registration', () => {
  it('stores the file and returns validated metadata', async () => {
    server = await createTestServer();
    const response = await post(documentUploadBody());

    expect(response.statusCode).toBe(201);
    const document = savedDocumentSchema.parse(response.json<{ data: unknown }>().data);

    expect(document.name).toBe('Computer Engineering Resume');
    expect(document.type).toBe('resume');
    expect(document.mimeType).toBe('application/pdf');
    expect(document.sizeBytes).toBeGreaterThan(0);
    expect(document.tags).toEqual(['ce']);
    expect(document.targetRoles).toEqual(['Embedded Software Intern']);

    // The file genuinely exists where the record says it does.
    expect(existsSync(document.filePath)).toBe(true);
    expect(document.filePath.startsWith(server.documentsDir)).toBe(true);
    expect(readdirSync(server.documentsDir)).toContain(document.fileName);
  });

  it('requires a token', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/documents',
      payload: documentUploadBody(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a mime type outside the allowlist', async () => {
    server = await createTestServer();
    const response = await post(
      documentUploadBody({ mimeType: 'application/x-msdownload', fileName: 'setup.exe' }),
    );
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects content whose bytes contradict the declared type', async () => {
    server = await createTestServer();
    const response = await post(
      documentUploadBody({
        contentBase64: Buffer.from('MZ this is really an executable').toString('base64'),
      }),
    );

    expect(response.statusCode).toBe(422);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.message).toContain('do not look like application/pdf');
    // Nothing may be left behind on disk after a rejected upload.
    expect(readdirSync(server.documentsDir)).toHaveLength(0);
  });

  it('rejects an extension that disagrees with the mime type', async () => {
    server = await createTestServer();
    const response = await post(documentUploadBody({ fileName: 'resume.txt' }));
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.message).toContain('does not match');
  });

  it('rejects empty content', async () => {
    server = await createTestServer();
    const response = await post(documentUploadBody({ contentBase64: '' }));
    expect(response.statusCode).toBe(422);
  });

  it('rejects a data: URL prefix rather than storing a corrupt file', async () => {
    server = await createTestServer();
    const response = await post(
      documentUploadBody({ contentBase64: `data:application/pdf;base64,${PDF_BASE64}` }),
    );
    expect(response.statusCode).toBe(422);
  });
});

describe('file path restrictions', () => {
  it('neutralizes a traversal attempt in the filename', async () => {
    server = await createTestServer();
    const response = await post(
      documentUploadBody({ fileName: '../../../../../../Windows/System32/evil.pdf' }),
    );

    expect(response.statusCode).toBe(201);
    const document = savedDocumentSchema.parse(response.json<{ data: unknown }>().data);

    // Only the basename survives, prefixed with the document id.
    expect(document.fileName).toBe(`${document.id}-evil.pdf`);
    expect(document.fileName).not.toContain('..');
    expect(document.filePath).toBe(join(server.documentsDir, document.fileName));
    expect(existsSync(join(server.documentsDir, document.fileName))).toBe(true);
  });

  it('strips an absolute Windows path down to its basename', () => {
    expect(sanitizeFileName('C:\\Windows\\System32\\drivers\\etc\\hosts.pdf')).toBe('hosts.pdf');
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('../../secret.pdf')).toBe('secret.pdf');
  });

  it('removes characters that are illegal or dangerous in a filename', () => {
    expect(sanitizeFileName('re:su|me?.pdf')).toBe('resume.pdf');
    expect(sanitizeFileName('trailing dots...')).toBe('trailing dots');
    // Windows reserved device names must not become real files.
    expect(sanitizeFileName('CON.pdf')).toBe('document.pdf');
    expect(sanitizeFileName('nul')).toBe('document');
  });

  it('falls back to a safe name when nothing usable remains', () => {
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName('///')).toBe('document');
    expect(sanitizeFileName('<>:"|?*')).toBe('document');
  });

  it('drops an unexpected extension shape rather than trusting it', () => {
    expect(sanitizeFileName('resume.pdf.exe.verylongextension')).toBe('resume.pdf.exe');
  });

  it('refuses to resolve a path outside the documents root', () => {
    const root = 'C:/agent/documents';
    expect(() => resolveInsideRoot(root, '../elsewhere/file.pdf')).toThrow(PathOutsideRootError);
    expect(() => resolveInsideRoot(root, 'C:/Windows/system.ini')).toThrow(PathOutsideRootError);
    // The root itself is not a file inside the root.
    expect(() => resolveInsideRoot(root, '.')).toThrow(PathOutsideRootError);
  });

  it('does not accept a sibling directory that shares a name prefix', () => {
    expect(() => resolveInsideRoot('C:/agent/documents', 'C:/agent/documents-evil/x.pdf')).toThrow(
      PathOutsideRootError,
    );
  });

  it('accepts an ordinary filename inside the root', () => {
    const resolved = resolveInsideRoot('C:/agent/documents', 'abc-resume.pdf');
    expect(resolved.replace(/\\/g, '/')).toContain('agent/documents/abc-resume.pdf');
  });

  it('prefixes the stored name with the document id so uploads cannot collide', () => {
    const first = documentFileName('id-one', 'resume.pdf');
    const second = documentFileName('id-two', 'resume.pdf');
    expect(first).not.toBe(second);
    expect(first).toBe('id-one-resume.pdf');
  });
});

describe('default resume selection', () => {
  it('makes the first resume the default automatically', async () => {
    server = await createTestServer();
    const created = savedDocumentSchema.parse(
      (await post(documentUploadBody({ isDefault: false }))).json<{ data: unknown }>().data,
    );

    expect(created.isDefault).toBe(true);
    const listed = await listDocuments();
    expect(listed.defaultResumeId).toBe(created.id);
  });

  it('moves the default when a later document asks for it', async () => {
    server = await createTestServer();
    const first = savedDocumentSchema.parse(
      (await post(documentUploadBody({ name: 'First' }))).json<{ data: unknown }>().data,
    );
    const second = savedDocumentSchema.parse(
      (
        await post(documentUploadBody({ name: 'Second', fileName: 'sw.pdf', isDefault: true }))
      ).json<{ data: unknown }>().data,
    );

    const listed = await listDocuments();
    expect(listed.defaultResumeId).toBe(second.id);
    expect(listed.documents.filter((document) => document.isDefault)).toHaveLength(1);
    expect(listed.documents.find((document) => document.id === first.id)?.isDefault).toBe(false);
  });

  it('switches the default through PUT and keeps exactly one', async () => {
    server = await createTestServer();
    const first = savedDocumentSchema.parse(
      (await post(documentUploadBody({ name: 'First' }))).json<{ data: unknown }>().data,
    );
    await post(documentUploadBody({ name: 'Second', fileName: 'sw.pdf', isDefault: true }));

    const response = await server.app.inject({
      method: 'PUT',
      url: `/documents/${first.id}`,
      headers: authHeaders,
      payload: { isDefault: true },
    });

    expect(response.statusCode).toBe(200);
    expect(savedDocumentSchema.parse(response.json<{ data: unknown }>().data).isDefault).toBe(true);

    const listed = await listDocuments();
    expect(listed.defaultResumeId).toBe(first.id);
    expect(listed.documents.filter((document) => document.isDefault)).toHaveLength(1);
  });

  it('tracks defaults per document type', async () => {
    server = await createTestServer();
    const resume = savedDocumentSchema.parse(
      (await post(documentUploadBody())).json<{ data: unknown }>().data,
    );
    const letter = savedDocumentSchema.parse(
      (
        await post(
          documentUploadBody({ name: 'Cover letter', type: 'cover_letter', fileName: 'cl.pdf' }),
        )
      ).json<{ data: unknown }>().data,
    );

    expect(resume.isDefault).toBe(true);
    expect(letter.isDefault).toBe(true);

    const listed = await listDocuments();
    // The default *resume* is unambiguous even though two documents are defaults.
    expect(listed.defaultResumeId).toBe(resume.id);
  });

  it('reports no default resume when only other document types exist', async () => {
    server = await createTestServer();
    await post(documentUploadBody({ type: 'transcript', fileName: 'transcript.pdf' }));

    const listed = await listDocuments();
    expect(listed.defaultResumeId).toBeNull();
  });
});

describe('document metadata updates', () => {
  it('updates tags and targets without touching the stored file', async () => {
    server = await createTestServer();
    const created = savedDocumentSchema.parse(
      (await post(documentUploadBody())).json<{ data: unknown }>().data,
    );

    const response = await server.app.inject({
      method: 'PUT',
      url: `/documents/${created.id}`,
      headers: authHeaders,
      payload: { name: 'Renamed', tags: ['ee', 'fpga'], targetIndustries: ['Aerospace'] },
    });

    const updated = savedDocumentSchema.parse(response.json<{ data: unknown }>().data);
    expect(updated.name).toBe('Renamed');
    expect(updated.tags).toEqual(['ee', 'fpga']);
    expect(updated.targetIndustries).toEqual(['Aerospace']);
    expect(updated.fileName).toBe(created.fileName);
    expect(existsSync(updated.filePath)).toBe(true);
  });

  it('reports DOCUMENT_MISSING for an unknown id', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'PUT',
      url: '/documents/does-not-exist',
      headers: authHeaders,
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('DOCUMENT_MISSING');
  });
});

describe('document deletion', () => {
  it('removes the record and the file from disk', async () => {
    server = await createTestServer();
    const created = savedDocumentSchema.parse(
      (await post(documentUploadBody())).json<{ data: unknown }>().data,
    );
    expect(existsSync(created.filePath)).toBe(true);

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/documents/${created.id}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { deleted: boolean; fileRemoved: boolean } }>();
    expect(body.data.deleted).toBe(true);
    expect(body.data.fileRemoved).toBe(true);

    expect(existsSync(created.filePath)).toBe(false);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it('reports fileRemoved: false when the file was already gone', async () => {
    server = await createTestServer();
    const created = savedDocumentSchema.parse(
      (await post(documentUploadBody())).json<{ data: unknown }>().data,
    );

    const { rmSync } = await import('node:fs');
    rmSync(created.filePath);

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/documents/${created.id}`,
      headers: authHeaders,
    });

    // Honest reporting: the row is gone, but we do not claim to have deleted a
    // file that was not there.
    expect(response.json<{ data: { fileRemoved: boolean } }>().data.fileRemoved).toBe(false);
  });

  it('reports DOCUMENT_MISSING when deleting an unknown id', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/documents/nope',
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('DOCUMENT_MISSING');
  });
});
