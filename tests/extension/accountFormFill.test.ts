import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  ACCOUNT_CREATION_DISCLOSURE_VERSION,
  applicationScanResultSchema,
  extensionSettingsSchema,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import { fillAccountForm } from '../../extension/src/background/accountForm.js';
import { unlockVault } from '../../extension/src/credentials/vault.js';
import { profileFixture } from './popupFixtures.js';
import { installChromeMock } from './setup.js';

/**
 * The account form actually being filled.
 *
 * The planner, the executor and the vault were all implemented and tested, and
 * nothing called them — so a user who turned on automatic account creation and
 * landed on an iCIMS registration page still typed their own username and
 * password. These pin the connection, and the one property that matters most
 * about it: the password is typed and is not anywhere else.
 */

function credentialField(overrides: Partial<DetectedField>): DetectedField {
  return {
    id: 'f',
    pageId: 'page-1',
    label: '',
    normalizedLabel: '',
    question: '',
    fieldType: 'text',
    selector: '#f',
    required: true,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

const FIELDS: DetectedField[] = [
  credentialField({
    id: 'username',
    label: 'Username',
    normalizedLabel: 'username',
    question: 'Username',
    selector: '#username',
    metadata: { name: 'username' },
  }),
  credentialField({
    id: 'email',
    label: 'Email Address',
    normalizedLabel: 'email address',
    question: 'Email Address',
    fieldType: 'email',
    selector: '#email',
  }),
  credentialField({
    id: 'password',
    label: 'Password',
    normalizedLabel: 'password',
    question: 'Password',
    fieldType: 'password',
    selector: '#password',
    metadata: { name: 'password' },
  }),
  credentialField({
    id: 'confirm',
    label: 'Confirm Password',
    normalizedLabel: 'confirm password',
    question: 'Confirm Password',
    fieldType: 'password',
    selector: '#confirm',
    metadata: { name: 'confirmPassword' },
  }),
];

function scanOf(): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: 'scan-account',
    createdAt: new Date().toISOString(),
    url: 'https://careers2-quanta.icims.com/jobs/register',
    domain: 'careers2-quanta.icims.com',
    ats: {
      id: 'icims',
      displayName: 'iCIMS',
      confidence: 0.98,
      detectionReason: 'hostname',
      supported: true,
    },
    jobContext: {},
    fields: FIELDS,
    navigation: { kind: 'account_creation', requiresCredentials: true, actions: [] },
    warnings: [],
    statistics: {
      total: FIELDS.length,
      supported: FIELDS.length,
      unknown: 0,
      required: FIELDS.length,
      optional: 0,
      text: 2,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 2,
      navigationActions: 0,
    },
    durationMs: 4,
    status: 'completed',
    readOnly: true,
  });
}

function settingsWith(employerAccounts: Record<string, unknown>) {
  return extensionSettingsSchema.parse({
    serverUrl: 'http://127.0.0.1:4318',
    authToken: '',
    selectedModel: 'model:latest',
    selectedDocumentId: null,
    ai: { generationModel: 'model:latest' },
    employerAccounts,
    settingsVersion: 1,
    settingsUpdatedAt: new Date().toISOString(),
  });
}

const ENABLED = settingsWith({
  autoCreateEnabled: true,
  acknowledgedAt: new Date().toISOString(),
  acknowledgedDisclosureVersion: ACCOUNT_CREATION_DISCLOSURE_VERSION,
  saveToVault: true,
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
});

describe('filling an employer account form', () => {
  it('types the username, email, password and confirmation when enabled', async () => {
    unlockVault('a-long-test-passphrase');
    const written = new Map<string, string>();

    const outcome = await fillAccountForm({
      scan: scanOf(),
      settings: ENABLED,
      profile: profileFixture(),
      accountPreferences: {
        applicationEmail: 'jordan.applies@example.com',
        preferredUsername: 'jordan.applies',
        wantsAccountCreationHelp: true,
      },
      writeField: (selector, value) => {
        written.set(selector, value);
        return Promise.resolve(true);
      },
      writeCheckbox: () => Promise.resolve(true),
    });

    expect(outcome.filled).toBe(true);
    expect(written.get('#email')).toBe('jordan.applies@example.com');
    expect(written.get('#username')).toBeTruthy();
    // Both password boxes get the same generated secret.
    const password = written.get('#password');
    expect(password).toBeTruthy();
    expect(written.get('#confirm')).toBe(password);
  });

  it('never returns, logs, or reports the password it typed', async () => {
    unlockVault('a-long-test-passphrase');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let typed = '';

    const outcome = await fillAccountForm({
      scan: scanOf(),
      settings: ENABLED,
      profile: profileFixture(),
      accountPreferences: {
        applicationEmail: 'jordan.applies@example.com',
        wantsAccountCreationHelp: true,
      },
      writeField: (selector, value) => {
        if (selector === '#password') typed = value;
        return Promise.resolve(true);
      },
      writeCheckbox: () => Promise.resolve(true),
    });

    expect(typed.length).toBeGreaterThan(11);
    // The outcome carries labels, never values.
    expect(JSON.stringify(outcome)).not.toContain(typed);
    expect(outcome.filledLabels).toContain('Password');
    // And nothing logged carries it either.
    const logged = info.mock.calls.map((call) => JSON.stringify(call)).join(' ');
    expect(logged).not.toContain(typed);
    info.mockRestore();
  });

  it('does nothing at all when the user has not turned it on', async () => {
    const written: string[] = [];
    const outcome = await fillAccountForm({
      scan: scanOf(),
      settings: settingsWith({ autoCreateEnabled: false }),
      profile: profileFixture(),
      accountPreferences: { applicationEmail: 'a@b.com', wantsAccountCreationHelp: true },
      writeField: (selector) => {
        written.push(selector);
        return Promise.resolve(true);
      },
      writeCheckbox: () => Promise.resolve(true),
    });

    expect(outcome.filled).toBe(false);
    expect(written).toHaveLength(0);
    expect(outcome.reason).toMatch(/off|not on/i);
  });

  it('refuses a page that is not an account form', async () => {
    const scan = applicationScanResultSchema.parse({
      ...scanOf(),
      navigation: { kind: 'application_form', requiresCredentials: false, actions: [] },
    });
    const written: string[] = [];
    const outcome = await fillAccountForm({
      scan,
      settings: ENABLED,
      profile: profileFixture(),
      accountPreferences: { applicationEmail: 'a@b.com', wantsAccountCreationHelp: true },
      writeField: (selector) => {
        written.push(selector);
        return Promise.resolve(true);
      },
      writeCheckbox: () => Promise.resolve(true),
    });
    expect(outcome.filled).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('stops on a blocked page rather than registering through a CAPTCHA', async () => {
    unlockVault('a-long-test-passphrase');
    const scan = applicationScanResultSchema.parse({
      ...scanOf(),
      navigation: {
        kind: 'blocked',
        requiresCredentials: true,
        actions: [],
        blockedReason: 'This page has a CAPTCHA. Solve it yourself, then continue.',
      },
    });
    const written: string[] = [];
    const outcome = await fillAccountForm({
      scan,
      settings: ENABLED,
      profile: profileFixture(),
      accountPreferences: { applicationEmail: 'a@b.com', wantsAccountCreationHelp: true },
      writeField: (selector) => {
        written.push(selector);
        return Promise.resolve(true);
      },
      writeCheckbox: () => Promise.resolve(true),
    });
    expect(outcome.filled).toBe(false);
    expect(written).toHaveLength(0);
  });
});
