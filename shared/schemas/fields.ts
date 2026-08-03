import { z } from 'zod';
import { confidenceSchema, idSchema } from './common.js';
import { CANONICAL_QUESTIONS, FIELD_SECTIONS } from '../constants/questions.js';

/**
 * THE canonical field-type list. Low-level DOM behavior; semantic meaning is
 * represented separately.
 *
 * This array is the single source of truth for every runtime boundary in the
 * system — the content script that emits a scan, the background worker that
 * validates it, the popup that renders it, the agent server that stores it, and
 * every test fixture. Nothing may re-declare these members.
 *
 * That rule exists because breaking it is invisible until it is expensive. When
 * `password` was added to the scanner, a boundary still holding the old list
 * rejected the whole scan with INVALID_SCAN_RESULT — the page was read
 * correctly and thrown away at a validation step nobody had noticed was a
 * second copy. `fieldTypeContract.test.ts` now fails the build if any boundary,
 * source or built bundle, disagrees with this array.
 *
 * To add a member: add it here, then run the typecheck. Exhaustive `Record<
 * FieldType, …>` maps (notably `CONTROL_TYPE_BY_FIELD_TYPE`) will fail to
 * compile until every consumer has been taught what the new member means, which
 * is the point — a silently-unhandled member is how a field gets skipped.
 */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'date',
  // A month/year control. Distinct from `date`: it has no day component, and
  // writing a full ISO date into one is rejected by the browser.
  'month',
  'url',
  // An account password. Scanned so login and registration pages are
  // understood; only ever filled from the encrypted credential vault, never
  // from a profile value and never from a model.
  'password',
  'select',
  'combobox',
  'radio',
  'checkbox',
  'multi_select',
  'file',
  'contenteditable',
  'unknown',
] as const;

export const fieldTypeSchema = z.enum(FIELD_TYPES);

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The types a value can be typed or chosen into.
 *
 * `file` is excluded because it is uploaded rather than filled, and `unknown`
 * because there is nothing to fill it with.
 */
export const FILLABLE_FIELD_TYPES: readonly FieldType[] = FIELD_TYPES.filter(
  (type): type is Exclude<FieldType, 'file' | 'unknown'> => type !== 'file' && type !== 'unknown',
);

export const semanticTypeSchema = z.enum([
  'first_name',
  'middle_name',
  'last_name',
  'preferred_name',
  'email',
  'phone',
  'address',
  'city',
  'state',
  'postal_code',
  'country',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'school',
  'degree',
  'major',
  'gpa',
  'graduation_date',
  'resume',
  'cover_letter',
  'work_authorization',
  'sponsorship',
  'demographic',
  'other',
]);

export type SemanticType = z.infer<typeof semanticTypeSchema>;

export const canonicalQuestionSchema = z.enum(CANONICAL_QUESTIONS);
export const fieldSectionSchema = z.enum(FIELD_SECTIONS);

export const fieldOptionSchema = z.object({
  label: z.string().max(1000),
  value: z.string().max(1000),
  selected: z.boolean().optional(),
  /**
   * A disabled option is not a choice — it is usually a placeholder such as
   * "Select…". The resolver excludes these so one can never be selected.
   */
  disabled: z.boolean().optional(),
});

export type FieldOption = z.infer<typeof fieldOptionSchema>;

export const fieldValueSchema = z.union([
  z.string().max(20_000),
  z.array(z.string().max(2000)),
  z.boolean(),
]);

/** A validated, read-only description of one logical application question. */
export const detectedFieldSchema = z.object({
  id: idSchema,
  pageId: idSchema,
  label: z.string().max(2000),
  normalizedLabel: z.string().max(2000),
  canonicalKey: canonicalQuestionSchema.optional(),
  question: z.string().max(2000),
  fieldType: fieldTypeSchema,
  semanticType: semanticTypeSchema.optional(),
  selector: z.string().max(2000),
  required: z.boolean(),
  visible: z.boolean(),
  disabled: z.boolean(),
  currentValue: fieldValueSchema.optional(),
  options: z.array(fieldOptionSchema).optional(),
  section: fieldSectionSchema.optional(),
  placeholder: z.string().max(1000).optional(),
  minLength: z.number().int().nonnegative().max(50_000).optional(),
  maxLength: z.number().int().positive().max(50_000).optional(),
  helpText: z.string().max(4000).optional(),
  validationText: z.string().max(2000).optional(),
  confidence: confidenceSchema,
  sourceSignals: z.array(z.string().min(1).max(120)).max(30),
  warnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type DetectedField = z.infer<typeof detectedFieldSchema>;

export const fieldStatusSchema = z.enum([
  'pending',
  'filled',
  'verified',
  'skipped',
  'needs_review',
  'unsupported',
  'failed',
]);

export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const validationIssueSchema = z.object({
  fieldId: idSchema.optional(),
  message: z.string().max(2000),
  severity: z.enum(['info', 'warning', 'error']),
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
