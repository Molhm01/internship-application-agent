import { useEffect, useState } from 'react';
import {
  ACCOUNT_CREATION_DISCLOSURE,
  ACCOUNT_CREATION_DISCLOSURE_VERSION,
  mayCreateAccountsAutomatically,
  type EmployerAccountSettings,
  type PortalStrategy,
} from '@internship-agent/shared';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../storage/settings.js';

/**
 * Employer-portal accounts.
 *
 * Turning this on is a two-step gesture on purpose. Ticking the box does not
 * save anything; it reveals the disclosure and a confirm button, and only
 * pressing that records the acknowledgement the executor checks for. A single
 * click cannot therefore grant a permission whose consequence is a real account
 * on someone else's system under the user's name.
 *
 * Turning it off saves immediately, because withdrawing a permission should
 * never require a second confirmation.
 */

const STRATEGIES: ReadonlyArray<{ value: PortalStrategy | ''; label: string; hint: string }> = [
  {
    value: '',
    label: 'Use my Internship Pilot profile setting',
    hint: 'Whatever you chose on the website.',
  },
  {
    value: 'prefer_guest',
    label: 'Prefer applying as a guest',
    hint: 'Take the guest route whenever the employer offers one.',
  },
  {
    value: 'create_when_required',
    label: 'Create an account when one is required',
    hint: 'Take the New User or Create Account route, and register there. Requires the switch below.',
  },
  {
    value: 'use_existing_account',
    label: 'I already have an account',
    hint: 'Take the sign-in route. Your browser’s password manager or the extension’s vault fills the credentials; the agent never types a password it was not given.',
  },
  {
    value: 'always_ask',
    label: 'Always ask me',
    hint: 'Stop on every portal and let you choose.',
  },
];

export function EmployerAccountsSection(): JSX.Element {
  const [settings, setSettings] = useState<EmployerAccountSettings>(
    DEFAULT_SETTINGS.employerAccounts,
  );
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void loadSettings().then((loaded) => setSettings(loaded.employerAccounts));
  }, []);

  const enabled = mayCreateAccountsAutomatically(settings);

  const persist = async (update: Partial<EmployerAccountSettings>): Promise<void> => {
    const saved = await saveSettings({ employerAccounts: update });
    setSettings(saved.employerAccounts);
  };

  const confirm = async (): Promise<void> => {
    await persist({
      autoCreateEnabled: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedDisclosureVersion: ACCOUNT_CREATION_DISCLOSURE_VERSION,
    });
    setConfirming(false);
    setStatus('The agent may now create employer accounts for this profile.');
  };

  const disable = async (): Promise<void> => {
    // The acknowledgement is dropped with the switch, so turning this back on
    // asks again rather than reusing a past decision.
    await persist({ autoCreateEnabled: false });
    setConfirming(false);
    setStatus('Automatic employer account creation is off.');
  };

  return (
    <section className="section">
      <h2>Employer portal accounts</h2>
      <p className="muted">
        Some employers — Taleo, Workday, iCIMS, and many company career sites — will not show the
        application until you sign in or register. This decides what the agent does when it meets
        one.
      </p>

      <label className="field">
        <span>When an employer portal asks for an account</span>
        <select
          value={settings.portalStrategy ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            void persist({
              portalStrategy: value ? (value as PortalStrategy) : undefined,
            });
            setStatus('Saved.');
          }}
        >
          {STRATEGIES.map((strategy) => (
            <option key={strategy.value} value={strategy.value}>
              {strategy.label}
            </option>
          ))}
        </select>
        <span className="muted">
          {STRATEGIES.find((strategy) => strategy.value === (settings.portalStrategy ?? ''))?.hint}
        </span>
      </label>

      <hr />

      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={enabled || confirming}
          onChange={(event) => {
            setStatus('');
            if (event.target.checked) setConfirming(true);
            else void disable();
          }}
        />
        <span>Automatically create employer portal accounts when required</span>
      </label>

      {enabled ? (
        <p className="muted">
          On since {new Date(settings.acknowledgedAt ?? '').toLocaleString()}. The agent still stops
          for a CAPTCHA, a verification code, or an email confirmation, and it never submits an
          application.
        </p>
      ) : null}

      {confirming && !enabled ? (
        <div className="callout callout--warning">
          <p>{ACCOUNT_CREATION_DISCLOSURE}</p>
          <div className="row">
            <button type="button" onClick={() => void confirm()}>
              I understand — let the agent create employer accounts
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={settings.saveToVault}
          onChange={(event) => {
            void persist({ saveToVault: event.target.checked });
            setStatus('Saved.');
          }}
        />
        <span>
          Save the generated password in this extension’s encrypted vault
          <span className="muted">
            {' '}
            — turn this off to let your browser’s own password manager catch it instead.
          </span>
        </span>
      </label>

      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}
