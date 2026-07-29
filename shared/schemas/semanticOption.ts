import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { canonicalQuestionSchema } from './fields.js';
import { AUTOFILL_POLICIES, CANONICAL_INTENTS } from '../constants/intents.js';

export const canonicalIntentSchema = z.enum(CANONICAL_INTENTS);
export const autofillPolicySchema = z.enum(AUTOFILL_POLICIES);

export const availableOptionSchema = z.object({
  label: z.string().max(1000),
  value: z.string().max(1000),
  disabled: z.boolean().default(false),
});

/**
 * The record of choosing one option from the choices a page actually offered.
 *
 * `availableOptions` is stored alongside the decision on purpose: it is the
 * evidence that the selection came from the page rather than from the model's
 * imagination, and it lets the review screen show exactly what was on offer.
 */
export const semanticOptionDecisionSchema = z
  .object({
    fieldId: idSchema,
    question: z.string().max(2000),
    canonicalQuestion: canonicalQuestionSchema,
    availableOptions: z.array(availableOptionSchema).max(2000),
    /** The answer the user's data supports, before any page-specific wording. */
    intendedAnswer: z.string().max(2000),
    canonicalIntent: canonicalIntentSchema.optional(),
    selectedOption: z
      .object({ label: z.string().max(1000), value: z.string().max(1000) })
      .optional(),
    source: z.enum([
      'profile',
      'approved_answer',
      'sensitive_policy',
      'user_override',
      'ai_semantic_match',
      'none',
    ]),
    sourceReference: z.string().max(500).optional(),
    confidence: z.enum(['high', 'medium', 'low']),
    requiresReview: z.boolean(),
    sensitive: z.boolean(),
    /** A short, user-facing explanation. Never model reasoning. */
    reason: z.string().min(1).max(500),
    warnings: z.array(z.string().min(1).max(500)).max(20).default([]),
    status: z.enum(['matched', 'ambiguous', 'missing_information', 'prohibited', 'unsupported']),
  })
  .superRefine((decision, ctx) => {
    if (decision.status === 'matched' && !decision.selectedOption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedOption'],
        message: 'A matched decision must name the option it selected',
      });
    }
    if (decision.status !== 'matched' && decision.selectedOption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedOption'],
        message: 'Only a matched decision may carry a selected option',
      });
    }
    // The central guarantee: a selection must exist among the page's own
    // options. A model that returns anything else is rejected here, before the
    // value can reach the DOM.
    if (
      decision.selectedOption &&
      !decision.availableOptions.some(
        (option) =>
          option.value === decision.selectedOption?.value &&
          option.label === decision.selectedOption.label,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedOption'],
        message: 'The selected option is not one of the options detected on the page',
      });
    }
    if (decision.selectedOption) {
      const chosen = decision.availableOptions.find(
        (option) => option.value === decision.selectedOption?.value,
      );
      if (chosen?.disabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedOption'],
          message: 'A disabled option cannot be selected',
        });
      }
    }
    if (decision.sensitive && decision.source === 'ai_semantic_match' && !decision.requiresReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReview'],
        message: 'A sensitive field matched by AI always requires review',
      });
    }
    if (decision.status === 'prohibited' && decision.selectedOption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'A prohibited field must not select anything',
      });
    }
  });

export type SemanticOptionDecision = z.infer<typeof semanticOptionDecisionSchema>;
export type AvailableOption = z.infer<typeof availableOptionSchema>;

/**
 * A reusable answer to a question that recurs across applications, stored by
 * intent rather than by one employer's wording.
 */
export const applicationPresetSchema = z
  .object({
    id: idSchema,
    canonicalQuestion: canonicalQuestionSchema,
    /** A literal value, when the user configured a specific answer. */
    value: z.string().max(2000).optional(),
    /** The meaning to convey, when no single literal wording applies. */
    intent: canonicalIntentSchema.optional(),
    aliases: z.array(z.string().min(1).max(500)).max(50).default([]),
    sensitive: z.boolean(),
    autofillPolicy: autofillPolicySchema,
    requiresReview: z.boolean(),
    lastUpdatedAt: isoDateTimeSchema,
  })
  .superRefine((preset, ctx) => {
    if (preset.value === undefined && preset.intent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'A preset needs either a configured value or an intent',
      });
    }
    // A sensitive preset that fills automatically is only ever allowed to
    // decline; anything else must be reviewed, so no protected trait is
    // disclosed by a background process.
    if (
      preset.sensitive &&
      preset.autofillPolicy === 'auto_fill_semantic' &&
      preset.intent !== 'prefer_not_to_answer' &&
      preset.intent !== 'decline_to_self_identify'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autofillPolicy'],
        message:
          'A sensitive preset may only auto-fill semantically when its intent is to decline; otherwise it must be reviewed',
      });
    }
  });

export type ApplicationPreset = z.infer<typeof applicationPresetSchema>;

export const applicationPresetListSchema = z.object({
  presets: z.array(applicationPresetSchema).max(200),
});
