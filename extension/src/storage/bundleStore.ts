import {
  applicationBundleSchema,
  bundleMatchesUrl,
  bundleSharesPortal,
  bundleVersionProblem,
  urlIsDifferentPosting,
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
  // Checked before a single byte is written. Storing a bundle this build cannot
  // fully read would turn fields it does not understand into silently
  // unanswered questions, which is indistinguishable from an empty profile.
  const versionProblem = bundleVersionProblem(transfer);
  if (versionProblem) throw new Error(versionProblem);

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
    bundleVersion: transfer.bundleVersion,
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
    // Absent when the user has told us nothing about this employer, which the
    // resolver must be able to see: unknown becomes a question, never a "no".
    ...(transfer.companyRelationship ? { companyRelationship: transfer.companyRelationship } : {}),
    ...(stored.resume ? { resume: stored.resume } : {}),
    ...(stored.cover_letter ? { coverLetter: stored.cover_letter } : {}),
    createdAt: transfer.createdAt,
  });

  await withStore(BUNDLE_STORE, 'readwrite', (store) => runRequest(store.put(bundle)));
  await chrome.storage.local.set({ [ACTIVE_KEY]: bundle.id });
  // The journey starts here, not at the first route the agent takes.
  //
  // Internship Pilot opens the employer tab itself, immediately after this
  // acknowledgement, and the applicant then clicks "Apply" or "Create account"
  // by hand. Those hops leave the job's path — iCIMS sends /jobs/12345/job to
  // /jobs/login — and until the agent happened to take a route of its own,
  // nothing recorded that this origin belonged to the run in progress. So
  // `bundleForUrl` fell through to null and the popup said "No application
  // loaded from Internship Pilot" with the tailored documents apparently gone.
  //
  // Seeding it from the bundle's own URL is safe because it is scoped to the
  // active bundle, expires with the journey TTL, and history bundles are still
  // matched on path — two jobs at one employer in two tabs cannot borrow each
  // other's documents.
  await rememberPortalJourneyFor(bundle.id, bundle.officialApplicationUrl);
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
  const matched = bundles.find((bundle) => bundleMatchesUrl(bundle, url));
  if (matched) return matched;
  // Last resort: the agent itself walked the applicant off the posting and onto
  // a sign-in or account page, whose path has no relationship to the job's.
  //
  // Deliberately not a plain same-origin match. Greenhouse and Lever host every
  // employer on one origin, so "same origin" there means "some other company's
  // job" — the journey record is what distinguishes a hop this extension
  // performed from the user simply browsing to a different posting.
  const journey = await loadPortalJourney();
  const sameJourney =
    active !== null &&
    journey !== null &&
    journey.bundleId === active.id &&
    bundleSharesPortal(active, url) &&
    // A page that names a different requisition is another job on the same
    // portal, not a hop in this application. Without this the journey — which
    // now starts the moment the bundle is saved, so the applicant's own click
    // on "Apply" keeps it — would hand this bundle's tailored documents to any
    // posting the user happened to open on the same host.
    !urlIsDifferentPosting(active, url);
  return sameJourney ? active : null;
}

const JOURNEY_KEY = 'portalJourney';
/** A journey older than this is stale browsing, not the run that is in progress. */
const JOURNEY_TTL_MS = 60 * 60 * 1000;

interface PortalJourney {
  bundleId: string;
  origin: string;
  startedAt: number;
}

/**
 * Records that the agent took a portal route while this bundle was active.
 *
 * This is what lets the bundle follow the applicant from `/jobs/12345/job` to
 * `/jobs/login` to `/connect` without letting it follow them to an unrelated
 * employer that happens to share a hostname.
 */
export async function rememberPortalJourney(url: string): Promise<void> {
  const active = await loadActiveBundle();
  if (!active) return;
  await rememberPortalJourneyFor(active.id, url);
}

/**
 * Records a journey for a named bundle.
 *
 * Separate from the above because `saveBundle` calls it while the active
 * pointer is still being written, and reading the active bundle back at that
 * moment would be both wasteful and racy.
 */
export async function rememberPortalJourneyFor(bundleId: string, url: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  await chrome.storage.local.set({
    [JOURNEY_KEY]: { bundleId, origin, startedAt: Date.now() } satisfies PortalJourney,
  });
}

async function loadPortalJourney(): Promise<PortalJourney | null> {
  const stored = await chrome.storage.local.get(JOURNEY_KEY);
  const raw = stored[JOURNEY_KEY] as Partial<PortalJourney> | undefined;
  if (
    !raw ||
    typeof raw.bundleId !== 'string' ||
    typeof raw.origin !== 'string' ||
    typeof raw.startedAt !== 'number'
  ) {
    return null;
  }
  if (Date.now() - raw.startedAt > JOURNEY_TTL_MS) return null;
  return raw as PortalJourney;
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
