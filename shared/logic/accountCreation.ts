import type { DetectedField } from '../schemas/fields.js';
import type { Profile } from '../schemas/profile.js';
import type {
  AccountPreferences,
  PolicyAcknowledgementMode,
} from '../schemas/applicationBundle.js';
import {
  isPasswordConfirmationField,
  isPasswordField,
  isUsernameField,
  type NavigationState,
} from './navigationState.js';
import { detectPasswordPolicy, describePolicy, type PasswordPolicy } from './passwordPolicy.js';

/**
 * Planning an employer-portal registration.
 *
 * This module decides *what* to put in a registration form. It is deliberately
 * pure and deliberately deterministic — no model is consulted, and no value
 * here is invented. Every filled value traces to the profile, to a preference
 * the user set, or to the CSPRNG in the case of the password.
 *
 * The password is the reason the shape is what it is. A plan carries a
 * `secretRef` — a symbolic marker naming *which* secret goes in a field — and
 * never the secret itself. The executor resolves those markers immediately
 * before typing, so a plan can be logged, serialized, shown in the UI, or
 * handed to a test without a password ever being present to leak.
 */

/** What goes in a field, without saying what the secret is. */
export type AccountFieldValue =
  | { kind: 'literal'; value: string }
  | { kind: 'secret'; secretRef: 'generated_password' | 'stored_password' };

export interface AccountFieldPlan {
  fieldId: string;
  selector: string;
  label: string;
  value: AccountFieldValue;
  /** Why this value, in words, for the review panel. */
  reason: string;
}

export type AccountPlanOutcome =
  | { status: 'ready'; plan: AccountPlan }
  | { status: 'blocked'; reason: string }
  | { status: 'needs_user'; reason: string; missing: string[] };

export interface AccountPlan {
  origin: string;
  /** The address the account is registered under. */
  email: string;
  username?: string;
  policy: PasswordPolicy;
  policyDescription: string;
  fields: AccountFieldPlan[];
  /** Required fields on the page this plan cannot answer. */
  unresolvedRequired: string[];
  /** Consent controls found, and whether each may be ticked. */
  consents: ConsentDecision[];
}

export interface ConsentDecision {
  fieldId: string;
  selector: string;
  label: string;
  kind: 'terms' | 'marketing' | 'unknown';
  /** True only when ticking it is required to register, or the user opted in. */
  check: boolean;
  reason: string;
}

const MARKETING =
  /\b(marketing|promotional|promotions|newsletter|offers|updates about|subscribe|text messages?|sms|email me|keep me informed|third[- ]part(y|ies))\b/i;
const TERMS =
  /\b(terms|conditions|privacy|policy|agreement|consent to (the )?(processing|use)|i agree|acknowledge|gdpr|data protection)\b/i;

/**
 * Classifies a consent checkbox.
 *
 * Marketing is checked first and wins: an ATS routinely writes "I agree to the
 * terms and to receive marketing updates" as one label, and reading that as
 * plain terms would opt the user into marketing they never asked for. When the
 * two are genuinely combined the safe reading is the one that does not consent.
 */
export function classifyConsent(label: string): ConsentDecision['kind'] {
  if (MARKETING.test(label)) return 'marketing';
  if (TERMS.test(label)) return 'terms';
  return 'unknown';
}

function isConsentField(field: DetectedField): boolean {
  return field.fieldType === 'checkbox';
}

/** A username from the saved preference, or from the email's local part. */
export function usernameFor(
  preferences: AccountPreferences | undefined,
  email: string,
): string | undefined {
  const preferred = preferences?.preferredUsername?.trim();
  if (preferred) return preferred;
  // The local part of the application email is the user's own choice of
  // identifier, so it is a derivation rather than an invention. Anything
  // stranger — appending digits, adding the employer's name — would be the
  // agent making up an identity, so it is not done.
  const local = email.split('@')[0]?.trim();
  return local && local.length >= 3 ? local : undefined;
}

