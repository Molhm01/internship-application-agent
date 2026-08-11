import { z } from 'zod';
import { ATS_IDS } from '../constants/ats.js';
import { agentErrorSchema } from './error.js';
import { confidenceSchema, idSchema, isoDateTimeSchema } from './common.js';
import { canonicalQuestionSchema } from './fields.js';
import { deterministicAnswerSourceSchema, deterministicFillActionKindSchema } from './fill.js';
import { dropdownTraceSchema } from './dropdownExecution.js';
import { REQUIRED_FIELD_OUTCOMES } from '../logic/requiredFieldAudit.js';
import { ANNOTATION_KINDS, FINAL_FIELD_STATUSES } from '../logic/finalFieldStatus.js';

/**
 * One-button autofill: the contract between the popup, the background
 * orchestrator, and the content script.
 *
 * The settings here decide what may be filled without a person looking at it
 * first. They are deliberately fine-grained, because "fill my name" and "answer
 * a question about my disability" are not the same permission.
 */

export const autofillSettingsSchema = z.object({
  applicationAutofillEnabled: z.boolean().default(true),
  /** A saved value copied verbatim: a name, an email, a postal code. */
  autoFillExactProfileValues: z.boolean().default(true),
  /** A saved value matched to this form's own wording for the same thing. */
  autoFillSemanticProfileMatches: z.boolean().default(true),
  autoFillApprovedAnswers: z.boolean().default(true),
  /**
   * Written answers the model produced and validation passed.
   *
   * On by default. It was off, which meant every drafted answer landed in
   * review no matter how good it was — so "Autofill Application" filled the
   * name and email and handed back two dozen fields to do by hand, which is not
   * autofill. The safety is not this switch: it is that the answer must pass
   * validation, must be grounded, must clear the confidence bands, and can
   * never touch a protected or employer-relationship question.
   */
  autoFillValidatedAiAnswers: z.boolean().default(true),
  /**
   * Permits a grounded best-effort answer on ordinary questions.
   *
   * "Grounded" is load-bearing and enforced in `approvalPolicy`: below 0.90 an
   * answer fills only when it names the saved facts it rests on. An ungrounded
   * guess still does not fill at any confidence.
   */
  allowGroundedNonSensitiveGuesses: z.boolean().default(true),
  /**
   * Applies a saved disclosure preset — in practice, declining. Only ever acts
   * on an explicit preset; it can never cause a trait to be disclosed.
   */
  autoFillSensitiveDisclosurePresets: z.boolean().default(true),
  /**
   * Attach the tailored résumé and cover letter to the upload fields that ask
   * for them.
   *
   * On by default. Uploading the document the user generated for this exact job
   * is the point of the handoff; making them do it by hand on every form was
   * the single largest remaining manual step. Only bundle documents and the
   * user's own registered résumé are ever attached — this can never reach an
   * arbitrary file, and a form asking for a transcript still gets nothing.
   */
  autoAttachApprovedDocuments: z.boolean().default(true),
  scrollToFirstReviewField: z.boolean().default(true),
  /**
   * Not a preference. It is stored so it appears in any exported settings and
   * in the UI as a fact, and the schema refuses any other value.
   */
  neverSubmit: z.literal(true).default(true),
  /**
   * Run the retired whole-page pipeline instead of Agent Mode.
   *
   * Developer-only, off by default, and only consulted when `developerMode` is
   * also on. It exists so the old path stays exercisable rather than being
   * deleted for tidiness — not so a user can end up with two systems writing to
   * one page. The worker resolves which of the two runs *once*, before either
   * starts, so they can never be concurrent.
   */
  legacyWholePageAutofill: z.boolean().default(false),
});

export type AutofillSettings = z.infer<typeof autofillSettingsSchema>;

export const DEFAULT_AUTOFILL_SETTINGS: AutofillSettings = autofillSettingsSchema.parse({});

