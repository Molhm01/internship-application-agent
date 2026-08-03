import {
  accountCreationBlockedReason,
  mayCreateAccountsAutomatically,
  planAccountCreation,
  type AccountPlan,
  type ApplicationScanResult,
  type ExtensionSettings,
  type Profile,
} from '@internship-agent/shared';
import { executeAccountPlan, originHasCredential } from '../accounts/accountExecutor.js';

/**
 * Registering on an employer portal, wired to the live page.
 *
 * The planner, the executor and the vault all existed and were tested; nothing
 * called them, so a user who turned on automatic account creation still typed
 * their own username and password. This is the missing connection, and it is
 * deliberately thin — it decides *whether* to run and hands the DOM writing to
 * the content script, because every rule about what may be typed already lives
 * in `planAccountCreation` and `executeAccountPlan`.
 *
 * The password path is the reason this file is short. The value is read from
 * the encrypted vault inside `executeAccountPlan`, handed to one `writeField`
 * call, and never returned, stored, logged, or put in a message that carries
 * anything else. What crosses to the content script is a selector and a string,
 * for one field, once.
 */

export interface AccountFormOutcome {
  /** True when something was typed. */
  filled: boolean;
  /** Fields written, by label. Never a value. */
  filledLabels: string[];
  /** Why nothing happened, in the user's words. */
  reason?: string;
}

export interface AccountFormDependencies {
  scan: ApplicationScanResult;
  settings: ExtensionSettings;
  profile: Profile | undefined;
  accountPreferences: Parameters<typeof planAccountCreation>[0]['accountPreferences'];
  /** Types one value into one selector, in the page. */
  writeField(selector: string, value: string): Promise<boolean>;
  writeCheckbox(selector: string, checked: boolean): Promise<boolean>;
}

/**
 * Fills the account form on this page, when the user has asked for that.
 *
 * Returns rather than throws for every refusal: "the switch is off" and "there
 * is a CAPTCHA" are outcomes the run reports, not failures of the run.
 */
export async function fillAccountForm(
  dependencies: AccountFormDependencies,
): Promise<AccountFormOutcome> {
  const { scan, settings } = dependencies;
  const accounts = settings.employerAccounts;

  // The permission is checked here as well as inside the executor. Cheap, and
  // it means this function cannot be repurposed into a path that skips it.
  const blocked = accountCreationBlockedReason(accounts);
  if (blocked || !mayCreateAccountsAutomatically(accounts)) {
    return { filled: false, filledLabels: [], reason: blocked ?? 'Account creation is not on.' };
  }

  const navigation = scan.navigation;
  if (!navigation || navigation.kind !== 'account_creation') {
    return { filled: false, filledLabels: [], reason: 'This page is not an account form.' };
  }

  const planned = planAccountCreation({
    origin: scan.url,
    navigation,
    fields: scan.fields,
    pageText: scan.fields.map((field) => field.question).join(' \n '),
    profile: dependencies.profile,
    accountPreferences: dependencies.accountPreferences,
    hasStoredCredential: await originHasCredential(scan.url),
  });

  if (planned.status !== 'ready') {
    return {
      filled: false,
      filledLabels: [],
      reason: 'reason' in planned ? planned.reason : 'The account form could not be planned.',
    };
  }

  const result = await executeAccountPlan({
    plan: planned.plan satisfies AccountPlan,
    settings: accounts,
    // Wrapped rather than passed by reference: passing the method directly
    // detaches it from `dependencies`, which is a real scoping hazard for any
    // caller that supplies an object method rather than a closure.
    writeField: (selector, value) => dependencies.writeField(selector, value),
    writeCheckbox: (selector, checked) => dependencies.writeCheckbox(selector, checked),
  });

  // Labels only. A value never reaches a log line from here, and the executor
  // is structurally incapable of returning one.
  console.info('[agent] account form', {
    status: result.status,
    fields: result.filledLabels.length,
    consents: result.checkedConsents.length,
    savedToVault: result.savedToVault,
  });

  return {
    filled: result.status === 'filled',
    filledLabels: result.filledLabels,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
