import {
  navigationIntentFor,
  navigationActivationResultSchema,
  type ActivateNavigationMessage,
  type NavigationActivationResult,
} from '@internship-agent/shared';
import { isFinalSubmitControl, selectAdapter } from '../scanner/adapters.js';

/**
 * Taking a route off a sign-in or choose-how-to-apply page.
 *
 * This is the only code in the extension that clicks something the user did not
 * click, so every guard here is load-bearing:
 *
 * 1. The message cannot express `final_submit` — the schema's intent enum has
 *    three members, all of them routes.
 * 2. The control's own words are re-read from the page and re-classified. A
 *    selector captured during a scan can point at a different control by the
 *    time this runs, on a portal that re-renders; a control whose words no
 *    longer read as the requested route is not clicked.
 * 3. The words are checked against the adapter's final-submit wording as well,
 *    so a control that says "Submit Application" is refused no matter what
 *    intent the caller claimed for it.
 *
 * The three together mean there is no argument to this function that ends an
 * application.
 */

/** How long to wait for the portal to navigate or re-render after the click. */
const SETTLE_TIMEOUT_MS = 8_000;
/** How long the DOM must be quiet before the page counts as settled. */
const QUIET_MS = 400;

function visibleText(element: Element): string {
  const label =
    element.getAttribute('aria-label') ??
    (element instanceof HTMLInputElement ? element.value : null) ??
    element.textContent ??
    '';
  return label.replace(/\s+/g, ' ').trim();
}

function refused(reason: string): NavigationActivationResult {
  return navigationActivationResultSchema.parse({ status: 'refused', reason });
}

/**
 * Resolves once the page has navigated or stopped changing.
 *
 * A portal route is sometimes a real navigation and sometimes a client-side
 * re-render, and the caller needs the same promise for both. Waiting on a
 * mutation observer covers the second; the URL check covers the first; the
 * timeout covers a click that did nothing at all, which must not hang the
 * popup.
 */
function waitForSettle(
  target: Document,
  startUrl: string,
  readUrl: () => string,
): Promise<{ navigated: boolean }> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      observer.disconnect();
      resolve({ navigated: readUrl() !== startUrl });
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, QUIET_MS);
    });
    observer.observe(target.documentElement, { childList: true, subtree: true });
    const hardTimer = setTimeout(finish, SETTLE_TIMEOUT_MS);
    // A click that changes nothing still has to resolve, so the quiet timer
    // starts immediately rather than on the first mutation.
    quietTimer = setTimeout(finish, QUIET_MS);
  });
}

export async function activateNavigation(
  message: ActivateNavigationMessage,
  target: Document = document,
  /**
   * Where the page is. Injected because a jsdom `Document` has a
   * non-configurable `location` of its own, so a test cannot otherwise put the
   * code under test on an employer URL — and the ATS the page belongs to is
   * what decides which control counts as a final Submit.
   */
  readUrl: () => string = () => target.location.href,
): Promise<NavigationActivationResult> {
  let element: Element | null;
  try {
    element = target.querySelector(message.selector);
  } catch {
    return refused('That navigation control could not be located on this page.');
  }
  if (!element) {
    return refused('That navigation control is no longer on this page. Rescan and try again.');
  }

  const words = visibleText(element);
  const actual = navigationIntentFor(words);
  if (actual !== message.intent) {
    // Names the mismatch without quoting the page back at the user, who is
    // looking at it.
    return refused(
      `The control at that position is no longer the ${message.intent.replace(/_/g, ' ')} route. Rescan the page and try again.`,
    );
  }

  const ats = (() => {
    try {
      return selectAdapter({
        url: readUrl(),
        hostname: new URL(readUrl()).hostname,
        title: target.title,
        bodyText: target.body?.textContent?.slice(0, 4000) ?? '',
        document: target,
      }).adapter.id;
    } catch {
      return 'generic' as const;
    }
  })();
  if (isFinalSubmitControl(ats, words)) {
    return refused('That control submits the application. The agent never clicks it.');
  }

  const startUrl = readUrl();
  const settled = waitForSettle(target, startUrl, readUrl);
  (element as HTMLElement).click();
  const { navigated } = await settled;

  return navigationActivationResultSchema.parse({
    status: 'activated',
    intent: message.intent,
    url: readUrl(),
    navigated,
  });
}
