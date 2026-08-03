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

/** Often enough to feel live, rarely enough not to wake the worker needlessly. */
const RUN_POLL_INTERVAL_MS = 700;
/**
 * The longest the popup will follow a run. Generous: five passes over a large
 * form with an AI batch in each is genuinely slow, and cutting it short would
 * recreate the bug this replaced.
 */
const RUN_POLL_CEILING_MS = 10 * 60 * 1000;

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
      // A run started by "Apply with Agent" is already in flight by the time
      // anyone opens the popup. Adopting it here is what makes the automatic
      // start visible instead of looking like nothing happened.
      const { run: existing } = await sendMessage({ type: 'GET_AUTOFILL_RUN' });
      if (!cancelled && existing) {
        if (existing.progress) setProgress(existing.progress);
        if (existing.status === 'running') setRunning(true);
        else if (existing.report) setReport(existing.report);
        if (existing.error) setError(existing.error);
      }
      // A report from another page is not this page's report.
      const previous = reportResult.report;
      setReport(previous && (!tabUrl || previous.url === tabUrl) ? previous : null);
      setLoadingBundle(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tabUrl]);

  /**
   * Starts a run and follows it to completion.
   *
   * The request itself returns an acknowledgement in milliseconds; the run then
   * reports through durable state. Holding one `sendMessage` open for the whole
   * operation is what produced "no response within 15000ms" on every real form —
   * the deadline was shorter than a single AI batch, so it always fired.
   */
  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setProgress(null);
    setReport(null);

    const accepted = await sendMessage({
      type: 'RUN_APPLICATION_AUTOFILL',
      ...(tabUrl ? { targetUrl: tabUrl } : {}),
    });
    if ('error' in accepted) {
      setError(accepted.error);
      setRunning(false);
      return;
    }

    // Polled rather than awaited. A popup that closes mid-run misses every
    // broadcast, and reopening it has to be able to find out where the run got
    // to; reading the state is the only thing that works in both cases.
    const started = Date.now();
    for (;;) {
      const { run: state } = await sendMessage({ type: 'GET_AUTOFILL_RUN' });
      if (state && state.runId === accepted.runId) {
        if (state.progress) setProgress(state.progress);
        if (state.status !== 'running') {
          if (state.report) setReport(state.report);
          setError(state.error ?? state.report?.error ?? null);
          break;
        }
      }
      // A ceiling so the popup can never spin forever on a run whose worker
      // vanished without recording an outcome.
      if (Date.now() - started > RUN_POLL_CEILING_MS) {
        setError({
          code: 'INTERNAL_ERROR',
          message: 'The run stopped responding. Try it again.',
          recoverable: true,
          suggestedAction: 'Click Autofill Application again.',
          debugContext: { runId: accepted.runId },
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
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
