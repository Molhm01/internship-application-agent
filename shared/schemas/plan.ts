import { z } from 'zod';
import { confidenceSchema, idSchema, jobContextSchema } from './common.js';
import { fieldStatusSchema, fieldTypeSchema } from './fields.js';
import { ATS_IDS } from '../constants/ats.js';

export const fillActionKindSchema = z.enum([
  'fill_text',
  'select_option',
  'select_multiple',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
  'upload_file',
  'skip',
  'manual_review',
]);

export type FillActionKind = z.infer<typeof fillActionKindSchema>;

export const answerSourceSchema = z.enum([
  'profile',
  'approved_answer',
  'generated',
  'job_context',
  'user_override',
]);

export type AnswerSource = z.infer<typeof answerSourceSchema>;

/**
 * One intended change to one field. This is the *only* thing a model is
 * permitted to produce — there is no field for a selector, a script, or any
 * other executable instruction, so a compromised or confused model cannot
 * express a DOM operation.
 */
export const fillActionSchema = z
  .object({
    fieldId: idSchema,
    question: z.string().max(2000),
    fieldType: fieldTypeSchema,
    action: fillActionKindSchema,
    value: z.union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()]).optional(),
    matchedOption: z.string().max(1000).optional(),
    documentId: idSchema.optional(),
    source: answerSourceSchema,
    sourceReference: z.string().max(500).optional(),
    confidence: confidenceSchema,
    requiresReview: z.boolean(),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((action, ctx) => {
    const needsValue: readonly FillActionKind[] = [
      'fill_text',
      'select_option',
      'select_multiple',
      'choose_radio',
      'toggle_checkbox',
      'set_date',
    ];
    if (needsValue.includes(action.action) && action.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `action "${action.action}" requires a value`,
      });
    }
    if (action.action === 'upload_file' && !action.documentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentId'],
        message: 'action "upload_file" requires a documentId',
      });
    }
    if (action.action === 'select_multiple' && !Array.isArray(action.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'action "select_multiple" requires an array value',
      });
    }
    if (action.action === 'toggle_checkbox' && typeof action.value !== 'boolean') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'action "toggle_checkbox" requires a boolean value',
      });
    }
  });

export type FillAction = z.infer<typeof fillActionSchema>;

export const applicationPlanSchema = z.object({
  runId: idSchema,
  applicationUrl: z.string().url(),
  ats: z.enum(ATS_IDS),
  jobContext: jobContextSchema.optional(),
  actions: z.array(fillActionSchema),
  warnings: z.array(z.string().max(2000)).default([]),
  requiresUserReview: z.boolean(),
});

export type ApplicationPlan = z.infer<typeof applicationPlanSchema>;

export const fillResultSchema = z.object({
  fieldId: idSchema,
  status: fieldStatusSchema,
  attemptedValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()])
    .optional(),
  message: z.string().max(2000).optional(),
});

export type FillResult = z.infer<typeof fillResultSchema>;

export const verificationResultSchema = z.object({
  fieldId: idSchema,
  verified: z.boolean(),
  /** What the page actually contained after the action, for honest reporting. */
  observedValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()])
    .optional(),
  method: z.enum([
    'input_value',
    'selected_option',
    'checked_state',
    'visible_text',
    'uploaded_filename',
    'validation_cleared',
    'not_verifiable',
  ]),
  message: z.string().max(2000).optional(),
});

export type VerificationResult = z.infer<typeof verificationResultSchema>;
