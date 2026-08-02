import { useCallback, useEffect, useState } from 'react';
import {
  AUTOFILL_PHASE_LABELS,
  autofillProgressSchema,
  type AgentError,
  type ApplicationAutofillReport,
  type ApplicationBundle,
  type AutofillProgress,
} from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';

/**
 * Everything the "Autofill Application" panel needs.
 *
 * Kept separate from `usePopupState`, which reports connection health. This
 * hook is about one job: which application is loaded, what a run is doing, and
 * what it left behind.
 */

export interface AutofillState {
  bundle: ApplicationBundle | null;
  loadingBundle: boolean;
  running: boolean;
  progress: AutofillProgress | null;
  /** The phase sentence shown while a run is in flight. */
  phaseLabel: string | null;
  report: ApplicationAutofillReport | null;
  error: AgentError | null;
  run: () => Promise<void>;
  cancel: () => Promise<void>;
  focusField: (fieldId: string) => Promise<void>;
  clearHighlights: () => Promise<void>;
}

export function useAutofillState(tabUrl: string | null): AutofillState {
  const [bundle, setBundle] = useState<ApplicationBundle | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutofillProgress | null>(null);
  const [report, setReport] = useState<ApplicationAutofillReport | null>(null);
  const [error, setError] = useState<AgentError | null>(null);

  useEffect(() => {
    const listener = (message: unknown): void => {
      const parsed = autofillProgressSchema.safeParse(
        (message as { progress?: unknown } | null)?.progress,
      );
      if (parsed.success) setProgress(parsed.data);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener?.(listener);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingBundle(true);
    void (async () => {
      const [bundleResult, reportResult] = await Promise.all([
        sendMessage({ type: 'GET_ACTIVE_BUNDLE', ...(tabUrl ? { url: tabUrl } : {}) }),
        sendMessage({ type: 'GET_AUTOFILL_REPORT' }),
      ]);
      if (cancelled) return;
      setBundle(bundleResult.data ?? null);
      // A report from another page is not this page's report.
      const previous = reportResult.report;
      setReport(previous && (!tabUrl || previous.url === tabUrl) ? previous : null);
      setLoadingBundle(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tabUrl]);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setProgress(null);
    setReport(null);
    const response = await sendMessage({
      type: 'RUN_APPLICATION_AUTOFILL',
      ...(tabUrl ? { targetUrl: tabUrl } : {}),
    });
    if ('report' in response) {
      setReport(response.report);
      setError(response.report.error ?? null);
    } else {
      setError(response.error);
    }
    setRunning(false);
  }, [tabUrl]);

  const cancel = useCallback(async (): Promise<void> => {
    await sendMessage({ type: 'CANCEL_APPLICATION_AUTOFILL' });
  }, []);

  const focusField = useCallback(async (fieldId: string): Promise<void> => {
    await sendMessage({ type: 'FOCUS_REVIEW_FIELD', fieldId });
  }, []);

  const clearHighlights = useCallback(async (): Promise<void> => {
    await sendMessage({ type: 'CLEAR_REVIEW_HIGHLIGHTS' });
  }, []);

  return {
    bundle,
    loadingBundle,
    running,
    progress,
    phaseLabel: progress ? AUTOFILL_PHASE_LABELS[progress.phase] : null,
    report,
    error,
    run,
    cancel,
    focusField,
    clearHighlights,
  };
}
