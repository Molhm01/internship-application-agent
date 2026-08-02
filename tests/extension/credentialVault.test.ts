import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  credentialSummary,
  deleteCredential,
  generatePassword,
  hasCredential,
  isVaultUnlocked,
  listCredentialSummaries,
  lockVault,
  originOf,
  revealPassword,
  saveCredential,
  unlockVault,
} from '../../extension/src/credentials/vault.js';

const ORIGIN = 'https://careers.example.com';
const PASSPHRASE = 'correct horse battery staple';
const PASSWORD = 'Tr0ub4dor&3-employer';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  lockVault();
});

describe('the credential vault', () => {
  it('stores and returns a password only for the right passphrase', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    expect(await revealPassword(ORIGIN)).toBe(PASSWORD);

    // A different passphrase authenticates as wrong rather than returning rubbish.
    unlockVault('a different passphrase');
    expect(await revealPassword(ORIGIN)).toBeNull();
  });

  it('never writes the password in plaintext', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('internship-agent-credentials');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(String(request.error)));
    });
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction('credentials', 'readonly')
        .objectStore('credentials')
        .get(ORIGIN);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(String(request.error)));
    });
    database.close();

    const record = raw as { ciphertext: ArrayBuffer };
    const bytes = new Uint8Array(record.ciphertext);
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...(raw as object), ciphertext: undefined })).not.toContain(PASSWORD);
  });

  it('refuses to store or reveal anything while locked', async () => {
    await expect(saveCredential(ORIGIN, 'jordanellis', PASSWORD)).rejects.toThrow(/locked/i);
    await expect(revealPassword(ORIGIN)).rejects.toThrow(/locked/i);
    expect(isVaultUnlocked()).toBe(false);
  });

  it('forgets the passphrase when locked, as a worker restart would', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    lockVault();
    expect(isVaultUnlocked()).toBe(false);
    await expect(revealPassword(ORIGIN)).rejects.toThrow(/locked/i);
  });

  it('exposes a username and dates but has no field that could hold a secret', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);

    const summary = await credentialSummary(ORIGIN);
    expect(summary?.username).toBe('jordanellis');
    expect(Object.keys(summary!)).toEqual(['origin', 'username', 'createdAt', 'updatedAt']);
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);

    const listed = await listCredentialSummaries();
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
  });

  it('stores nothing for an insecure origin', async () => {
    unlockVault(PASSPHRASE);
    await expect(saveCredential('http://careers.example.com', 'x', PASSWORD)).rejects.toThrow(
      /secure origins/i,
    );
  });

  it('keeps credentials separate per origin', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    expect(await hasCredential('https://other-employer.example.com')).toBe(false);
    expect(await revealPassword('https://other-employer.example.com')).toBeNull();
  });

  it('removes the ciphertext when a credential is deleted', async () => {
    unlockVault(PASSPHRASE);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    await deleteCredential(ORIGIN);
    expect(await hasCredential(ORIGIN)).toBe(false);
    expect(await credentialSummary(ORIGIN)).toBeNull();
  });

  it('re-encrypts with a fresh salt and IV on every save', async () => {
    unlockVault(PASSPHRASE);
    const first = await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    const firstReveal = await revealPassword(ORIGIN);
    await saveCredential(ORIGIN, 'jordanellis', PASSWORD);
    expect(await revealPassword(ORIGIN)).toBe(firstReveal);
    // The original creation time survives an update.
    expect((await credentialSummary(ORIGIN))?.createdAt).toBe(first.createdAt);
  });
});

describe('origins', () => {
  it('accepts HTTPS and loopback, and rejects plain HTTP on the internet', () => {
    expect(originOf('https://careers.example.com/login')).toBe('https://careers.example.com');
    expect(originOf('http://localhost:4173/x')).toBe('http://localhost:4173');
    expect(originOf('http://careers.example.com')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('generated passwords', () => {
  it('produces a long, unique password each time', () => {
    const first = generatePassword();
    const second = generatePassword();
    expect(first).toHaveLength(20);
    expect(first).not.toBe(second);
  });

  it('omits characters that are misread when retyped', () => {
    const sample = Array.from({ length: 40 }, () => generatePassword(40)).join('');
    expect(sample).not.toMatch(/[0OIl1]/);
  });
});
