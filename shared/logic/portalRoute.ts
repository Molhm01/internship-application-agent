import type { PortalStrategy } from '../schemas/employerAccounts.js';
import type { NavigationAction, NavigationState } from './navigationState.js';

/**
 * Which route to take off an employer sign-in or choose-how-to-apply page.
 *
 * `classifyPage` says what the page is and what routes lead off it. This module
 * decides which one to take, from a preference the user set once in advance
 * rather than from a prompt on every portal.
 *
 * The decision is deterministic and readable: no model is consulted, and the
 * only inputs are the user's saved strategy and the routes the page itself
 * offers. That matters because the choice is durable — an account on an
 * employer's system is a real record under the user's name — so it must be
 * traceable to something they actually chose.
 *
 * What no strategy can authorize:
 *
 * - Acting on a blocked page. A CAPTCHA, an MFA prompt, or an email
 *   verification is a person's job, and a saved preference is not consent to
 *   guess at one.
 * - Clicking a control that ends the application. `endsApplication` routes are
 *   filtered out before anything is considered, so no reachable code path here
 *   can return a final Submit.
 */

/** The routes this module will ever choose between. */
export const PORTAL_ROUTE_INTENTS = ['apply_as_guest', 'create_account', 'login'] as const;

export type PortalRouteIntent = (typeof PORTAL_ROUTE_INTENTS)[number];

/** How the popup names each route, in the user's words rather than the ATS's. */
export const PORTAL_ROUTE_LABELS: Record<PortalRouteIntent, string> = {
  create_account: 'Create employer account',
  apply_as_guest: 'Apply as guest',
  login: 'I already have an account',
};

/** How the options page names each strategy. */
export const PORTAL_STRATEGY_LABELS: Record<PortalStrategy, string> = {
  prefer_guest: 'Prefer guest application',
  create_when_required: 'Create an account when required',
  use_existing_account: 'I already have an account',
  always_ask: 'Ask every time',
};

export type PortalRouteDecision =
  /** Take this route. The caller may click it without asking. */
  | { decision: 'act'; action: PortalRouteAction; reason: string }
  /** Show these routes and let the user pick. */
  | { decision: 'ask'; options: PortalRouteAction[]; reason: string }
  /** The page needs a person before any route can be taken. */
  | { decision: 'blocked'; reason: string }
  /** Nothing here is a route. Not a failure — most pages are not sign-in pages. */
  | { decision: 'none'; reason: string };

/**
 * A navigation action already proven to be a route.
 *
 * The narrowed `intent` is what stops a `final_submit` action from being
 * assignable to anything downstream that clicks — the compiler rejects it
 * rather than a runtime check having to catch it.
 */
export type PortalRouteAction = NavigationAction & { intent: PortalRouteIntent };

function isRoute(action: NavigationAction): action is PortalRouteAction {
  return (
    !action.endsApplication && (PORTAL_ROUTE_INTENTS as readonly string[]).includes(action.intent)
  );
}

/**
 * The routes on this page, deduplicated by intent.
 *
 * A portal often renders the same route twice — a header link and a body button
 * — and offering the user "Apply as guest" twice makes the choice look like
 * four options when it is three.
 */
export function portalRoutes(navigation: NavigationState): PortalRouteAction[] {
  const seen = new Set<PortalRouteIntent>();
  return navigation.actions.flatMap((action) => {
    if (!isRoute(action) || seen.has(action.intent)) return [];
    seen.add(action.intent);
    return [action];
  });
}

/**
 * The user's saved preference, applied to what this page actually offers.
 *
 * `always_ask` and an unset strategy are the same decision — ask — but they are
 * different states, and the caller may want to say so. An unset strategy is
 * reported with a reason naming the setting, so the popup can point at it.
 */
export function selectPortalRoute(
  navigation: NavigationState,
  strategy: PortalStrategy | undefined,
): PortalRouteDecision {
  // Ordered first deliberately. A page can offer a perfectly good guest route
  // *and* sit behind a CAPTCHA; taking the route would leave the run stuck on a
  // challenge with no one watching.
  if (navigation.blockedReason) {
    return { decision: 'blocked', reason: navigation.blockedReason };
  }

  const routes = portalRoutes(navigation);
  if (routes.length === 0) {
    return { decision: 'none', reason: 'This page offers no sign-in, guest, or sign-up route.' };
  }

  const find = (intent: PortalRouteIntent): PortalRouteAction | undefined =>
    routes.find((route) => route.intent === intent);
  const guest = find('apply_as_guest');
  const create = find('create_account');
  const login = find('login');

  const act = (action: PortalRouteAction, reason: string): PortalRouteDecision => ({
    decision: 'act',
    action,
    reason,
  });
  const ask = (reason: string): PortalRouteDecision => ({
    decision: 'ask',
    options: routes,
    reason,
  });

  switch (strategy) {
    case 'prefer_guest':
      if (guest) return act(guest, 'You asked to apply as a guest whenever that is possible.');
      if (create) {
        return act(
          create,
          'You asked to prefer applying as a guest, and this portal offers no guest route, so an account is required here.',
        );
      }
      return ask(
        'You asked to prefer applying as a guest, but this page offers neither a guest route nor a way to register.',
      );

    case 'create_when_required':
      // Literal reading of the setting: when the user has chosen to have
      // accounts created, the account route is the one taken. The guest route is
      // the fallback only when the portal offers no way to register.
      if (create)
        return act(create, 'You asked the agent to create an employer account when one is needed.');
      if (guest) {
        return act(
          guest,
          'You asked the agent to create an account when one is needed. This portal offers no way to register, so it is continuing as a guest.',
        );
      }
      return ask(
        'You asked the agent to create an account when needed, but this page offers neither route.',
      );

    case 'use_existing_account':
      if (login) return act(login, 'You said you already have an account on employer portals.');
      return ask('You said you already have an account, but this page offers no sign-in route.');

    case 'always_ask':
      return ask('You asked to be shown the choice on every employer portal.');

    default:
      return ask(
        'No employer portal strategy is saved yet. Choose one here, or set a default in the extension’s options.',
      );
  }
}