export const autofillPhaseSchema = z.enum([
  'preparing',
  'scanning',
  'discovering_options',
  'resolving',
  /**
   * The one batched analysis of what the profile could not answer.
   *
   * Distinct from `generating`, which drafts written answers for individual
   * questions. Naming this separately is what lets the popup say "analyzing the
   * remaining questions" instead of showing "Matching profile information" for
   * the twenty seconds a model call actually takes.
   */
  'analyzing',
  'generating',
  'planning',
  'normalizing',
  'filling',
  'verifying',
  /**
   * Writing and confirming what the analysis produced.
   *
   * Kept apart from `filling` and `verifying` so the popup — and the durable
   * run state behind it — can say which half of the run is in progress. The two
   * halves have different failure modes and different remedies: the first stage
   * failing means the profile or the page is wrong, the second means the local
   * model is.
   */
  'filling_ai',
  'verifying_ai',
  'rescanning',
  /**
   * The Dropdown Engine pass, driving every option control on the page.
   *
   * Named separately from `filling` because it is a separate stage with a
   * separate failure mode, and because the popup must not be able to show a
   * finished run while it is still going. A run whose summary appeared while
   * nine menus were still being opened is what made the engine look absent.
   */
  'filling_dropdowns',
  'rescanning_dependencies',
  'completed',
  'completed_with_review',
  'failed',
  'cancelled',
]);

export type AutofillPhase = z.infer<typeof autofillPhaseSchema>;

/** What the popup says while each phase runs. */
export const AUTOFILL_PHASE_LABELS: Record<AutofillPhase, string> = {
  preparing: 'Preparing',
  scanning: 'Scanning application',
  discovering_options: 'Inspecting answer choices',
  resolving: 'Matching profile information',
  analyzing: 'Analyzing the remaining questions',
  generating: 'Generating written answers',
  planning: 'Preparing answers',
  normalizing: 'Reading the questions',
  filling: 'Filling saved answers',
  verifying: 'Verifying saved answers',
  filling_ai: 'Filling analyzed answers',
  verifying_ai: 'Verifying analyzed answers',
  rescanning: 'Rescanning dynamic fields',
  filling_dropdowns: 'Processing dropdown menus',
  rescanning_dependencies: 'Reading choices the page just produced',
  completed: 'Autofill complete',
  completed_with_review: 'Autofill complete — some fields need review',
  failed: 'Autofill failed',
  cancelled: 'Autofill cancelled',
};

/**
 * Why a field is drawing attention to itself. The colours are meaning, not
 * decoration: a person scanning the page should be able to tell "I must answer
 * this myself" from "check what was written here".
 */
export const reviewReasonSchema = z.enum([
  'ai_suggestion',
  'missing_information',
  'manual_required',
  'failed',
]);

export type ReviewReason = z.infer<typeof reviewReasonSchema>;

export const REVIEW_BADGES: Record<ReviewReason, string> = {
  ai_suggestion: 'AI suggestion — review',
  missing_information: 'Information needed',
  manual_required: 'Manual response required',
  failed: 'Autofill failed',
};

