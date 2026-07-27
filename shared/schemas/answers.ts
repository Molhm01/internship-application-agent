import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const answerTypeSchema = z.enum([
  'text',
  'boolean',
  'single_select',
  'multi_select',
  'date',
  'number',
]);

export type AnswerType = z.infer<typeof answerTypeSchema>;

export const answerValueSchema = z.union([
  z.string().max(20_000),
  z.array(z.string().max(2_000)),
  z.boolean(),
  z.number(),
]);

export type AnswerValue = z.infer<typeof answerValueSchema>;

/** Rejects an answer whose value does not match its declared `answerType`. */
function checkAnswerMatchesType(
  answer: { answerType: AnswerType; answer: AnswerValue },
  ctx: z.RefinementCtx,
): void {
  const { answerType, answer: value } = answer;
  const expectation: Record<AnswerType, (input: AnswerValue) => boolean> = {
    text: (input) => typeof input === 'string',
    boolean: (input) => typeof input === 'boolean',
    single_select: (input) => typeof input === 'string',
    multi_select: (input) => Array.isArray(input),
    date: (input) => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input),
    number: (input) => typeof input === 'number',
  };

  if (!expectation[answerType](value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['answer'],
      message: `answerType "${answerType}" does not match the supplied answer value`,
    });
  }
}

const approvedAnswerFields = {
  canonicalQuestion: z.string().min(1).max(1000),
  normalizedQuestion: z.string().min(1).max(1000).optional(),
  aliases: z.array(z.string().min(1).max(1000)).max(50).default([]),
  answerType: answerTypeSchema,
  answer: answerValueSchema,
  category: z.string().min(1).max(120),
  approved: z.boolean(),
  autoFillAllowed: z.boolean(),
  sensitive: z.boolean(),
  tailoringAllowed: z.boolean(),
  requiresReview: z.boolean(),
  classification: z.string().max(120).optional(),
  evidenceReferences: z.array(z.string().min(1).max(500)).max(50).optional(),
  scope: z.enum(['general', 'company', 'job']).optional(),
  scopeReference: z.string().max(500).optional(),
  wordCount: z.number().int().nonnegative().optional(),
  createdAt: isoDateTimeSchema.optional(),
};

/**
 * A reusable answer to a question the user has already decided how to handle.
 * The pipeline searches this library before it ever asks the model to generate
 * something new.
 */
export const approvedAnswerSchema = z
  .object({
    id: idSchema,
    ...approvedAnswerFields,
    lastUpdatedAt: isoDateTimeSchema,
  })
  .superRefine(checkAnswerMatchesType);

export type ApprovedAnswer = z.infer<typeof approvedAnswerSchema>;

/**
 * Body of `POST /answers`. The server owns `id` and `lastUpdatedAt`.
 *
 * A sensitive answer may never be auto-filled without review: the combination
 * `sensitive && autoFillAllowed && !requiresReview` is rejected here so no
 * caller — including a future UI bug — can create one.
 */
export const approvedAnswerInputSchema = z
  .object(approvedAnswerFields)
  .superRefine((answer, ctx) => {
    checkAnswerMatchesType(answer, ctx);

    if (answer.sensitive && answer.autoFillAllowed && !answer.requiresReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReview'],
        message:
          'A sensitive answer cannot be auto-filled without review. Set requiresReview, or turn off autoFillAllowed.',
      });
    }

    if (answer.autoFillAllowed && !answer.approved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoFillAllowed'],
        message: 'An answer must be approved before it can be auto-filled.',
      });
    }
  });

export type ApprovedAnswerInput = z.infer<typeof approvedAnswerInputSchema>;

export const answerListResponseSchema = z.object({
  answers: z.array(approvedAnswerSchema),
});

export type AnswerListResponse = z.infer<typeof answerListResponseSchema>;

export const answerDeleteResponseSchema = z.object({
  id: idSchema,
  deleted: z.literal(true),
});
