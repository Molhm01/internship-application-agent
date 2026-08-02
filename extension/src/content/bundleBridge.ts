import {
  BUNDLE_BRIDGE,
  applicationBundleTransferSchema,
  bundleOfferMessageSchema,
  bundleProbeMessageSchema,
  bundleResultMessageSchema,
  type BundleResultMessage,
} from '@internship-agent/shared';

/**
 * The website → extension handoff.
 *
 * Internship Pilot posts an application bundle on the page; this content script
 * validates it and passes it to the background worker, which owns storage. The
 * website then waits for the acknowledgement before opening the employer page.
 *
 * Deliberately *not* used: an ApplicationSession row, a shared auth token, a
 * URL fragment, or the local agent server. Nothing here requires the agent
 * server to be running, and no document content ever appears in a URL.
 *
 * Trust boundary: a page can post anything, so a message is accepted only when
 * it came from this window, on an allowed origin, and passes schema validation.
 * The extension never executes anything the page sends — a bundle is data.
 */

/** Origins allowed to hand a bundle to the extension. */
export function isAllowedBridgeOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') {
      return /(^|\.)internship-pilot\.app$/i.test(url.hostname);
    }
    // The website runs locally during development and in the test lab. Loopback
    // only — a LAN address is somebody else's machine.
    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

function post(message: BundleResultMessage): void {
  window.postMessage(bundleResultMessageSchema.parse(message), window.location.origin);
}

/**
 * Starts listening. Returns a stop function so tests can tear it down; the
 * content script itself never stops.
 */
export function startBundleBridge(): () => void {
  const listener = (event: MessageEvent): void => {
    // A message from another frame or another origin is not this page talking
    // to its own extension.
    if (event.source !== window) return;
    if (!isAllowedBridgeOrigin(event.origin)) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null || !('channel' in data)) return;

    const probe = bundleProbeMessageSchema.safeParse(data);
    if (probe.success) {
      window.postMessage(
        { channel: BUNDLE_BRIDGE.probeAck, requestId: probe.data.requestId },
        window.location.origin,
      );
      return;
    }

    const offer = bundleOfferMessageSchema.safeParse(data);
    if (!offer.success) {
      if ((data as { channel?: unknown }).channel !== BUNDLE_BRIDGE.offer) return;
      const candidate = data as Record<string, unknown>;
      const requestId = typeof candidate.requestId === 'string' ? candidate.requestId : 'unknown';
      post({
        channel: BUNDLE_BRIDGE.result,
        requestId,
        result: {
          ok: false,
          reason: `The application bundle failed validation: ${offer.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        },
      });
      return;
    }

    void (async () => {
      try {
        // Parsed a second time so what crosses into the worker is the schema's
        // output, with unknown keys stripped, rather than the page's object.
        const bundle = applicationBundleTransferSchema.parse(offer.data.bundle);
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'SAVE_APPLICATION_BUNDLE',
          bundle,
        });
        const parsed = bundleResultMessageSchema.shape.result.safeParse(
          (response as { result?: unknown } | undefined)?.result,
        );
        post({
          channel: BUNDLE_BRIDGE.result,
          requestId: offer.data.requestId,
          result: parsed.success
            ? parsed.data
            : {
                ok: false,
                reason:
                  'The extension did not confirm the bundle was saved. Reload the extension and try again.',
              },
        });
      } catch (cause) {
        post({
          channel: BUNDLE_BRIDGE.result,
          requestId: offer.data.requestId,
          result: {
            ok: false,
            reason: `The extension could not store the bundle: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          },
        });
      }
    })();
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
