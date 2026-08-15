import { useCallback, useEffect, useState } from 'react';
import { AGENT_SERVER_URL } from '@internship-agent/shared';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from '../../storage/settings.js';
import { sendMessage } from '../../messaging/messages.js';
import { TextField } from '../components/Field.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { BUILD_ID } from '../../generated/buildInfo.js';

type SaveState = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string };

/**
 * What the extension knows about the local server right now.
 *
 * Held separately from the form values because they answer different questions:
 * the form is what you are about to save, and this is what is actually true of
 * the connection. A page that showed only the form could report a URL that has
 * never been reached as though it were connected.
 */
interface Connection {
  reachable: boolean;
  authenticated: boolean;
  serverVersion: string;
  schemaVersion: number | null;
  latencyMs: number | null;
  detail: string;
}

/** Where the last good connection is remembered. UI state, not configuration. */
const LAST_CONNECTED_KEY = 'connectionLastSucceededAt';

export interface ConnectionSectionProps {
  /**
   * Called after the connection settings change. On first run the profile is
   * fetched before a token exists, so that request fails; once the token is
   * saved the profile must be re-fetched rather than leaving a stale error.
   */
  onConnectionChanged?: () => void;
}

/**
 * A token, shown as evidence that one is stored rather than as the token.
 *
 * The first four characters are enough to tell a stale paste from the current
 * one; the rest is not the settings page's to display, and it is on screen in a
 * window the user may well be sharing.
 */
function maskToken(token: string): string {
  if (!token) return 'Not set';
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}${'•'.repeat(12)}${token.slice(-2)}`;
}

export function ConnectionSection({ onConnectionChanged }: ConnectionSectionProps): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then((stored) => {
      setSettings(stored);
      setLoaded(true);
    });
    void chrome.storage.local.get(LAST_CONNECTED_KEY).then((stored: Record<string, unknown>) => {
      const value = stored[LAST_CONNECTED_KEY];
      if (typeof value === 'string') setLastConnectedAt(value);
    });
  }, []);

  /**
   * Asks the worker what the server says, and records the answer.
   *
   * The same call backs both the status panel and the Test connection button —
   * two ways of asking would eventually disagree, and the panel would then be
   * reporting a connection the button had just failed to make.
   */
  const check = useCallback(async (announce: boolean): Promise<void> => {
    const status = await sendMessage({ type: 'AGENT_STATUS_REQUEST' });

    if (status.error || !status.health) {
      setConnection({
        reachable: false,
        authenticated: false,
        serverVersion: '—',
        schemaVersion: null,
        latencyMs: null,
        detail: status.error
          ? `${status.error.message} ${status.error.suggestedAction}`
          : 'The server did not answer.',
      });
      if (announce && status.error) {
        setTestResult({
          ok: false,
          text: `${status.error.message} ${status.error.suggestedAction}`,
        });
      }
      return;
    }

    const ollama = status.health.ollama;
    const text =
      `Server reachable in ${status.latencyMs}ms (v${status.health.version}, schema v${status.health.database.schemaVersion}). ` +
      `Ollama: ${ollama.state}${
        ollama.state === 'connected'
          ? ` with ${ollama.modelCount ?? 0} model${ollama.modelCount === 1 ? '' : 's'}`
          : ` — ${ollama.error?.message ?? 'no detail reported'}`
      }. Token accepted: ${status.health.authenticated ? 'yes' : 'no'}.`;

    setConnection({
      reachable: true,
      authenticated: status.health.authenticated,
      serverVersion: status.health.version,
      schemaVersion: status.health.database.schemaVersion,
      latencyMs: status.latencyMs,
      detail: text,
    });
    // Recorded only when the server both answered and accepted the token: a
    // 401 is a reply, not a connection the user can work with.
    if (status.health.authenticated) {
      const at = new Date().toISOString();
      setLastConnectedAt(at);
      void chrome.storage.local.set({ [LAST_CONNECTED_KEY]: at });
    }
    if (announce) setTestResult({ ok: status.health.authenticated, text });
  }, []);

  // Asked once when the page opens, so the panel states what is true rather
  // than waiting for the user to press a button to find out.
  useEffect(() => {
    if (!loaded) return;
    void check(false);
  }, [loaded, check]);

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
        await check(false);
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
      await check(true);
      setTesting(false);
      onConnectionChanged?.();
    })();
  };

  if (!loaded) return <p className="muted">Loading settings…</p>;

  const state = !connection
    ? { tone: 'idle' as const, label: 'Checking' }
    : connection.reachable && connection.authenticated
      ? { tone: 'verified' as const, label: 'Connected' }
      : connection.reachable
        ? { tone: 'warning' as const, label: 'Token rejected' }
        : { tone: 'danger' as const, label: 'Disconnected' };

  return (
    <>
      <h2>Local agent server</h2>
      <p className="section-note">
        The agent server runs on your machine and binds to loopback only. Nothing here is sent to a
        remote service.
      </p>

      {/*
        The connection as it actually is, before the form that changes it. Every
        line is a fact the extension has observed — the versions come from the
        server's own reply, and "last connected" is only written when the token
        was accepted.
      */}
      <section className="connection" aria-label="Connection status">
        <header className="connection__head">
          <StatusBadge tone={state.tone} label={state.label} size="lg" live />
          {connection?.latencyMs !== null && connection?.latencyMs !== undefined ? (
            <span className="connection__latency mono">{connection.latencyMs}ms</span>
          ) : null}
        </header>
        <dl className="diagnostics-grid">
          <div>
            <dt>Server URL</dt>
            <dd className="mono">{settings.serverUrl}</dd>
          </div>
          <div>
            <dt>Access token</dt>
            <dd className="mono">{maskToken(settings.authToken)}</dd>
          </div>
          <div>
            <dt>Server version</dt>
            <dd className="mono">
              {connection?.reachable
                ? `${connection.serverVersion} · schema v${connection.schemaVersion ?? '—'}`
                : 'Unknown'}
            </dd>
          </div>
          <div>
            <dt>Extension build</dt>
            <dd className="mono">{BUILD_ID}</dd>
          </div>
          <div>
            <dt>Last successful connection</dt>
            <dd>{lastConnectedAt ? new Date(lastConnectedAt).toLocaleString() : 'Never'}</dd>
          </div>
        </dl>
      </section>

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
        {/*
          Reconnect re-asks with the settings already stored, without saving the
          form. It is the control for "the server was down and I have started
          it", which is a different action from "I have changed something".
        */}
        <button type="button" onClick={() => void check(false)} disabled={testing}>
          Reconnect
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
