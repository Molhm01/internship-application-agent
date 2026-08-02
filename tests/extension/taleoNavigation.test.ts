import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  isPasswordConfirmationField,
  isPasswordField,
  isUsernameField,
  navigationIntentFor,
  type DetectedField,
} from '@internship-agent/shared';
import { collectNavigationControls, scanDom } from '../../extension/src/scanner/domScanner.js';

/**
 * The reported failure, reproduced and fixed.
 *
 * On a Taleo sign-in page the extension detected one field even though a
 * username and a password were both visible, and neither "New User" nor
 * "Apply as Guest" was recognized at all.
 */

function load(name: string): void {
  const html = readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'lab', name), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '');
}

async function scan(name: string): Promise<DetectedField[]> {
  load(name);
  const result = await scanDom(document, 'page-taleo', new AbortController().signal);
  return result.fields;
}

async function classify(name: string) {
  const fields = await scan(name);
  return {
    fields,
    state: classifyPage({
      url: `https://careers.example.taleo.net/${name}`,
      title: document.title,
      bodyText: document.body.textContent ?? '',
      fields,
      controls: collectNavigationControls(document),
    }),
  };
}

describe('the Taleo sign-in page', () => {
  it('detects the username and the password, not one lone field', async () => {
    const fields = await scan('taleo-login.html');
    const labels = fields.map((field) => field.label);
    expect(labels).toContain('User Name');
    expect(labels).toContain('Password');
    expect(fields.length).toBeGreaterThanOrEqual(2);
  });

  it('types the password field as a password rather than discarding it', async () => {
    const fields = await scan('taleo-login.html');
    const password = fields.find((field) => field.label === 'Password');
    expect(password?.fieldType).toBe('password');
    expect(isPasswordField(password!)).toBe(true);
  });

  it('recognizes the username field by its name and label', async () => {
    const fields = await scan('taleo-login.html');
    expect(isUsernameField(fields.find((field) => field.label === 'User Name')!)).toBe(true);
  });

  it('reads the page as a sign-in page, not as an application form', async () => {
    const { state } = await classify('taleo-login.html');
    expect(state.kind).toBe('login');
    expect(state.requiresCredentials).toBe(true);
  });

  it('finds the login, New User, guest, and forgotten-credential routes', async () => {
    const { state } = await classify('taleo-login.html');
    const intents = state.actions.map((action) => action.intent);
    expect(intents).toContain('login');
    expect(intents).toContain('create_account');
    expect(intents).toContain('apply_as_guest');
    expect(intents).toContain('forgot_username');
    expect(intents).toContain('forgot_password');
  });

  it('never counts a navigation control as a question', async () => {
    const { fields } = await classify('taleo-login.html');
    const labels = fields.map((field) => field.label);
    for (const control of ['Login', 'New User', 'Apply as Guest']) {
      expect(labels).not.toContain(control);
    }
  });

  it('offers no route that would end the application', async () => {
    const { state } = await classify('taleo-login.html');
    expect(state.actions.every((action) => !action.endsApplication)).toBe(true);
  });
});

describe('the Taleo account-creation page', () => {
  it('reads two password boxes as registration rather than sign-in', async () => {
    const { state } = await classify('taleo-create-account.html');
    expect(state.kind).toBe('account_creation');
  });

  it('tells the confirmation box from the password box', async () => {
    const fields = await scan('taleo-create-account.html');
    const password = fields.find((field) => field.label === 'Password');
    const confirmation = fields.find((field) => field.label === 'Re-enter Password');
    expect(isPasswordConfirmationField(password!)).toBe(false);
    expect(isPasswordConfirmationField(confirmation!)).toBe(true);
  });

  it('finds the security question, its answer, and the consent checkbox', async () => {
    const fields = await scan('taleo-create-account.html');
    const labels = fields.map((field) => field.label);
    expect(labels).toContain('Security Question');
    expect(labels).toContain('Security Answer');
    expect(labels.some((label) => label.includes('Privacy Agreement'))).toBe(true);
  });
});

describe('the Taleo review page', () => {
  it('reads a page whose only forward control submits as the final step', async () => {
    const { state } = await classify('taleo-review.html');
    expect(state.kind).toBe('final_submit');
    expect(state.actions.some((action) => action.endsApplication)).toBe(true);
  });
});

describe('pages that need a person', () => {
  it('stops on a CAPTCHA even when the credentials are recognizable', () => {
    const state = classifyPage({
      url: 'https://careers.example.taleo.net/login',
      title: 'Login',
      bodyText: 'Please complete the reCAPTCHA to continue.',
      fields: [],
      controls: [{ label: 'Login', selector: '#login' }],
    });
    expect(state.kind).toBe('blocked');
    expect(state.blockedReason).toContain('CAPTCHA');
  });

  it('stops when a verification code is requested', () => {
    const state = classifyPage({
      url: 'https://careers.example.taleo.net/mfa',
      title: 'Verify',
      bodyText: 'Enter the verification code we sent to your phone.',
      fields: [],
      controls: [],
    });
    expect(state.kind).toBe('blocked');
    expect(state.blockedReason).toContain('verification code');
  });

  it('stops when the account needs email confirmation', () => {
    const state = classifyPage({
      url: 'https://careers.example.taleo.net/registered',
      title: 'Almost there',
      bodyText: 'Please verify your email to activate your account.',
      fields: [],
      controls: [],
    });
    expect(state.kind).toBe('blocked');
    expect(state.blockedReason).toContain('email');
  });
});

describe('reading a control as navigation', () => {
  it.each([
    ['Login', 'login'],
    ['Sign In', 'login'],
    ['Returning User', 'login'],
    ['New User', 'create_account'],
    ['Create an account', 'create_account'],
    ['Register', 'create_account'],
    ['Apply as Guest', 'apply_as_guest'],
    ['Continue as a guest', 'apply_as_guest'],
    ['Next', 'continue'],
    ['Save and Continue', 'continue'],
    ['Back', 'back'],
    ['Save draft', 'save_draft'],
    ['Forgot your user name?', 'forgot_username'],
    ['Forgot your password?', 'forgot_password'],
    ['Submit Application', 'final_submit'],
  ])('reads "%s" as %s', (label, expected) => {
    expect(navigationIntentFor(label)).toBe(expected);
  });

  it('does not read an ordinary question as navigation', () => {
    expect(navigationIntentFor('First name')).toBeNull();
    expect(navigationIntentFor('Are you legally authorized to work?')).toBeNull();
  });

  it('treats only final submission as ending the application', () => {
    const state = classifyPage({
      url: 'https://careers.example.taleo.net/apply',
      title: 'Apply',
      bodyText: '',
      fields: [],
      controls: [
        { label: 'Next', selector: '#next' },
        { label: 'Submit Application', selector: '#submit' },
      ],
    });
    const byIntent = new Map(state.actions.map((action) => [action.intent, action.endsApplication]));
    expect(byIntent.get('continue')).toBe(false);
    expect(byIntent.get('final_submit')).toBe(true);
  });
});
