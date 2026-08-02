import {
  generatePassword,
  mayCreateAccountsAutomatically,
  accountCreationBlockedReason,
  planContainsSecret,
  satisfiesPolicy,
  type AccountPlan,
  type EmployerAccountSettings,
} from '@internship-agent/shared';
import {
  hasCredential,
  isVaultUnlocked,
  originOf,
  revealPassword,
  saveCredential,
} from '../credentials/vault.js';

/**
 * Turning an account plan into typed characters.
 *
 * This is the only place in the extension where an employer-site password
 * exists as a string, and it exists for the duration of one function call. The
 * rules that make that true, and which must not be relaxed:
 *
 * - The password never enters the plan. The planner emits a `secretRef` marker;
 *   this module resolves it and hands the value straight to the DOM writer.
 * - The password is never returned to a caller, never put in a message, never
 *   logged, and never included in anything a model receives. The functions here
 *   return statuses, not values.
 * - Nothing is typed until `mayCreateAccountsAutomatically` says the user
 *   turned this on *and* acknowledged the current wording.
 *
 * The DOM writer is injected so this can be tested without a browser — and so
 * that a test can assert what was typed without production code ever exposing
 * it.
 */

export type FieldWriter = (selector: string, value: string) => Promise<boolean> | boolean;
export type CheckboxWriter = (selector: string, checked: boolean) => Promise<boolean> | boolean;

export interface ExecuteAccountPlanInput {
  plan: AccountPlan;
  settings: EmployerAccountSettings;
  writeField: FieldWriter;
  writeCheckbox: CheckboxWriter;
  /** Injected only so tests are deterministic; production uses the CSPRNG. */
  makePassword?: (plan: AccountPlan) => string;
}

export interface AccountExecutionResult {
  status: 'filled' | 'refused';
  /** Fields written, by label. Never contains a value. */
  filledLabels: string[];
  /** Fields that could not be written. */
  failedLabels: string[];
  /** Consent boxes ticked, by label. */
  checkedConsents: string[];
  /** Required fields still unanswered after the fill. */
  unresolvedRequired: string[];
  /** Whether the password was written to the encrypted vault. */
  savedToVault: boolean;
  reason?: string;
}

/**
 * Resolves the one secret this plan needs.
 *
 * A stored credential is preferred so a re-run does not orphan the account the
 * user already has. A generated one is verified against the site's own policy
 * before it is used — refusing here is far better than typing something the
 * site rejects after clearing the form.
 */
async function resolveSecret(
  plan: AccountPlan,
  makePassword: (plan: AccountPlan) => string,
): Promise<{ password: string; generated: boolean } | { error: string }> {
  const needsStored = plan.fields.some(
    (field) => field.value.kind === 'secret' && field.value.secretRef === 'stored_password',
  );

  if (needsStored) {
    if (!isVaultUnlocked()) {
      return {
        error:
          'A password is already saved for this employer, but the credential vault is locked. Unlock it in the extension to continue.',
      };
    }
    const stored = await revealPassword(plan.origin);
    if (stored) return { password: stored, generated: false };
    // The vault has a row but it would not decrypt — a wrong passphrase. Making
    // up a new password here would silently strand the account they already
    // have, so this stops instead.
    return {
      error:
        'The saved password for this employer could not be decrypted. Unlock the vault with the right passphrase, or remove the saved credential.',
    };
  }

  const password = makePassword(plan);
  if (!satisfiesPolicy(password, plan.policy)) {
    return { error: `The generated password does not meet this site's rules (${plan.policyDescription}).` };
  }
  return { password, generated: true };
}

export async function executeAccountPlan(
  input: ExecuteAccountPlanInput,
): Promise<AccountExecutionResult> {
  const empty = {
    filledLabels: [],
    failedLabels: [],
    checkedConsents: [],
    unresolvedRequired: input.plan.unresolvedRequired,
    savedToVault: false,
  };

  const blocked = accountCreationBlockedReason(input.settings);
  if (blocked || !mayCreateAccountsAutomatically(input.settings)) {
    return { status: 'refused', ...empty, reason: blocked ?? 'Account creation is not enabled.' };
  }

  if (!originOf(input.plan.origin)) {
    return {
      status: 'refused',
      ...empty,
      reason: 'Accounts are only created on secure (https) employer sites.',
    };
  }

  const resolved = await resolveSecret(input.plan, input.makePassword ?? (({ policy }) => generatePassword(policy)));
  if ('error' in resolved) {
    return { status: 'refused', ...empty, reason: resolved.error };
  }

  const filledLabels: string[] = [];
  const failedLabels: string[] = [];

  for (const field of input.plan.fields) {
    const value =
      field.value.kind === 'literal' ? field.value.value : resolved.password;
    const ok = await input.writeField(field.selector, value);
    (ok ? filledLabels : failedLabels).push(field.label);
  }

  const checkedConsents: string[] = [];
  for (const consent of input.plan.consents) {
    if (!consent.check) continue;
    const ok = await input.writeCheckbox(consent.selector, true);
    if (ok) checkedConsents.push(consent.label);
    else failedLabels.push(consent.label);
  }

  let savedToVault = false;
  if (resolved.generated && input.settings.saveToVault && isVaultUnlocked()) {
    // Saved only after it has actually been typed, so the vault never holds a
    // password for an account that was never created.
    await saveCredential(input.plan.origin, input.plan.username ?? input.plan.email, resolved.password);
    savedToVault = true;
  }

  // A last structural check: nothing that leaves this function may contain the
  // secret. Cheap, and it turns the invariant into something enforced rather
  // than merely intended.
  if (planContainsSecret(input.plan, resolved.password)) {
    throw new Error('Refusing to continue: the account plan contains the password.');
  }

  return {
    status: 'filled',
    filledLabels,
    failedLabels,
    checkedConsents,
    unresolvedRequired: input.plan.unresolvedRequired,
    savedToVault,
  };
}

/** Whether this origin already has a credential, for the planner. */
export async function originHasCredential(url: string): Promise<boolean> {
  const origin = originOf(url);
  return origin ? hasCredential(origin) : false;
}