/** Semantic fills a registration form asks for that the profile can answer. */
const PROFILE_FIELD_RULES: ReadonlyArray<{
  test: RegExp;
  read: (profile: Profile) => string | undefined;
  reason: string;
}> = [
  {
    test: /\b(first|given|fore)\s*name\b/i,
    read: (profile) => profile.personal.legalFirstName,
    reason: 'Legal first name from your profile',
  },
  {
    test: /\b(last|family|sur)\s*name\b/i,
    read: (profile) => profile.personal.legalLastName,
    reason: 'Legal last name from your profile',
  },
  {
    test: /\bmiddle\s*(name|initial)\b/i,
    read: (profile) => profile.personal.legalMiddleName,
    reason: 'Legal middle name from your profile',
  },
  {
    test: /\b(phone|mobile|telephone)\b/i,
    read: (profile) => profile.personal.phone,
    reason: 'Phone number from your profile',
  },
  {
    test: /\b(zip|postal)\s*code\b/i,
    read: (profile) => profile.personal.address.postalCode,
    reason: 'Postal code from your profile',
  },
  {
    test: /\bcountry\b/i,
    read: (profile) => profile.personal.address.country,
    reason: 'Country from your profile',
  },
  {
    test: /\bcity\b/i,
    read: (profile) => profile.personal.address.city,
    reason: 'City from your profile',
  },
];

export interface AccountPlanInput {
  origin: string;
  navigation: NavigationState;
  fields: readonly DetectedField[];
  pageText: string;
  profile: Profile | undefined;
  accountPreferences: AccountPreferences | undefined;
  /** True when a credential for this origin is already in the vault. */
  hasStoredCredential: boolean;
}

/**
 * Builds the registration plan, or explains why there is not one.
 *
 * A blocked page always wins. A CAPTCHA on a registration form is still a
 * CAPTCHA, and no quantity of correctly-identified fields makes it something
 * the agent may proceed through.
 */
export function planAccountCreation(input: AccountPlanInput): AccountPlanOutcome {
  if (input.navigation.kind === 'blocked') {
    return {
      status: 'blocked',
      reason:
        input.navigation.blockedReason ??
        'This page needs you to complete a verification step before the agent can continue.',
    };
  }

  const email = input.accountPreferences?.applicationEmail ?? input.profile?.personal.email;
  if (!email) {
    return {
      status: 'needs_user',
      reason:
        'No application email is saved, and the agent will not invent an address to register under.',
      missing: ['Application email'],
    };
  }

  const visible = input.fields.filter((field) => field.visible && !field.disabled);
  const passwordFields = visible.filter(isPasswordField);
  const confirmationFields = passwordFields.filter(isPasswordConfirmationField);
  const primaryPassword = passwordFields.find((field) => !isPasswordConfirmationField(field));

  if (!primaryPassword) {
    return {
      status: 'needs_user',
      reason: 'No password field was found on this page, so there is nothing to register with.',
      missing: ['Password field'],
    };
  }

  const policy = detectPasswordPolicy(primaryPassword, input.pageText);
  const secretRef = input.hasStoredCredential
    ? ('stored_password' as const)
    : ('generated_password' as const);

  const fields: AccountFieldPlan[] = [];

  // Password and its confirmation. Both carry the same marker, so the executor
  // types one value twice rather than generating a second password that would
  // never match.
  fields.push({
    fieldId: primaryPassword.id,
    selector: primaryPassword.selector,
    label: primaryPassword.label,
    value: { kind: 'secret', secretRef },
    reason:
      secretRef === 'stored_password'
        ? 'The password already saved for this employer'
        : `A new password for this site alone, meeting its rules: ${describePolicy(policy)}`,
  });
  for (const confirmation of confirmationFields) {
    fields.push({
      fieldId: confirmation.id,
      selector: confirmation.selector,
      label: confirmation.label,
      value: { kind: 'secret', secretRef },
      reason: 'The same password again, so the confirmation matches',
    });
  }

  const username = usernameFor(input.accountPreferences, email);
  for (const field of visible.filter(isUsernameField)) {
    if (!username) continue;
    fields.push({
      fieldId: field.id,
      selector: field.selector,
      label: field.label,
      value: { kind: 'literal', value: username },
      reason: input.accountPreferences?.preferredUsername
        ? 'Your saved username preference'
        : 'The local part of your application email',
    });
  }

  // Email boxes, including the "confirm your email" second one.
  for (const field of visible) {
    if (isPasswordField(field) || isUsernameField(field)) continue;
    const haystack = `${field.label} ${field.question}`;
    if (field.fieldType === 'email' || /\be-?mail\b/i.test(haystack)) {
      fields.push({
        fieldId: field.id,
        selector: field.selector,
        label: field.label,
        value: { kind: 'literal', value: email },
        reason: 'The application email from your profile',
      });
    }
  }

  // Everything else the profile can answer without guessing.
  const claimed = new Set(fields.map((entry) => entry.fieldId));
  for (const field of visible) {
    if (claimed.has(field.id) || isConsentField(field)) continue;
    if (isPasswordField(field) || isUsernameField(field)) continue;
    if (!input.profile) break;
    const haystack = `${field.label} ${field.question}`;
    const rule = PROFILE_FIELD_RULES.find((entry) => entry.test.test(haystack));
    const value = rule?.read(input.profile);
    if (rule && value) {
      fields.push({
        fieldId: field.id,
        selector: field.selector,
        label: field.label,
        value: { kind: 'literal', value },
        reason: rule.reason,
      });
      claimed.add(field.id);
    }
  }

  const consents = planConsents(
    visible,
    input.profile,
    input.accountPreferences?.policyAcknowledgement ?? 'ask_every_time',
  );
  for (const consent of consents) claimed.add(consent.fieldId);

  // Every required field this plan leaves unanswered, so none can be silently
  // skipped. A registration that fails validation after the form is cleared is
  // worse than one that stops and says what is missing.
  const unresolvedRequired = visible
    .filter((field) => field.required && !claimed.has(field.id))
    .map((field) => field.label || field.question)
    .filter(Boolean);

  return {
    status: 'ready',
    plan: {
      origin: input.origin,
      email,
      ...(username ? { username } : {}),
      policy,
      policyDescription: describePolicy(policy),
      fields,
      unresolvedRequired,
      consents,
    },
  };
}

