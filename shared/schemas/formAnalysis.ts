import { z } from 'zod';
import { confidenceSchema, idSchema } from './common.js';
import { canonicalQuestionSchema, fieldOptionSchema, fieldSectionSchema } from './fields.js';
import { agentErrorSchema } from './error.js';
import { SENSITIVE_CATEGORIES } from '../constants/ats.js';

/**
 * The normalized question model, and the batched analysis that runs over it.
 *
 * Two rules make this safe to hand to a local model:
 *
 * 1. A question carries no selector, no DOM path, and no element handle. The
 *    model sees text, options, and metadata; it can only name a `questionId`
 *    the extension itself minted.
 * 2. A returned answer can only be one of the fixed `PLANNED_ACTIONS`. There is no
 *    field in which a selector, a script, or any executable instruction could be
 *    expressed, and Zod strips unknown keys, so a model cannot smuggle one in.
 *
 * The deterministic executor owns every DOM interaction. The model only decides
 * what a question means and which saved fact answers it.
 */

/** How a question is answered, independent of the underlying markup. */
export const questionControlTypeSchema = z.enum([
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'password',
  'url',
  'date',
  'month',
  'select',
  'combobox',
  'radio_group',
  'checkbox',
  'checkbox_group',
  'file_upload',
  'rich_text',
  'unknown',
]);

export type QuestionControlType = z.infer<typeof questionControlTypeSchema>;

/**
 * Categories that may never be answered without an explicit saved preference.
 * Absent means the question is ordinary. This is the one existing sensitive
 * taxonomy — the profile's saved policies are keyed by exactly these values, so
 * a normalized question and a stored preference can never disagree.
 */
export const questionSensitiveCategorySchema = z.enum(SENSITIVE_CATEGORIES);

/** One logical question. A radio group is one of these, not five. */
export const normalizedQuestionSchema = z.object({
  questionId: idSchema,
  /** Every scanned control this question answers through. */
  fieldIds: z.array(idSchema).min(1).max(200),
  questionText: z.string().max(2000),
  /** Help text, legend, nearby paragraph, and upload instructions, joined. */
  contextualText: z.string().max(4000).default(''),
  section: fieldSectionSchema.optional(),
  controlType: questionControlTypeSchema,
  required: z.boolean().default(false),
  currentValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()])
    .optional(),
  options: z.array(fieldOptionSchema).max(500).optional(),
  validation: z.string().max(2000).optional(),
  sensitiveCategory: questionSensitiveCategorySchema.optional(),
  /** Best deterministic guess. `unknown` is honest, not a failure. */
  likelyIntent: canonicalQuestionSchema.default('unknown'),
});

export type NormalizedQuestion = z.infer<typeof normalizedQuestionSchema>;

/**
 * One saved fact offered to the model. Facts are addressed by id so an answer
 * can name what it was grounded in, and so a fact the model did not receive can
 * never appear in a `sourceFactIds` list.
 */
export const profileFactSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  value: z.string().max(4000),
});

export type ProfileFact = z.infer<typeof profileFactSchema>;

export const analysisJobContextSchema = z.object({
  company: z.string().max(300).optional(),
  jobTitle: z.string().max(300).optional(),
  /** Truncated by the caller. The model never needs the whole posting. */
  jobDescriptionExcerpt: z.string().max(6000).optional(),
});

export const analysisDocumentSchema = z.object({
  kind: z.enum(['resume', 'cover_letter']),
  filename: z.string().max(255),
  mimeType: z.string().max(120),
});

/**
 * One request per page. Never one per field.
 *
 * `questions` holds only what deterministic resolution could not settle, and
 * `facts` holds only the profile values relevant to those questions.
 */
export const formAnalysisRequestSchema = z.object({
  pageId: idSchema,
  questions: z.array(normalizedQuestionSchema).min(1).max(120),
  facts: z.array(profileFactSchema).max(200).default([]),
  approvedAnswers: z
    .array(z.object({ id: idSchema, question: z.string().max(2000), answer: z.string().max(8000) }))
    .max(200)
    .default([]),
  jobContext: analysisJobContextSchema.default({}),
  documents: z.array(analysisDocumentSchema).max(4).default([]),
  model: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(180_000).default(60_000),
});

export type FormAnalysisRequest = z.infer<typeof formAnalysisRequestSchema>;

/**
 * The complete set of things an answer may ask for. Adding a member here is the
 * only way to widen what a model can cause to happen.
 */
