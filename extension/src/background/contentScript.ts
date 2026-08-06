import { RECONNECT_MESSAGE } from '@internship-agent/shared';
import type { ContentPingResult } from '../messaging/messages.js';

/**
 * Keeping the content script reachable.
 *
 * A content script declared in the manifest is injected at page load and never
 * again. Reloading the extension tears down every injected instance, so every
 * tab that was already open keeps its page but loses its script — and the
 * popup's message to it fails with "Receiving end does not exist". The user did
 * nothing wrong and the page is perfectly fine, but the extension used to
 * report this as though the page had no application form on it, which sent
 * people off reinstalling the extension to fix a problem a refresh would clear.
 *
 * `chrome.scripting.executeScript` puts the script back without a reload,
 * provided the manifest grants host permission for that page. That is the whole
 * remedy: ping, inject, ping again, and only then admit failure — with a
 * sentence that names the actual fix.
 *
 * Injection is not always possible and the failure is not always ours: Chrome
 * refuses to inject into its own pages, the Web Store, PDF viewers, and any
 * origin the manifest does not cover. Those are reported as needing a reload
 * rather than retried, because retrying cannot succeed.
 */

export interface ContentScriptConnection {
  reachable: boolean;
  /** True when the script had to be put back, i.e. the tab predates this build. */
  injected: boolean;
  /** Present only when `reachable` is false. Always the user-facing sentence. */
  reason?: string;
  /** The ATS the page reported on the successful ping, when it named one. */
  ats?: ContentPingResult['ats'];
  /**
   * The build the page's content script came from. Absent when the script
   * predates build stamping, which is itself a mismatch.
   */
  buildId?: string;
}

/** A page the browser will never let a content script run on. */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

async function ping(tabId: number): Promise<ContentPingResult | null> {
  try {
    // Addressed to the main frame, not broadcast. Now that the script runs in
    // every frame, an unaddressed `sendMessage` resolves with whichever frame
    // answers first — which could be an advertising iframe, and its answer would
    // be taken as the page's own.
    const response: unknown = await chrome.tabs.sendMessage(
      tabId,
      { type: 'CONTENT_PING' },
      { frameId: 0 },
    );
    if (!response || typeof response !== 'object') return null;
    return response as ContentPingResult;
  } catch {
    // The only failure that reaches here is "no receiving end", which is the
    // condition this module exists to repair. It is not logged: it is expected
    // on the first ping after every extension reload.
    return null;
  }
}

/**
 * Guarantees a reachable content script in `tabId`, or explains why not.
 *
 * Exactly one reinjection is attempted. A second would not help — if the script
 * loaded but did not register its listener, doing it again produces two copies
 * of a script that still does not answer.
 */
export async function ensureContentScript(
  tabId: number,
  url?: string,
): Promise<ContentScriptConnection> {
  const first = await ping(tabId);
  if (first) {
    return {
      reachable: true,
      injected: false,
      ...(first.ats ? { ats: first.ats } : {}),
      ...(first.buildId ? { buildId: first.buildId } : {}),
    };
  }

  if (!isInjectablePage(url)) {
    return {
      reachable: false,
      injected: false,
      reason: 'The extension only works on http and https pages.',
    };
  }

  try {
    await chrome.scripting.executeScript({
      // Every frame, because the application form is routinely not in the main
      // document. Re-injecting a frame that already has the script is harmless:
      // the script guards against loading twice.
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (cause) {
    // Almost always a missing host permission or a restricted origin. Either
    // way the user's move is the same, so they get one instruction rather than
    // a Chrome error string.
    console.warn('[agent] content script reinjection refused', {
      tabId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return { reachable: false, injected: false, reason: RECONNECT_MESSAGE };
  }

  const second = await ping(tabId);
  if (second) {
    console.info('[agent] content script reinjected', { tabId });
    return {
      reachable: true,
      injected: true,
      ...(second.ats ? { ats: second.ats } : {}),
      ...(second.buildId ? { buildId: second.buildId } : {}),
    };
  }
  return { reachable: false, injected: true, reason: RECONNECT_MESSAGE };
}
