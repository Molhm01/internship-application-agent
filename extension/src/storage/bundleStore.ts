import {
  applicationBundleSchema,
  bundleMatchesUrl,
  type ApplicationBundle,
  type ApplicationBundleTransfer,
  type BundleDocumentKind,
  type StoredBundleDocument,
} from '@internship-agent/shared';

/**
 * Extension-owned storage for application bundles and their document bytes.
 *
 * `chrome.storage.sync` is quota-limited and synchronised across devices, so a
 * multi-megabyte PDF must never go there. `chrome.storage.local` would hold the
 * metadata but not binary data efficiently. IndexedDB is the only store in the
 * extension that owns real bytes, works in a service worker, and survives the
 * worker being torn down between messages — so bundles live here, and only the
 * pointer to the active one lives in `chrome.storage.local`.
 */

const DATABASE_NAME = 'internship-agent-bundles';
const DATABASE_VERSION = 1;
const BUNDLE_STORE = 'bundles';
const BLOB_STORE = 'documents';
const ACTIVE_KEY = 'activeBundleId';
/** How many past bundles to keep. Enough to switch back to a job from yesterday. */
export const BUNDLE_HISTORY_LIMIT = 10;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BUNDLE_STORE)) {
        database.createObjectStore(BUNDLE_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(BLOB_STORE)) {
        database.createObjectStore(BLOB_STORE);
      }
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

/** Base64 → bytes, without pulling in a dependency for it. */
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

function bundleIdFor(transfer: ApplicationBundleTransfer): string {
  let hash = 2166136261;
  const seed = `${transfer.websiteJobId}|${transfer.officialApplicationUrl}|${transfer.createdAt}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bundle-${(hash >>> 0).toString(36)}-${transfer.websiteJobId.slice(0, 24)}`;
}

/**
 * Writes a validated transfer to storage: bytes first, then metadata, then the
 * active pointer. In that order, because a bundle that names a blob which does
 * not exist is worse than a blob nothing points at — the second is garbage, the
 * first is a broken upload at fill time.
 */
export async function saveBundle(transfer: ApplicationBundleTransfer): Promise<ApplicationBundle> {
  const id = bundleIdFor(transfer);
  const stored: Partial<Record<BundleDocumentKind, StoredBundleDocument>> = {};

  for (const document of transfer.documents) {
    const bytesReference = `${id}:${document.kind}`;
    const bytes = decodeBase64(document.contentBase64);
    if (bytes.length !== document.byteLength) {
      throw new Error(
        `The ${document.kind} arrived with ${bytes.length} bytes but declared ${document.byteLength}.`,
      );
    }
    await withStore(BLOB_STORE, 'readwrite', (store) =>
      runRequest(store.put(bytes, bytesReference)),
    );
    stored[document.kind] = {
      kind: document.kind,
      filename: document.filename,
      mimeType: document.mimeType,
      bytesReference,
      byteLength: document.byteLength,
      generatedAt: document.generatedAt,
    };
  }

  const bundle = applicationBundleSchema.parse({
    id,
    websiteJobId: transfer.websiteJobId,
    company: transfer.company,
    jobTitle: transfer.jobTitle,
    jobDescription: transfer.jobDescription,
    officialApplicationUrl: transfer.officialApplicationUrl,
    // The website is the source of truth for identity; the snapshot travels
    // with the bundle so the extension never keeps a second copy that could
    // disagree with what the user maintains on Internship Pilot.
    ...(transfer.profile ? { profile: transfer.profile } : {}),
    approvedAnswers: transfer.approvedAnswers,
    ...(transfer.accountPreferences ? { accountPreferences: transfer.accountPreferences } : {}),
    ...(stored.resume ? { resume: stored.resume } : {}),
    ...(stored.cover_letter ? { coverLetter: stored.cover_letter } : {}),
    createdAt: transfer.createdAt,
  });

  await withStore(BUNDLE_STORE, 'readwrite', (store) => runRequest(store.put(bundle)));
  await chrome.storage.local.set({ [ACTIVE_KEY]: bundle.id });
  await pruneHistory();
  return bundle;
}

async function allBundles(): Promise<ApplicationBundle[]> {
  const rows = await withStore(BUNDLE_STORE, 'readonly', (store) =>
    runRequest(store.getAll() as IDBRequest<unknown[]>),
  );
  // Every row is re-validated on read: storage from an older build is data, not
  // a promise about shape.
  return rows
    .map((row) => applicationBundleSchema.safeParse(row))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Drops the oldest bundles and their bytes once history exceeds the limit. */
async function pruneHistory(): Promise<void> {
  const bundles = await allBundles();
  const stale = bundles.slice(BUNDLE_HISTORY_LIMIT);
  for (const bundle of stale) await deleteBundle(bundle.id);
}

export async function listBundles(): Promise<ApplicationBundle[]> {
  return allBundles();
}

export async function loadActiveBundle(): Promise<ApplicationBundle | null> {
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  const id: unknown = stored[ACTIVE_KEY];
  if (typeof id !== 'string' || !id) return null;
  const row = await withStore(BUNDLE_STORE, 'readonly', (store) =>
    runRequest(store.get(id) as IDBRequest<unknown>),
  );
  const parsed = applicationBundleSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export async function setActiveBundle(id: string): Promise<ApplicationBundle | null> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
  return loadActiveBundle();
}

/**
 * The bundle that belongs to a page, preferring the active one.
 *
 * Falling back through history is what lets a user who opened two applications
 * in two tabs get the right documents in each, without the website having to
 * re-send anything.
 */
export async function bundleForUrl(url: string): Promise<ApplicationBundle | null> {
  const active = await loadActiveBundle();
  if (active && bundleMatchesUrl(active, url)) return active;
  const bundles = await allBundles();
  return bundles.find((bundle) => bundleMatchesUrl(bundle, url)) ?? null;
}

export async function readBundleDocument(
  document: StoredBundleDocument,
): Promise<Uint8Array | null> {
  const bytes = await withStore(BLOB_STORE, 'readonly', (store) =>
    runRequest(store.get(document.bytesReference) as IDBRequest<unknown>),
  );
  // Structured clone can hand back the value as a typed array, as a raw buffer,
  // or — across realms, which is what a service worker restart looks like — as
  // an object that is none of those by `instanceof` but still holds the bytes.
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

export async function deleteBundle(id: string): Promise<void> {
  const row = await withStore(BUNDLE_STORE, 'readonly', (store) =>
    runRequest(store.get(id) as IDBRequest<unknown>),
  );
  const parsed = applicationBundleSchema.safeParse(row);
  if (parsed.success) {
    for (const document of [parsed.data.resume, parsed.data.coverLetter]) {
      if (!document) continue;
      await withStore(BLOB_STORE, 'readwrite', (store) =>
        runRequest(store.delete(document.bytesReference)),
      );
    }
  }
  await withStore(BUNDLE_STORE, 'readwrite', (store) => runRequest(store.delete(id)));
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  if (stored[ACTIVE_KEY] === id) await chrome.storage.local.remove(ACTIVE_KEY);
}
