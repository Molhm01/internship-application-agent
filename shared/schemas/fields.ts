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

/**
 * The types that are answered by *choosing* from a list.
 *
 * These, and only these, may carry `options`, be matched against options, or be
 * driven by an option-selecting executor action.
 *
 * The negative case is the one that caused real damage. A text input whose
 * container happened to hold an element with "menu" in its class name was given
 * an option list by the scanner, which made the planner match "Molhm" against
 * page options and the executor report *"No option on the page matched Molhm"*
 * for a box you simply type your first name into. Anything not in this list is
 * text-like and is written with `SET_TEXT`.
 */
export const OPTION_FIELD_TYPES: readonly FieldType[] = [
  'select',
  'combobox',
  'radio',
  'checkbox',
  'multi_select',
];

/** True when this control is answered by choosing rather than by typing. */
export function isOptionFieldType(type: FieldType): boolean {
  return OPTION_FIELD_TYPES.includes(type);
}

/**
 * The types a value is *typed* into. A password is text-like in exactly this
 * sense — what makes it special is where the value comes from, not how it is
 * written — so it is here, and the vault remains its only source.
 */
export const TEXT_FIELD_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'url',
  'password',
  'contenteditable',
];

/** True when this control is answered by typing into it. */
export function isTextFieldType(type: FieldType): boolean {
  return TEXT_FIELD_TYPES.includes(type);
}

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
  /**
   * The frame this control actually lives in.
   *
   * An application is routinely not one document: iCIMS, Workday and
   * SmartRecruiters render the upload section, and sometimes the whole form, in
   * an iframe. A field discovered in a subframe and then executed against the
   * top frame silently does nothing, so frame identity travels with the field
   * from the moment it is found to the moment it is filled.
   *
   * Optional because the frame id is assigned by the background worker, which is
   * the only side that knows it — the page cannot learn its own frame id. A
   * field the worker has not stamped is treated as the main frame (0).
   */
  frameId: z.number().int().nonnegative().optional(),
  frameUrl: z.string().max(2048).optional(),
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
