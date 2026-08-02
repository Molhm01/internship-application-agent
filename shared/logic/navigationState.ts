import type { DetectedField } from '../schemas/fields.js';

/**
 * What kind of page the applicant is looking at.
 *
 * An application is not one form. Before any question is asked, an ATS may
 * demand a login, offer to create an account, or offer a guest route; after the
 * questions it shows a review page whose only control ends the application.
 * Treating all of those as "a form with fields" is how a login page gets read
 * as an application with one question, which is exactly what happened on Taleo.
 *
 * This module classifies the page and names the routes available on it. It
 * chooses nothing: which route to take is the user's decision, because
 * "create an account" and "apply as guest" have permanently different
 * consequences for them.
 */

export const PAGE_KINDS = [
  'login',
  'account_creation',
  'guest_option',
  'application_form',
  'review',
  'final_submit',
  'confirmation',
  'blocked',
  'unknown',
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

/** A control that moves the applicant somewhere rather than answering a question. */
export const NAVIGATION_INTENTS = [
  'login',
  'create_account',
  'apply_as_guest',
  'continue',
  'back',
  'save_draft',
  'forgot_username',
  'forgot_password',
  'final_submit',
] as const;

export type NavigationIntent = (typeof NAVIGATION_INTENTS)[number];

export interface NavigationAction {
  intent: NavigationIntent;
  /** The control's visible words, as the page wrote them. */
  label: string;
  /** How the executor would reach it. Never produced by a model. */
  selector: string;
  /** True when acting on this would end the application. */
  endsApplication: boolean;
}

export interface NavigationState {
  kind: PageKind;
  actions: NavigationAction[];
  /** Set when the page needs a person: CAPTCHA, MFA, email verification. */
  blockedReason?: string;
  /** True when the page is asking for credentials rather than answers. */
  requiresCredentials: boolean;
}

function normalize(value: string): string {
  return value.replace(/[\s ]+/g, ' ').replace(/[-_+/]+/g, ' ').trim().toLowerCase();
}

/**
 * Ordered most specific first. "create an account" must beat "account", and
 * "submit application" must beat "submit", so the order carries meaning.
 */
const INTENT_RULES: ReadonlyArray<{ intent: NavigationIntent; pattern: RegExp }> = [
  { intent: 'forgot_username', pattern: /\bforgot(ten)?\b.*\buser ?name\b|\buser ?name\b.*\bforgot/ },
  { intent: 'forgot_password', pattern: /\bforgot(ten)?\b.*\bpassword\b|\breset (your )?password\b/ },
  {
    intent: 'final_submit',
    pattern:
      /\b(submit application|submit your application|send application|complete application|finish (and )?submit|submit my application)\b/,
  },
  {
    intent: 'create_account',
    pattern:
      /\bnew user\b|\bcreate (an? )?(new )?(account|profile|login)\b|\bregister\b|\bsign ?up\b|\bfirst time (user|here)\b/,
  },
  {
    intent: 'apply_as_guest',
    pattern: /\b(apply|continue|proceed) as (a )?guest\b|\bguest (application|apply|access)\b|\bwithout (an )?account\b/,
  },
  {
    intent: 'login',
    pattern: /\b(log ?in|sign ?in|login)\b|\breturning (user|applicant)\b|\bexisting (user|account)\b/,
  },
  { intent: 'back', pattern: /\b(back|previous|go back)\b/ },
  { intent: 'save_draft', pattern: /\bsave( as)? draft\b|\bsave (and )?(exit|for later)\b/ },
  { intent: 'continue', pattern: /\b(next|continue|save and continue|proceed|start)\b/ },
];

/** The navigation intent of a control's words, or null when it answers a question. */
export function navigationIntentFor(label: string): NavigationIntent | null {
  const normalized = normalize(label);
  if (!normalized) return null;
  return INTENT_RULES.find((rule) => rule.pattern.test(normalized))?.intent ?? null;
}

/** True when acting on this control would end the application. */
export function endsApplication(intent: NavigationIntent): boolean {
  return intent === 'final_submit';
}

const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|i'?m not a robot|verify you are human)\b/i;
const MFA =
  /\b(verification code|two[- ]factor|2fa|authenticator|one[- ]time (code|password)|multi[- ]factor|security code)\b/i;
const EMAIL_VERIFICATION =
  /\b(verify your email|check your (email|inbox)|confirmation (email|link)|we sent you an email|activate your account)\b/i;

export interface PageSignals {
  url: string;
  title: string;
  /** Visible text, already truncated by the caller. */
  bodyText: string;
  fields: readonly DetectedField[];
  /** Every clickable control's visible words plus a selector for it. */
  controls: ReadonlyArray<{ label: string; selector: string }>;
}

/** True when a field is asking for the account password rather than a question. */
export function isPasswordField(field: DetectedField): boolean {
  if (field.fieldType !== 'password') return false;
  return true;
}

/** True when a field is asking for an account username. */
export function isUsernameField(field: DetectedField): boolean {
  const metadata = field.metadata;
  const haystack = normalize(
    [
      field.label,
      field.question,
      typeof metadata.name === 'string' ? metadata.name : '',
      typeof metadata.elementId === 'string' ? metadata.elementId : '',
      typeof metadata.autocomplete === 'string' ? metadata.autocomplete : '',
    ].join(' '),
  );
  return /\buser ?name\b|\buser id\b|\blogin( id| name)?\b|\baccount name\b/.test(haystack);
}

/** True when a field is confirming a password the applicant just chose. */
export function isPasswordConfirmationField(field: DetectedField): boolean {
  if (field.fieldType !== 'password') return false;
  const metadata = field.metadata;
  const haystack = normalize(
    [
      field.label,
      field.question,
      typeof metadata.name === 'string' ? metadata.name : '',
      typeof metadata.elementId === 'string' ? metadata.elementId : '',
    ].join(' '),
  );
  return /\b(confirm|re ?enter|repeat|verify|again)\b/.test(haystack);
}

/**
 * Classifies the page and lists the routes off it.
 *
 * A blocked page wins over everything: a CAPTCHA on a login page is still a
 * CAPTCHA, and no amount of correctly-identified username fields makes it
 * something the agent may proceed through.
 */
export function classifyPage(signals: PageSignals): NavigationState {
  const haystack = `${signals.title} ${signals.bodyText}`;
  const actions: NavigationAction[] = signals.controls.flatMap((control) => {
    const intent = navigationIntentFor(control.label);
    if (!intent) return [];
    return [
      {
        intent,
        label: control.label.trim(),
        selector: control.selector,
        endsApplication: endsApplication(intent),
      },
    ];
  });

  const blocked =
    (CAPTCHA.test(haystack) && 'This page has a CAPTCHA. Solve it yourself, then continue.') ||
    (MFA.test(haystack) &&
      'This page is asking for a verification code. Enter it yourself, then continue.') ||
    (EMAIL_VERIFICATION.test(haystack) &&
      'This step needs an email confirmation. Complete it in your inbox, then continue.');

  const passwordFields = signals.fields.filter(isPasswordField);
  const hasPassword = passwordFields.length > 0;
  const hasUsername = signals.fields.some(isUsernameField);
  const confirming = passwordFields.some(isPasswordConfirmationField);
  const answerable = signals.fields.filter(
    (field) => field.visible && !field.disabled && !isPasswordField(field) && !isUsernameField(field),
  );

  if (blocked) {
    return { kind: 'blocked', actions, blockedReason: blocked, requiresCredentials: hasPassword };
  }

  // Two password boxes, or one plus a create-account route, is registration.
  // One password box beside a login control is a returning-user login.
  const kind: PageKind = (() => {
    if (confirming || (hasPassword && passwordFields.length > 1)) return 'account_creation';
    if (hasPassword) {
      const creating = actions.some((action) => action.intent === 'create_account');
      const loggingIn = actions.some((action) => action.intent === 'login');
      if (loggingIn || !creating) return 'login';
      return 'account_creation';
    }
    if (actions.some((action) => action.intent === 'final_submit') && answerable.length === 0) {
      return 'final_submit';
    }
    if (answerable.length > 0) return 'application_form';
    if (actions.some((action) => action.intent === 'apply_as_guest')) return 'guest_option';
    if (actions.some((action) => action.intent === 'create_account')) return 'account_creation';
    if (/\b(thank you|application (received|submitted)|we have received)\b/i.test(haystack)) {
      return 'confirmation';
    }
    if (actions.some((action) => action.intent === 'continue')) return 'review';
    return 'unknown';
  })();

  return {
    kind,
    actions,
    requiresCredentials: hasPassword || (hasUsername && kind === 'login'),
  };
}

/** How the popup describes a page to the user, in their terms. */
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  login: 'Sign-in page',
  account_creation: 'Account creation',
  guest_option: 'Choose how to apply',
  application_form: 'Application form',
  review: 'Review step',
  final_submit: 'Final submission page',
  confirmation: 'Confirmation page',
  blocked: 'Needs you',
  unknown: 'Unrecognized page',
};
