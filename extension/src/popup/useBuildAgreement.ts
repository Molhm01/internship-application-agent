import { useEffect, useState } from 'react';
import { compareBuilds, type BuildAgreement } from '@internship-agent/shared';
import { BUILD_ID } from '../generated/buildInfo.js';

/**
 * Whether the popup and the service worker came from the same build.
 *
 * The content script is checked by the worker itself, at the moment a run is
 * accepted, because only the worker can reach the page. This hook covers the
 * other half — and it is the half the user sees first, because a popup from a
 * different build than the worker cannot even describe the run correctly.
 *
 * Asked once per popup open. There is no polling: neither bundle can change
 * while the popup is on screen without the popup being torn down with it.
 */
export function useBuildAgreement(): BuildAgreement | null {
  const [agreement, setAgreement] = useState<BuildAgreement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Deliberately a raw `sendMessage`: the wrapper in `messaging/messages.ts`
      // reports a silent worker as EXTENSION_RELOAD_REQUIRED, and a worker that
      // does not answer is a different problem from one that answers with a
      // different build. Only the latter is this hook's business.
      //
      // Wrapped in `try` as well as `.catch`, because `sendMessage` throws
      // *synchronously* when the extension context has been invalidated — the
      // state right after an extension reload, which is exactly when a build
      // mismatch is most likely. A rejection handler alone never sees that.
      let response: unknown = null;
      try {
        response = await chrome.runtime.sendMessage({ type: 'WORKER_PING' });
      } catch {
        response = null;
      }
      if (cancelled) return;
      const workerBuild = (response as { buildId?: string } | null)?.buildId;
      // No answer at all means the worker is gone, which the connection status
      // already reports. Claiming a build mismatch on top of that would send the
      // user after the wrong remedy.
      if (workerBuild === undefined) return;
      const result = compareBuilds([
        { component: 'popup', buildId: BUILD_ID },
        { component: 'worker', buildId: workerBuild },
      ]);
      if (!result.agreed) {
        console.warn('[agent] popup and worker are from different builds', {
          popup: BUILD_ID,
          worker: workerBuild,
        });
      }
      setAgreement(result);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return agreement;
}
