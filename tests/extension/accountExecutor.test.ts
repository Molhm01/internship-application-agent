import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_CREATION_DISCLOSURE_VERSION,
  employerAccountSettingsSchema,
  type AccountPlan,
  type EmployerAccountSettings,
} from '@internship-agent/shared';

/**
 * The vault is stubbed rather than exercised against fake-indexeddb, because
 * what these tests are about is the *flow* of the secret: where it comes from,
 * where it is allowed to go, and where it must never appear. The vault's own
 * crypto is covered by its own tests.
 */
const vault = vi.hoisted(() => ({
  unlocked: true,
  stored: null as string | null,
  saved: [] as Array<{ origin: string; username: string; password: string }>,
}));

vi.mock('../../extension/src/credentials/vault.js', () => ({
  isVaultUnlocked: () => vault.unlocked,
  revealPassword: () => Promise.resolve(vault.stored),
  saveCredential: (origin: string, username: string, password: string) => {
    vault.saved.push({ origin, username, password });
    return Promise.resolve({ origin, username, createdAt: '', updatedAt: '' });
  },
  hasCredential: () => Promise.resolve(vault.stored !== null),
  originOf: (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.hostname === 'localhost' ? parsed.origin : null;
    } catch {
      return null;
    }
  },
}));

const { executeAccountPlan } = await import('../../extension/src/accounts/accountExecutor.js');

const PLAN: AccountPlan = {
  origin: 'https://careers.example.com',
  email: 'jordan.applies@example.com',
  username: 'jordanellis',
  policy: {
    minLength: 8,
    maxLength: 20,
    requiresUppercase: true,
    requiresLowercase: true,
    requiresDigit: true,
    requiresSymbol: false,
    allowedSymbols: '',
    sources: [],
  },
  policyDescription: 'at least 8 characters',
  fields: [
    {
      fieldId: 'username',
      selector: '#username',
      label: 'User Name',
      value: { kind: 'literal', value: 'jordanellis' },
      reason: 'Saved preference',
    },
    {
      fieldId: 'password',
      selector: '#password',
      label: 'Password',
      value: { kind: 'secret', secretRef: 'generated_password' },
      reason: 'New password for this site',
    },
    {
      fieldId: 'confirm',
      selector: '#confirm',
      label: 'Re-enter Password',
      value: { kind: 'secret', secretRef: 'generated_password' },
      reason: 'Same password again',
    },
  ],
  unresolvedRequired: [],
  consents: [
    {
      fieldId: 'terms',
      selector: '#terms',
      label: 'I agree to the Terms',
      kind: 'terms',
      check: true,
      reason: 'Required',
    },
    {
      fieldId: 'marketing',
      selector: '#marketing',
      label: 'Send me promotions',
      kind: 'marketing',
      check: false,
      reason: 'Never assumed',
    },
  ],
};

const ENABLED: EmployerAccountSettings = employerAccountSettingsSchema.parse({
  autoCreateEnabled: true,
  acknowledgedAt: '2026-08-02T09:00:00.000Z',
  acknowledgedDisclosureVersion: ACCOUNT_CREATION_DISCLOSURE_VERSION,
});

const GENERATED = 'Qm7xTb2Ldp9Kv';

function harness(settings = ENABLED, plan = PLAN) {
  const typed: Array<{ selector: string; value: string }> = [];
  const checked: Array<{ selector: string; checked: boolean }> = [];
  return {
    typed,
    checked,
    run: () =>
      executeAccountPlan({
        plan,
        settings,
        writeField: (selector, value) => {
          typed.push({ selector, value });
          return true;
        },
        writeCheckbox: (selector, isChecked) => {
          checked.push({ selector, checked: isChecked });
          return true;
        },
        makePassword: () => GENERATED,
      }),
  };
}

beforeEach(() => {
  vault.unlocked = true;
  vault.stored = null;
  vault.saved = [];
});

