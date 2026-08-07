import { z } from 'zod';
import { ATS_IDS } from '../constants/ats.js';
import { agentErrorSchema } from './error.js';
import { confidenceSchema, idSchema, isoDateTimeSchema } from './common.js';
import { fieldTypeSchema, fieldValueSchema } from './fields.js';
import { dropdownTraceSchema } from './dropdownExecution.js';

export const deterministicAnswerSourceSchema = z.enum([
  'profile',
  'approved_answer',
  'document',
  'user_override',
  'ai_generated',
  /**
   * A value the model normalized into the page's own wording, grounded entirely
   * in saved data (e.g. profile "United States" → option "United States of
   * America"). Never applies to a sensitive question, and never pre-approved.
   */
  'ai_suggestion',
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
  /** A custom (non-`<select>`) combobox whose option list was read off the page. */
  'select_suggested_option',
  /**
   * An option-based control whose live choices were discovered and matched to
   * exactly one real option before the plan was built. Distinct from
   * `select_suggested_option`, where the list is unknown until fill time: here
   * the matched option is evidence, not a prediction.
   */
  'select_resolved_option',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
  'upload_file',
  'skip',
  'manual_review',
  /**
   * An executor exists, but no grounded value does. Distinct from `unsupported`,
   * which means the control itself cannot be driven — conflating the two hid
   * fields that only needed a saved value or a selected document.
   */
  'missing_information',
  'unsupported',
]);

export type DeterministicFillActionKind = z.infer<typeof deterministicFillActionKindSchema>;

export const matchedOptionSchema = z.object({
  label: z.string().max(1000),
  value: z.string().max(1000),
});

/**
 * Saved grounding the executor re-applies against the option list a custom
 * combobox reveals only once opened.
 *
 * It carries facts, never instructions: a place the profile states, or the
 * meaning a saved policy expressed. There is no field here able to express a
 * selector, a script, or an index, so nothing that reaches the executor through
 * this object can direct it at an arbitrary element.
 */
export const matchHintSchema = z.object({
  canonicalQuestion: z.string().max(60).optional(),
  /** A canonical intent such as `prefer_not_to_answer`. Never free text. */
  intent: z.string().max(60).optional(),
  location: z
    .object({
      city: z.string().max(200).optional(),
      state: z.string().max(200).optional(),
      country: z.string().max(200).optional(),
    })
    .optional(),
  /** Search text for an autocomplete, derived only from saved values. */
  searchText: z.string().max(300).optional(),
});

