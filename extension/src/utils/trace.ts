/**
 * Stage tracing for the flows that cross an extension boundary.
 *
 * These paths span three JavaScript realms (page → service worker → server), so
 * a failure in the middle is invisible without a breadcrumb per stage. Written at
 * `console.debug`, which Chrome hides behind the "Verbose" log level, so it costs
 * nothing in normal use but is there the moment something hangs.
 *
 * Open DevTools on the options page (or the service worker at
 * chrome://extensions → "service worker") and enable Verbose to read it.
 */
const PREFIX = '[agent]';

export function trace(scope: string, stage: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) {
    console.debug(`${PREFIX} ${scope}: ${stage}`);
    return;
  }
  console.debug(`${PREFIX} ${scope}: ${stage}`, detail);
}

/** Traces a failure at `warn`, because a stuck flow must be visible by default. */
export function traceFailure(scope: string, stage: string, detail: Record<string, unknown>): void {
  console.warn(`${PREFIX} ${scope}: ${stage}`, detail);
}
