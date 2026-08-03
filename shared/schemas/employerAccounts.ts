import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';

/**
 * Whether the agent may create an account on an employer's site, and how.
 *
 * Creating an account is not a form fill. It leaves a durable record on someone
 * else's system under the user's name and email, it usually cannot be undone
 * from the applicant side, and it commits them to whatever terms the page
 * stated. So the switch is off by default and turning it on takes one explicit
 * confirmation that this schema can prove happened.
 */

/**
 * The four routes a user can pre-authorize off an employer sign-in page.
 *
 * Declared once, here. `applicationBundleSchema` used to spell the same list out
 * a second time, so a strategy added in one place was silently rejected by the
 * other — the same duplicate-enum fault that made the scanner and its validator
 * disagree about field types.
 */
export const PORTAL_STRATEGIES = [
  /** Take the guest route whenever the site offers one. */
  'prefer_guest',
  /** Create an account, but only when there is no way past without one. */
  'create_when_required',
  /** Sign in to an account the user already has on this employer's portal. */
  'use_existing_account',
  /** Stop and ask on every portal. */
  'always_ask',
] as const;

export const portalStrategySchema = z.enum(PORTAL_STRATEGIES);

export type PortalStrategy = z.infer<typeof portalStrategySchema>;

/**
 * The wording the user has to agree to.
 *
 * Stored alongside the acknowledgement so a later build that changes the terms
 * can tell that the user agreed to the *old* ones and ask again, rather than
 * treating a stale yes as consent to something they never read.
 */
export const ACCOUNT_CREATION_DISCLOSURE_VERSION = 1;

export const ACCOUNT_CREATION_DISCLOSURE = [
  'The agent will create accounts on employer application sites for you.',
  'It uses the application email on your Internship Pilot profile, a username from your saved preference, and a password it generates for that site alone.',
  'The password is encrypted in this extension and is never sent to Internship Pilot, never written to a log, and never shown to the AI model.',
  'An account on an employer site is a real record under your name that you may not be able to delete yourself.',
  'The agent still stops for a CAPTCHA, a verification code, or an email confirmation, and it never submits an application.',
].join(' ');

export const employerAccountSettingsSchema = z.object({
  /**
   * The master switch. Default off, and there is deliberately no way to turn it
   * on except by also recording the acknowledgement below.
   */
  autoCreateEnabled: z.boolean().default(false),
  /** When the user confirmed, and to which wording. Absent means they never did. */
  acknowledgedAt: isoDateTimeSchema.optional(),
  acknowledgedDisclosureVersion: z.number().int().positive().optional(),
  /** Overrides the profile's strategy when set here. */
  portalStrategy: portalStrategySchema.optional(),
  /**
   * Save the generated password to the extension's encrypted vault. Off means
   * the browser's own password manager is expected to catch it instead.
   */
  saveToVault: z.boolean().default(true),
});

export type EmployerAccountSettings = z.infer<typeof employerAccountSettingsSchema>;

/**
 * Whether the agent may create an account right now.
 *
 * Both halves are required: the switch being on is not enough if the
 * acknowledgement is missing or was given for older wording. That makes a
 * hand-edited `chrome.storage` entry insufficient to unlock the behaviour.
 */
export function mayCreateAccountsAutomatically(settings: EmployerAccountSettings): boolean {
  return (
    settings.autoCreateEnabled === true &&
    typeof settings.acknowledgedAt === 'string' &&
    settings.acknowledgedDisclosureVersion === ACCOUNT_CREATION_DISCLOSURE_VERSION
  );
}

/** Why the agent will not create an account, in the user's words, or null. */
export function accountCreationBlockedReason(settings: EmployerAccountSettings): string | null {
  if (mayCreateAccountsAutomatically(settings)) return null;
  if (!settings.autoCreateEnabled) {
    return 'Automatic employer account creation is off. Turn it on in the extension’s options to let the agent register for you.';
  }
  return 'The terms for automatic account creation have changed. Review and confirm them again in the extension’s options.';
}
