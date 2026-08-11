import { useEffect, useState } from 'react';
import type {
  AnswerGenerationStore,
  ApplicationScanResult,
  AutofillRunTraceExport,
  DeterministicFillPlan,
  FillRunReport,
  HealthResponse,
  PageControlTrace,
  ProfileFieldStatus,
  RunTrace,
} from '@internship-agent/shared';
import {
  describeAvailabilityGaps,
  describeDependency,
  describeLiveDropdown,
  describeRepeaterSection,
  describeRunTrace,
} from '@internship-agent/shared';
import { sendMessage, type ExtensionResponse } from '../../messaging/messages.js';
import { loadSettings, saveSettings } from '../../storage/settings.js';
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
  const [exported, setExported] = useState<AutofillRunTraceExport | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [pageTrace, setPageTrace] = useState<PageControlTrace | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState('');
  /**
   * The run-trace export is a development tool, so it is behind the same switch
   * as every other one.
   *
   * Not a security boundary — the trace holds no personal data by construction —
   * but a product one. Someone applying for a job is offered one button; a page
   * of JSON export controls is what turned the diagnostics into the product last
   * time. Read from settings rather than from a build flag so a user chasing a
   * bug can turn it on without a rebuild.
   */
  const [developerMode, setDeveloperMode] = useState(false);

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

  /**
   * The last run, field by field, as one document.
   *
   * This is the answer to "why was this field not filled?" for every field at
   * once: each record names the question, the control, whether a saved value
   * existed, what was planned, whether the executor was invoked, what
   * verification observed, the final status, and how long it took. The summary
   * at the top says where the run lost the fields it did not fill.
   *
   * Nothing personal can be in it. `fieldTraceSchema` is strict and has no
   * member capable of holding a value, a password, a document, or a model
   * prompt — so this is safe to attach to a bug report without reading it
   * first.
   */
  const exportRunTrace = async (): Promise<void> => {
    setExporting(true);
    setExportError('');
    try {
      const result = await sendMessage({ type: 'EXPORT_AUTOFILL_RUN_TRACE' });
      if ('error' in result) {
        setExportError(`${result.error.message} ${result.error.suggestedAction}`);
        return;
      }
      const blob = new Blob([JSON.stringify(result.export, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `autofill-run-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExported(result.export);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  /**
   * A frame-by-frame account of the upload controls on the page in front of you.
   *
   * This exists so a visible "My Computer" button cannot be silently ignored. It
   * reports every frame, how many file inputs each holds, how many of those are
   * hidden, how many upload launchers were seen, and how each one was — or was
   * not — resolved to something a file can be put into. Nothing personal is in
   * it: no field values, no page text, only structural counts and identifiers.
   *
   * Attaching nothing is the point. It never activates a launcher and never
   * carries a document byte, so it is safe to run on any page at any time.
   */
  const exportPageControls = async (): Promise<void> => {
    setTracing(true);
    setTraceError('');
    try {
      const result = await sendMessage({ type: 'EXPORT_PAGE_CONTROL_TRACE' });
      if ('error' in result) {
        setTraceError(result.error.message);
        return;
      }
      const blob = new Blob([JSON.stringify(result.trace, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `page-control-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setPageTrace(result.trace);
    } catch (cause) {
      setTraceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTracing(false);
    }
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
        setDeveloperMode(settings.developerMode);
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
        Imports the profile you maintain on Internship Pilot into this extension. Nothing you have
        already entered here is overwritten, and no value is shown below — only which keys were
        found.
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

      {/*
        The switch that turns the rest of this on.

        It lives here rather than in a Preferences panel because here is where a
        person is told they need it: the export buttons below used to say "turn
        on developer mode in Preferences" with no such control anywhere in the
        extension, and the setting was dropped by settings normalization on
        every read even if one had existed. Both halves of that are fixed; this
        is the half a user can see.
      */}
      <h3>Developer mode</h3>
      <label htmlFor="developer-mode">
        <input
          id="developer-mode"
          type="checkbox"
          checked={developerMode}
          onChange={(event) => {
            const enabled = event.target.checked;
            setDeveloperMode(enabled);
            void saveSettings({ developerMode: enabled }).catch((cause: unknown) => {
              // Reverted rather than left showing a state that was not stored.
              setDeveloperMode(!enabled);
              setError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        />{' '}
        Show diagnostic tools
      </label>
      <p className="muted">
        Adds the run-trace and dropdown-trace exports, the fill-plan builder, and raw confidence and
        validation output. No personal data is shown either way.
      </p>

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
      {/*
        The field-by-field export sits first because it is the one a bug report
        needs: the rolling list below answers "how have runs been going", this
        answers "what happened to each field on the last one, and why".
      */}
      {developerMode ? (
        <button type="button" onClick={() => void exportRunTrace()} disabled={exporting}>
          {exporting ? 'Collecting the run…' : 'Export Autofill Run Trace'}
        </button>
      ) : (
        <p className="muted">Turn on developer mode above to export the last run field by field.</p>
      )}
      <button type="button" onClick={exportTraces} disabled={traces.length === 0}>
        Export run traces
      </button>
      <button type="button" onClick={() => void clearTraces()} disabled={traces.length === 0}>
        Clear run traces
      </button>
      {exportError ? (
        <p className="result result--bad" role="alert">
          {exportError}
        </p>
      ) : null}
      {exported ? (
        <ul className="diagnostics-traces">
          <li>
            <strong>
              {exported.trace.fields.length} field
              {exported.trace.fields.length === 1 ? '' : 's'} exported
            </strong>{' '}
            · build {exported.buildId} ·{' '}
            {Object.entries(exported.trace.finalStatusCounts)
              .filter(([, count]) => count > 0)
              .map(([status, count]) => `${count} ${status}`)
              .join(', ')}
            {exported.trace.pendingAtCompletion > 0
              ? ` · ${exported.trace.pendingAtCompletion} still pending`
              : ''}
            <ul>
              {exported.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {/*
              The Repeater Engine Trace.

              Shown separately because it is the one part of a run that cannot
              be read off the field list: a Work Experience block that was never
              created has no field to appear as unanswered, so "you have one job
              saved" and "this page's Add button was never pressed" produced
              identical field-by-field exports. These lines are the difference,
              and they carry indices and counts only — never an employer or a
              school.
            */}
            {/*
              The Dependency Engine Trace.

              Its own list because it answers what the field list cannot:
              "State is empty" is the same sentence whether Country was never
              answered, whether the page never rebuilt the region list, or
              whether the list was rebuilt and the saved state genuinely is not
              on it. Identities, fingerprint counts and codes — never an option
              text and never an answer.
            */}
            {exported.trace.dependencies.length > 0 ? (
              <>
                <strong>Dependency Engine</strong>
                <ul className="diagnostics-dependencies">
                  {exported.trace.dependencies.map((edge) => (
                    <li key={`${edge.parent.nodeId}→${edge.dependent.nodeId}`}>
                      {describeDependency(edge)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {exported.trace.repeaters.length > 0 ? (
              <>
                <strong>Repeater Engine</strong>
                <ul className="diagnostics-repeaters">
                  {exported.trace.repeaters.map((section) => (
                    <li key={`${section.type}:${section.frameId ?? 0}`}>
                      {describeRepeaterSection(section)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {/*
              The Live Dropdown Trace.

              The record a failure on a real employer page is diagnosed from
              without another rewrite. One line per option control, naming which
              pass found it, how the control is built, how its menu was located,
              and the *first* stage that did not happen — because everything
              after that stage is a consequence of it.

              Stage names, counts and codes only. `liveDropdownTraceSchema` is
              strict and has no member able to hold an option label, a displayed
              value, or an answer, so this list cannot leak one even if a future
              caller tries.
            */}
            {/*
              What the profile could answer, before anything about controls.

              The first thing to read when a run comes back with unfilled
              dropdowns, because two different failures look identical from
              outside: a control that could not be driven, and a control with
              nothing to be filled from. Two of Lincoln Electric's — Education
              Country and Education State — are the second kind, and no repair
              to a dropdown would ever have fixed them.

              Booleans and counts. Nothing here can hold a saved value.
            */}
            {exported.trace.profileAvailability ? (
              <>
                <strong>Profile data available to this run</strong>
                <ul className="diagnostics-availability">
                  {describeAvailabilityGaps(exported.trace.profileAvailability).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {exported.trace.dropdownEngineTraces.length > 0 ? (
              <>
                <strong>Dropdown Engine — live trace</strong>
                <p className="muted">
                  {exported.trace.optionActionsDeferred} option action
                  {exported.trace.optionActionsDeferred === 1 ? '' : 's'} deferred to this engine ·{' '}
                  {exported.trace.legacyOptionExecutions} driven by the retired executor
                  {exported.trace.legacyOptionExecutions === 0 ? ' (as it must be)' : ''}
                </p>
                <ul className="diagnostics-dropdowns">
                  {exported.trace.dropdownEngineTraces.map((entry) => (
                    <li key={entry.dropdownId}>{describeLiveDropdown(entry)}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </li>
        </ul>
      ) : null}
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

      <h3>Page control trace</h3>
      {/*
        Structural facts about the page in front of you: frames, file inputs,
        hidden inputs, upload launchers, and how each launcher resolved. Nothing
        typed into the form and nothing from the profile appears here — which is
        what makes it safe to attach to a bug report.
      */}
      <p className="muted">
        Frames, upload controls, and how each one was resolved — for the page in the active tab.
        Counts and identifiers only; no field values or document contents. Nothing is uploaded and
        no button is pressed.
      </p>
      <button type="button" onClick={() => void exportPageControls()} disabled={tracing}>
        {tracing ? 'Inspecting the page…' : 'Export Page Control Trace'}
      </button>
      {traceError ? (
        <p className="result result--bad" role="alert">
          {traceError}
        </p>
      ) : null}
      {pageTrace ? (
        <ul className="diagnostics-traces">
          <li>
            <strong>
              {pageTrace.framesReached} of {pageTrace.totalFrames} frame
              {pageTrace.totalFrames === 1 ? '' : 's'} answered
            </strong>{' '}
            · {Math.round(pageTrace.elapsedMs / 100) / 10}s · build {pageTrace.buildId}
          </li>
          {pageTrace.frames.map((frame) => (
            <li key={frame.frameId}>
              Frame {frame.frameId}
              {frame.topFrame ? ' (main)' : ''} · {frame.frameOrigin} · {frame.fileInputs} file
              input
              {frame.fileInputs === 1 ? '' : 's'} ({frame.hiddenFileInputs} hidden) ·{' '}
              {frame.uploadLaunchers} upload launcher
              {frame.uploadLaunchers === 1 ? '' : 's'} · {frame.cloudLaunchers} cloud button
              {frame.cloudLaunchers === 1 ? '' : 's'} (never used)
              {frame.controls.length > 0 ? (
                <ul>
                  {frame.controls.map((control) => (
                    <li key={control.controlId}>
                      {control.kind} · {control.discovery} ·{' '}
                      {control.accessible ? 'reachable' : 'no reachable file input'}
                      {control.hidden ? ' · hidden' : ''}
                      {control.launcherLabel ? ` · “${control.launcherLabel}”` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
