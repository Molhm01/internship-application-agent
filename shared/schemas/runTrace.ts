import { z } from 'zod';
import { ANNOTATION_KINDS, FINAL_FIELD_STATUSES } from '../logic/finalFieldStatus.js';
import { requiredSourceSchema } from './fields.js';
import { dropdownTraceSchema } from './dropdownExecution.js';

/**
 * One autofill run, described in counts and outcomes only.
 *
 * The failure this exists for was not that autofill went wrong — it was that
 * nobody could say *where* it went wrong. Twenty-six fields detected and two
 * filled looks identical from outside whether the cause was a missing profile
 * value, a missing intent mapping, an action the contract rejected, an executor
 * that was never invoked, a DOM write that failed, a verification that failed,
 * an analysis that never ran, or a run that completed early. Those are eight
 * different repairs, and the run trace is what tells them apart.
 *
 * ## What may never appear here
 *
 * No field values. No passwords. No résumé or document bytes. No profile
 * contents. No model prompts or completions. No personal information of any
 * kind. Every field record carries a sanitized id, an intent name, a control
 * type, and the outcome of each stage — nothing that was typed and nothing that
 * was read from the page.
 *
 * The schema is what enforces that: Zod strips unknown keys, so a future caller
 * that tries to attach a value to a trace record silently loses it rather than
 * quietly publishing it.
 */

/** Where a field's answer came from, or why it had none. */
export const tracePlannerSourceSchema = z.enum([
  'deterministic',
  'structural',
  'approved_answer',
  'document',
  'ai',
  'none',
]);

/** What became of one field, at each stage it passed through. */
export const fieldTraceSchema = z
  .object({
    /**
     * The scanner's own field id. Derived from position and control identity,
     * never from the value — safe to log, and the only way to correlate a field
     * across the scan, the plan, and the fill.
     */
    /**
     * The run and the build this record came from, repeated on every field.
     *
     * Redundant against the trace envelope, and deliberately so: field records
     * get pasted into bug reports one at a time, and a record that cannot say
     * which run and which bundle produced it is unusable. Three rounds of
     * repairs looked ineffective because nobody could tell which build the
     * evidence came from.
     */
    runId: z.string().max(200),
    buildId: z.string().max(120),
    fieldId: z.string().max(200),
    /**
     * The frame the control actually lives in. 0 is the top document.
     *
     * An application is routinely not one document — iCIMS, Workday and
     * SmartRecruiters render whole sections in iframes — and "the field was
     * found in frame 2 and the write went to frame 0" is invisible without
     * this.
     */
    frameId: z.number().int().nonnegative().default(0),
    /**
     * The question as the employer worded it.
     *
     * A question, never an answer. Without it every record in this file reads
     * `field-1a2b3c`, which correlates perfectly and diagnoses nothing — the
     * whole point of a trace is that a person can look at it and say "that one,
     * the graduation date, is the field that failed".
     */
    label: z.string().max(300),
    /** Which part of the form the question sits under. */
    section: z.string().max(60).optional(),
    /** The canonical intent, when one was resolved. Never the question text. */
    intent: z.string().max(120).optional(),
    controlType: z.string().max(40),
    /**
     * Which repetition of a repeating block this control belongs to.
     *
     * A number, never a value. Without it, "three employer blocks were filled"
     * and "one employer was filled into three blocks" are the same record — and
     * the second is a fabricated employment history that looked, from the
     * outside, like unusually good coverage.
     */
    recordIndex: z.number().int().nonnegative().max(50).optional(),
    required: z.boolean(),
    /**
     * The evidence behind `required`. A vocabulary member, never page text — an
     * asterisk's *location* is diagnostic, its wording is not.
     *
     * Without it, "this field was marked required" and "this field inherited an
     * asterisk from the section above it" are the same record, and the second is
     * a scanner defect that reads as a form the user failed to complete.
     */
    requiredSource: requiredSourceSchema.optional(),
    plannerSource: tracePlannerSourceSchema,
    /**
     * Whether a saved value existed to answer this question — yes or no, never
     * the value. "The profile had nothing" and "the profile had it and the
     * write failed" are the two halves of every unfilled field, and they were
     * indistinguishable from outside.
     */
    profileValueAvailable: z.boolean(),
    /** The action the planner produced. */
    plannedAction: z.string().max(60).optional(),
    /** Whether the control-type contract accepted, repaired, or rejected it. */
    contractResult: z.enum(['accepted', 'repaired', 'rejected', 'not_applicable']),
    /** Whether the executor was actually invoked for this field. */
    executorAttempted: z.boolean(),
    /** What verification observed. A stage result, not a verdict. */
    verification: z.string().max(40),
    /**
     * The verdict. Exactly one member of the closed final vocabulary, for every
     * field, always — this is the field the acceptance gates are written
     * against and the field the page annotation is chosen from.
     */
    finalStatus: z.enum(FINAL_FIELD_STATUSES),
    /** The mark this field should be wearing on the page. */
    annotation: z.enum(ANNOTATION_KINDS),
    /** An `ERROR_CODES` member. Never a message, which can quote a value. */
    errorCode: z.string().max(60).optional(),
    /**
     * What the dropdown engine did, for a field that drove one.
     *
     * The widget shape, how many choices it offered, how a match was reached,
     * and the stage it stopped at — and no answer, because `dropdownTraceSchema`
     * has no field able to hold one. This is the record that tells "the list
     * never opened" from "the list had nothing in it" from "the answer is not
     * on this form", which were one red badge between them.
     */
    dropdown: dropdownTraceSchema.optional(),
    /** How long this field spent in the executor, when it reached one. */
    durationMs: z.number().nonnegative().max(600_000).optional(),
  })
  .strict();

