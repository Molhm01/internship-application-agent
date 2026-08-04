import type { AutofillFieldResult } from '../schemas/autofill.js';

/**
 * The difference between "not answered yet" and "not answerable".
 *
 * The deterministic pass marks a field it could not settle as
 * `missing_information` and hands it to the batched analysis. That marker is a
 * *stage*, not a verdict — but nothing distinguished the two, so when the
 * analysis did not run the marker was rendered verbatim as a final card:
 * eighteen of them reading `"<question>" is waiting on the page analysis`,
 * beside a summary claiming nothing needed confirmation and nothing had failed.
 *
 * A pending record is now recognizable, must be resolved before a run may
 * complete, and carries a reason that names why it stopped.
 */

/** Wordings the planner uses to mark a field as still in the pipeline. */
const PENDING_MARKERS = [/waiting on the page analysis/i, /is waiting on/i];

/**
 * True when this result is a stage marker rather than an outcome.
 *
 * Keyed on the combination that can only occur mid-pipeline: an action that
 * proposes nothing, no execution attempt, and a reason that names a later stage.
 */
export function isPendingResult(result: AutofillFieldResult): boolean {
  if (result.verification !== 'not_attempted') return false;
  if (result.action !== 'missing_information') return false;
  return PENDING_MARKERS.some((pattern) => pattern.test(result.reason));
}

/** Why the pipeline stopped before this field was resolved. */
export type PendingCause =
  /** The batched analysis never ran — no model, or it failed. */
  | 'analysis_unavailable'
  /** The analysis ran and had nothing to propose for this field. */
  | 'analysis_no_answer'
  /** The run ended first. */
  | 'run_ended';

const CAUSE_REASONS: Record<PendingCause, string> = {
  analysis_unavailable:
    'The page analysis could not run, so this question was never interpreted. Answer it yourself, or start the local AI agent and run autofill again.',
  analysis_no_answer:
    'The page analysis had nothing it could ground an answer in. Answer this one yourself.',
  run_ended:
    'The run ended before this question was resolved. Answer it yourself before submitting.',
};

/**
 * Turns a stage marker into a truthful final result.
 *
 * Always `USER_CONFIRMATION_REQUIRED` in effect: the field is unanswered and a
 * person has to deal with it. What changes is the sentence, which now names the
 * stage that did not happen rather than pretending the field was considered and
 * found wanting.
 */
export function finalizePendingResult(
  result: AutofillFieldResult,
  cause: PendingCause,
): AutofillFieldResult {
  return {
    ...result,
    reviewReason: 'missing_information',
    reason: CAUSE_REASONS[cause],
  };
}

/**
 * Proof that a finished run has no stage markers left in it.
 *
 * Called before the report is built. Returns the offending questions rather
 * than throwing, because the caller's job is to resolve them — a run that
 * cannot resolve them must report that honestly, not crash.
 */
export function pendingResults(
  results: readonly AutofillFieldResult[],
): readonly AutofillFieldResult[] {
  return results.filter(isPendingResult);
}
