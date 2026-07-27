import { useEffect, useState } from 'react';
import type {
  AnswerGenerationStore,
  ApplicationScanResult,
  DeterministicFillPlan,
  FillRunReport,
  HealthResponse,
} from '@internship-agent/shared';
import { sendMessage } from '../../messaging/messages.js';
import { loadSettings } from '../../storage/settings.js';

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

export function DiagnosticsSection(): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

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
            <dt>Git build hash</dt>
            <dd>Not embedded in this local build</dd>
          </div>
          <div>
            <dt>Latest migration</dt>
            <dd>{value(diagnostics.server?.database.schemaVersion)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
