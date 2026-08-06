import type { AutofillFieldResult } from '../schemas/autofill.js';
import type { DetectedField } from '../schemas/fields.js';

/**
 * The one vocabulary in which a finished run may describe a field.
 *
 * Everything before this point in the pipeline is a *stage*: `pending`,
 * `unverified`, `not_attempted`, "waiting on the page analysis". Those are
 * legitimate while the run is moving and are lies once it has stopped, because
 * the reader of a finished run has no way to tell a field the agent is still
 * thinking about from one it gave up on. That ambiguity is what produced the
 * three failures this module exists to end: a verified field still wearing an
 * "Information needed" mark, a stage marker rendered as a final popup card, and
 * a completion count that agreed with none of the fields it claimed to total.
 *
 * There are exactly six outcomes and no seventh, and no field may reach the end
 * of a run without exactly one of them.
 */
export const FINAL_FIELD_STATUSES = [
  /** Written by the agent and confirmed against observed DOM state afterwards. */
  'FILLED_VERIFIED',
  /** Optional, deliberately left empty, and correctly so. Not outstanding work. */
  'OPTIONAL_LEFT_BLANK',
  /** A person must answer or confirm this one. */
  'USER_CONFIRMATION_REQUIRED',
  /** The agent tried to write it and the page did not take the value. */
  'FAILED_EXECUTION',
  /** A CAPTCHA, verification step, or page protection stood in the way. */
  'BLOCKED',
  /** The page already held the correct answer, so nothing was written. */
  'SKIPPED_ALREADY_VALID',
] as const;

export type FinalFieldStatus = (typeof FINAL_FIELD_STATUSES)[number];

/** True for a member of the closed final vocabulary. */
export function isFinalFieldStatus(value: string): value is FinalFieldStatus {
  return (FINAL_FIELD_STATUSES as readonly string[]).includes(value);
}

/**
 * Where a field has got to while the run is still moving.
 *
 * These are legitimate — a field genuinely is waiting to be scanned, resolved,
 * executed or verified — and they are lies the moment the run stops. Naming them
 * explicitly is what makes the difference checkable: previously a temporary
 * state was recognised by matching a regular expression against a prose reason
 * ("is waiting on the page analysis"), so a stage marker whose wording drifted
 * survived into the popup as a final card. A stage is now a value, not a phrase.
 *
 * The stage a field is in is *not* a status it may end in. `COMPLETED_STATUSES`
 * and these two arrays share no member, and `unsettledFieldIds` below is what a
 * run consults before it may call itself complete.
 */
export const RUNNING_FIELD_STATUSES = [
  /** Seen on the page; nothing has been decided about it yet. */
  'PENDING_SCAN',
  /** Handed to the planner or the batched analysis; no answer yet. */
  'PENDING_RESOLUTION',
  /** An action exists and the executor has not been invoked yet. */
  'PENDING_EXECUTION',
  /** Written, and not yet checked against what the page actually holds. */
  'PENDING_VERIFICATION',
] as const;

export type RunningFieldStatus = (typeof RUNNING_FIELD_STATUSES)[number];

/** Every status a field may hold, at any moment of a run. */
export type FieldRunStatus = FinalFieldStatus | RunningFieldStatus;

/** True for a temporary stage marker rather than an outcome. */
export function isRunningFieldStatus(value: string): value is RunningFieldStatus {
  return (RUNNING_FIELD_STATUSES as readonly string[]).includes(value);
}

/**
 * Which stage a field is in, given what has happened to it so far.
 *
 * Derived rather than assigned at each stage: a flag set in one place and
 * cleared in another is how a field ends up in two states at once, and the
 * whole point of this module is that a field has exactly one.
 */
export function resolveRunningFieldStatus(input: {
  planned: boolean;
  executionAttempted: boolean;
  verificationObserved: boolean;
}): RunningFieldStatus {
  if (input.verificationObserved) return 'PENDING_VERIFICATION';
  if (input.executionAttempted) return 'PENDING_VERIFICATION';
  if (input.planned) return 'PENDING_EXECUTION';
  return 'PENDING_RESOLUTION';
}

