import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  BUNDLE_BRIDGE,
  applicationBundleTransferSchema,
  bundleMatchesUrl,
  type ApplicationBundleTransfer,
} from '@internship-agent/shared';
import {
  bundleForUrl,
  deleteBundle,
  encodeBase64,
  listBundles,
  loadActiveBundle,
  readBundleDocument,
  saveBundle,
  setActiveBundle,
} from '../../extension/src/storage/bundleStore.js';
import {
  isAllowedBridgeOrigin,
  startBundleBridge,
} from '../../extension/src/content/bundleBridge.js';
import { installChromeMock } from './setup.js';

const RESUME_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const COVER_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]);

function transfer(overrides: Partial<ApplicationBundleTransfer> = {}): ApplicationBundleTransfer {
  return applicationBundleTransferSchema.parse({
    websiteJobId: 'job-42',
    company: 'Northwind Robotics',
    jobTitle: 'Software Engineering Intern',
    jobDescription: 'Build robots that do not fall over.',
    officialApplicationUrl: 'https://boards.greenhouse.io/northwind/jobs/9911',
    createdAt: '2026-08-02T09:00:00.000Z',
    profile: {
      id: 'primary',
      personal: { legalFirstName: 'Jordan', legalLastName: 'Ellis', address: { city: 'Clifton' } },
      education: [],
      experience: [],
      projects: [],
      certifications: [],
      volunteering: [],
      skills: {},
      eligibility: { workAuthorization: 'U.S. Citizen' },
      preferences: {},
      sensitivePolicies: [{ category: 'gender', policy: 'decline_to_answer' }],
      updatedAt: '2026-08-02T08:00:00.000Z',
    },
    approvedAnswers: [],
    accountPreferences: { applicationEmail: 'jordan.applies@example.com', wantsAccountCreationHelp: true },
    documents: [
      {
        kind: 'resume',
        filename: 'Resume-Northwind-Robotics.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(RESUME_BYTES),
        byteLength: RESUME_BYTES.length,
        generatedAt: '2026-08-02T08:55:00.000Z',
      },
      {
        kind: 'cover_letter',
        filename: 'Cover-Letter-Northwind-Robotics.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(COVER_BYTES),
        byteLength: COVER_BYTES.length,
        generatedAt: '2026-08-02T08:56:00.000Z',
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  // A clean database per test; IndexedDB otherwise persists across the file.
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
});

describe('bundle storage', () => {
  it('stores the tailored résumé and cover letter with filename, MIME type, and real bytes', async () => {
    const bundle = await saveBundle(transfer());

    expect(bundle.company).toBe('Northwind Robotics');
    expect(bundle.jobTitle).toBe('Software Engineering Intern');
    expect(bundle.websiteJobId).toBe('job-42');
    expect(bundle.officialApplicationUrl).toBe('https://boards.greenhouse.io/northwind/jobs/9911');

    expect(bundle.resume).toMatchObject({
      filename: 'Resume-Northwind-Robotics.pdf',
      mimeType: 'application/pdf',
      byteLength: RESUME_BYTES.length,
    });
    expect(bundle.coverLetter).toMatchObject({
      filename: 'Cover-Letter-Northwind-Robotics.pdf',
      mimeType: 'application/pdf',
      byteLength: COVER_BYTES.length,
    });

    // The bytes themselves, not a reference to a page that may be gone.
    expect(await readBundleDocument(bundle.resume!)).toEqual(RESUME_BYTES);
    expect(await readBundleDocument(bundle.coverLetter!)).toEqual(COVER_BYTES);
  });

  it('stores the canonical profile the website sent with the documents', async () => {
    const bundle = await saveBundle(transfer());
    expect(bundle.profile?.personal.legalFirstName).toBe('Jordan');
    expect(bundle.profile?.eligibility.workAuthorization).toBe('U.S. Citizen');
    expect(bundle.profile?.sensitivePolicies).toEqual([
      { category: 'gender', policy: 'decline_to_answer' },
    ]);
    expect(bundle.accountPreferences?.applicationEmail).toBe('jordan.applies@example.com');
    expect(bundle.accountPreferences?.wantsAccountCreationHelp).toBe(true);
  });

  it('never stores a credential alongside the bundle', async () => {
    const bundle = await saveBundle(transfer());
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/password|passwd|secret|credential/i);
  });

  it('refuses bytes that do not match the declared length', async () => {
    const broken = transfer();
    broken.documents[0]!.byteLength = 999;
    await expect(saveBundle(broken)).rejects.toThrow(/declared 999/);
  });

  it('makes the newest bundle active and keeps earlier ones in history', async () => {
    await saveBundle(transfer());
    const second = await saveBundle(
      transfer({
        websiteJobId: 'job-77',
        company: 'Helios Systems',
        officialApplicationUrl: 'https://jobs.lever.co/helios/abc-123',
        createdAt: '2026-08-02T10:00:00.000Z',
      }),
    );

    expect((await loadActiveBundle())?.id).toBe(second.id);
    expect((await listBundles()).map((entry) => entry.company)).toEqual([
      'Helios Systems',
      'Northwind Robotics',
    ]);
  });

  it('finds the bundle that belongs to a page even when another is active', async () => {
    const northwind = await saveBundle(transfer());
    await saveBundle(
      transfer({
        websiteJobId: 'job-77',
        company: 'Helios Systems',
        officialApplicationUrl: 'https://jobs.lever.co/helios/abc-123',
        createdAt: '2026-08-02T10:00:00.000Z',
      }),
    );

    const found = await bundleForUrl('https://boards.greenhouse.io/northwind/jobs/9911/apply');
    expect(found?.id).toBe(northwind.id);
  });

  it('does not offer a bundle from a different employer', async () => {
    await saveBundle(transfer());
    expect(await bundleForUrl('https://boards.greenhouse.io/someone-else/jobs/1')).toBeNull();
  });

  it('removes the bytes when a bundle is deleted', async () => {
    const bundle = await saveBundle(transfer());
    const resume = bundle.resume!;
    await deleteBundle(bundle.id);
    expect(await listBundles()).toEqual([]);
    expect(await readBundleDocument(resume)).toBeNull();
    expect(await loadActiveBundle()).toBeNull();
  });

  it('can switch the active bundle back to an earlier one', async () => {
    const first = await saveBundle(transfer());
    await saveBundle(
      transfer({
        websiteJobId: 'job-77',
        officialApplicationUrl: 'https://jobs.lever.co/helios/abc-123',
        createdAt: '2026-08-02T10:00:00.000Z',
      }),
    );
    expect((await setActiveBundle(first.id))?.id).toBe(first.id);
  });
});

describe('page matching', () => {
  const bundle = {
    officialApplicationUrl: 'https://boards.greenhouse.io/northwind/jobs/9911',
  } as Parameters<typeof bundleMatchesUrl>[0];

  it('matches the same page with tracking parameters', () => {
    expect(
      bundleMatchesUrl(bundle, 'https://boards.greenhouse.io/northwind/jobs/9911?gh_src=abc'),
    ).toBe(true);
  });

  it('matches the apply sub-page of the same posting', () => {
    expect(bundleMatchesUrl(bundle, 'https://boards.greenhouse.io/northwind/jobs/9911/apply')).toBe(
      true,
    );
  });

  it('does not match another origin', () => {
    expect(bundleMatchesUrl(bundle, 'https://evil.example.com/northwind/jobs/9911')).toBe(false);
  });

  it('does not match another posting on the same board', () => {
    expect(bundleMatchesUrl(bundle, 'https://boards.greenhouse.io/northwind/jobs/1234')).toBe(
      false,
    );
  });
});

describe('bridge origin policy', () => {
  it('accepts the production site and loopback development', () => {
    expect(isAllowedBridgeOrigin('https://internship-pilot.app')).toBe(true);
    expect(isAllowedBridgeOrigin('https://www.internship-pilot.app')).toBe(true);
    expect(isAllowedBridgeOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedBridgeOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('rejects lookalikes, plain HTTP on the internet, and LAN addresses', () => {
    expect(isAllowedBridgeOrigin('https://internship-pilot.app.evil.com')).toBe(false);
    expect(isAllowedBridgeOrigin('https://notinternship-pilot.app')).toBe(false);
    expect(isAllowedBridgeOrigin('http://internship-pilot.app')).toBe(false);
    expect(isAllowedBridgeOrigin('http://192.168.1.20:3000')).toBe(false);
    expect(isAllowedBridgeOrigin('not a url')).toBe(false);
  });
});

describe('the page bridge', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  /** Delivers a message as if the page had posted it from `origin`. */
  function post(data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin,
        source: window as unknown as MessageEventSource,
      }),
    );
  }

  function nextPostedMessage(channel: string, timeoutMs = 200): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', listener);
        reject(new Error(`No ${channel} message within ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (event: MessageEvent): void => {
        const data = event.data as Record<string, unknown>;
        if (data?.channel !== channel) return;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(data);
      };
      window.addEventListener('message', listener);
    });
  }

  it('answers a probe so the website knows the extension is present', async () => {
    stop = startBundleBridge();
    const answered = nextPostedMessage(BUNDLE_BRIDGE.probeAck);
    post({ channel: BUNDLE_BRIDGE.probe, requestId: 'probe-1' });
    expect(await answered).toMatchObject({ requestId: 'probe-1' });
  });

  it('forwards a valid bundle to the worker and returns its acknowledgement', async () => {
    const chrome = installChromeMock();
    chrome.runtime.sendMessage.mockResolvedValue({
      result: {
        ok: true,
        bundleId: 'bundle-1',
        storedDocuments: ['resume', 'cover_letter'],
        storedAt: '2026-08-02T09:00:00.000Z',
      },
    });
    stop = startBundleBridge();

    const answered = nextPostedMessage(BUNDLE_BRIDGE.result);
    post({ channel: BUNDLE_BRIDGE.offer, requestId: 'offer-1', bundle: transfer() });
    const message = await answered;

    expect(message.result).toMatchObject({ ok: true, bundleId: 'bundle-1' });
    const forwarded = chrome.runtime.sendMessage.mock.calls[0]![0] as { type: string };
    expect(forwarded.type).toBe('SAVE_APPLICATION_BUNDLE');
    // No ApplicationSession is created anywhere in the handoff.
    for (const call of chrome.runtime.sendMessage.mock.calls) {
      expect(String((call[0] as { type: string }).type)).not.toContain('SESSION');
    }
  });

  it('ignores a message from a disallowed origin without contacting the worker', async () => {
    const chrome = installChromeMock();
    stop = startBundleBridge();
    post(
      { channel: BUNDLE_BRIDGE.offer, requestId: 'evil-1', bundle: transfer() },
      'https://evil.example.com',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed bundle and never forwards it', async () => {
    const chrome = installChromeMock();
    stop = startBundleBridge();
    const answered = nextPostedMessage(BUNDLE_BRIDGE.result);
    post({
      channel: BUNDLE_BRIDGE.offer,
      requestId: 'offer-2',
      bundle: { websiteJobId: 'job-1', company: 'X' },
    });
    expect(await answered).toMatchObject({
      requestId: 'offer-2',
      result: { ok: false },
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reports a refusal when the worker does not confirm', async () => {
    const chrome = installChromeMock();
    chrome.runtime.sendMessage.mockResolvedValue(undefined);
    stop = startBundleBridge();
    const answered = nextPostedMessage(BUNDLE_BRIDGE.result);
    post({ channel: BUNDLE_BRIDGE.offer, requestId: 'offer-3', bundle: transfer() });
    const message = await answered;
    expect(message.result).toMatchObject({ ok: false });
    expect(String((message.result as { reason: string }).reason)).toContain('did not confirm');
  });
});

describe('no document content leaves through a URL', () => {
  it('keeps base64 out of every field that could reach an address bar', async () => {
    const bundle = await saveBundle(transfer());
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(encodeBase64(RESUME_BYTES));
    expect(bundle.officialApplicationUrl).not.toContain('#');
    expect(bundle.officialApplicationUrl).not.toMatch(/base64/i);
  });
});

describe('base64 round trip', () => {
  it('survives a payload larger than one encoding chunk', () => {
    const large = new Uint8Array(0x8000 * 2 + 17).map((_, index) => index % 251);
    const decoded = Uint8Array.from(atob(encodeBase64(large)), (character) =>
      character.charCodeAt(0),
    );
    expect(decoded).toEqual(large);
  });
});

// Keeps the linter honest about the unused import guard above.
void vi;
