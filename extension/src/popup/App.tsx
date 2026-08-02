import { ATS_DISPLAY_NAMES } from '@internship-agent/shared';
import { StatusRow, type StatusTone } from './StatusRow.js';
import { usePopupState } from './usePopupState.js';
import { useAutofillState } from './useAutofillState.js';
import { AutofillPanel } from './AutofillPanel.js';

const NOT_YET = 'Not analyzed yet';

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
  const {
    status,
    tab,
    loading,
    refresh,
    scanState,
    scan,
    progress,
    scanError,
    cancel,
  } = usePopupState();
  const autofill = useAutofillState(tab.url);
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
              ? 'The content script is not reachable on this tab. Reload the page after installing or updating the extension.'
              : null
          }
        />
        <StatusRow
          label="ATS"
          tone={currentScan ? 'ok' : 'idle'}
          value={currentScan?.ats.displayName ?? ATS_DISPLAY_NAMES.unknown}
          detail={currentScan?.ats.detectionReason}
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
          <strong>{scanError.code}</strong> {scanError.message}
          <span className="status-row__action">{scanError.suggestedAction}</span>
        </section>
      ) : null}
      {applicationFormDetected || autofill.bundle ? (
        <AutofillPanel
          state={autofill}
          eligible={eligible}
          fieldsDetected={currentScan?.statistics.total ?? null}
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
      </footer>
    </main>
  );
}
