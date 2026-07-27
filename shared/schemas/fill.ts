import { z } from 'zod';
import { ATS_IDS } from '../constants/ats.js';
import { agentErrorSchema } from './error.js';
import { confidenceSchema, idSchema, isoDateTimeSchema } from './common.js';
import { fieldTypeSchema, fieldValueSchema } from './fields.js';

export const deterministicAnswerSourceSchema = z.enum([
  'profile',
  'approved_answer',
  'user_override',
  'ai_generated',
  'none',
]);

export type DeterministicAnswerSource = z.infer<typeof deterministicAnswerSourceSchema>;

export const fieldMatchSchema = z.object({
  fieldId: idSchema,
  matched: z.boolean(),
  source: deterministicAnswerSourceSchema,
  sourceReference: z.string().max(500).optional(),
  rawValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean(), z.number()])
    .optional(),
  formattedValue: fieldValueSchema.optional(),
  confidence: confidenceSchema,
  requiresReview: z.boolean(),
  sensitive: z.boolean(),
  reason: z.string().min(1).max(2000),
  warnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
});

export type FieldMatch = z.infer<typeof fieldMatchSchema>;

export const deterministicFillActionKindSchema = z.enum([
  'fill_text',
  'fill_generated_text',
  'select_option',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
  'skip',
  'manual_review',
  'unsupported',
]);

export type DeterministicFillActionKind = z.infer<typeof deterministicFillActionKindSchema>;

export const matchedOptionSchema = z.object({
  label: z.string().max(1000),
  value: z.string().max(1000),
});

export const deterministicFillActionSchema = z
  .object({
    id: idSchema,
    fieldId: idSchema,
    question: z.string().max(2000),
    fieldType: fieldTypeSchema,
    action: deterministicFillActionKindSchema,
    proposedValue: fieldValueSchema.optional(),
    matchedOption: matchedOptionSchema.optional(),
    source: deterministicAnswerSourceSchema,
    sourceReference: z.string().max(500).optional(),
    confidence: confidenceSchema,
    sensitive: z.boolean(),
    requiresReview: z.boolean(),
    approved: z.boolean(),
    reason: z.string().min(1).max(2000),
    warnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
    originalMatch: fieldMatchSchema.optional(),
    generationId: idSchema.optional(),
    evidenceIds: z.array(idSchema).max(30).optional(),
    wordCount: z.number().int().nonnegative().optional(),
    characterCount: z.number().int().nonnegative().optional(),
    answerValidationPassed: z.boolean().optional(),
  })
  .superRefine((action, ctx) => {
    const actionable: readonly DeterministicFillActionKind[] = [
      'fill_text',
      'fill_generated_text',
      'select_option',
      'choose_radio',
      'toggle_checkbox',
      'set_date',
    ];
    if (actionable.includes(action.action) && action.proposedValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: `action "${action.action}" requires a proposed value`,
      });
    }
    if (
      (action.action === 'select_option' || action.action === 'choose_radio') &&
      !action.matchedOption
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matchedOption'],
        message: `action "${action.action}" requires an exact matched option`,
      });
    }
    if (
      (action.action === 'select_option' || action.action === 'choose_radio') &&
      action.matchedOption &&
      action.proposedValue !== action.matchedOption.value
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: 'The proposed value must equal the exact matched option value',
      });
    }
    if (action.action === 'toggle_checkbox') {
      const valid =
        typeof action.proposedValue === 'boolean' || Array.isArray(action.proposedValue);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedValue'],
          message: 'toggle_checkbox requires a boolean or an array of exact option values',
        });
      }
    }
    if (!actionable.includes(action.action) && action.approved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approved'],
        message: `action "${action.action}" cannot be approved for execution`,
      });
    }
    if (action.action === 'fill_generated_text') {
      if (typeof action.proposedValue !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposedValue'],
          message: 'fill_generated_text requires a string proposed value',
        });
      }
      if (!action.requiresReview) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiresReview'],
          message: 'AI-generated text must always require review',
        });
      }
      if (action.approved && action.answerValidationPassed !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answerValidationPassed'],
          message: 'An AI-generated action cannot be approved before validation passes',
        });
      }
    }
  });

export type DeterministicFillAction = z.infer<typeof deterministicFillActionSchema>;

export const deterministicFillStatisticsSchema = z.object({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  sensitive: z.number().int().nonnegative(),
});

export const deterministicFillPlanSchema = z.object({
  id: idSchema,
  scanId: idSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  url: z.string().url(),
  domain: z.string().max(300),
  ats: z.enum(ATS_IDS),
  actions: z.array(deterministicFillActionSchema),
  warnings: z.array(z.string().min(1).max(2000)).default([]),
  statistics: deterministicFillStatisticsSchema,
});

export type DeterministicFillPlan = z.infer<typeof deterministicFillPlanSchema>;

export const fillVerificationResultSchema = z.object({
  fieldId: idSchema,
  verified: z.boolean(),
  expectedValue: fieldValueSchema.optional(),
  actualValue: fieldValueSchema.optional(),
  method: z.enum([
    'input_value',
    'selected_option',
    'checked_state',
    'validation_state',
    'not_verifiable',
  ]),
  message: z.string().max(2000).optional(),
});

export type FillVerificationResult = z.infer<typeof fillVerificationResultSchema>;

export const fillExecutionStatusSchema = z.enum([
  'verified',
  'filled_unverified',
  'skipped',
  'needs_review',
  'unsupported',
  'failed',
  'cancelled',
]);

export const fillExecutionResultSchema = z.object({
  actionId: idSchema,
  fieldId: idSchema,
  status: fillExecutionStatusSchema,
  expectedValue: fieldValueSchema.optional(),
  actualValue: fieldValueSchema.optional(),
  attempts: z.number().int().min(0).max(2),
  durationMs: z.number().nonnegative(),
  error: agentErrorSchema.optional(),
});

export type FillExecutionResult = z.infer<typeof fillExecutionResultSchema>;

export const fillRunStatusSchema = z.enum([
  'running',
  'completed',
  'completed_with_errors',
  'cancelled',
  'failed',
]);

export const fillRunReportSchema = z.object({
  id: idSchema,
  planId: idSchema,
  scanId: idSchema,
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  url: z.string().url(),
  ats: z.enum(ATS_IDS),
  totalActions: z.number().int().nonnegative(),
  approvedActions: z.number().int().nonnegative(),
  verifiedActions: z.number().int().nonnegative(),
  failedActions: z.number().int().nonnegative(),
  reviewActions: z.number().int().nonnegative(),
  skippedActions: z.number().int().nonnegative(),
  unsupportedActions: z.number().int().nonnegative(),
  status: fillRunStatusSchema,
  results: z.array(fillExecutionResultSchema),
  warnings: z.array(z.string().min(1).max(2000)).default([]),
  submitted: z.literal(false).default(false),
});

export type FillRunReport = z.infer<typeof fillRunReportSchema>;

export const fillProgressSchema = z.object({
  runId: idSchema,
  planId: idSchema,
  stage: z.enum(['preflight', 'filling', 'verifying', 'done']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  message: z.string().max(300),
});

export type FillProgress = z.infer<typeof fillProgressSchema>;

export const fillUiStateSchema = z.enum([
  'idle',
  'planning',
  'ready_for_review',
  'filling',
  'completed',
  'completed_with_errors',
  'cancelled',
  'failed',
]);

export type FillUiState = z.infer<typeof fillUiStateSchema>;