export const PLANNED_ACTIONS = [
  'SET_TEXT',
  /**
   * Fill the account password for this origin.
   *
   * Deliberately carries no value. The model may say "this field wants the
   * account password"; it never sees one and can never supply one. The value
   * comes from the encrypted credential vault at fill time, or the field is
   * left for the user.
   */
  'SET_PASSWORD',
  'SET_DATE',
  'SELECT_OPTION',
  'SELECT_RADIO',
  'SET_CHECKBOX',
  'UPLOAD_RESUME',
  'UPLOAD_COVER_LETTER',
  'LEAVE_BLANK',
  'REQUIRE_USER_REVIEW',
] as const;

export const plannedActionSchema = z.enum(PLANNED_ACTIONS);
export type PlannedActionKind = z.infer<typeof plannedActionSchema>;

export const plannedAnswerSchema = z
  .object({
    questionId: idSchema,
    action: plannedActionSchema,
    /** Text, an ISO date, or "true"/"false" for a checkbox. */
    value: z.string().max(20_000).optional(),
    /** The exact option label the model chose, matched against real options. */
    selectedOption: z.string().max(1000).optional(),
    confidence: confidenceSchema,
    sourceFactIds: z.array(z.string().min(1).max(200)).max(20).default([]),
    requiresReview: z.boolean().default(true),
    reason: z.string().max(1000).default(''),
  })
  .superRefine((answer, ctx) => {
    // A password never travels in a plan. Anything a model puts here is
    // discarded rather than trusted, because a value in this position could
    // only have been invented or echoed back from somewhere it should not be.
    if (answer.action === 'SET_PASSWORD' && answer.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'SET_PASSWORD must not carry a value; the vault supplies it',
      });
    }
    const needsValue: PlannedActionKind[] = ['SET_TEXT', 'SET_DATE', 'SET_CHECKBOX'];
    if (needsValue.includes(answer.action) && !answer.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${answer.action} requires a value`,
      });
    }
    const needsOption: PlannedActionKind[] = ['SELECT_OPTION', 'SELECT_RADIO'];
    if (needsOption.includes(answer.action) && !answer.selectedOption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedOption'],
        message: `${answer.action} requires selectedOption`,
      });
    }
  });

export type PlannedAnswer = z.infer<typeof plannedAnswerSchema>;

export const formFillPlanSchema = z.object({
  pageId: idSchema,
  answers: z.array(plannedAnswerSchema).max(200).default([]),
});

export type FormFillPlan = z.infer<typeof formFillPlanSchema>;

export const formAnalysisResponseSchema = z.object({
  plan: formFillPlanSchema,
  model: z.string().max(200),
  durationMs: z.number().int().nonnegative(),
  /** Answers the model returned that failed validation and were discarded. */
  rejected: z.array(z.string().max(600)).max(200).default([]),
  error: agentErrorSchema.optional(),
});

export type FormAnalysisResponse = z.infer<typeof formAnalysisResponseSchema>;

/**
 * Discards anything the model returned that names a question it was not asked
 * about, repeats a question, or asks for a document that is not loaded.
 *
 * This runs on both sides of the wire. Rejection is silent to the model and
 * loud in the report: a discarded answer is listed, never quietly dropped.
 */
export function sanitizeFormFillPlan(
  plan: FormFillPlan,
  askedQuestionIds: readonly string[],
  availableDocuments: readonly ('resume' | 'cover_letter')[] = [],
): { plan: FormFillPlan; rejected: string[] } {
  const asked = new Set(askedQuestionIds);
  const seen = new Set<string>();
  const rejected: string[] = [];
  const answers: PlannedAnswer[] = [];

  for (const answer of plan.answers) {
    if (!asked.has(answer.questionId)) {
      rejected.push(`Unknown questionId "${answer.questionId}".`);
      continue;
    }
    if (seen.has(answer.questionId)) {
      rejected.push(`Duplicate answer for "${answer.questionId}".`);
      continue;
    }
    if (answer.action === 'UPLOAD_RESUME' && !availableDocuments.includes('resume')) {
      rejected.push(`No résumé is loaded, so "${answer.questionId}" cannot upload one.`);
      continue;
    }
    if (answer.action === 'UPLOAD_COVER_LETTER' && !availableDocuments.includes('cover_letter')) {
      rejected.push(`No cover letter is loaded, so "${answer.questionId}" cannot upload one.`);
      continue;
    }
    seen.add(answer.questionId);
    answers.push(answer);
  }

  return { plan: { pageId: plan.pageId, answers }, rejected };
}
