import { useEffect, useState } from 'react';
import { AGENT_SERVER_URL } from '@internship-agent/shared';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from '../../storage/settings.js';
import { sendMessage } from '../../messaging/messages.js';
import { TextField } from '../components/Field.js';

type SaveState = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string };

export interface ConnectionSectionProps {
  /**
   * Called after the connection settings change. On first run the profile is
   * fetched before a token exists, so that request fails; once the token is
   * saved the profile must be re-fetched rather than leaving a stale error.
   */
  onConnectionChanged?: () => void;
}

export function ConnectionSection({ onConnectionChanged }: ConnectionSectionProps): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void loadSettings().then((stored) => {
      setSettings(stored);
      setLoaded(true);
    });
  }, []);

  const update = (patch: Partial<ExtensionSettings>): void => {
    setSettings((current) => ({ ...current, ...patch }));
    setSaveState({ kind: 'idle' });
  };

  const onSave = (): void => {
    void (async () => {
      try {
        setSettings(await saveSettings(settings));
        setSaveState({ kind: 'saved' });
        onConnectionChanged?.();
      } catch (cause) {
        setSaveState({
          kind: 'error',
          message: `Could not write to extension storage: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
    })();
  };

  const onTest = (): void => {
    setTesting(true);
    setTestResult(null);
    void (async () => {
      await saveSettings(settings);
      const status = await sendMessage({ type: 'AGENT_STATUS_REQUEST' });

      if (status.error) {
        setTestResult({
          ok: false,
          text: `${status.error.message} ${status.error.suggestedAction}`,
        });
      } else if (status.health) {
        const ollama = status.health.ollama;
        setTestResult({
          ok: status.health.authenticated,
          text:
            `Server reachable in ${status.latencyMs}ms (v${status.health.version}, schema v${status.health.database.schemaVersion}). ` +
            `Ollama: ${ollama.state}${
              ollama.state === 'connected'
                ? ` with ${ollama.modelCount ?? 0} model${ollama.modelCount === 1 ? '' : 's'}`
                : ` — ${ollama.error?.message ?? 'no detail reported'}`
            }. Token accepted: ${status.health.authenticated ? 'yes' : 'no'}.`,
        });
      }
      setTesting(false);
      onConnectionChanged?.();
    })();
  };

  if (!loaded) return <p className="muted">Loading settings…</p>;

  return (
    <>
      <h2>Local agent server</h2>
      <p className="section-note">
        The agent server runs on your machine and binds to loopback only. Nothing here is sent to a
        remote service.
      </p>

      <TextField
        id="serverUrl"
        label="Server URL"
        type="url"
        value={settings.serverUrl}
        onChange={(serverUrl) => update({ serverUrl })}
        placeholder={AGENT_SERVER_URL}
        hint="Leave this unless you changed AGENT_PORT."
      />
      <TextField
        id="authToken"
        label="Access token"
        type="password"
        value={settings.authToken}
        onChange={(authToken) => update({ authToken })}
        hint={
          <>
            Printed when the server starts, and stored at <code>local-data/agent-token.txt</code>.
            Required for everything except <code>/health</code> and <code>/version</code>.
          </>
        }
      />
      <p className="section-note">
        Select the generation model from the installed-model dropdown in <strong>AI answers</strong>
        .
      </p>

      <div className="options__buttons">
        <button className="primary" type="button" onClick={onSave}>
          Save
        </button>
        <button type="button" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>

      {saveState.kind === 'saved' ? (
        <p className="result result--ok" role="status">
          Settings saved.
        </p>
      ) : null}
      {saveState.kind === 'error' ? (
        <p className="result result--bad" role="alert">
          {saveState.message}
        </p>
      ) : null}
      {testResult ? (
        <p
          className={`result ${testResult.ok ? 'result--ok' : 'result--bad'}`}
          role={testResult.ok ? 'status' : 'alert'}
        >
          {testResult.text}
        </p>
      ) : null}
    </>
  );
}