/**
 * Decides each consent box.
 *
 * Terms that are required to register are ticked, because refusing them is the
 * same as abandoning the application the user asked for. Marketing is never
 * ticked unless the profile carries an explicit opt-in — and since the profile
 * can only express consent, not refusal, silence correctly leaves it unchecked.
 * Anything unrecognized is left for the user.
 */
export function planConsents(
  fields: readonly DetectedField[],
  profile: Profile | undefined,
  /** Defaults to asking, so an omitted preference can never mean "agree". */
  mode: PolicyAcknowledgementMode = 'ask_every_time',
): ConsentDecision[] {
  return fields.filter(isConsentField).map((field) => {
    const label = field.label || field.question;
    const kind = classifyConsent(label);
    if (kind === 'marketing') {
      const optedIn = profile?.preferences.marketingTextConsent === true;
      return {
        fieldId: field.id,
        selector: field.selector,
        label,
        kind,
        check: optedIn,
        reason: optedIn
          ? 'You opted in to promotional messages on your profile'
          : 'Marketing consent is never assumed, so this is left unchecked',
      };
    }
    if (kind === 'terms') {
      // Permission first, requirement second. "Required to register" explains
      // why ticking it is reasonable; it is not on its own consent to tick it,
      // and the default is to ask.
      const permitted = mode === 'allow_required';
      return {
        fieldId: field.id,
        selector: field.selector,
        label,
        kind,
        check: permitted && field.required,
        reason: !permitted
          ? 'Agreeing to an employer’s policies is yours to do; read it and tick it yourself'
          : field.required
            ? 'Required to register, and you allowed required policy acknowledgements'
            : 'Optional, so it is left for you to decide',
      };
    }
    return {
      fieldId: field.id,
      selector: field.selector,
      label,
      kind,
      check: false,
      reason: 'This checkbox was not recognized, so it is left for you',
    };
  });
}

/**
 * Proof that a plan carries no secret.
 *
 * Called before a plan is logged or rendered. It is cheap, and it converts
 * "we were careful" into something a test can assert.
 */
export function planContainsSecret(plan: AccountPlan, secret: string): boolean {
  if (!secret) return false;
  return JSON.stringify(plan).includes(secret);
}