describe('filling a registration form', () => {
  it('types the password and its confirmation identically', async () => {
    const { typed, run } = harness();
    await run();
    const password = typed.find((entry) => entry.selector === '#password');
    const confirm = typed.find((entry) => entry.selector === '#confirm');
    expect(password?.value).toBe(GENERATED);
    expect(confirm?.value).toBe(GENERATED);
  });

  it('reports what it filled without ever reporting a value', async () => {
    const { run } = harness();
    const result = await run();
    expect(result.status).toBe('filled');
    expect(result.filledLabels).toEqual(['User Name', 'Password', 'Re-enter Password']);
    expect(JSON.stringify(result)).not.toContain(GENERATED);
  });

  it('ticks the required terms and leaves marketing alone', async () => {
    const { checked, run } = harness();
    const result = await run();
    expect(checked).toEqual([{ selector: '#terms', checked: true }]);
    expect(result.checkedConsents).toEqual(['I agree to the Terms']);
  });

  it('saves the generated password to the vault, encrypted, after typing it', async () => {
    const { run } = harness();
    const result = await run();
    expect(result.savedToVault).toBe(true);
    expect(vault.saved).toEqual([
      { origin: 'https://careers.example.com', username: 'jordanellis', password: GENERATED },
    ]);
  });

  it('does not save when the user asked for the browser password manager instead', async () => {
    const settings = employerAccountSettingsSchema.parse({ ...ENABLED, saveToVault: false });
    const { run } = harness(settings);
    const result = await run();
    expect(result.savedToVault).toBe(false);
    expect(vault.saved).toEqual([]);
  });
});

describe('reusing an account that already exists', () => {
  const storedPlan: AccountPlan = {
    ...PLAN,
    fields: PLAN.fields.map((entry) =>
      entry.value.kind === 'secret'
        ? { ...entry, value: { kind: 'secret' as const, secretRef: 'stored_password' as const } }
        : entry,
    ),
  };

  it('types the saved password rather than generating a second one', async () => {
    vault.stored = 'AlreadyChosen9';
    const { typed, run } = harness(ENABLED, storedPlan);
    await run();
    expect(typed.find((entry) => entry.selector === '#password')?.value).toBe('AlreadyChosen9');
    // Nothing new was saved: the account already exists.
    expect(vault.saved).toEqual([]);
  });

  it('stops rather than stranding the existing account when the vault is locked', async () => {
    vault.unlocked = false;
    vault.stored = 'AlreadyChosen9';
    const { typed, run } = harness(ENABLED, storedPlan);
    const result = await run();
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/locked/i);
    expect(typed).toEqual([]);
  });

  it('stops rather than making up a new password when decryption fails', async () => {
    vault.stored = null;
    const { typed, run } = harness(ENABLED, storedPlan);
    const result = await run();
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/could not be decrypted/i);
    expect(typed).toEqual([]);
  });
});

describe('what stops the executor before it types anything', () => {
  it('refuses when the user never turned account creation on', async () => {
    const { typed, run } = harness(employerAccountSettingsSchema.parse({}));
    const result = await run();
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/off/i);
    expect(typed).toEqual([]);
    expect(vault.saved).toEqual([]);
  });

  it('refuses when the switch is on but the terms were never acknowledged', async () => {
    const { typed, run } = harness(employerAccountSettingsSchema.parse({ autoCreateEnabled: true }));
    const result = await run();
    expect(result.status).toBe('refused');
    expect(typed).toEqual([]);
  });

  it('refuses to register over plain http', async () => {
    const { typed, run } = harness(ENABLED, { ...PLAN, origin: 'http://careers.example.com' });
    const result = await run();
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/secure/i);
    expect(typed).toEqual([]);
  });

  it('refuses a password that would not satisfy the site, rather than typing it', async () => {
    const result = await executeAccountPlan({
      plan: PLAN,
      settings: ENABLED,
      writeField: () => true,
      writeCheckbox: () => true,
      // Too short, no uppercase, no digit.
      makePassword: () => 'abc',
    });
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/does not meet/i);
  });
});

describe('required fields are never silently dropped', () => {
  it('carries the unanswered ones through to the result', async () => {
    const { run } = harness(ENABLED, {
      ...PLAN,
      unresolvedRequired: ['Security question: first pet'],
    });
    const result = await run();
    expect(result.unresolvedRequired).toEqual(['Security question: first pet']);
  });
});
