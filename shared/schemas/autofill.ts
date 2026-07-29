import { z } from 'zod';
import { ATS_IDS } from '../constants/ats.js';
import { agentErrorSchema } from './error.js';
import { confidenceSchema, idSchema, isoDateTimeSchema } from './common.js';
import { canonicalQuestionSchema } from './fields.js';
import { deterministicAnswerSourceSchema, deterministicFillActionKindSchema } from './fill.js';

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
   * Written answers the model produced and validation passed. Off until the
   * user opts in, because generated prose is the one thing here they have not
   * already written themselves.
   */
  autoFillValidatedAiAnswers: z.boolean().default(false),
  /**
   * Permits a grounded best-effort answer on ordinary questions. Off by
   * default: an unanswered field is visibly unanswered, while a wrong one looks
   * finished.
   */
  allowGroundedNonSensitiveGuesses: z.boolean().default(false),
  /**
   * Applies a saved disclosure preset — in practice, declining. Only ever acts
   * on an explicit preset; it can never cause a trait to be disclosed.
   */
  autoFillSensitiveDisclosurePresets: z.boolean().default(true),
  autoAttachApprovedDocuments: z.boolean().default(false),
  scrollToFirstReviewField: z.boolean().default(true),
  /**
   * Not a preference. It is stored so it appears in any exported settings and
   * in the UI as a fact, and the schema refuses any other value.
   */
  neverSubmit: z.literal(true).default(true),
});

export type AutofillSettings = z.infer<typeof autofillSettingsSchema>;

export const DEFAULT_AUTOFILL_SETTINGS: AutofillSettings = autofillSettingsSchema.parse({});

export const autofillPhaseSchema = z.enum([
  'preparing',
  'scanning',
  'discovering_options',
  'resolving',
  'generating',
  'planning',
  'filling',
  'verifying',
  'rescanning',
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
  generating: 'Generating written answers',
  planning: 'Preparing answers',
  filling: 'Filling fields',
  verifying: 'Verifying answers',
  rescanning: 'Rescanning dynamic fields',
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
  verification: z.enum(['verified', 'unverified', 'not_attempted', 'failed']),
  /** Set when the field is asking for attention; absent when it is settled. */
  reviewReason: reviewReasonSchema.optional(),
  reviewed: z.boolean().default(false),
  failureCode: z.string().max(80).optional(),
  reason: z.string().max(2000).default(''),
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
    documentsAttached: z.number().int().nonnegative().default(0),
    /**
     * Always true. Recorded per run so the report itself is evidence that no
     * submission happened, rather than something the reader has to trust.
     */
    submissionPrevented: z.literal(true).default(true),
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
