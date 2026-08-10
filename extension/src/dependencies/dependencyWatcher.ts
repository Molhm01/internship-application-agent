import { fingerprintChanged, type ControlFingerprint } from '@internship-agent/shared';
import { fingerprintControl, watchTargetFor } from './dependencyDetector.js';

/**
 * Waiting for the page to finish reacting to an answer.
 *
 * Bounded by an *observation*, never by a clock. The run this replaces bridged
 * Country → State with a fixed 350ms sleep, which is both far too long for a
 * page that repopulates instantly and far too short for one that fetches its
 * region list — and the second case is the reported failure: State was rescanned
 * before its options existed, matched nothing, and stayed blank.
 *
 * ## Every observer is disconnected
 *
 * On success, on timeout, and on a caller that abandons the wait. There is
 * exactly one `finish`, it is idempotent, and it is the only path out — so a
 * page with forty dependent controls cannot end a run holding forty live
 * observers. That is checkable: `activeWatcherCount()` is exported for the test
 * that asserts it returns to zero.
 */

/** The ordinary ceiling. Long enough for a region list, short enough to feel instant. */
export const MUTATION_TIMEOUT_MS = 2000;
/** One bounded retry, for an ATS that rebuilds a control twice. */
export const MUTATION_RETRY_MS = 1500;
/** A safety net under the observer, for a page that mutates outside the subtree. */
const POLL_MS = 60;

let active = 0;

/** How many observers this module currently holds. Must be zero between runs. */
export function activeWatcherCount(): number {
  return active;
}

/**
 * True when a control has finished changing and can actually be answered.
 *
 * "Changed" is not "ready". A form rebuilding a region list disables the
 * control, empties it, and repopulates it a beat later — and a form that
 * answers one parent by queueing *two* rebuilds (one clearing the child, one
 * filling it) passes through a state where the control is enabled, changed, and
 * holding nothing but its own prompt. Ending the wait there hands the executor
 * an empty list, which is the same stale-read failure this watcher exists to
 * prevent, arrived at from the other side. It was observed doing exactly that
 * on the Education State → School link.
 *
 * A control with no options at all — a text box revealed by a Yes — is settled
 * as soon as it is present and enabled, because there is no list to wait for.
 */
function isSettled(fingerprint: ControlFingerprint): boolean {
  if (!fingerprint.present) return false;
  if (fingerprint.disabled) return false;
  if (fingerprint.optionCount === 0) return true;
  return fingerprint.usableOptionCount > 0;
}

export interface WatchOutcome {
  mutationObserved: boolean;
  fingerprint: ControlFingerprint;
  waitedMs: number;
}

/**
 * Resolves when this control's fingerprint differs from `before`, or at the
 * deadline.
 *
 * The observer watches the control's *container* rather than the control,
 * because a framework repopulating a select routinely replaces the element —
 * and an observer bound to the old element would be watching a node that is no
 * longer in the document. A poll runs underneath at a low rate, because a page
 * that swaps a whole section can move the container too.
 */
export function awaitControlChange(
  document: Document,
  selector: string,
  before: ControlFingerprint,
  timeoutMs: number = MUTATION_TIMEOUT_MS,
): Promise<WatchOutcome> {
  const started = Date.now();

  const read = (): ControlFingerprint => fingerprintControl(document, selector);
  const immediate = read();
  // Settled already, and usable. A control that is mid-rebuild right now falls
  // through to the observer below rather than being handed over disabled.
  if (fingerprintChanged(before, immediate) && isSettled(immediate)) {
    return Promise.resolve({
      mutationObserved: true,
      fingerprint: immediate,
      waitedMs: Date.now() - started,
    });
  }

  return new Promise((resolve) => {
    let done = false;
    active += 1;

    const finish = (mutationObserved: boolean, fingerprint: ControlFingerprint): void => {
      if (done) return;
      done = true;
      active -= 1;
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearInterval(poller);
      resolve({ mutationObserved, fingerprint, waitedMs: Date.now() - started });
    };

    const check = (): void => {
      const now = read();
      if (!fingerprintChanged(before, now)) return;
      // Changed, but not necessarily *finished* changing.
      //
      // A form rebuilding a region list routinely disables the control first,
      // empties it, and repopulates it a beat later. Every one of those is a
      // fingerprint change, and resolving on the first one hands the executor a
      // control that is disabled and empty — which is the same stale-read
      // failure this watcher exists to prevent, just arrived at from the other
      // direction. So a control mid-rebuild is not settled: it has to be usable
      // again before the wait ends, and the timeout below is what stops a page
      // that never finishes from blocking the run.
      if (!isSettled(now)) return;
      finish(true, now);
    };

    const observer = new MutationObserver(check);
    observer.observe(watchTargetFor(document, selector), {
      childList: true,
      subtree: true,
      // Attributes matter here in a way they did not for a pure option-presence
      // wait: `disabled` and `aria-disabled` coming off a control is exactly the
      // change a CONTROL_ENABLE dependency is waiting for, and it is an
      // attribute mutation with no child list change at all.
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-expanded', 'hidden'],
    });

    const poller = window.setInterval(check, POLL_MS);
    const timer = window.setTimeout(() => finish(false, read()), timeoutMs);
  });
}

/**
 * The same wait, with one bounded retry.
 *
 * A retry rather than a longer timeout: a control that has not moved in two
 * seconds is usually never going to, and the cases that do need longer are ATS
 * widgets that rebuild once and then rebuild again. Total worst case is
 * `MUTATION_TIMEOUT_MS + MUTATION_RETRY_MS`, and it is bounded whatever the page
 * does.
 */
export async function awaitControlChangeWithRetry(
  document: Document,
  selector: string,
  before: ControlFingerprint,
): Promise<WatchOutcome> {
  const first = await awaitControlChange(document, selector, before, MUTATION_TIMEOUT_MS);
  if (first.mutationObserved) return first;
  const second = await awaitControlChange(document, selector, before, MUTATION_RETRY_MS);
  return { ...second, waitedMs: first.waitedMs + second.waitedMs };
}
