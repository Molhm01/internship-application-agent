import { z } from 'zod';
import { NAVIGATION_INTENTS } from '../logic/navigationState.js';
import { PORTAL_ROUTE_INTENTS } from '../logic/portalRoute.js';
import { agentErrorSchema } from './error.js';

/**
 * Clicking a route control, as a validated contract.
 *
 * The one control the agent must never activate is the final Submit, so the
 * message that carries an intent cannot even express it: `routeIntentSchema`
 * is the three-member route list, not the full navigation-intent enum. A
 * malformed or hostile message asking for `final_submit` fails schema
 * validation at the boundary rather than relying on a check further in.
 */

export const routeIntentSchema = z.enum(PORTAL_ROUTE_INTENTS);

export const activateNavigationMessageSchema = z.object({
  type: z.literal('ACTIVATE_NAVIGATION'),
  intent: routeIntentSchema,
  /** A CSS selector produced by the scanner. Never by a model. */
  selector: z.string().min(1).max(500),
  /**
   * The words the scanner saw on the control. Re-checked in the page before the
   * click, so a control that changed identity since the scan is not activated.
   */
  expectedLabel: z.string().max(300).optional(),
});

export type ActivateNavigationMessage = z.infer<typeof activateNavigationMessageSchema>;

export const navigationActivationResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('activated'),
    intent: routeIntentSchema,
    /** Where the page ended up. Same value as before when it re-rendered in place. */
    url: z.string().url(),
    /** True when the URL changed rather than the DOM being replaced under it. */
    navigated: z.boolean(),
  }),
  z.object({
    status: z.literal('refused'),
    reason: z.string().min(1).max(500),
  }),
]);

export type NavigationActivationResult = z.infer<typeof navigationActivationResultSchema>;

/** What the background reports back after deciding, and possibly taking, a route. */
export const portalRouteResponseSchema = z.union([
  z.object({
    decision: z.enum(['act', 'ask', 'blocked', 'none']),
    reason: z.string(),
    /** The route taken, when one was. */
    takenIntent: routeIntentSchema.optional(),
    /** The routes to offer, when the decision is to ask. */
    options: z
      .array(
        z.object({
          intent: z.enum(NAVIGATION_INTENTS),
          label: z.string(),
          selector: z.string(),
          endsApplication: z.boolean(),
        }),
      )
      .optional(),
    /** Present when a route was taken and the page was rescanned afterwards. */
    url: z.string().url().optional(),
  }),
  z.object({ error: agentErrorSchema }),
]);

export type PortalRouteResponse = z.infer<typeof portalRouteResponseSchema>;
