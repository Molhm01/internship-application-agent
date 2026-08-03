import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CREATION_DISCLOSURE_VERSION,
  accountCreationBlockedReason,
  classifyConsent,
  classifyPage,
  employerAccountSettingsSchema,
  mayCreateAccountsAutomatically,
  planAccountCreation,
  planContainsSecret,
  profileSchema,
  usernameFor,
  type AccountPlan,
  type DetectedField,
  type Profile,
} from '@internship-agent/shared';

function field(overrides: Partial<DetectedField> & { id: string }): DetectedField {
  return {
    pageId: 'page-1',
    label: '',
    normalizedLabel: '',
    question: '',
    fieldType: 'text',
    selector: `#${overrides.id}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

const PROFILE: Profile = profileSchema.parse({
  version: 2,
  personal: {
    legalFirstName: 'Jordan',
    legalLastName: 'Ellis',
    email: 'jordan.applies@example.com',
    phone: '+1 201 555 0134',
    address: { city: 'Clifton', postalCode: '07011', country: 'United States' },
  },
  updatedAt: '2026-08-02T09:00:00.000Z',
});

/** A Taleo-shaped New User registration page. */
const TALEO_REGISTRATION: DetectedField[] = [
  field({ id: 'username', label: 'User Name', question: 'User Name', required: true }),
  field({
    id: 'password',
    label: 'Password',
    question: 'Password',
    fieldType: 'password',
    required: true,
    helpText:
      'The password must be between 8 and 20 characters and contain one upper case letter and one number.',
  }),
  field({
    id: 'confirm',
    label: 'Re-enter Password',
    question: 'Re-enter Password',
    fieldType: 'password',
    required: true,
  }),
  field({
    id: 'email',
    label: 'E-Mail Address',
    question: 'E-Mail Address',
    fieldType: 'email',
    required: true,
  }),
  field({
    id: 'terms',
    label: 'I have read and agree to the Terms of Use and Privacy Policy',
    question: 'Terms',
    fieldType: 'checkbox',
    required: true,
  }),
  field({
    id: 'marketing',
    label: 'Yes, send me promotional text messages about new opportunities',
    question: 'Marketing',
    fieldType: 'checkbox',
    required: false,
  }),
];

function plan(
  fields: DetectedField[] = TALEO_REGISTRATION,
  pageText = '',
  policyAcknowledgement: 'allow_required' | 'ask_every_time' = 'ask_every_time',
) {
  const navigation = classifyPage({
    url: 'https://careers.example.com/register',
    title: 'New User Registration',
    bodyText: pageText,
    fields,
    controls: [{ label: 'Create Account', selector: '#create' }],
  });
  return planAccountCreation({
    origin: 'https://careers.example.com',
    navigation,
    fields,
    pageText,
    profile: PROFILE,
    accountPreferences: {
      applicationEmail: 'jordan.applies@example.com',
      preferredUsername: 'jordanellis',
      wantsAccountCreationHelp: true,
      policyAcknowledgement,
    },
    hasStoredCredential: false,
  });
}

describe('planning a Taleo registration', () => {
  it('recognizes the page as account creation, not as a form with one question', () => {
    const navigation = classifyPage({
      url: 'https://careers.example.com/register',
      title: 'New User Registration',
      bodyText: '',
      fields: TALEO_REGISTRATION,
      controls: [{ label: 'Create Account', selector: '#create' }],
    });
    expect(navigation.kind).toBe('account_creation');
    expect(navigation.requiresCredentials).toBe(true);
  });

  it('fills the username from the saved preference', () => {
    const outcome = plan();
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    const username = outcome.plan.fields.find((entry) => entry.fieldId === 'username');
    expect(username?.value).toEqual({ kind: 'literal', value: 'jordanellis' });
  });

  it('fills the email from the application address', () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const email = outcome.plan.fields.find((entry) => entry.fieldId === 'email');
    expect(email?.value).toEqual({ kind: 'literal', value: 'jordan.applies@example.com' });
  });

  it('points the password and its confirmation at the same secret', () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const password = outcome.plan.fields.find((entry) => entry.fieldId === 'password');
    const confirm = outcome.plan.fields.find((entry) => entry.fieldId === 'confirm');
    expect(password?.value).toEqual({ kind: 'secret', secretRef: 'generated_password' });
    // The same marker, so the executor types one value twice instead of
    // generating a second password the confirmation could never match.
    expect(confirm?.value).toEqual(password?.value);
  });

  it("reads the site's password rules off the field help text", () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    expect(outcome.plan.policy.minLength).toBe(8);
    expect(outcome.plan.policy.maxLength).toBe(20);
    expect(outcome.plan.policy.requiresUppercase).toBe(true);
    expect(outcome.plan.policy.requiresDigit).toBe(true);
  });

  it('never puts a password in the plan', () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    // The password field carries a marker, and has no `value` key at all.
    const password = outcome.plan.fields.find((entry) => entry.fieldId === 'password');
    expect(password?.value).toEqual({ kind: 'secret', secretRef: 'generated_password' });
    expect(password?.value).not.toHaveProperty('value');

    // Every literal in the plan traces to the profile or the preferences.
    // Nothing was generated into it.
    const literals = outcome.plan.fields
      .filter((entry) => entry.value.kind === 'literal')
      .map((entry) => (entry.value as { value: string }).value);
    expect(literals.sort()).toEqual(['jordan.applies@example.com', 'jordanellis']);
  });
});

describe('consent', () => {
  it('leaves required terms for the user by default', () => {
    // Agreeing to an employer's policies is a statement the applicant makes.
    // "Required to register" explains why ticking it is reasonable; it is not
    // consent to tick it, and the saved preference defaults to asking.
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const terms = outcome.plan.consents.find((entry) => entry.fieldId === 'terms');
    expect(terms?.kind).toBe('terms');
    expect(terms?.check).toBe(false);
    expect(terms?.reason).toMatch(/yourself/i);
  });

  it('ticks required terms once the user has allowed it', () => {
    const outcome = plan(TALEO_REGISTRATION, '', 'allow_required');
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const terms = outcome.plan.consents.find((entry) => entry.fieldId === 'terms');
    expect(terms?.check).toBe(true);
    expect(terms?.reason).toMatch(/you allowed/i);
  });

  it('still never ticks marketing, even with policy acknowledgement allowed', () => {
    const outcome = plan(TALEO_REGISTRATION, '', 'allow_required');
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    expect(outcome.plan.consents.find((entry) => entry.fieldId === 'marketing')?.check).toBe(false);
  });

  it('never ticks marketing the user did not opt in to', () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const marketing = outcome.plan.consents.find((entry) => entry.fieldId === 'marketing');
    expect(marketing?.kind).toBe('marketing');
    expect(marketing?.check).toBe(false);
  });

  it('ticks marketing only when the profile carries an explicit opt-in', () => {
    const optedIn = profileSchema.parse({
      ...PROFILE,
      preferences: { ...PROFILE.preferences, marketingTextConsent: true },
    });
    const navigation = classifyPage({
      url: 'https://careers.example.com/register',
      title: 'New User',
      bodyText: '',
      fields: TALEO_REGISTRATION,
      controls: [],
    });
    const outcome = planAccountCreation({
      origin: 'https://careers.example.com',
      navigation,
      fields: TALEO_REGISTRATION,
      pageText: '',
      profile: optedIn,
      accountPreferences: { wantsAccountCreationHelp: true },
      hasStoredCredential: false,
    });
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    expect(outcome.plan.consents.find((entry) => entry.fieldId === 'marketing')?.check).toBe(true);
  });

  it('reads a combined terms-and-marketing label as marketing, and leaves it alone', () => {
    // The unsafe reading would tick a required "terms" box that also opts the
    // user into marketing they never agreed to.
    expect(classifyConsent('I agree to the Terms of Use and to receive marketing emails')).toBe(
      'marketing',
    );
  });

  it('leaves an unrecognized checkbox for the user', () => {
    const fields = [
      ...TALEO_REGISTRATION,
      field({ id: 'mystery', label: 'Enable beta features', fieldType: 'checkbox' }),
    ];
    const outcome = plan(fields);
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    const mystery = outcome.plan.consents.find((entry) => entry.fieldId === 'mystery');
    expect(mystery?.kind).toBe('unknown');
    expect(mystery?.check).toBe(false);
  });
});

describe('a page the agent must not proceed through', () => {
  it('stops for a CAPTCHA rather than registering around it', () => {
    const navigation = classifyPage({
      url: 'https://careers.example.com/register',
      title: 'New User',
      bodyText: 'Please complete the reCAPTCHA below to continue.',
      fields: TALEO_REGISTRATION,
      controls: [],
    });
    const outcome = planAccountCreation({
      origin: 'https://careers.example.com',
      navigation,
      fields: TALEO_REGISTRATION,
      pageText: 'Please complete the reCAPTCHA below to continue.',
      profile: PROFILE,
      accountPreferences: { wantsAccountCreationHelp: true },
      hasStoredCredential: false,
    });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.reason).toMatch(/CAPTCHA/i);
  });

  it('stops for a verification code', () => {
    const fields = [field({ id: 'code', label: 'Verification code', required: true })];
    const navigation = classifyPage({
      url: 'https://careers.example.com/verify',
      title: 'Verify',
      bodyText: 'Enter the verification code we sent to your phone.',
      fields,
      controls: [],
    });
    expect(navigation.kind).toBe('blocked');
  });

  it('stops for an email confirmation', () => {
    const navigation = classifyPage({
      url: 'https://careers.example.com/verify',
      title: 'Almost there',
      bodyText: 'Please verify your email. We sent you an email with a confirmation link.',
      fields: [],
      controls: [],
    });
    expect(navigation.kind).toBe('blocked');
    expect(navigation.blockedReason).toMatch(/inbox|email/i);
  });
});

describe('what the agent refuses to invent', () => {
  it('will not register without an application email', () => {
    const navigation = classifyPage({
      url: 'https://careers.example.com/register',
      title: 'New User',
      bodyText: '',
      fields: TALEO_REGISTRATION,
      controls: [],
    });
    const outcome = planAccountCreation({
      origin: 'https://careers.example.com',
      navigation,
      fields: TALEO_REGISTRATION,
      pageText: '',
      profile: profileSchema.parse({ updatedAt: '2026-08-02T09:00:00.000Z' }),
      accountPreferences: undefined,
      hasStoredCredential: false,
    });
    expect(outcome.status).toBe('needs_user');
    if (outcome.status !== 'needs_user') return;
    expect(outcome.missing).toContain('Application email');
  });

  it('derives a username from the email rather than inventing one', () => {
    expect(usernameFor(undefined, 'jordan.applies@example.com')).toBe('jordan.applies');
    expect(
      usernameFor({ preferredUsername: 'jellis', wantsAccountCreationHelp: true }, 'a@b.com'),
    ).toBe('jellis');
  });

  it('offers no username at all when neither source gives a usable one', () => {
    expect(usernameFor(undefined, 'ab@example.com')).toBeUndefined();
  });

  it('names every required field it could not answer instead of skipping it', () => {
    const fields = [
      ...TALEO_REGISTRATION,
      field({ id: 'secret-q', label: 'Security question: first pet', required: true }),
    ];
    const outcome = plan(fields);
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    expect(outcome.plan.unresolvedRequired).toContain('Security question: first pet');
  });
});

describe('the account-creation permission', () => {
  it('is off by default', () => {
    const settings = employerAccountSettingsSchema.parse({});
    expect(settings.autoCreateEnabled).toBe(false);
    expect(mayCreateAccountsAutomatically(settings)).toBe(false);
  });

  it('stays off when the switch is flipped without an acknowledgement', () => {
    // This is what a hand-edited chrome.storage entry looks like.
    const settings = employerAccountSettingsSchema.parse({ autoCreateEnabled: true });
    expect(mayCreateAccountsAutomatically(settings)).toBe(false);
    expect(accountCreationBlockedReason(settings)).toMatch(/terms .* changed|confirm them again/i);
  });

  it('turns on only with the switch and a current acknowledgement together', () => {
    const settings = employerAccountSettingsSchema.parse({
      autoCreateEnabled: true,
      acknowledgedAt: '2026-08-02T09:00:00.000Z',
      acknowledgedDisclosureVersion: ACCOUNT_CREATION_DISCLOSURE_VERSION,
    });
    expect(mayCreateAccountsAutomatically(settings)).toBe(true);
    expect(accountCreationBlockedReason(settings)).toBeNull();
  });

  it('asks again when the wording has changed since the user agreed', () => {
    const settings = employerAccountSettingsSchema.parse({
      autoCreateEnabled: true,
      acknowledgedAt: '2026-08-02T09:00:00.000Z',
      // Agreed to wording that is not the current wording.
      acknowledgedDisclosureVersion: ACCOUNT_CREATION_DISCLOSURE_VERSION + 1,
    });
    expect(mayCreateAccountsAutomatically(settings)).toBe(false);
  });
});

describe('the secret-detection guard', () => {
  it('spots a password that leaked into a plan', () => {
    const leaky = {
      fields: [{ value: { kind: 'literal', value: 'Hunter2!x' } }],
    } as unknown as AccountPlan;
    expect(planContainsSecret(leaky, 'Hunter2!x')).toBe(true);
  });

  it('passes a clean plan', () => {
    const outcome = plan();
    if (outcome.status !== 'ready') throw new Error('expected a plan');
    expect(planContainsSecret(outcome.plan, 'Hunter2!x')).toBe(false);
  });
});
