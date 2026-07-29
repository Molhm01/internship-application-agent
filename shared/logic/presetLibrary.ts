import type { AutofillPolicy } from '../constants/intents.js';
import { SENSITIVE_CANONICAL_QUESTIONS, type CanonicalQuestion } from '../constants/questions.js';
import { applicationPresetSchema, type ApplicationPreset } from '../schemas/semanticOption.js';

/**
 * The recurring questions a preset library covers, and how each one is allowed
 * to be answered automatically.
 *
 * Every protected question defaults to declining. That is the one answer which
 * discloses nothing, and it is chosen because it is neutral — never because it
 * might improve an outcome. A user who wants to disclose a trait sets that
 * preset explicitly; nothing here does it for them.
 */

export interface PresetDefinition {
  canonicalQuestion: CanonicalQuestion;
  policy: AutofillPolicy;
  /** Set only for questions answered from a saved intent rather than a value. */
  intent?: ApplicationPreset['intent'];
  /** Alternative question wordings a form might use. */
  aliases?: readonly string[];
}

/** Questions answered directly from profile data, filled without confirmation. */
const EXACT_VALUE_QUESTIONS: readonly CanonicalQuestion[] = [
  'first_name',
  'middle_name',
  'last_name',
  'preferred_name',
  'email',
  'phone',
  'phone_country_code',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'country',
  'current_location',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'school',
  'degree',
  'degree_level',
  'major',
  'minor',
  'gpa',
  'graduation_date',
  'education_status',
];

/**
 * Questions whose wording varies enough that a saved answer has to be matched
 * semantically against the page's own options, but which disclose nothing
 * protected and so need no per-field confirmation.
 */
const SEMANTIC_QUESTIONS: readonly CanonicalQuestion[] = [
  'willing_to_relocate',
  'onsite_availability',
  'hybrid_availability',
  'remote_availability',
  'internship_availability',
  'earliest_start_date',
  'how_did_you_hear',
  'referral_source',
  'employee_referral',
  'recruiting_event',
  'job_board_source',
];

/**
 * Questions that carry legal weight. They may be pre-filled from an explicit
 * saved answer but never applied without the user looking at them, because a
 * wrong answer here is a false statement rather than an inconvenience.
 */
const REVIEW_BEFORE_FILL_QUESTIONS: readonly CanonicalQuestion[] = [
  'work_authorization',
  'sponsorship_required',
  'citizenship',
  'security_clearance',
  'criminal_history',
  'salary_expectation',
];

/** Questions no preset may ever answer automatically. */
const ALWAYS_MANUAL_QUESTIONS: readonly CanonicalQuestion[] = ['terms_attestation', 'signature'];

/** Protected questions, which default to declining. */
const PROTECTED_QUESTIONS: readonly CanonicalQuestion[] = [
  'gender',
  'transgender',
  'sexual_orientation',
  'race_ethnicity',
  'hispanic_latino',
  'veteran_status',
  'disability_status',
  'religion',
  'medical_information',
];

export const PRESET_DEFINITIONS: readonly PresetDefinition[] = [
  ...EXACT_VALUE_QUESTIONS.map((canonicalQuestion): PresetDefinition => ({
    canonicalQuestion,
    policy: 'auto_fill_exact',
  })),
  ...SEMANTIC_QUESTIONS.map((canonicalQuestion): PresetDefinition => ({
    canonicalQuestion,
    policy: 'auto_fill_semantic',
  })),
  ...REVIEW_BEFORE_FILL_QUESTIONS.map((canonicalQuestion): PresetDefinition => ({
    canonicalQuestion,
    policy: 'review_before_fill',
  })),
  ...ALWAYS_MANUAL_QUESTIONS.map((canonicalQuestion): PresetDefinition => ({
    canonicalQuestion,
    policy: 'always_manual',
  })),
  ...PROTECTED_QUESTIONS.map((canonicalQuestion): PresetDefinition => ({
    canonicalQuestion,
    policy: 'prefer_not_to_answer',
    intent: 'prefer_not_to_answer',
  })),
];

/** True when this question is protected and defaults to declining. */
export function isProtectedQuestion(canonicalQuestion: CanonicalQuestion): boolean {
  return PROTECTED_QUESTIONS.includes(canonicalQuestion);
}

/**
 * The preset library a new profile starts with.
 *
 * Value-bearing presets carry no value yet — they point at the profile field
 * that will answer them. A preset with neither a value nor an intent is not
 * created at all, because an empty preset would look configured while
 * answering nothing.
 */
export function defaultPresetLibrary(now: string): ApplicationPreset[] {
  return PRESET_DEFINITIONS.filter((definition) => definition.intent !== undefined).map(
    (definition) =>
      applicationPresetSchema.parse({
        id: `preset-${definition.canonicalQuestion}`,
        canonicalQuestion: definition.canonicalQuestion,
        intent: definition.intent,
        aliases: [...(definition.aliases ?? [])],
        sensitive: SENSITIVE_CANONICAL_QUESTIONS.includes(definition.canonicalQuestion),
        autofillPolicy: definition.policy,
        requiresReview: false,
        lastUpdatedAt: now,
      }),
  );
}

/** The policy a question uses when the user has configured nothing. */
export function defaultPolicyFor(canonicalQuestion: CanonicalQuestion): AutofillPolicy {
  const definition = PRESET_DEFINITIONS.find(
    (candidate) => candidate.canonicalQuestion === canonicalQuestion,
  );
  // An unlisted question has nothing configured behind it, so it is shown to
  // the user rather than filled silently — whether or not it is sensitive.
  return definition?.policy ?? 'review_before_fill';
}
