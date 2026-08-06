import 'fake-indexeddb/auto';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LatestDocumentRecord } from '@internship-agent/shared';
import {
  clearStoredDocument,
  readStoredBytes,
  readStoredDocuments,
  writeStoredDocument,
  DocumentIntegrityError,
} from '../../extension/src/storage/latestDocumentStore.js';
import { installChromeMock } from './setup.js';

/**
 * The extension's own copy of the latest documents: checksum-verified on write,
 * one row per type, and readable after everything a service worker survives.
 */

const RESUME_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const COVER_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(
  documentType: 'resume' | 'cover_letter',
  bytes: Uint8Array,
  overrides: Partial<LatestDocumentRecord> = {},
): LatestDocumentRecord {
  return {
    id: `${documentType}-1`,
    documentType,
    filename: documentType === 'resume' ? 'Resume-Acme.pdf' : 'Cover-Letter-Acme.pdf',
    mimeType: 'application/pdf',
    byteLength: bytes.byteLength,
    createdAt: '2026-08-05T10:00:00.000Z',
    source: 'tailored',
    company: 'Acme',
    jobTitle: 'Software Engineering Intern',
    jobId: 'job-1',
    checksum: sha256(bytes),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
  // `crypto.subtle` is what verifies a checksum, and jsdom does not provide it.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the extension document store', () => {
  it('stores and reads back a résumé byte-for-byte', async () => {
    const stored = await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    expect(stored.filename).toBe('Resume-Acme.pdf');
    expect(stored.receivedAt).toBeTruthy();

    const bytes = await readStoredBytes('resume');
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual(Array.from(RESUME_BYTES));
  });

  it('keeps the résumé and the cover letter apart', async () => {
    await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    await writeStoredDocument(record('cover_letter', COVER_BYTES), COVER_BYTES);

    const documents = await readStoredDocuments();
    expect(documents.resume?.documentType).toBe('resume');
    expect(documents.coverLetter?.documentType).toBe('cover_letter');
    expect(Array.from((await readStoredBytes('cover_letter'))!)).toEqual(Array.from(COVER_BYTES));
  });

  it('refuses a file whose checksum does not match its record', async () => {
    await expect(
      writeStoredDocument(
        record('resume', RESUME_BYTES, { checksum: 'b'.repeat(64) }),
        RESUME_BYTES,
      ),
    ).rejects.toBeInstanceOf(DocumentIntegrityError);
    expect((await readStoredDocuments()).resume).toBeNull();
  });

  it('refuses a file whose byte length does not match its record', async () => {
    await expect(
      writeStoredDocument(record('resume', RESUME_BYTES, { byteLength: 999 }), RESUME_BYTES),
    ).rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  it('replaces rather than duplicates when a newer document arrives', async () => {
    await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    const newer = new Uint8Array([...RESUME_BYTES, 0x0a]);
    await writeStoredDocument(
      record('resume', newer, { id: 'resume-2', filename: 'Resume-Acme-v2.pdf' }),
      newer,
    );

    const documents = await readStoredDocuments();
    expect(documents.resume?.id).toBe('resume-2');
    expect(documents.resume?.filename).toBe('Resume-Acme-v2.pdf');
    expect((await readStoredBytes('resume'))!.byteLength).toBe(newer.byteLength);
  });

  it('survives the database being reopened, as a suspended worker requires', async () => {
    await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    // Every helper opens and closes its own connection, so a second read here
    // is exactly what a restarted service worker performs.
    const documents = await readStoredDocuments();
    expect(documents.resume?.checksum).toBe(sha256(RESUME_BYTES));
  });

  it('clears a document on request', async () => {
    await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    await clearStoredDocument('resume');
    expect((await readStoredDocuments()).resume).toBeNull();
    expect(await readStoredBytes('resume')).toBeNull();
  });
});

describe('syncing from the agent server', () => {
  async function loadSync() {
    return import('../../extension/src/background/latestDocuments.js');
  }

  it('downloads a document this browser does not have', async () => {
    const listed = record('resume', RESUME_BYTES);
    vi.doMock('../../extension/src/background/agentClient.js', () => ({
      listLatestDocuments: vi
        .fn()
        .mockResolvedValue({ data: { resume: listed, coverLetter: null } }),
      getLatestDocumentContent: vi.fn().mockResolvedValue({
        data: { ...listed, contentBase64: Buffer.from(RESUME_BYTES).toString('base64') },
      }),
    }));
    vi.resetModules();

    const { syncLatestDocuments } = await loadSync();
    const result = await syncLatestDocuments();
    expect(result.documents.resume?.id).toBe(listed.id);
    expect(result.error).toBeUndefined();
    vi.doUnmock('../../extension/src/background/agentClient.js');
  });

  it('does not re-download a document it already holds', async () => {
    const listed = record('resume', RESUME_BYTES);
    const getContent = vi.fn().mockResolvedValue({
      data: { ...listed, contentBase64: Buffer.from(RESUME_BYTES).toString('base64') },
    });
    vi.doMock('../../extension/src/background/agentClient.js', () => ({
      listLatestDocuments: vi
        .fn()
        .mockResolvedValue({ data: { resume: listed, coverLetter: null } }),
      getLatestDocumentContent: getContent,
    }));
    vi.resetModules();

    const { syncLatestDocuments } = await loadSync();
    await syncLatestDocuments();
    await syncLatestDocuments();
    // Opening the popup twice must not create a second copy of the same file.
    expect(getContent).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../extension/src/background/agentClient.js');
  });

  it('keeps the stored documents when the server cannot be reached', async () => {
    await writeStoredDocument(record('resume', RESUME_BYTES), RESUME_BYTES);
    vi.doMock('../../extension/src/background/agentClient.js', () => ({
      listLatestDocuments: vi.fn().mockResolvedValue({
        error: {
          code: 'AGENT_SERVER_UNAVAILABLE',
          message: 'not running',
          recoverable: true,
          suggestedAction: 'start it',
          debugContext: {},
        },
      }),
      getLatestDocumentContent: vi.fn(),
    }));
    vi.resetModules();

    const { syncLatestDocuments } = await loadSync();
    const result = await syncLatestDocuments();
    expect(result.error?.code).toBe('AGENT_SERVER_UNAVAILABLE');
    // The whole point: a résumé already here stays attachable.
    expect(result.documents.resume?.filename).toBe('Resume-Acme.pdf');
    vi.doUnmock('../../extension/src/background/agentClient.js');
  });

  it('reports, and does not store, a document that fails its checksum in transit', async () => {
    const listed = record('resume', RESUME_BYTES);
    vi.doMock('../../extension/src/background/agentClient.js', () => ({
      listLatestDocuments: vi
        .fn()
        .mockResolvedValue({ data: { resume: listed, coverLetter: null } }),
      getLatestDocumentContent: vi.fn().mockResolvedValue({
        data: { ...listed, contentBase64: Buffer.from(COVER_BYTES).toString('base64') },
      }),
    }));
    vi.resetModules();

    const { syncLatestDocuments } = await loadSync();
    const result = await syncLatestDocuments();
    expect(result.error?.code).toBe('DOCUMENT_SYNC_FAILED');
    expect(result.documents.resume).toBeNull();
    vi.doUnmock('../../extension/src/background/agentClient.js');
  });
});
