import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTOFILL_PHASE_LABELS,
  autofillProgressSchema,
  type AgentError,
  type ApplicationAutofillReport,
  type ApplicationBundle,
  type AutofillProgress,
} from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';
import type { AutofillRunPhaseState, AutofillRunState } from '../storage/runState.js';

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
  /** Which stage the run is in, as one of the explicit run states. */
  runState: AutofillRunPhaseState;
  /** How long the current run has been going, so a wait is visible as a wait. */
  elapsedMs: number;
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
  const [runState, setRunState] = useState<AutofillRunPhaseState>('IDLE');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  /** Set only when the run reaches a terminal state; freezes the clock. */
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  /**
   * The synchronous half of the click guard. `running` is React state and does
   * not update until the next render, so two rapid clicks both saw `false` and
   * both sent a start message.
   */
  const runningRef = useRef(false);

  /**
   * The clock.
   *
   * Both timestamps come from the worker, never from popup mount time: a popup
   * opened thirty seconds into a run must say thirty seconds, and reopening it
   * must not restart the count from zero. That was the "Elapsed time: 0s" bug —
   * `startedAt` was set only inside `run()`, so a popup that *adopted* a run
   * already in flight had nothing to subtract from.
   *
   * Once `completedAt` exists the value is frozen, so a finished or cancelled
   * run reports how long it actually took.
   */
  useEffect(() => {
    if (startedAt === null) {
      setElapsedMs(0);
      return;
    }
    if (completedAt !== null) {
      setElapsedMs(Math.max(0, completedAt - startedAt));
      return;
    }
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const timer = setInterval(() => setElapsedMs(Math.max(0, Date.now() - startedAt)), 1000);
    // Cleared on unmount and on every dependency change, so closing the popup
    // mid-run cannot leak an interval into the next one.
    return () => clearInterval(timer);
  }, [startedAt, completedAt]);

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
        adopt(existing);
        // Adopting used to stop here: `running` was set true and nothing else
        // was. The popup therefore showed a live Cancel button beside a button
        // reading "Ready" (the IDLE label), a frozen 2/27 bar, and 0s elapsed —
        // and never found out the run had ended, because nothing was polling.
        if (existing.status === 'running') void follow(existing.runId);
        else if (existing.report) setReport(existing.report);
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
  /**
   * Copies one snapshot of the worker's run into the popup.
   *
   * Every field the UI shows comes from here, so the popup can never disagree
   * with the worker about what is happening — it does not infer state from a
   * button label or from its own timers.
   */
  const adopt = useCallback((state: AutofillRunState): void => {
    setRunState(state.state);
    setStartedAt(state.startedAt);
    setCompletedAt(state.completedAt ?? null);
    setRunning(state.status === 'running');
    runningRef.current = state.status === 'running';
    if (state.progress) setProgress(state.progress);
    if (state.error) setError(state.error);
  }, []);

  /**
   * Follows a run to its terminal state.
   *
   * Polled rather than awaited: a popup that closes mid-run misses every
   * broadcast, and reopening it has to be able to find out where the run got
   * to. Reading the state is the only thing that works in both cases.
   */
  const follow = useCallback(
    async (runId: string): Promise<void> => {
      const started = Date.now();
      for (;;) {
        const { run: state } = await sendMessage({ type: 'GET_AUTOFILL_RUN' });
        if (state && state.runId === runId) {
          adopt(state);
          if (state.status !== 'running') {
            if (state.report) setReport(state.report);
            setError(state.error ?? state.report?.error ?? null);
            return;
          }
        } else if (!state) {
          // The run vanished — cleared, or replaced by another page's. There is
          // nothing left to follow, and pretending otherwise strands the UI.
          setRunning(false);
          runningRef.current = false;
          setRunState('IDLE');
          return;
        }
        if (Date.now() - started > RUN_POLL_CEILING_MS) {
          setError({
            code: 'INTERNAL_ERROR',
            message: 'The run stopped responding. Try it again.',
            recoverable: true,
            suggestedAction: 'Click Autofill Application again.',
            debugContext: { runId },
          });
          setRunning(false);
          runningRef.current = false;
          setRunState('FAILED');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
      }
    },
    [adopt],
  );

  const run = useCallback(async (): Promise<void> => {
    // The popup's own `running` flag is local React state, so a popup closed
    // and reopened mid-run shows an enabled button. The worker's lock is the
    // real one; this guard only avoids the pointless round trip.
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    // Immediately, so the button can never read "Ready" while a run is being
    // accepted. `IDLE` beside a live Cancel button was the invalid combination
    // the user actually saw.
    setRunState('SCANNING');
    setError(null);
    setProgress(null);
    setReport(null);
    setCompletedAt(null);
    // Provisional only; the worker's own `startedAt` replaces it on the first
    // poll, and the worker's is the one that survives the popup closing.
    setStartedAt(Date.now());

    const accepted = await sendMessage({
      type: 'RUN_APPLICATION_AUTOFILL',
      ...(tabUrl ? { targetUrl: tabUrl } : {}),
    });
    if ('error' in accepted) {
      setError(accepted.error);
      setRunning(false);
      runningRef.current = false;
      setRunState('FAILED');
      return;
    }
    // Whether the worker started a run or refused because one already owns the
    // page, the answer names the run to follow — so both cases follow it, and
    // neither starts a second.
    await follow(accepted.runId);
  }, [tabUrl, follow]);

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
    runState,
    elapsedMs,
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
