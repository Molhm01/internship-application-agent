/**
 * The encrypted credential vault.
 *
 * Employer sites need an account. The browser's own password manager is the
 * preferred place for that, and this vault exists only for the case where the
 * user asks the agent to remember a credential itself.
 *
 * What makes it safe to have at all:
 *
 * - Secrets are encrypted with AES-GCM before they touch storage. The key is
 *   derived from a passphrase the user supplies with PBKDF2, and is held only
 *   in memory for the life of the service worker. Nothing usable survives on
 *   disk without that passphrase.
 * - Ciphertext lives in IndexedDB, never in `chrome.storage.sync`, which is
 *   synchronised off the device.
 * - A secret is never logged, never placed in a URL, never sent to a model, and
 *   never included in an application bundle. The functions here return a value
 *   exactly once, to the executor that is about to type it.
 * - Saving and filling both require an explicit prior decision by the user,
 *   recorded per origin.
 *
 * The one thing this file must never grow is a "convenience" accessor that
 * returns every secret at once, or a debug path that stringifies one.
 */

const DATABASE_NAME = 'internship-agent-credentials';
const DATABASE_VERSION = 1;
const STORE = 'credentials';
/** OWASP's floor for PBKDF2-SHA256 at the time of writing. */
const PBKDF2_ITERATIONS = 600_000;

export interface StoredCredential {
  /** Origin the credential belongs to, e.g. `https://careers.example.com`. */
  origin: string;
  username: string;
  /** AES-GCM ciphertext of the password. Never the password. */
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  salt: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

/** What a caller may see. Deliberately has no field that could hold a secret. */
export interface CredentialSummary {
  origin: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'origin' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('The credential vault could not be opened.'));
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Credential vault request failed.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await work(database.transaction(STORE, mode).objectStore(STORE));
  } finally {
    database.close();
  }
}

/** Normalizes a page URL to the origin a credential is keyed by. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.hostname === 'localhost' ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The unlock passphrase, held in memory only.
 *
 * A service-worker restart clears it, which is the intended behaviour: the user
 * re-confirms rather than the agent silently retaining the ability to type
 * their password forever.
 */
let unlockedPassphrase: string | null = null;

export function unlockVault(passphrase: string): void {
  if (!passphrase) throw new Error('A passphrase is required to unlock the credential vault.');
  unlockedPassphrase = passphrase;
}

export function lockVault(): void {
  unlockedPassphrase = null;
}

export function isVaultUnlocked(): boolean {
  return unlockedPassphrase !== null;
}

/**
 * Stores a credential for an origin.
 *
 * The caller must already have the user's explicit confirmation; this function
 * does not and cannot obtain it.
 */
export async function saveCredential(
  origin: string,
  username: string,
  password: string,
): Promise<CredentialSummary> {
  if (!unlockedPassphrase) throw new Error('The credential vault is locked.');
  if (!originOf(origin)) throw new Error('Credentials are only stored for secure origins.');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(unlockedPassphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(password),
  );

  const now = new Date().toISOString();
  const existing = await findRaw(origin);
  const record: StoredCredential = {
    origin,
    username,
    ciphertext,
    iv,
    salt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await withStore('readwrite', (store) => runRequest(store.put(record)));
  return summarize(record);
}

function summarize(record: StoredCredential): CredentialSummary {
  return {
    origin: record.origin,
    username: record.username,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function findRaw(origin: string): Promise<StoredCredential | null> {
  const row = await withStore('readonly', (store) =>
    runRequest(store.get(origin) as IDBRequest<unknown>),
  );
  return row && typeof row === 'object' && 'ciphertext' in row ? (row as StoredCredential) : null;
}

/** Whether a credential exists, without revealing anything about it. */
export async function hasCredential(origin: string): Promise<boolean> {
  return (await findRaw(origin)) !== null;
}

/** The username and metadata for an origin. Never the password. */
export async function credentialSummary(origin: string): Promise<CredentialSummary | null> {
  const record = await findRaw(origin);
  return record ? summarize(record) : null;
}

export async function listCredentialSummaries(): Promise<CredentialSummary[]> {
  const rows = await withStore('readonly', (store) =>
    runRequest(store.getAll() as IDBRequest<unknown[]>),
  );
  return rows
    .filter(
      (row): row is StoredCredential =>
        row !== null && typeof row === 'object' && 'ciphertext' in row,
    )
    .map(summarize);
}

/**
 * Decrypts a password for one use.
 *
 * The only correct caller is the executor, immediately before typing it into a
 * password field it has already identified. The returned value must not be
 * stored, logged, or passed anywhere else.
 */
export async function revealPassword(origin: string): Promise<string | null> {
  if (!unlockedPassphrase) throw new Error('The credential vault is locked.');
  const record = await findRaw(origin);
  if (!record) return null;
  const key = await deriveKey(unlockedPassphrase, record.salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as unknown as BufferSource },
      key,
      record.ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A wrong passphrase fails authentication rather than returning rubbish.
    return null;
  }
}

export async function deleteCredential(origin: string): Promise<void> {
  await withStore('readwrite', (store) => runRequest(store.delete(origin)));
}

/**
 * A password strong enough for an employer site, from the platform's CSPRNG.
 *
 * Offered so a user who wants a unique password per employer does not have to
 * invent one. It is shown to them before anything is saved or typed.
 */
export function generatePassword(length = 20): string {
  // Ambiguous characters are excluded: these get read aloud and retyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  let password = '';
  for (const byte of bytes) password += alphabet[byte % alphabet.length];
  return password;
}
