import { SENSITIVE_CATEGORIES, type SensitiveCategory } from '../constants/ats.js';
import { SENSITIVE_CANONICAL_QUESTIONS, type CanonicalQuestion } from '../constants/questions.js';
import type { DetectedField, FieldType } from '../schemas/fields.js';
import {
  normalizedQuestionSchema,
  type NormalizedQuestion,
  type QuestionControlType,
} from '../schemas/formAnalysis.js';
import { matchCanonicalQuestion, normalizeLabel } from './normalizeQuestion.js';

/**
 * Converts scanned controls into the normalized question model.
 *
 * A question is a thing a person is being asked, not an element. The scanner
 * already collapses a radio group and a combobox-plus-popover into one
 * `DetectedField`, so this is mostly a projection — but it is the projection
 * that decides what the model is shown, so it lives on its own and is tested on
 * its own.
 */

const CONTROL_TYPE_BY_FIELD_TYPE: Record<FieldType, QuestionControlType> = {
  text: 'text',
  textarea: 'long_text',
  email: 'email',
  tel: 'phone',
  number: 'number',
  password: 'password',
  date: 'date',
  url: 'url',
  select: 'select',
  combobox: 'combobox',
  radio: 'radio_group',
  checkbox: 'checkbox',
  multi_select: 'checkbox_group',
  file: 'file_upload',
  contenteditable: 'rich_text',
  unknown: 'unknown',
};

/**
 * Wordings that identify a sensitive question even when canonical mapping
 * missed it. Ordered: the first hit wins, and the narrower rules come first so
 * "Do you identify as transgender?" is governed by the gender policy rather
 * than falling into a generic bucket.
 */
const SENSITIVE_LABEL_RULES: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
  ['sexual_orientation', /\bsexual orientation\b/],
  ['gender', /\btransgender\b/],
  ['veteran_status', /\b(veteran|military (service|status))\b/],
  ['security_clearance', /\b(security )?clearance\b/],
  ['criminal_history', /\b(criminal|felony|conviction|convicted)\b/],
  ['salary_expectation', /\b(salary|compensation|desired pay|pay expectation)\b/],
  ['medical', /\b(medical|health condition|health information)\b/],
  ['disability', /\bdisabilit/],
  ['religion', /\b(religion|religious affiliation|faith)\b/],
  ['sponsorship', /\b(sponsor|sponsorship|visa support)\b/],
  ['citizenship', /\b(citizen|citizenship|nationality)\b/],
  ['ethnicity', /\b(ethnic|hispanic|latin[aox])\b/],
  ['race', /\brace\b/],
  ['gender', /\b(gender|\bsex\b)\b/],
];

/** Canonical questions whose sensitive category is fixed, not text-derived. */
const CATEGORY_BY_CANONICAL: Partial<Record<CanonicalQuestion, SensitiveCategory>> = {
  gender: 'gender',
  transgender: 'gender',
  hispanic_latino: 'ethnicity',
  religion: 'religion',
  medical_information: 'medical',
  veteran_status: 'veteran_status',
  disability_status: 'disability',
  sexual_orientation: 'sexual_orientation',
  citizenship: 'citizenship',
  sponsorship_required: 'sponsorship',
  criminal_history: 'criminal_history',
  security_clearance: 'security_clearance',
  salary_expectation: 'salary_expectation',
};

/**
 * The sensitive category a question falls into, or undefined when it is an
 * ordinary question. A category means "never answer this without an explicit
 * saved preference", so over-reporting is safe and under-reporting is not.
 */
export function sensitiveCategoryForQuestion(
  canonical: CanonicalQuestion | undefined,
  text: string,
): SensitiveCategory | undefined {
  const normalized = normalizeLabel(text);
  if (canonical === 'race_ethnicity') return /\bethnic/.test(normalized) ? 'ethnicity' : 'race';
  if (canonical && CATEGORY_BY_CANONICAL[canonical]) return CATEGORY_BY_CANONICAL[canonical];
  if (canonical && SENSITIVE_CANONICAL_QUESTIONS.includes(canonical)) {
    const named = SENSITIVE_CATEGORIES.find((category) => category === canonical);
    if (named) return named;
  }
  return SENSITIVE_LABEL_RULES.find(([, pattern]) => pattern.test(normalized))?.[0];
}

/** A stable id for a question, derived from what the question *is*. */
export function questionIdFor(field: DetectedField): string {
  let hash = 2166136261;
  const seed = `${field.pageId}|${field.selector}|${field.normalizedLabel}|${field.fieldType}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `question-${(hash >>> 0).toString(36)}`;
}

/** Everything around the control that helps read what it is asking. */
function contextualTextFor(field: DetectedField): string {
  const parts = [
    field.helpText,
    field.validationText,
    field.placeholder && field.placeholder !== field.label ? field.placeholder : undefined,
    typeof field.metadata.nearbyText === 'string' ? field.metadata.nearbyText : undefined,
    typeof field.metadata.sectionHeading === 'string' ? field.metadata.sectionHeading : undefined,
    typeof field.metadata.uploadInstructions === 'string'
      ? field.metadata.uploadInstructions
      : undefined,
    typeof field.metadata.autocomplete === 'string'
      ? `autocomplete=${field.metadata.autocomplete}`
      : undefined,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return [...new Set(parts)].join(' — ').slice(0, 4000);
}

export function toNormalizedQuestion(field: DetectedField): NormalizedQuestion {
  const contextualText = contextualTextFor(field);
  const canonical =
    field.canonicalKey ?? matchCanonicalQuestion(`${field.label} ${contextualText}`).question;
  const sensitiveCategory = sensitiveCategoryForQuestion(
    canonical === 'unknown' ? undefined : canonical,
    `${field.label} ${contextualText}`,
  );

  return normalizedQuestionSchema.parse({
    questionId: questionIdFor(field),
    fieldIds: [field.id],
    questionText: field.label || field.question,
    contextualText,
    ...(field.section ? { section: field.section } : {}),
    controlType: CONTROL_TYPE_BY_FIELD_TYPE[field.fieldType],
    required: field.required,
    ...(field.currentValue !== undefined ? { currentValue: field.currentValue } : {}),
    ...(field.options?.length ? { options: field.options } : {}),
    ...(field.validationText ? { validation: field.validationText } : {}),
    ...(sensitiveCategory ? { sensitiveCategory } : {}),
    likelyIntent: canonical,
  });
}

/**
 * Builds the question list for a page. Fields the scanner marked invisible or
 * disabled are excluded: they are not questions being asked right now, and
 * proposing answers for them would inflate every count in the report.
 */
export function buildNormalizedQuestions(fields: readonly DetectedField[]): NormalizedQuestion[] {
  const questions = new Map<string, NormalizedQuestion>();
  for (const field of fields) {
    if (!field.visible || field.disabled) continue;
    const question = toNormalizedQuestion(field);
    const existing = questions.get(question.questionId);
    if (existing) {
      // Two controls that reduced to the same question are the same question
      // asked through two elements; both field ids are recorded so the executor
      // can act on whichever one is live.
      questions.set(question.questionId, {
        ...existing,
        fieldIds: [...new Set([...existing.fieldIds, ...question.fieldIds])],
      });
      continue;
    }
    questions.set(question.questionId, question);
  }
  return [...questions.values()];
}
