import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  errorResponseSchema,
  latestDocumentContentResponseSchema,
  latestDocumentListResponseSchema,
  latestDocumentRecordSchema,
} from '@internship-agent/shared';
import { PDF_BYTES, authHeaders, createTestServer, type TestServer } from './helpers.js';

/**
 * The tailored-document API: saving the newest résumé and cover letter,
 * listing them, and reading their bytes back byte-for-byte.
 */

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function pdfFor(marker: string): Buffer {
  // Still a valid PDF — the signature check must be exercised — but distinct
  // per document so a mixed-up file cannot pass a checksum comparison.
  return Buffer.concat([PDF_BYTES, Buffer.from(`%${marker}\n`)]);
}

function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uploadBody(
  documentType: 'resume' | 'cover_letter',
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    documentType,
    filename: documentType === 'resume' ? 'Resume-Acme-Intern.pdf' : 'Cover-Letter-Acme-Intern.pdf',
    mimeType: 'application/pdf',
    source: 'tailored',
    company: 'Acme',
    jobTitle: 'Software Engineering Intern',
    jobId: 'job-1',
    checksum: checksumOf(bytes),
    contentBase64: bytes.toString('base64'),
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return server!.app.inject({
    method: 'POST',
    url: '/documents/latest',
    headers: authHeaders,
    payload: body,
  });
}

describe('latest tailored documents', () => {
  it('stores a résumé and returns it as the latest one', async () => {
    server = await createTestServer();
    const bytes = pdfFor('resume-v1');

    const created = await post(uploadBody('resume', bytes));
    expect(created.statusCode).toBe(201);
    const record = latestDocumentRecordSchema.parse(created.json().data);
    expect(record.documentType).toBe('resume');
    expect(record.filename).toBe('Resume-Acme-Intern.pdf');
    expect(record.byteLength).toBe(bytes.byteLength);
    expect(record.checksum).toBe(checksumOf(bytes));

    const listed = await server.app.inject({
      method: 'GET',
      url: '/documents/latest',
      headers: authHeaders,
    });
    const list = latestDocumentListResponseSchema.parse(listed.json().data);
    expect(list.resume?.id).toBe(record.id);
    expect(list.coverLetter).toBeNull();
  });

  it('returns the exact bytes that were stored', async () => {
    server = await createTestServer();
    const bytes = pdfFor('resume-content');
    const created = await post(uploadBody('resume', bytes));
    const record = latestDocumentRecordSchema.parse(created.json().data);

    const content = await server.app.inject({
      method: 'GET',
      url: `/documents/latest/${record.id}/content`,
      headers: authHeaders,
    });
    const payload = latestDocumentContentResponseSchema.parse(content.json().data);
    expect(Buffer.from(payload.contentBase64, 'base64').equals(bytes)).toBe(true);
    expect(payload.checksum).toBe(checksumOf(bytes));
  });

  it('keeps résumé and cover letter apart', async () => {
    server = await createTestServer();
    const resumeBytes = pdfFor('resume');
    const coverBytes = pdfFor('cover');
    await post(uploadBody('resume', resumeBytes));
    await post(uploadBody('cover_letter', coverBytes));

    const listed = await server.app.inject({
      method: 'GET',
      url: '/documents/latest',
      headers: authHeaders,
    });
    const list = latestDocumentListResponseSchema.parse(listed.json().data);
    expect(list.resume?.checksum).toBe(checksumOf(resumeBytes));
    expect(list.coverLetter?.checksum).toBe(checksumOf(coverBytes));
    expect(list.resume?.id).not.toBe(list.coverLetter?.id);
  });

  it('supersedes the previous document of the same type', async () => {
    server = await createTestServer();
    const first = pdfFor('resume-v1');
    const second = pdfFor('resume-v2');
    const firstRecord = latestDocumentRecordSchema.parse(
      (await post(uploadBody('resume', first))).json().data,
    );
    const secondRecord = latestDocumentRecordSchema.parse(
      (await post(uploadBody('resume', second, { filename: 'Resume-Acme-Intern-v2.pdf' }))).json()
        .data,
    );

    const listed = await server.app.inject({
      method: 'GET',
      url: '/documents/latest',
      headers: authHeaders,
    });
    const list = latestDocumentListResponseSchema.parse(listed.json().data);
    expect(list.resume?.id).toBe(secondRecord.id);
    expect(list.resume?.filename).toBe('Resume-Acme-Intern-v2.pdf');

    // The superseded file is gone, not merely unreferenced: a generated
    // document must not accumulate copies on disk.
    const stale = await server.app.inject({
      method: 'GET',
      url: `/documents/latest/${firstRecord.id}/content`,
      headers: authHeaders,
    });
    expect(stale.statusCode).toBe(404);
  });

  it('refuses bytes that do not match the declared checksum', async () => {
    server = await createTestServer();
    const response = await post(uploadBody('resume', pdfFor('real'), { checksum: 'a'.repeat(64) }));
    expect(response.statusCode).toBe(422);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.message).toContain('checksum');
  });

  it('refuses an empty file', async () => {
    server = await createTestServer();
    const response = await post(
      uploadBody('resume', pdfFor('x'), {
        contentBase64: '',
        checksum: checksumOf(Buffer.alloc(0)),
      }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('refuses a non-PDF mime type and a file whose bytes are not a PDF', async () => {
    server = await createTestServer();
    const wrongMime = await post(uploadBody('resume', pdfFor('x'), { mimeType: 'text/plain' }));
    expect(wrongMime.statusCode).toBe(422);

    const notAPdf = Buffer.from('this is not a pdf at all');
    const wrongBytes = await post(
      uploadBody('resume', notAPdf, {
        contentBase64: notAPdf.toString('base64'),
        checksum: checksumOf(notAPdf),
      }),
    );
    expect(wrongBytes.statusCode).toBe(422);
  });

  it('refuses an unknown document type', async () => {
    server = await createTestServer();
    const response = await post(uploadBody('resume', pdfFor('x'), { documentType: 'transcript' }));
    expect(response.statusCode).toBe(422);
  });

  it('refuses an empty filename', async () => {
    server = await createTestServer();
    const response = await post(uploadBody('resume', pdfFor('x'), { filename: '' }));
    expect(response.statusCode).toBe(422);
  });

  it('requires the agent token on every route', async () => {
    server = await createTestServer();
    for (const [method, url] of [
      ['GET', '/documents/latest'],
      ['POST', '/documents/latest'],
      ['GET', '/documents/latest/anything/content'],
    ] as const) {
      const response = await server.app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(401);
    }
  });

  it('answers 404 for a document id that is not stored', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/documents/latest/missing-id/content',
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
  });
});
