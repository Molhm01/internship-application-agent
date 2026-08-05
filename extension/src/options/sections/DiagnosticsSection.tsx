import { useEffect, useState } from 'react';
import type {
  AnswerGenerationStore,
  ApplicationScanResult,
  DeterministicFillPlan,
  FillRunReport,
  HealthResponse,
  ProfileFieldStatus,
  RunTrace,
} from '@internship-agent/shared';
import { describeRunTrace } from '@internship-agent/shared';
import { sendMessage, type ExtensionResponse } from '../../messaging/messages.js';
import { loadSettings } from '../../storage/settings.js';
import { BUILD_ID, BUILD_INFO } from '../../generated/buildInfo.js';

interface Diagnostics {
  extensionVersion: string;
  server?: HealthResponse;
  serverUrl: string;
  aiEnabled: boolean;
  selectedModel: string;
  lastScan: ApplicationScanResult | null;
  lastPlan: DeterministicFillPlan | null;
  lastReport: FillRunReport | null;
  generations: AnswerGenerationStore | null;
}

function value(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'None';
  return String(value);
}

/** The order statuses are listed in: what changed first, what is absent last. */
const SYNC_STATUS_ORDER: readonly ProfileFieldStatus[] = [
  'imported',
  'updated',
  'invalid',
  'unmapped',
  'present',
  'missing',
];

