import {
  applicationAutofillReportSchema,
  autofillProgressSchema,
  agentErrorSchema,
  type AgentError,
  type ApplicationAutofillReport,
  type AutofillProgress,
} from '@internship-agent/shared';
import { z } from 'zod';

/**
 * The state of an autofill run, stored where a service-worker restart cannot
 * destroy it.
 *
 * Manifest V3 terminates the worker whenever it is idle, and a run that lives
 * only in a module-level variable dies with it — silently, mid-fill, with the
 * popup still waiting. Every transition is written to `chrome.storage.local`
 * instead, so the popup reads the run's state rather than holding a message
 * open across it.
 *
 * This is what replaces the fifteen-second request. The popup used to send
 * `RUN_APPLICATION_AUTOFILL` and wait for the entire scan, AI batch, fill and
 * rescan to finish inside one `sendMessage` — an operation that cannot complete
 * in fifteen seconds and therefore always failed with
 * "no response within 15000ms". Reloading the extension never helped because
 * nothing was broken: the deadline was simply shorter than the work.
 */

const KEY = 'autofillRun';
/** A run older than this was killed by a worker restart mid-flight. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * The states a run can be in, named for what the user is waiting on.
 *
 * `status` said only running/completed/failed/cancelled, which cannot answer
 * "what is it doing?" — so the popup showed one label for a stage that
 * contained a sixty-second model call, and looked identical whether it was
 * scanning or stuck. The stage is part of the run's identity now, not a
 * decoration on top of it.
 */
export const AUTOFILL_RUN_STATES = [
  'IDLE',
  'SCANNING',
  'RESOLVING_DETERMINISTIC',
  'ANALYZING_AI',
  'EXECUTING',
  'VERIFYING',
  'WAITING_FOR_USER',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type AutofillRunPhaseState = (typeof AUTOFILL_RUN_STATES)[number];

/** The states in which a run still owns the lock. */
const ACTIVE_STATES: readonly AutofillRunPhaseState[] = [
  'SCANNING',
  'RESOLVING_DETERMINISTIC',
  'ANALYZING_AI',
  'EXECUTING',
  'VERIFYING',
];

/** Maps a progress phase onto the run state it represents. */
export function stateForPhase(phase: AutofillProgress['phase']): AutofillRunPhaseState {
  switch (phase) {
    case 'preparing':
    case 'scanning':
    case 'rescanning':
      return 'SCANNING';
    case 'discovering_options':
    case 'resolving':
      return 'RESOLVING_DETERMINISTIC';
    case 'generating':
      return 'ANALYZING_AI';
    case 'planning':
    case 'filling':
      return 'EXECUTING';
    case 'verifying':
      return 'VERIFYING';
    case 'completed':
    case 'completed_with_review':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
  }
}

export const autofillRunStateSchema = z.object({
  runId: z.string().min(1).max(200),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  /**
   * The stage. Defaulted rather than required so a run written by an earlier
   * build still parses instead of vanishing from the popup entirely.
   */
  state: z.enum(AUTOFILL_RUN_STATES).default('SCANNING'),
  /** The tab this run belongs to, so a restart can find its way back. */
  url: z.string().max(2048),
  startedAt: z.number(),
  updatedAt: z.number(),
  /**
   * Set once, when the run reaches a terminal state.
   *
   * The popup's clock reads `completedAt - startedAt` after the run ends and
   * `Date.now() - startedAt` while it is going, so a finished run shows the
   * time it actually took rather than continuing to count. Both timestamps come
   * from the worker; the popup owns neither, which is what makes the elapsed
   * time survive the popup being closed and reopened.
   */
  completedAt: z.number().optional(),
  progress: autofillProgressSchema.optional(),
  report: applicationAutofillReportSchema.optional(),
  error: agentErrorSchema.optional(),
});

export type AutofillRunState = z.infer<typeof autofillRunStateSchema>;

export async function startRun(runId: string, url: string): Promise<AutofillRunState> {
  const now = Date.now();
  const state: AutofillRunState = {
    runId,
    status: 'running',
    state: 'SCANNING',
    url,
    startedAt: now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [KEY]: state });
  return state;
}

/**
 * The run currently holding the lock, or null.
 *
 * This is what makes "one click, one run" true. `acceptAutofillRun` had no such
 * check: a second click minted a second id, overwrote the stored run, and left
 * the first orchestrator running invisibly against the same page and the same
 * stored plan. So did "Apply with Agent" auto-start racing a user click.
 *
 * Reads through `loadRun`, so a run abandoned by a terminated service worker
 * has already aged out and does not hold the lock forever.
 */
export async function activeRun(): Promise<AutofillRunState | null> {
  const run = await loadRun();
  if (!run || run.status !== 'running') return null;
  return ACTIVE_STATES.includes(run.state) ? run : null;
}

/** Records which stage a run has reached. */
export async function recordState(runId: string, state: AutofillRunPhaseState): Promise<void> {
  await patchRun(runId, { state });
}

/**
 * Merges a change into the stored run.
 *
 * Keyed on `runId`: a late progress message from a run the user already
 * cancelled must not resurrect it, and two runs cannot interleave their
 * updates.
 */
async function patchRun(runId: string, patch: Partial<AutofillRunState>): Promise<void> {
  const current = await loadRun();
  if (!current || current.runId !== runId) return;
  await chrome.storage.local.set({
    [KEY]: { ...current, ...patch, updatedAt: Date.now() },
  });
}

export async function recordProgress(runId: string, progress: AutofillProgress): Promise<void> {
  await patchRun(runId, { progress, state: stateForPhase(progress.phase) });
}

export async function finishRun(
  runId: string,
  outcome: { report?: ApplicationAutofillReport; error?: AgentError },
): Promise<void> {
  // A cancellation arrives as an error, but it is not a failure — the user
  // asked for it, and reporting "the run failed" for something they did reads
  // as a bug in the extension.
  const cancelled =
    outcome.error?.code === 'AUTOFILL_CANCELLED' || outcome.report?.status === 'cancelled';
  const status: AutofillRunState['status'] = cancelled
    ? 'cancelled'
    : outcome.error
      ? 'failed'
      : 'completed';
  // The lock is released here and nowhere else: whatever happened, the run is
  // no longer in an active state, so the next click is accepted.
  await patchRun(runId, {
    status,
    state: cancelled ? 'CANCELLED' : outcome.error ? 'FAILED' : 'COMPLETED',
    completedAt: Date.now(),
    ...(outcome.report ? { report: outcome.report } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}

/**
 * The stored run, or null.
 *
 * A `running` record that has not been touched for ten minutes is reported as
 * failed rather than as still running: the worker that owned it is gone, and
 * leaving the popup on "Filling information…" forever is the worst of the
 * available outcomes.
 */
export async function loadRun(): Promise<AutofillRunState | null> {
  const stored = await chrome.storage.local.get(KEY);
  const parsed = autofillRunStateSchema.safeParse(stored[KEY]);
  if (!parsed.success) return null;
  const run = parsed.data;
  if (run.status === 'running' && Date.now() - run.updatedAt > STALE_AFTER_MS) {
    return {
      ...run,
      status: 'failed',
      state: 'FAILED',
      // The worker died without writing one, so the last sign of life is the
      // honest end of the run. Leaving it unset would make the popup's clock
      // count forever on a run that is already over.
      completedAt: run.completedAt ?? run.updatedAt,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The run stopped unexpectedly. Start it again.',
        recoverable: true,
        suggestedAction: 'Click Autofill Application again.',
        debugContext: { runId: run.runId, reason: 'worker_restart' },
      },
    };
  }
  return run;
}

export async function clearRun(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