export type FieldTrace = z.infer<typeof fieldTraceSchema>;

/** How long one stage took. */
export const stageTraceSchema = z
  .object({
    stage: z.string().max(60),
    pass: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export type StageTrace = z.infer<typeof stageTraceSchema>;

export const runTraceSchema = z
  .object({
    buildId: z.string().max(120),
    runId: z.string().max(200),
    /**
     * Origin only — never the full URL. A path can carry a requisition id, a
     * candidate id, or a session token, and none of those is needed to say
     * which vendor's page this was.
     */
    origin: z.string().max(300),
    pageClassification: z.string().max(60),
    atsClassification: z.string().max(60),

    scanStartedAt: z.string().max(40),
    scanCompletedAt: z.string().max(40),

    rawControls: z.number().int().nonnegative(),
    falseControlsRemoved: z.number().int().nonnegative(),
    duplicateControlsRemoved: z.number().int().nonnegative(),
    normalizedQuestions: z.number().int().nonnegative(),
    requiredQuestions: z.number().int().nonnegative(),

    deterministicPlanned: z.number().int().nonnegative(),
    deterministicAccepted: z.number().int().nonnegative(),
    deterministicExecuted: z.number().int().nonnegative(),
    deterministicVerified: z.number().int().nonnegative(),

    questionsSentToAi: z.number().int().nonnegative(),
    aiRequests: z.number().int().nonnegative(),
    aiActionsReturned: z.number().int().nonnegative(),
    aiActionsAccepted: z.number().int().nonnegative(),
    aiActionsExecuted: z.number().int().nonnegative(),
    aiActionsVerified: z.number().int().nonnegative(),

    dependentFieldsRescanned: z.number().int().nonnegative(),
    requiredFieldsRemaining: z.number().int().nonnegative(),

    /**
     * The six final statuses, counted by name over every field the run saw.
     *
     * Every count the popup shows is derived from this one object, so a summary
     * that disagrees with its own field list is no longer constructible. It
     * previously mixed required-field verdicts with per-result verification
     * stages in one map, which double-counted required fields and counted stage
     * markers as outcomes — the arithmetic behind "Could not fill: 0" printed
     * above eighteen unanswered questions.
     */
    finalStatusCounts: z.record(z.enum(FINAL_FIELD_STATUSES), z.number().int().nonnegative()),
    /**
     * Fields still in a temporary state when the run stopped. Must be zero: a
     * run may not complete holding one, and recording it makes that checkable
     * from the trace alone rather than only from an assertion inside the worker.
     */
    pendingAtCompletion: z.number().int().nonnegative().default(0),

    stages: z.array(stageTraceSchema).max(200),
    fields: z.array(fieldTraceSchema).max(500),
    totalDurationMs: z.number().nonnegative(),
  })
  .strict();

export type RunTrace = z.infer<typeof runTraceSchema>;

/**
 * One run's trace, packaged for a human to open.
 *
 * The trace alone is a list of records; this adds the sentences that say what
 * the records mean, so a bug report carries a diagnosis rather than homework.
 * Still counts and outcomes only — the schema is strict, and `fieldTraceSchema`
 * has no field capable of holding a value.
 */
export const autofillRunTraceExportSchema = z
  .object({
    exportedAt: z.string().max(40),
    buildId: z.string().max(120),
    /** Why each field ended where it did, one sentence per cause. */
    summary: z.array(z.string().max(500)).max(50),
    trace: runTraceSchema,
  })
  .strict();

export type AutofillRunTraceExport = z.infer<typeof autofillRunTraceExportSchema>;

/**
 * The origin of a URL, or a placeholder.
 *
 * Never throws: a trace is diagnostic, and losing the whole trace because a URL
 * was malformed would defeat the purpose.
 */
export function traceOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'unknown';
  }
}