export type MatchHint = z.infer<typeof matchHintSchema>;

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
    /**
     * The saved facts an AI-proposed answer rests on.
     *
     * Carried through from the model's `sourceFactIds` so the approval policy
     * can tell a grounded answer from an invented one *at execution time*,
     * rather than trusting a confidence number the model chose for itself.
     * Empty on deterministic actions, which are grounded by construction.
     */
    sourceFactIds: z.array(z.string().min(1).max(200)).max(20).optional(),
    confidence: confidenceSchema,
    sensitive: z.boolean(),
    requiresReview: z.boolean(),
    approved: z.boolean(),
    reason: z.string().min(1).max(2000),
    warnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
    originalMatch: fieldMatchSchema.optional(),
    matchHint: matchHintSchema.optional(),
    generationId: idSchema.optional(),
    evidenceIds: z.array(idSchema).max(30).optional(),
    wordCount: z.number().int().nonnegative().optional(),
    characterCount: z.number().int().nonnegative().optional(),
    answerValidationPassed: z.boolean().optional(),
    documentId: idSchema.optional(),
    documentName: z.string().min(1).max(255).optional(),
  })
  .superRefine((action, ctx) => {
    const actionable: readonly DeterministicFillActionKind[] = [
      'fill_text',
      'fill_generated_text',
      'select_option',
      'select_suggested_option',
      'select_resolved_option',
      'choose_radio',
      'toggle_checkbox',
      'set_date',
      'upload_file',
    ];
    if (
      actionable.includes(action.action) &&
      action.action !== 'upload_file' &&
      action.proposedValue === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: `action "${action.action}" requires a proposed value`,
      });
    }
    if (action.action === 'upload_file' && (!action.documentId || !action.documentName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentId'],
        message: 'upload_file requires an approved document reference',
      });
    }
    if (
      (action.action === 'select_option' ||
        action.action === 'select_suggested_option' ||
        action.action === 'select_resolved_option' ||
        action.action === 'choose_radio') &&
      !action.matchedOption
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matchedOption'],
        message: `action "${action.action}" requires an exact matched option`,
      });
    }
    if (
      (action.action === 'select_option' ||
        action.action === 'select_suggested_option' ||
        action.action === 'select_resolved_option' ||
        action.action === 'choose_radio') &&
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
    // An AI suggestion is a proposal, never a decision: it must carry a matched
    // option, must never be sensitive, and can never arrive pre-approved.
    if (action.source === 'ai_suggestion') {
      if (action.sensitive) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source'],
          message: 'A sensitive field can never be answered by an AI suggestion',
        });
      }
      if (!action.requiresReview) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiresReview'],
          message: 'An AI suggestion must always require review',
        });
      }
    }
    if (action.action === 'select_suggested_option' && action.proposedValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: 'select_suggested_option requires a proposed value',
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

/**
 * Every action lands in exactly one of `ready`, `approved`, `review`,
 * `missingInformation`, `skipped`, and `unsupported`; `sensitive` is a
 * cross-cutting count. The buckets summing to `total` is asserted by a test, so
 * an action can no longer be counted as approved while showing no value.
 */
export const deterministicFillStatisticsSchema = z.object({
  total: z.number().int().nonnegative(),
  /** Has a valid proposed value, is executable, and needs no further approval. */
  ready: z.number().int().nonnegative(),
  /** Executable and explicitly approved by the user. */
  approved: z.number().int().nonnegative().default(0),
  /** A value exists but the user must approve it first. */
  review: z.number().int().nonnegative(),
  /** An executor exists, but nothing grounded it. */
  missingInformation: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative(),
  /** No executor exists for this control. */
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

/**
 * The outcome of trying to give an unresolved field a grounded value.
 *
 * `prohibited` is reserved for sensitive questions and legal attestations: it
 * records that the resolver was forbidden from proposing anything, which is a
 * different fact from having looked and found nothing (`missing_information`).
 */
export const unresolvedFieldResolutionSchema = z
  .object({
    fieldId: idSchema,
    status: z.enum([
      'resolved',
      'needs_review',
      'missing_information',
      'prohibited',
      'unsupported',
    ]),
    proposedValue: fieldValueSchema.optional(),
    matchedOption: matchedOptionSchema.optional(),
    source: z.enum(['profile', 'approved_answer', 'user_override', 'ai_suggestion', 'none']),
    sourceReference: z.string().max(500).optional(),
    confidence: z.enum(['high', 'medium', 'low']),
    requiresReview: z.boolean(),
    sensitive: z.boolean(),
    reason: z.string().min(1).max(2000),
    warnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
  })
  .superRefine((resolution, ctx) => {
    if (resolution.status === 'resolved' && resolution.proposedValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: 'A resolved field must carry a proposed value',
      });
    }
    if (resolution.sensitive && resolution.source === 'ai_suggestion') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'Sensitive fields are never resolved by AI suggestion',
      });
    }
    if (resolution.status === 'prohibited' && resolution.proposedValue !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposedValue'],
        message: 'A prohibited field must not carry a proposed value',
      });
    }
    if (resolution.source === 'ai_suggestion' && !resolution.requiresReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReview'],
        message: 'An AI suggestion always requires review',
      });
    }
  });

export type UnresolvedFieldResolution = z.infer<typeof unresolvedFieldResolutionSchema>;

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
    'uploaded_filename',
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
  uploadedFileName: z.string().min(1).max(255).optional(),
  attempts: z.number().int().min(0).max(2),
  durationMs: z.number().nonnegative(),
  error: agentErrorSchema.optional(),
  /**
   * How the dropdown engine got on, when this action drove one.
   *
   * Carried on the result rather than derived later because only the executor
   * knows what the control actually offered — by the time anything else looks,
   * the menu has closed. Values are stripped; see `dropdownTraceSchema`.
   */
  dropdown: dropdownTraceSchema.optional(),
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
