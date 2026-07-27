import { useEffect, useMemo, useState } from 'react';
import {
  FIELD_SECTION_LABELS,
  scanProgressMessageSchema,
  type AgentError,
  type ApplicationScanResult,
  type DetectedField,
  type ScanProgress,
  type ScanState,
} from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';
import { sanitizeScanForExport } from '../storage/scans.js';

type RequirementFilter = 'all' | 'required' | 'optional';
type ConfidenceFilter = 'all' | 'high' | 'medium' | 'low';

function confidence(field: DetectedField): Exclude<ConfidenceFilter, 'all'> {
  return field.confidence >= 0.8 ? 'high' : field.confidence >= 0.5 ? 'medium' : 'low';
}

function displayValue(value: DetectedField['currentValue']): string {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return 'Empty';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function jsonFor(result: ApplicationScanResult): string {
  return JSON.stringify(sanitizeScanForExport(result), null, 2);
}

function downloadJson(result: ApplicationScanResult): void {
  const blob = new Blob([jsonFor(result)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `application-scan-${result.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function FieldRow({ field }: { field: DetectedField }): JSX.Element {
  const level = confidence(field);
  return (
    <article className="field-card">
      <header>
        <div>
          <h3>{field.question || 'Unlabelled field'}</h3>
          <p>{field.normalizedLabel || 'No normalized label'}</p>
        </div>
        <span className={`confidence confidence--${level}`}>{level} confidence</span>
      </header>
      <dl>
        <div>
          <dt>Canonical key</dt>
          <dd>{field.canonicalKey ?? 'Unrecognized'}</dd>
        </div>
        <div>
          <dt>Field type</dt>
          <dd>{field.fieldType}</dd>
        </div>
        <div>
          <dt>Semantic type</dt>
          <dd>{field.semanticType ?? 'Other / unknown'}</dd>
        </div>
        <div>
          <dt>Requirement</dt>
          <dd>{field.required ? 'Required' : 'Optional'}</dd>
        </div>
        <div>
          <dt>Section</dt>
          <dd>{FIELD_SECTION_LABELS[field.section ?? 'other']}</dd>
        </div>
        <div>
          <dt>Current value</dt>
          <dd className="field-card__value">{displayValue(field.currentValue)}</dd>
        </div>
        <div>
          <dt>Selector</dt>
          <dd>
            <code>{field.selector}</code>
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{Math.round(field.confidence * 100)}%</dd>
        </div>
        <div>
          <dt>Source signals</dt>
          <dd>{field.sourceSignals.join(', ') || 'None'}</dd>
        </div>
      </dl>
      {field.options?.length ? (
        <details>
          <summary>{field.options.length} detected options</summary>
          <ul>
            {field.options.map((option) => (
              <li key={`${option.value}-${option.label}`}>
                {option.label} <code>{option.value}</code>
                {option.selected ? ' — selected' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {field.helpText ? (
        <p>
          <strong>Help:</strong> {field.helpText}
        </p>
      ) : null}
      {field.validationText ? (
        <p>
          <strong>Validation:</strong> {field.validationText}
        </p>
      ) : null}
      {field.warnings.length ? (
        <ul className="warnings">
          {field.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function App(): JSX.Element {
  const [scan, setScan] = useState<ApplicationScanResult | null>(null);
  const [state, setState] = useState<ScanState>('idle');
  const [error, setError] = useState<AgentError | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('all');
  const [fieldType, setFieldType] = useState('all');
  const [requirement, setRequirement] = useState<RequirementFilter>('all');
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    let active = true;
    setState('scanning');
    void sendMessage({ type: 'GET_LAST_SCAN' }).then((response) => {
      if (!active) return;
      setScan(response.scan ?? null);
      setError(response.error ?? null);
      setState(response.scan ? 'completed' : response.error ? 'failed' : 'idle');
    });
    const listener = (message: unknown): void => {
      const parsed = scanProgressMessageSchema.safeParse(message);
      if (parsed.success) setProgress(parsed.data.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener?.(listener);
    };
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (scan?.fields ?? []).filter((field) => {
      const haystack = [
        field.question,
        field.normalizedLabel,
        field.canonicalKey,
        field.semanticType,
        field.fieldType,
        field.section,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        (section === 'all' || (field.section ?? 'other') === section) &&
        (fieldType === 'all' || field.fieldType === fieldType) &&
        (requirement === 'all' ||
          (requirement === 'required' ? field.required : !field.required)) &&
        (confidenceFilter === 'all' || confidence(field) === confidenceFilter)
      );
    });
  }, [scan, search, section, fieldType, requirement, confidenceFilter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DetectedField[]>();
    for (const field of filtered) {
      const key = field.section ?? 'other';
      groups.set(key, [...(groups.get(key) ?? []), field]);
    }
    return groups;
  }, [filtered]);

  const rescan = async (): Promise<void> => {
    if (!scan) return;
    setState('scanning');
    setError(null);
    setProgress(null);
    const response = await sendMessage({ type: 'SCAN_APPLICATION', targetUrl: scan.url });
    if (response.type === 'SCAN_COMPLETE') {
      setScan(response.result);
      setState('completed');
      setNotice('Scan refreshed.');
    } else {
      setError(response.error);
      setState(response.error.code === 'SCAN_CANCELLED' ? 'cancelled' : 'failed');
    }
  };

  const cancel = async (): Promise<void> => {
    await sendMessage({
      type: 'SCAN_CANCEL',
      ...(progress?.scanId ? { scanId: progress.scanId } : {}),
      ...(scan?.url ? { targetUrl: scan.url } : {}),
    });
    setState('cancelled');
  };

  const clear = async (): Promise<void> => {
    const response = await sendMessage({ type: 'CLEAR_LAST_SCAN' });
    if (response.ok) {
      setScan(null);
      setState('idle');
      setNotice('Stored scan cleared.');
    } else {
      setError(response.error);
      setState('failed');
    }
  };

  const buildPlan = async (): Promise<void> => {
    if (!scan) return;
    setPlanning(true);
    setError(null);
    const response = await sendMessage({ type: 'BUILD_DETERMINISTIC_PLAN', scanId: scan.id });
    setPlanning(false);
    if ('plan' in response) {
      void chrome.tabs.create({ url: chrome.runtime.getURL('fill-plan.html') });
    } else {
      setError(response.error);
    }
  };

  const copy = async (): Promise<void> => {
    if (!scan) return;
    await navigator.clipboard.writeText(jsonFor(scan));
    setNotice('Sanitized JSON copied to the clipboard.');
  };

  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (state === 'scanning' && !scan) {
    return (
      <main className="review-shell">
        <p aria-live="polite">Loading the latest scan…</p>
      </main>
    );
  }
  if (!scan) {
    return (
      <main className="review-shell">
        <h1>Application Scan Review</h1>
        {error ? (
          <div className="result result--bad" role="alert">
            {error.message} {error.suggestedAction}
          </div>
        ) : null}
        <p>
          No completed application scan is stored. Open an application page and use Analyze
          Application.
        </p>
      </main>
    );
  }

  const stats = scan.statistics;
  const sections = [...new Set(scan.fields.map((field) => field.section ?? 'other'))];
  const types = [...new Set(scan.fields.map((field) => field.fieldType))];
  return (
    <main className="review-shell">
      <header className="review-header">
        <div>
          <p className="eyebrow">Read-only application analysis</p>
          <h1>{scan.jobContext.jobTitle ?? 'Application Scan'}</h1>
          <p>{scan.jobContext.company ?? scan.domain}</p>
        </div>
        <div className="review-actions">
          <button
            type="button"
            onClick={() => void buildPlan()}
            disabled={planning || state === 'scanning'}
          >
            {planning ? 'Building Plan…' : 'Build Fill Plan'}
          </button>
          <button type="button" onClick={() => void rescan()} disabled={state === 'scanning'}>
            Rescan
          </button>
          {state === 'scanning' ? (
            <button type="button" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
          <button type="button" onClick={() => void copy()}>
            Copy JSON
          </button>
          <button type="button" onClick={() => downloadJson(scan)}>
            Export JSON
          </button>
          <button type="button" className="danger" onClick={() => void clear()}>
            Clear scan
          </button>
        </div>
      </header>
      {state === 'scanning' ? (
        <div className="scan-banner" aria-live="polite">
          <span>{progress?.message ?? 'Starting scan…'}</span>
          <progress max="100" value={progress?.percent ?? 5} />
        </div>
      ) : null}
      {notice ? (
        <p className="result" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div className="result result--bad" role="alert">
          <strong>{error.code}</strong> {error.message} {error.suggestedAction}
        </div>
      ) : null}
      <section className="summary" aria-label="Scan summary">
        <div>
          <span>URL</span>
          <strong title={scan.url}>{scan.url}</strong>
        </div>
        <div>
          <span>ATS</span>
          <strong>
            {scan.ats.displayName} ({Math.round(scan.ats.confidence * 100)}%)
          </strong>
        </div>
        <div>
          <span>Company</span>
          <strong>{scan.jobContext.company ?? 'Not found'}</strong>
        </div>
        <div>
          <span>Job title</span>
          <strong>{scan.jobContext.jobTitle ?? 'Not found'}</strong>
        </div>
        <div>
          <span>Total fields</span>
          <strong>{stats.total}</strong>
        </div>
        <div>
          <span>Required / optional</span>
          <strong>
            {stats.required} / {stats.optional}
          </strong>
        </div>
        <div>
          <span>Supported / unknown</span>
          <strong>
            {stats.supported} / {stats.unknown}
          </strong>
        </div>
        <div>
          <span>Document uploads</span>
          <strong>{stats.file}</strong>
        </div>
        <div>
          <span>Warnings</span>
          <strong>{scan.warnings.length}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{scan.durationMs} ms</strong>
        </div>
      </section>
      {scan.warnings.length ? (
        <section className="warnings" aria-label="Scan warnings">
          <h2>Warnings</h2>
          <ul>
            {scan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="filters" aria-label="Field filters">
        <label>
          Search
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label>
          Section
          <select value={section} onChange={(event) => setSection(event.target.value)}>
            <option value="all">All sections</option>
            {sections.map((value) => (
              <option value={value} key={value}>
                {FIELD_SECTION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Field type
          <select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
            <option value="all">All types</option>
            {types.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Requirement
          <select
            value={requirement}
            onChange={(event) => setRequirement(event.target.value as RequirementFilter)}
          >
            <option value="all">Required and optional</option>
            <option value="required">Required</option>
            <option value="optional">Optional</option>
          </select>
        </label>
        <label>
          Confidence
          <select
            value={confidenceFilter}
            onChange={(event) => setConfidenceFilter(event.target.value as ConfidenceFilter)}
          >
            <option value="all">All confidence</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
      </section>
      <p>
        {filtered.length} of {scan.fields.length} fields shown.
      </p>
      {[...grouped.entries()].map(([key, fields]) => (
        <section className="field-section" key={key}>
          <button
            type="button"
            className="section-toggle"
            onClick={() => toggle(key)}
            aria-expanded={!collapsed.has(key)}
          >
            <span>{FIELD_SECTION_LABELS[key as keyof typeof FIELD_SECTION_LABELS]}</span>
            <span>{fields.length} fields</span>
          </button>
          {!collapsed.has(key) ? (
            <div className="field-grid">
              {fields.map((field) => (
                <FieldRow field={field} key={field.id} />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </main>
  );
}
