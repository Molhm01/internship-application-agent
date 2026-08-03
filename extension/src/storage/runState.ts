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

export const autofillRunStateSchema = z.object({
  runId: z.string().min(1).max(200),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  /** The tab this run belongs to, so a restart can find its way back. */
  url: z.string().max(2048),
  startedAt: z.number(),
  updatedAt: z.number(),
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
    url,
    startedAt: now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [KEY]: state });
  return state;
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
  await patchRun(runId, { progress });
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
  await patchRun(runId, {
    status,
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