export function DiagnosticsSection(): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [traces, setTraces] = useState<RunTrace[]>([]);
  const [sync, setSync] = useState<ExtensionResponse<'SYNC_PROFILE'> | null>(null);
  const [syncing, setSyncing] = useState(false);

  /**
   * Runs the profile import and shows what it did, key by key.
   *
   * This is the answer to "the extension is asking me for things I already
   * entered": it names which keys came across, which were already here, and
   * which nobody holds — without ever showing what any of them contain.
   */
  const syncProfile = async (): Promise<void> => {
    setSyncing(true);
    try {
      setSync(await sendMessage({ type: 'SYNC_PROFILE' }));
    } catch (cause) {
      setSync(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    let active = true;
    void sendMessage({ type: 'GET_RUN_TRACES' }).then((result) => {
      if (active) setTraces(result.traces);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  /**
   * Writes the traces to a file the user chooses.
   *
   * A download rather than a copy-to-clipboard: a trace over a large form is
   * several hundred lines, and the point of it is to be attachable to a bug
   * report intact.
   */
  const exportTraces = (): void => {
    const blob = new Blob([JSON.stringify(traces, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `autofill-run-traces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    anchor.click();
    // Revoked immediately: the click has already handed the blob to the
    // download, and leaving the URL alive pins the data in memory.
    URL.revokeObjectURL(url);
  };

  const clearTraces = async (): Promise<void> => {
    await sendMessage({ type: 'CLEAR_RUN_TRACES' });
    setTraces([]);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadSettings(),
      sendMessage({ type: 'AGENT_STATUS_REQUEST' }),
      sendMessage({ type: 'GET_LAST_SCAN' }),
      sendMessage({ type: 'GET_FILL_PLAN' }),
      sendMessage({ type: 'GET_GENERATED_ANSWERS' }),
    ])
      .then(([settings, status, scan, plan, generations]) => {
        if (!active) return;
        setDiagnostics({
          extensionVersion: chrome.runtime.getManifest().version,
          server: status.health,
          serverUrl: settings.serverUrl,
          aiEnabled: settings.aiGenerationEnabled,
          selectedModel: settings.selectedModel,
          lastScan: 'scan' in scan ? scan.scan : null,
          lastPlan: 'plan' in plan ? plan.plan : null,
          lastReport: 'report' in plan ? plan.report : null,
          generations: 'store' in generations ? generations.store : null,
        });
        setError(status.error?.message ?? '');
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const latestGenerationError = diagnostics?.generations?.records
    .filter((record) => record.error)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.error;

  return (
    <section aria-labelledby="diagnostics-heading">
      <h2 id="diagnostics-heading">Diagnostics</h2>
      <p className="muted">No authentication token or answer text is shown here.</p>
      <button type="button" onClick={() => setRefresh((current) => current + 1)}>
        Refresh diagnostics
      </button>
      {error ? (
        <p className="result result--bad" role="alert">
          {error}
        </p>
      ) : null}
      {!diagnostics ? (
        <p className="muted">Loading diagnostics…</p>
      ) : (
        <dl className="diagnostics-grid">
          <div>
            <dt>Extension version</dt>
            <dd>{diagnostics.extensionVersion}</dd>
          </div>
          <div>
            <dt>Server version</dt>
            <dd>{value(diagnostics.server?.version)}</dd>
          </div>
          <div>
            <dt>Schema version</dt>
            <dd>{value(diagnostics.server?.database.schemaVersion)}</dd>
          </div>
          <div>
            <dt>Database path</dt>
            <dd>{value(diagnostics.server?.database.path)}</dd>
          </div>
          <div>
            <dt>Server URL</dt>
            <dd>{diagnostics.serverUrl}</dd>
          </div>
          <div>
            <dt>Server status</dt>
            <dd>{value(diagnostics.server?.status)}</dd>
          </div>
          <div>
            <dt>AI enabled</dt>
            <dd>{diagnostics.aiEnabled ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Ollama URL</dt>
            <dd>{value(diagnostics.server?.ollama.baseUrl)}</dd>
          </div>
          <div>
            <dt>Ollama status</dt>
            <dd>{value(diagnostics.server?.ollama.state)}</dd>
          </div>
          <div>
            <dt>Selected model</dt>
            <dd>{value(diagnostics.selectedModel)}</dd>
          </div>
          <div>
            <dt>Last scan</dt>
            <dd>{value(diagnostics.lastScan?.createdAt)}</dd>
          </div>
          <div>
            <dt>Last fill plan</dt>
            <dd>{value(diagnostics.lastPlan?.updatedAt)}</dd>
          </div>
          <div>
            <dt>Last fill run</dt>
            <dd>{value(diagnostics.lastReport?.completedAt)}</dd>
          </div>
          <div>
            <dt>Last generation error</dt>
            <dd>{value(latestGenerationError?.code)}</dd>
          </div>
          <div>
            <dt>Build</dt>
            {/* It is embedded now, and it is the first thing to check when the
                extension behaves like code that is not in the repository. */}
            <dd>{BUILD_ID}</dd>
          </div>
          <div>
            <dt>Built at</dt>
            <dd>{new Date(BUILD_INFO.builtAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Built from</dt>
            <dd>{BUILD_INFO.sourceRoot}</dd>
          </div>
          <div>
            <dt>Latest migration</dt>
            <dd>{value(diagnostics.server?.database.schemaVersion)}</dd>
          </div>
        </dl>
      )}
      <h3>Profile synchronization</h3>
      {/*
        Key names and statuses only. There is no code path here that can render
        a profile value or a document byte: the worker returns
        `profileSyncEntrySchema`, whose only fields are a key and a status.
      */}
      <p className="muted">
        Imports the profile you maintain on Internship Pilot into this
        extension. Nothing you have already entered here is overwritten, and no
        value is shown below — only which keys were found.
      </p>
      <button type="button" onClick={() => void syncProfile()} disabled={syncing}>
        {syncing ? 'Syncing profile…' : 'Sync profile now'}
      </button>
      {sync === null ? null : sync.ok ? (
        <>
          <p className={sync.changed ? 'result result--good' : 'muted'}>
            {sync.changed
              ? `Imported from ${sync.sources.join(', ')}.`
              : `Already up to date with ${sync.sources.join(', ')}.`}
            {sync.migratedFrom === null
              ? ''
              : ` The stored profile was migrated from format v${sync.migratedFrom}.`}
          </p>
          <ul className="diagnostics-sync">
            {[...sync.report]
              .sort(
                (left, right) =>
                  SYNC_STATUS_ORDER.indexOf(left.status) - SYNC_STATUS_ORDER.indexOf(right.status),
              )
              .map((entry) => (
                <li key={entry.key}>
                  <code>{entry.key}</code>: {entry.status}
                </li>
              ))}
          </ul>
        </>
      ) : (
        <p className="result result--bad" role="alert">
          {sync.error?.message ?? 'The profile could not be synchronized.'}
          {sync.error?.suggestedAction ? ` ${sync.error.suggestedAction}` : ''}
        </p>
      )}

      <h3>Autofill run traces</h3>
      {/*
        Counts and outcomes only — no field values, no passwords, no document
        contents, no profile data, no model prompts. `runTraceSchema` is strict,
        so nothing else can be in here even if a future caller tries.
      */}
      <p className="muted">
        The last {traces.length === 1 ? 'run' : `${traces.length} runs`}, in counts only. No field
        values, documents, or profile data are recorded.
      </p>
      <button type="button" onClick={exportTraces} disabled={traces.length === 0}>
        Export run traces
      </button>
      <button type="button" onClick={() => void clearTraces()} disabled={traces.length === 0}>
        Clear run traces
      </button>
      {traces.length === 0 ? (
        <p className="muted">No autofill run has been recorded yet.</p>
      ) : (
        <ul className="diagnostics-traces">
          {traces.map((trace) => (
            <li key={trace.runId}>
              <strong>{trace.origin}</strong> · {trace.normalizedQuestions} questions ·{' '}
              {trace.deterministicVerified} verified · {trace.aiRequests} AI request
              {trace.aiRequests === 1 ? '' : 's'} · {Math.round(trace.totalDurationMs / 100) / 10}s
              <ul>
                {describeRunTrace(trace).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