export const autofillFieldResultSchema = z.object({
  fieldId: idSchema,
  question: z.string().max(2000),
  canonicalQuestion: canonicalQuestionSchema.optional(),
  action: deterministicFillActionKindSchema,
  source: deterministicAnswerSourceSchema,
  confidence: confidenceSchema,
  sensitive: z.boolean().default(false),
  /** What the page actually held afterwards, read back from the DOM. */
  actualValue: z.string().max(2000).optional(),
  /**
   * What happened to this field.
   *
   * `optional_left_blank` is its own state rather than a flavour of
   * `not_attempted`, because the two look identical in a count and mean
   * opposite things: one is work outstanding, the other is work correctly
   * finished. Collapsing them is what produced "Could not fill: 0" beside a
   * list of fields that read as unresolved.
   */
  verification: z.enum([
    'verified',
    'unverified',
    'not_attempted',
    'optional_left_blank',
    /**
     * The form has switched this question off, so there was nothing to verify.
     *
     * Distinct from `optional_left_blank`, which the two used to share. "If
     * other, enter School" beside a School dropdown reading "Rutgers
     * University" is not an optional question the applicant declined — it is a
     * question this form is not asking, and answering it would be wrong.
     */
    'not_applicable',
    'failed',
  ]),
  /** Set when the field is asking for attention; absent when it is settled. */
  reviewReason: reviewReasonSchema.optional(),
  reviewed: z.boolean().default(false),
  failureCode: z.string().max(80).optional(),
  /** How the dropdown engine got on, when this field drove one. Values stripped. */
  dropdown: dropdownTraceSchema.optional(),
  reason: z.string().max(2000).default(''),
  /**
   * The action actually attempted, and how long it took.
   *
   * Recorded because the report could not previously say what was *tried*: a
   * field that never received an executable action and one whose execution
   * failed both arrived as "needs review", which is how the summary read
   * "Could not fill: 0" above a list of unresolved fields.
   */
  attemptedAction: deterministicFillActionKindSchema.optional(),
  durationMs: z.number().int().nonnegative().max(600_000).optional(),
});

export type AutofillFieldResult = z.infer<typeof autofillFieldResultSchema>;

export const autofillStatusSchema = z.enum([
  'idle',
  'running',
  'completed',
  'completed_with_review',
  'cancelled',
  'failed',
]);

export type AutofillStatus = z.infer<typeof autofillStatusSchema>;