/**
 * What a field's mark on the page means. Colour is meaning here, not decoration:
 * a person glancing down a filled form has to be able to tell "this is done"
 * from "this is yours to answer" without reading a word.
 */
export const ANNOTATION_KINDS = [
  /** Green. The agent wrote this and the page kept it. */
  'verified',
  /** Grey. Optional and intentionally blank. */
  'optional_blank',
  /** Orange. A factual answer nobody holds. */
  'information_needed',
  /** Purple. An explicit legal, sensitive, or consent decision. */
  'sensitive_decision',
  /** Red. The write was attempted and the page refused it, or something blocked it. */
  'execution_failed',
  /**
   * No mark at all.
   *
   * A field the agent did not touch because the page already held the right
   * answer has nothing to report: the user wrote it, they know it is there, and
   * decorating their own work with the agent's tick claims credit for it. This
   * is a real member rather than an absence so that the redraw can *remove* an
   * earlier mark from such a field — a status that simply omitted the field
   * would leave whatever an earlier pass had drawn on it.
   */
  'none',
] as const;

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/**
 * The single mapping from outcome to mark.
 *
 * One table rather than a branch at each call site: the reason a filled field
 * kept an "Information needed" badge is that the mark was chosen from a
 * *review reason* computed before execution, in a different module from the
 * status computed after it. There is now one input to the colour, and it is the
 * final status.
 */
export const ANNOTATION_BY_FINAL_STATUS: Record<FinalFieldStatus, AnnotationKind> = {
  FILLED_VERIFIED: 'verified',
  // Deliberately unmarked. The user's own correct answer is not the agent's
  // work, and a green tick on it says otherwise.
  SKIPPED_ALREADY_VALID: 'none',
  OPTIONAL_LEFT_BLANK: 'optional_blank',
  USER_CONFIRMATION_REQUIRED: 'information_needed',
  FAILED_EXECUTION: 'execution_failed',
  BLOCKED: 'execution_failed',
};

/**
 * The colour each mark is drawn in, as one hex value per meaning.
 *
 * `none` has no colour because it is never drawn; it is present so that a
 * future `Record<AnnotationKind, …>` cannot compile while ignoring the case.
 */
export const ANNOTATION_COLOURS: Record<AnnotationKind, string> = {
  verified: '#15803d',
  optional_blank: '#6b7280',
  information_needed: '#c2410c',
  sensitive_decision: '#7e22ce',
  execution_failed: '#b91c1c',
  none: 'transparent',
};

/** What each mark says, when it says anything. */
export const ANNOTATION_BADGES: Record<AnnotationKind, string> = {
  verified: 'Filled',
  optional_blank: 'Optional — left blank',
  information_needed: 'Information needed',
  sensitive_decision: 'Your decision',
  execution_failed: 'Autofill failed',
  none: '',
};

/** True when this annotation puts something on the employer's page. */
export function isDrawnAnnotation(annotation: AnnotationKind): boolean {
  return annotation !== 'none';
}

/**
 * True when a field's outcome is settled and asks nothing of the user.
 *
 * Read by the completion counters, so "completed" and "the sum of the settled
 * statuses" cannot disagree — they are the same computation.
 */
export function isSettledStatus(status: FinalFieldStatus): boolean {
  return (
    status === 'FILLED_VERIFIED' ||
    status === 'OPTIONAL_LEFT_BLANK' ||
    status === 'SKIPPED_ALREADY_VALID'
  );
}

/** Everything known about one field at the moment the run stopped. */
export interface FinalStatusInput {
  field?: DetectedField;
  result?: AutofillFieldResult;
  /**
   * True when the page already held this exact answer before the run started.
   * The distinction is worth keeping: "we filled it" and "it was already right"
   * are both fine outcomes, but only one of them is evidence the executor works.
   */
  alreadyValidBeforeRun?: boolean;
  /** Set when a CAPTCHA, MFA, or page protection stopped the run. */
  blocked?: boolean;
}

