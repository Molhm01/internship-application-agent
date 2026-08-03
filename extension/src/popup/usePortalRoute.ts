import { useCallback, useEffect, useState } from 'react';
import type { PortalRouteResponse } from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';

/**
 * What the agent will do about this portal's sign-in page, and doing it.
 *
 * The decision is asked for as soon as a scan exists, without side effects, so
 * the popup can show the user what is about to happen before it happens. Taking
 * the route is a separate call — the one the user's saved strategy authorizes
 * in advance, or that they trigger by clicking one of the offered choices.
 */

export interface PortalRouteState {
  route: PortalRouteResponse | null;
  /** True while a route is being taken and the page rescanned. */
  following: boolean;
  follow: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePortalRoute(
  tabUrl: string | null,
  /** Re-asked whenever this changes, so a route hop re-evaluates the new page. */
  scanNonce: unknown,
  onNavigated: () => void,
): PortalRouteState {
  const [route, setRoute] = useState<PortalRouteResponse | null>(null);
  const [following, setFollowing] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!tabUrl?.startsWith('http')) {
      setRoute(null);
      return;
    }
    setRoute(await sendMessage({ type: 'GET_PORTAL_ROUTE', targetUrl: tabUrl }));
  }, [tabUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh, scanNonce]);

  const follow = useCallback(async (): Promise<void> => {
    if (!tabUrl) return;
    setFollowing(true);
    try {
      const result = await sendMessage({ type: 'FOLLOW_PORTAL_ROUTE', targetUrl: tabUrl });
      setRoute(result);
      // The page moved, so the scan, the bundle lookup and the field list all
      // belong to a different page now.
      if ('decision' in result && result.decision === 'act') onNavigated();
    } finally {
      setFollowing(false);
    }
  }, [onNavigated, tabUrl]);

  return { route, following, follow, refresh };
}
