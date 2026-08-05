import { z } from 'zod';

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
    fieldId: z.string().max(200),
    /** The canonical intent, when one was resolved. Never the question text. */
    intent: z.string().max(120).optional(),
    controlType: z.string().max(40),
    required: z.boolean(),
    plannerSource: tracePlannerSourceSchema,
    /** The action the planner produced. */
    plannedAction: z.string().max(60).optional(),
    /** Whether the control-type contract accepted, repaired, or rejected it. */
    contractResult: z.enum(['accepted', 'repaired', 'rejected', 'not_applicable']),
    /** Whether the executor was actually invoked for this field. */
    executorAttempted: z.boolean(),
    verification: z.string().max(40),
    /** An `ERROR_CODES` member. Never a message, which can quote a value. */
    errorCode: z.string().max(60).optional(),
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

    /** Final `fieldStatusSchema` outcomes, counted by name. */
    finalStatusCounts: z.record(z.string().max(60), z.number().int().nonnegative()),

    stages: z.array(stageTraceSchema).max(200),
    fields: z.array(fieldTraceSchema).max(500),
    totalDurationMs: z.number().nonnegative(),
  })
  .strict();

export type RunTrace = z.infer<typeof runTraceSchema>;

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

  const missingValue = count(
    (field) => field.plannerSource === 'none' && field.intent !== undefined,
  );
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

  const failed = count((field) => field.verification === 'failed');
  if (failed > 0) lines.push(`${failed} field(s) were written but did not verify.`);

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
