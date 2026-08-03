import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_MESSAGE, anyPatternMatches, matchesPattern } from '@internship-agent/shared';
import {
  ensureContentScript,
  isInjectablePage,
} from '../../extension/src/background/contentScript.js';
import { installChromeMock, type ChromeMock } from './setup.js';

/**
 * The tab is open, the page is fine, and the extension cannot talk to it.
 *
 * That is what every user sees after reloading an unpacked extension, and it
 * used to be reported as though the page had no application form on it. These
 * tests pin the three things that make it recoverable: the manifest permits
 * reinjection on the pages that matter, the worker actually reinjects, and the
 * failure is never dressed up as a verdict about the page.
 */

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'extension', 'manifest.json'), 'utf8'),
) as {
  content_scripts: Array<{ matches: string[]; js: string[]; all_frames: boolean }>;
  host_permissions: string[];
  permissions: string[];
};

const ICIMS = 'https://careers2-quanta.icims.com/jobs/12345/login';

describe('manifest coverage for employer portals', () => {
  it('runs a content script on careers2-quanta.icims.com', () => {
    const [entry] = manifest.content_scripts;
    expect(entry).toBeDefined();
    expect(anyPatternMatches(entry!.matches, ICIMS)).toBe(true);
    expect(entry!.js).toContain('content.js');
  });

  it('holds host permission for the iCIMS tenant domains, so the script can be put back', () => {
    // Reinjection needs a host permission, not merely a content-script match:
    // `chrome.scripting.executeScript` checks the former and ignores the latter.
    for (const url of [
      ICIMS,
      'https://jobs-company.icims.com/jobs/1/candidate',
      'https://careers.icims.eu/jobs/2/apply',
    ]) {
      expect(anyPatternMatches(manifest.host_permissions, url)).toBe(true);
    }
    expect(manifest.host_permissions).toContain('https://*.icims.com/*');
    expect(manifest.permissions).toContain('scripting');
  });

  it('covers the other supported ATS vendors and ordinary employer career sites', () => {
    for (const url of [
      'https://company.wd5.myworkdayjobs.com/en-US/careers/job/Intern',
      'https://boards.greenhouse.io/company/jobs/123',
      'https://jobs.lever.co/company/abc',
      'https://company.taleo.net/careersection/2/jobapply.ftl',
      // An employer career portal on the company's own domain. This is why the
      // permissions cannot be narrowed to the named vendors.
      'https://careers.example.com/apply',
    ]) {
      expect(anyPatternMatches(manifest.host_permissions, url)).toBe(true);
      expect(anyPatternMatches(manifest.content_scripts[0]!.matches, url)).toBe(true);
    }
  });

  it('does not grant a lookalike domain', () => {
    expect(matchesPattern('https://*.icims.com/*', 'https://icims.com.attacker.example/')).toBe(
      false,
    );
    expect(matchesPattern('https://*.icims.com/*', 'https://evilicims.com/')).toBe(false);
    expect(matchesPattern('https://*.icims.com/*', 'https://careers2-quanta.icims.com/x')).toBe(
      true,
    );
  });
});

describe('reconnecting a content script', () => {
  let chromeMock: ChromeMock;
  beforeEach(() => {
    chromeMock = installChromeMock();
  });

  it('does nothing when the script already answers', async () => {
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: ICIMS });
    const result = await ensureContentScript(1, ICIMS);
    expect(result).toMatchObject({ reachable: true, injected: false });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('reinjects and retries once when the first ping finds no receiving end', async () => {
    // Exactly the state of every tab that was open when the extension reloaded.
    chromeMock.tabs.sendMessage
      .mockRejectedValueOnce(
        new Error('Could not establish connection. Receiving end does not exist.'),
      )
      .mockResolvedValueOnce({
        present: true,
        url: ICIMS,
        ats: { id: 'icims', displayName: 'iCIMS', confidence: 0.98, reason: 'hostname' },
      });

    const result = await ensureContentScript(7, ICIMS);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: false },
      files: ['content.js'],
    });
    expect(result.reachable).toBe(true);
    expect(result.injected).toBe(true);
    // The ping is what re-establishes the vendor, so it survives the reconnect.
    expect(result.ats?.displayName).toBe('iCIMS');
    // Exactly one retry. A second injection would leave two copies of a script
    // that is already not answering.
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('asks for a page reload — not a reinstall — when reinjection is refused', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Cannot access contents of the page.'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await ensureContentScript(9, ICIMS);

    expect(result.reachable).toBe(false);
    expect(result.reason).toBe(RECONNECT_MESSAGE);
    expect(result.reason).toMatch(/Reload this application page/);
    // Never diagnoses the page.
    expect(result.reason).not.toMatch(/form|unsupported|not detected/i);
    warn.mockRestore();
  });

  it('reports a still-silent script as needing a page reload rather than looping', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    const result = await ensureContentScript(11, ICIMS);
    expect(result).toMatchObject({ reachable: false, injected: true, reason: RECONNECT_MESSAGE });
  });

  it('refuses to attempt injection on a page Chrome would never allow it on', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    const result = await ensureContentScript(3, 'chrome://extensions');
    expect(result.reachable).toBe(false);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(isInjectablePage('chrome://extensions')).toBe(false);
    expect(isInjectablePage(ICIMS)).toBe(true);
    expect(isInjectablePage(undefined)).toBe(false);
  });
});