/**
 * Where the run lost the fields it did not fill, in one sentence per cause.
 *
 * This is the question the trace exists to answer, so it is answered here
 * rather than left to whoever reads the JSON. Each cause is reported only when
 * it actually occurred, and the counts come from the field records rather than
 * from the summary counters — so a summary that disagrees with its own fields
 * shows up as a discrepancy instead of being believed.
 */
export function describeRunTrace(trace: RunTrace): string[] {
  const lines: string[] = [];
  const count = (predicate: (field: FieldTrace) => boolean): number =>
    trace.fields.filter(predicate).length;

  const unmapped = count((field) => field.plannerSource === 'none' && field.intent === undefined);
  if (unmapped > 0) lines.push(`${unmapped} field(s) had no intent mapping at all.`);

  const missingValue = count((field) => !field.profileValueAvailable && field.intent !== undefined);
  if (missingValue > 0) {
    lines.push(`${missingValue} field(s) had an intent but no saved value to answer it.`);
  }

  const rejected = count((field) => field.contractResult === 'rejected');
  if (rejected > 0) lines.push(`${rejected} action(s) were rejected by the control-type contract.`);

  const repaired = count((field) => field.contractResult === 'repaired');
  if (repaired > 0) {
    lines.push(`${repaired} action(s) were repaired to suit their control before executing.`);
  }

  const notInvoked = count(
    (field) => field.plannedAction !== undefined && !field.executorAttempted,
  );
  if (notInvoked > 0) {
    lines.push(`${notInvoked} planned action(s) never reached the executor.`);
  }

  const failed = count((field) => field.finalStatus === 'FAILED_EXECUTION');
  if (failed > 0) lines.push(`${failed} field(s) were written but did not verify.`);

  const alreadyValid = count((field) => field.finalStatus === 'SKIPPED_ALREADY_VALID');
  if (alreadyValid > 0) {
    lines.push(`${alreadyValid} field(s) already held the correct answer and were left alone.`);
  }

  const optional = count((field) => field.finalStatus === 'OPTIONAL_LEFT_BLANK');
  if (optional > 0) {
    lines.push(`${optional} optional field(s) were deliberately left blank. Not outstanding work.`);
  }

  const blocked = count((field) => field.finalStatus === 'BLOCKED');
  if (blocked > 0) lines.push(`${blocked} field(s) were blocked by a verification step.`);

  if (trace.pendingAtCompletion > 0) {
    lines.push(
      `${trace.pendingAtCompletion} field(s) were still in a temporary state when the run stopped. ` +
        'That is a defect in the run, not in the page.',
    );
  }

  if (trace.questionsSentToAi > 0 && trace.aiRequests === 0) {
    lines.push(
      `${trace.questionsSentToAi} question(s) were queued for analysis but no request was made.`,
    );
  }
  if (trace.aiRequests > 0 && trace.aiActionsReturned === 0) {
    lines.push('The analysis ran and returned no usable answers.');
  }
  if (trace.requiredFieldsRemaining > 0) {
    lines.push(`${trace.requiredFieldsRemaining} required field(s) still need the user.`);
  }
  if (lines.length === 0) lines.push('Every field reached a final status with no losses.');
  return lines;
}