/**
 * The one place a final status is decided.
 *
 * Order matters and is deliberate. Blocking beats everything, because a page
 * that will not let the agent act says nothing about whether the answer was
 * known. A verified write beats a stale review flag, which is precisely the bug
 * that left filled fields marked "Information needed" — the flag was computed
 * before the executor ran and never revisited. An optional blank beats
 * "unanswered", because it is finished work rather than outstanding work.
 * Everything left is the user's.
 */
export function resolveFinalFieldStatus(input: FinalStatusInput): FinalFieldStatus {
  const { field, result } = input;

  if (result?.verification === 'verified') {
    return input.alreadyValidBeforeRun ? 'SKIPPED_ALREADY_VALID' : 'FILLED_VERIFIED';
  }
  if (input.blocked) return 'BLOCKED';
  if (result?.verification === 'failed') return 'FAILED_EXECUTION';
  // An attempted write the page never confirmed is a failed execution, not an
  // open question: something was typed, and the user has to be told the page
  // did not keep it rather than being asked to answer it from scratch.
  if (result?.verification === 'unverified') return 'FAILED_EXECUTION';
  if (result?.verification === 'optional_left_blank') return 'OPTIONAL_LEFT_BLANK';
  // A field with no result at all, and no obligation to have one, is blank on
  // purpose. Required fields never take this branch.
  if (result === undefined && field !== undefined && !field.required) {
    return 'OPTIONAL_LEFT_BLANK';
  }
  return 'USER_CONFIRMATION_REQUIRED';
}

/**
 * The annotation a field should be wearing once the run has stopped.
 *
 * A sensitive question the agent may not answer is purple rather than orange:
 * "we have no value for this" and "this is a decision only you may make" are
 * different requests, and colouring them alike is what made a disability
 * disclosure look like a missing postcode.
 */
export function annotationFor(status: FinalFieldStatus, sensitive: boolean): AnnotationKind {
  if (status === 'USER_CONFIRMATION_REQUIRED' && sensitive) return 'sensitive_decision';
  return ANNOTATION_BY_FINAL_STATUS[status];
}

/** One field's terminal record, as the popup and the trace both read it. */
export interface FinalFieldOutcome {
  fieldId: string;
  label: string;
  status: FinalFieldStatus;
  annotation: AnnotationKind;
  required: boolean;
  reason: string;
}

/**
 * Proof that a run may be called complete.
 *
 * Returns the field ids still holding a temporary stage marker. A run holding
 * any of them may not be `completed` — a completion claimed over an unresolved
 * field is the specific dishonesty this whole model exists to make impossible.
 *
 * Note what this does *not* include: a field that ended
 * `USER_CONFIRMATION_REQUIRED` or `FAILED_EXECUTION` is settled. The run
 * finished; the work did not. Those are reported honestly as
 * `completed_with_review`, which is a different claim from "still running".
 */
export function unsettledFieldIds(
  outcomes: readonly { fieldId: string; status: string }[],
): string[] {
  return outcomes
    .filter((outcome) => !isFinalFieldStatus(outcome.status))
    .map((outcome) => outcome.fieldId);
}

/**
 * The check a run performs before claiming COMPLETED.
 *
 * Throws rather than repairing. Silently coercing a temporary status into a
 * final one would hide exactly the defect this exists to catch, and the last
 * time a stage was rendered as a verdict it produced eighteen popup cards
 * reading "is waiting on the page analysis" beside a summary claiming nothing
 * needed confirmation.
 */
export function assertNoTemporaryStatuses(
  outcomes: readonly { fieldId: string; status: string }[],
): void {
  const pending = outcomes.filter((outcome) => isRunningFieldStatus(outcome.status));
  if (pending.length === 0) return;
  throw new Error(
    `A run may not complete with ${pending.length} field(s) in a temporary status ` +
      `(${[...new Set(pending.map((entry) => entry.status))].join(', ')}). ` +
      'A stage marker is not a final status.',
  );
}

/** Final statuses counted by name, over every field the run saw. */
export function countFinalStatuses(
  outcomes: readonly FinalFieldOutcome[],
): Record<FinalFieldStatus, number> {
  const counts = Object.fromEntries(FINAL_FIELD_STATUSES.map((status) => [status, 0])) as Record<
    FinalFieldStatus,
    number
  >;
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}