export const applicationAutofillReportSchema = z
  .object({
    id: idSchema,
    scanIds: z.array(idSchema).max(20).default([]),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.optional(),
    url: z.string().url(),
    ats: z.enum(ATS_IDS),
    iterations: z.number().int().min(0).max(20),
    fieldsFound: z.number().int().nonnegative(),
    fieldsCompleted: z.number().int().nonnegative(),
    fieldsVerified: z.number().int().nonnegative(),
    semanticMatches: z.number().int().nonnegative().default(0),
    generatedAnswers: z.number().int().nonnegative().default(0),
    exactProfileMatches: z.number().int().nonnegative().default(0),
    approvedAnswerMatches: z.number().int().nonnegative().default(0),
    uncertainSuggestions: z.number().int().nonnegative().default(0),
    manualBlockers: z.number().int().nonnegative().default(0),
    failedFields: z.number().int().nonnegative().default(0),
    skippedFields: z.number().int().nonnegative().default(0),
    /**
     * Optional questions the agent deliberately left empty — no middle name, no
     * second address line. Counted separately so they never appear as
     * outstanding work, and never inflate "needs confirmation".
     */
    optionalLeftBlank: z.number().int().nonnegative().default(0),
    /**
     * Required fields that still need the user, counted from the audit rather
     * than from the results list — the two disagree whenever a required field
     * produced no action at all, which is exactly when the summary used to
     * under-report.
     */
    userInputRequired: z.number().int().nonnegative().default(0),
    /** Fields a CAPTCHA, MFA, or protected page stopped the agent from reaching. */
    blockedFields: z.number().int().nonnegative().default(0),
    /**
     * The six final statuses, counted over every question on the form.
     *
     * Carried in the report so the summary is checkable against itself: the
     * counters above are tallies of this object, and a test can assert their
     * sum equals `fieldsFound` without re-deriving anything.
     */
    finalStatusCounts: z
      .record(z.enum(FINAL_FIELD_STATUSES), z.number().int().nonnegative())
      .default({}),
    /**
     * One terminal record per question, in page order.
     *
     * This is what the popup renders. `results` below is the fill pipeline's own
     * account, keyed by planner action, and a question the planner never
     * produced an action for is simply absent from it — which is how a run that
     * settled two of twenty-seven fields still looked finished. Every field on
     * the form appears here, with exactly one final status.
     */
    fieldOutcomes: z
      .array(
        z.object({
          fieldId: idSchema,
          label: z.string().max(2000),
          status: z.enum(FINAL_FIELD_STATUSES),
          annotation: z.enum(ANNOTATION_KINDS),
          required: z.boolean(),
          reason: z.string().max(2000).default(''),
        }),
      )
      .max(2000)
      .default([]),
    /** Wall-clock time for the whole run, so a slow run is visibly slow. */
    totalDurationMs: z.number().int().nonnegative().max(3_600_000).default(0),
    documentsAttached: z.number().int().nonnegative().default(0),
    /**
     * Always true. Recorded per run so the report itself is evidence that no
     * submission happened, rather than something the reader has to trust.
     */
    submissionPrevented: z.literal(true).default(true),
    /**
     * The terminal state of every required field on the page.
     *
     * Carried in the report rather than recomputed by each reader, because "no
     * required field may be silently skipped" is only checkable if the run
     * itself states what happened to each one. A field the run never reached is
     * reported as needing the user, which makes the omission visible.
     */
    requiredFields: z
      .array(
        z.object({
          fieldId: idSchema,
          label: z.string().max(2000),
          outcome: z.enum(REQUIRED_FIELD_OUTCOMES),
          reason: z.string().max(2000),
        }),
      )
      .max(2000)
      .default([]),
    status: autofillStatusSchema,
    results: z.array(autofillFieldResultSchema).max(2000).default([]),
    warnings: z.array(z.string().min(1).max(2000)).max(50).default([]),
    error: agentErrorSchema.optional(),
  })
  .superRefine((report, ctx) => {
    if (report.fieldsVerified > report.fieldsCompleted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fieldsVerified'],
        message: 'A field cannot be verified without having been completed',
      });
    }
    if (report.status === 'completed' && report.results.some((result) => result.reviewReason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'A run with fields awaiting review is completed_with_review, not completed',
      });
    }
    // Every question has exactly one final status, so the six counts add up to
    // the number of questions. Asserted in the schema rather than in a test:
    // this is the invariant the popup's summary rests on, and it must be
    // impossible to persist a report that breaks it.
    if (report.fieldOutcomes.length > 0) {
      const total = Object.values(report.finalStatusCounts).reduce((sum, count) => sum + count, 0);
      if (total !== report.fieldOutcomes.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['finalStatusCounts'],
          message: `The final statuses total ${total} but the run recorded ${report.fieldOutcomes.length} fields`,
        });
      }
      if (report.fieldsFound !== report.fieldOutcomes.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fieldsFound'],
          message: 'fieldsFound must be the number of fields with a final status',
        });
      }
    }
    // COMPLETED is a claim about every field, and it may not be made while one
    // of them is still outstanding. `completed_with_review` is the honest state
    // for that run, and the popup already knows how to render it.
    if (
      report.status === 'completed' &&
      report.fieldOutcomes.some(
        (outcome) =>
          outcome.status === 'USER_CONFIRMATION_REQUIRED' ||
          outcome.status === 'FAILED_EXECUTION' ||
          outcome.status === 'BLOCKED',
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'A run with an unsettled field cannot be completed',
      });
    }
  });

export type ApplicationAutofillReport = z.infer<typeof applicationAutofillReportSchema>;

export const autofillProgressSchema = z.object({
  runId: idSchema,
  phase: autofillPhaseSchema,
  iteration: z.number().int().min(0).max(20),
  message: z.string().max(300),
  fieldsCompleted: z.number().int().nonnegative().default(0),
  fieldsTotal: z.number().int().nonnegative().default(0),
});

export type AutofillProgress = z.infer<typeof autofillProgressSchema>;

/** One entry in the in-page review queue, in DOM order. */
export const reviewFieldSchema = z.object({
  fieldId: idSchema,
  question: z.string().max(2000),
  reason: reviewReasonSchema,
  badge: z.string().max(120),
  /** Position down the page, used only for ordering. */
  documentOrder: z.number().int().nonnegative(),
  reviewed: z.boolean().default(false),
});

export type ReviewField = z.infer<typeof reviewFieldSchema>;

export const reviewFieldListSchema = z.object({
  fields: z.array(reviewFieldSchema).max(2000).default([]),
});
