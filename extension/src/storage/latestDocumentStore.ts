import {
  storedLatestDocumentSchema,
  storedLatestDocumentsSchema,
  type LatestDocumentRecord,
  type LatestDocumentType,
  type StoredLatestDocument,
  type StoredLatestDocuments,
} from '@internship-agent/shared';

/**
 * The extension's copy of the newest tailored résumé and cover letter.
 *
 * A separate IndexedDB database from the bundle store on purpose. Bundles are
 * per-application and are matched to a page by URL; these two documents are
 * global, are keyed only by type, and must be attachable on a page that has no
 * relationship to any bundle — which is exactly the case a redirect through
 * Jobright produces.
 *
 * IndexedDB rather than `chrome.storage`: `sync` is quota-limited and replicated
 * across devices, so a multi-megabyte PDF must never go there, and `local` holds
 * binary data poorly. IndexedDB survives the service worker being torn down
 * between messages and survives a browser restart.
 *
 * Exactly one row per document type. Reopening the popup re-reads; it never
 * writes a second copy.
 */

const DATABASE_NAME = 'internship-agent-documents';
const DATABASE_VERSION = 1;
const META_STORE = 'latestMetadata';
const BLOB_STORE = 'latestBytes';

function keyFor(documentType: LatestDocumentType): string {
  return documentType;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(BLOB_STORE)) database.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'));
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const result = await work(transaction.objectStore(storeName));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    });
    return result;
  } finally {
    database.close();
  }
}

/** Base64 → bytes. Small and dependency-free; the same shape the bundle store uses. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Bytes → base64, chunked so a large file cannot blow the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** Lowercase hex SHA-256, matching the server and Internship Pilot. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readStoredDocument(
  documentType: LatestDocumentType,
): Promise<StoredLatestDocument | null> {
  const row = await withStore(META_STORE, 'readonly', (store) =>
    runRequest(store.get(keyFor(documentType)) as IDBRequest<unknown>),
  );
  // Re-validated on read: storage written by an older build is data, not a
  // promise about shape.
  const parsed = storedLatestDocumentSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export async function readStoredDocuments(): Promise<StoredLatestDocuments> {
  const [resume, coverLetter] = await Promise.all([
    readStoredDocument('resume'),
    readStoredDocument('cover_letter'),
  ]);
  return storedLatestDocumentsSchema.parse({ resume, coverLetter });
}

export class DocumentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentIntegrityError';
  }
}

/**
 * Stores one document, bytes first.
 *
 * Both the byte length and the checksum are checked against the record before
 * anything is written. A file that fails either is not stored at all: attaching
 * a résumé nobody has verified to a real job application is worse than telling
 * the user the transfer was corrupt.
 */
export async function writeStoredDocument(
  record: LatestDocumentRecord,
  bytes: Uint8Array,
): Promise<StoredLatestDocument> {
  if (bytes.byteLength !== record.byteLength) {
    throw new DocumentIntegrityError(
      `${record.filename} arrived with ${bytes.byteLength} bytes but declared ${record.byteLength}.`,
    );
  }
  const checksum = await sha256Hex(bytes);
  if (checksum !== record.checksum) {
    throw new DocumentIntegrityError(
      `${record.filename} does not match the checksum the agent recorded for it.`,
    );
  }

  const key = keyFor(record.documentType);
  await withStore(BLOB_STORE, 'readwrite', (store) => runRequest(store.put(bytes, key)));
  const stored = storedLatestDocumentSchema.parse({
    ...record,
    receivedAt: new Date().toISOString(),
  });
  await withStore(META_STORE, 'readwrite', (store) => runRequest(store.put(stored, key)));
  return stored;
}

export async function readStoredBytes(
  documentType: LatestDocumentType,
): Promise<Uint8Array | null> {
  const bytes = await withStore(BLOB_STORE, 'readonly', (store) =>
    runRequest(store.get(keyFor(documentType)) as IDBRequest<unknown>),
  );
  // Structured clone can hand the value back as a typed array, as a raw buffer,
  // or — across realms, which is what a service-worker restart looks like — as
  // an object that is neither by `instanceof` but still holds the bytes.
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes && typeof bytes === 'object' && 'byteLength' in bytes) {
    const candidate = bytes as { buffer?: ArrayBufferLike; byteLength: number };
    if (candidate.buffer) return new Uint8Array(candidate.buffer);
  }
  return null;
}

export async function clearStoredDocument(documentType: LatestDocumentType): Promise<void> {
  const key = keyFor(documentType);
  await withStore(BLOB_STORE, 'readwrite', (store) => runRequest(store.delete(key)));
  await withStore(META_STORE, 'readwrite', (store) => runRequest(store.delete(key)));
}
