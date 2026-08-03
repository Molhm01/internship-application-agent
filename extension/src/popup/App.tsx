import { useEffect } from 'react';
import { ATS_DISPLAY_NAMES, RECONNECT_MESSAGE } from '@internship-agent/shared';
import { BUILD_INFO } from '../generated/buildInfo.js';
import { StatusRow, type StatusTone } from './StatusRow.js';
import { usePopupState } from './usePopupState.js';
import { useAutofillState } from './useAutofillState.js';
import { usePortalRoute } from './usePortalRoute.js';
import { AutofillPanel } from './AutofillPanel.js';

const NOT_YET = 'Not analyzed yet';

/**
 * The only thing a normal user is told when a scan fails recoverably.
 *
 * Deliberately one sentence with one instruction. The underlying error can be a
 * schema rejection whose message is a JSON dump of Zod issues; that belongs in
 * the console, not in the popup.
 */
const RECOVERABLE_SCAN_MESSAGE =
  'Application analysis failed. Reload the extension and page, then try again.';

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function FailureDetail({
  message,
  suggestedAction,
}: {
  message: string;
  suggestedAction: string;
}): JSX.Element {
  return (
    <>
      {message}
      <span className="status-row__action">{suggestedAction}</span>
    </>
  );
}

export function App(): JSX.Element {
  const { status, tab, loading, refresh, scanState, scan, progress, scanError, cancel } =
    usePopupState();
  const autofill = useAutofillState(tab.url);
  // Development detail goes to the console only, and carries no field values —
  // a scan holds whatever the user typed, which can be a password.
  useEffect(() => {
    if (!scanError) return;
    console.warn('[agent] scan failed', {
      code: scanError.code,
      build: BUILD_INFO.commit,
      builtAt: BUILD_INFO.builtAt,
      sourceRoot: BUILD_INFO.sourceRoot,
      ...(scanError.debugContext ?? {}),
    });
  }, [scanError]);
  // The route decision is made in the background worker, which owns both the
  // saved strategy and the scan those routes came from. The popup asks what the
  // decision is and renders it; it does not re-derive it, because two copies of
  // this rule would eventually disagree about whether an account gets created.
  //
  // Re-asked whenever the scan changes, so a route hop re-evaluates the page it
  // landed on rather than the one it left.
  const portal = usePortalRoute(tab.url, scan?.id ?? null, refresh);
  const routeOffered =
    portal.route !== null && !('error' in portal.route) && portal.route.decision !== 'none';
  // What the AI can actually do right now, said plainly. An unreachable agent
  // is reported as such rather than as a bare error code.
  const agentStatus = loading
    ? null
    : !status?.health
      ? 'AI agent unavailable. Deterministic autofill still works from your saved profile.'
      : status.health.ollama.state === 'connected'
        ? 'AI agent connected.'
        : 'AI agent unavailable: the local model is not answering. Deterministic autofill still works.';
  const serverConnected = Boolean(status?.health);
  const health = status?.health;
  const ollama = health?.ollama;
  const ollamaConnected = ollama?.state === 'connected';
  const serverTone: StatusTone = loading ? 'idle' : serverConnected ? 'ok' : 'bad';
  const ollamaTone: StatusTone = loading
    ? 'idle'
    : !serverConnected
      ? 'idle'
      : ollamaConnected
        ? 'ok'
        : 'bad';
  const serverDetail =
    !loading && status?.error ? (
      <FailureDetail
        message={status.error.message}
        suggestedAction={status.error.suggestedAction}
      />
    ) : null;
  const ollamaDetail =
    !loading && serverConnected && ollama?.error ? (
      <FailureDetail
        message={ollama.error.message}
        suggestedAction={ollama.error.suggestedAction}
      />
    ) : null;
  const modelValue = !serverConnected
    ? 'Unknown'
    : !ollama?.selectedModel
      ? 'Not configured'
      : ollamaConnected && ollama.selectedModelInstalled === false
        ? `${ollama.selectedModel} (not installed)`
        : ollama.selectedModel;
  const modelTone: StatusTone = !serverConnected
    ? 'idle'
    : ollamaConnected && ollama?.selectedModelInstalled === false
      ? 'warn'
      : ollamaConnected
        ? 'ok'
        : 'idle';
  const profile: { tone: StatusTone; value: string; detail: string | null } = !serverConnected
    ? { tone: 'idle', value: 'Unknown', detail: null }
    : !status?.tokenConfigured
      ? {
          tone: 'warn',
          value: 'Token required',
          detail: 'Paste the agent server token in settings before reading your saved profile.',
        }
      : !health?.profileLoaded
        ? {
            tone: 'warn',
            value: 'Not created',
            detail: 'Open settings and fill in at least your name and contact details.',
          }
        : health.profileCompleteness
          ? {
              tone: health.profileCompleteness.percent === 100 ? 'ok' : 'warn',
              value: `${health.profileCompleteness.percent}% complete`,
              detail: (() => {
                const missing = health.profileCompleteness.sections.filter(
                  (section) => section.required && !section.complete,
                );
                return missing.length
                  ? `Still needed: ${missing.map((section) => section.label).join(', ')}.`
                  : `All ${health.profileCompleteness.totalRequiredSections} required sections are filled in.`;
              })(),
            }
          : {
              tone: 'warn',
              value: 'Saved, unreadable',
              detail:
                'A profile exists but could not be read against the current schema. Open settings to see which sections need re-entering.',
            };
  const resume: { tone: StatusTone; value: string; detail: string | null } = !serverConnected
    ? { tone: 'idle', value: 'Unknown', detail: null }
    : !status?.tokenConfigured
      ? { tone: 'warn', value: 'Token required', detail: null }
      : status.selectedResume
        ? {
            tone: 'ok',
            value: status.selectedResume.name,
            detail:
              status.selectedResume.reason === 'user_selected'
                ? 'Chosen explicitly for the next application.'
                : 'Your default resume.',
          }
        : status.selectedResume === null
          ? {
              tone: 'warn',
              value: 'None registered',
              detail: 'Add a resume in settings.',
            }
          : { tone: 'warn', value: 'Unknown', detail: 'The document list could not be read.' };
  const currentScan = scan?.url === tab.url ? scan : null;
  const eligible = Boolean(tab.url?.startsWith('http') && tab.contentScriptReachable);
  const applicationFormDetected = Boolean(currentScan && currentScan.statistics.total > 0);
  // A page the extension cannot talk to has told us nothing about itself. Saying
  // "no supported application form detected" there is a diagnosis we have not
  // earned, and it sent people to reinstall the extension when a refresh was
  // the whole fix.
  const disconnected = Boolean(tab.url?.startsWith('http')) && !tab.contentScriptReachable;

  return (
    <main className="popup">
      <header className="popup__header">
        <h1>Internship Application Agent</h1>
        <button className="link-button" onClick={refresh} disabled={loading} type="button">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </header>
      <section aria-label="Connection status" className="panel">
        <StatusRow
          label="Agent Server"
          tone={serverTone}
          value={loading ? 'Checking…' : serverConnected ? 'Connected' : 'Disconnected'}
          detail={
            serverDetail ??
            (serverConnected ? `${status?.serverUrl} · ${status?.latencyMs}ms` : null)
          }
        />
        <StatusRow
          label="Ollama"
          tone={ollamaTone}
          value={
            loading
              ? 'Checking…'
              : !serverConnected
                ? 'Unknown — server unreachable'
                : ollamaConnected
                  ? 'Connected'
                  : 'Disconnected'
          }
          detail={
            ollamaDetail ??
            (ollamaConnected
              ? `${ollama?.baseUrl} · ${ollama?.modelCount ?? 0} ${
                  ollama?.modelCount === 1 ? 'model' : 'models'
                } installed`
              : null)
          }
        />
        <StatusRow label="Model" tone={modelTone} value={modelValue} />
        <StatusRow
          label="Profile"
          tone={profile.tone}
          value={profile.value}
          detail={profile.detail}
        />
      </section>
      <section aria-label="Current page" className="panel">
        <StatusRow
          label="Current Site"
          tone={tab.domain ? 'ok' : 'idle'}
          value={tab.domain ?? 'No page detected'}
          detail={
            tab.domain && !tab.contentScriptReachable
              ? // One sentence, and the same one the worker uses. The old text
                // blamed "the content script", which is not a thing the person
                // reading it has any way to act on.
                RECONNECT_MESSAGE
              : tab.reconnected
                ? 'Reconnected to this page after the extension was reloaded.'
                : null
          }
        />
        <StatusRow
          label="ATS"
          tone={currentScan ? 'ok' : 'idle'}
          // The scan's answer when there is one, the page's own detection
          // otherwise. The second is what keeps the vendor visible when a scan
          // fails, which is when knowing it matters most.
          value={currentScan?.ats.displayName ?? tab.ats?.displayName ?? ATS_DISPLAY_NAMES.unknown}
          detail={currentScan?.ats.detectionReason ?? tab.ats?.reason ?? null}
        />
        <StatusRow
          label="Fields Detected"
          tone={currentScan ? 'ok' : 'idle'}
          value={currentScan ? currentScan.statistics.total : NOT_YET}
        />
        <StatusRow
          label="Selected Resume"
          tone={resume.tone}
          value={resume.value}
          detail={resume.detail}
        />
      </section>
      {scanState === 'scanning' ? (
        <section className="panel scan-progress" aria-live="polite">
          <strong>{progress?.message ?? 'Starting read-only scan…'}</strong>
          <progress max="100" value={progress?.percent ?? 5} />
          <button type="button" onClick={() => void cancel()}>
            Cancel scan
          </button>
        </section>
      ) : null}
      {scanError ? (
        <section className="result result--bad" role="alert">
          {/*
            A recoverable scan failure says one thing and nothing else. The
            error's own `message` can be a schema rejection, and rendering that
            put a raw Zod dump — including the validator's accepted-value list —
            in front of somebody who wanted to apply for a job. The list read as
            "your page is unsupported" when the truth was "this build is stale".
            The code and the details stay in the console for development.
          */}
          {RECOVERABLE_SCAN_MESSAGE}
        </section>
      ) : null}
      {disconnected ? (
        <section aria-label="Application" className="panel">
          <p role="alert">{RECONNECT_MESSAGE}</p>
        </section>
      ) : applicationFormDetected || autofill.bundle || routeOffered ? (
        <AutofillPanel
          state={autofill}
          eligible={eligible}
          fieldsDetected={currentScan?.statistics.total ?? null}
          {...(currentScan?.navigation ? { navigation: currentScan.navigation } : {})}
          route={portal.route}
          followingRoute={portal.following}
          onFollowRoute={() => void portal.follow()}
          agentStatus={agentStatus}
        />
      ) : scanState === 'scanning' || loading ? (
        <section aria-label="Application" className="panel">
          <button type="button" className="primary" disabled>
            Detecting application form…
          </button>
        </section>
      ) : (
        <section aria-label="Application" className="panel">
          <p>No supported application form detected on this page</p>
        </section>
      )}
      <section aria-label="Actions" className="popup__actions">
        <button type="button" className="primary" onClick={openSettings}>
          Open Settings
        </button>
      </section>
      <footer className="popup__footer">
        <p>Only explicitly approved deterministic actions can change fields.</p>
        <p>This agent never submits an application.</p>
        {/*
          Which build this actually is. A stale unpacked extension loaded from a
          sibling copy of the repository is otherwise indistinguishable from a
          current one, and that is exactly how a validator came to disagree with
          the scanner that feeds it.
        */}
        <p className="popup__build" title={BUILD_INFO.sourceRoot}>
          Build {BUILD_INFO.commit} · {new Date(BUILD_INFO.builtAt).toLocaleString()}
        </p>
        <p className="popup__build popup__build--path">{BUILD_INFO.sourceRoot}</p>
      </footer>
    </main>
  );
}
