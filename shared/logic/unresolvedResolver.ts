import { DEFAULT_SENSITIVE_POLICY } from '../constants/ats.js';
import { SENSITIVE_CANONICAL_QUESTIONS, type CanonicalQuestion } from '../constants/questions.js';
import type { ApprovedAnswer } from '../schemas/answers.js';
import type { DetectedField } from '../schemas/fields.js';
import type { Profile } from '../schemas/profile.js';
import {
  unresolvedFieldResolutionSchema,
  type UnresolvedFieldResolution,
} from '../schemas/fill.js';
import { allowsRegionSuffix, matchOption } from './optionMatcher.js';

/**
 * Questions the resolver may propose a value for from saved data alone. Anything
 * absent from this list is left to the deterministic matcher or to the user —
 * the resolver widens coverage deliberately, one question at a time, rather than
 * by inferring whatever looks plausible.
 */
export const AI_SUGGESTIBLE_QUESTIONS: readonly CanonicalQuestion[] = [
  'country',
  'city',
  'state',
  'postal_code',
  'address_line1',
  'school',
  'degree',
  'major',
  'minor',
  'willing_to_relocate',
  'willing_to_travel',
  'earliest_start_date',
  'internship_availability',
  'how_did_you_hear',
  'referral',
  'website',
  'portfolio',
  'linkedin',
  'github',
];

/**
 * Legal attestations are never accepted automatically, regardless of source.
 * Ticking a box that says "I certify the above is accurate" is the applicant's
 * statement to make, not the agent's.
 */
const LEGAL_ATTESTATION =
  /\b(certify|attest|acknowledge|consent|agree|terms|conditions|accurate|truthful|electronic signature)\b/i;

export function isLegalAttestationField(field: DetectedField): boolean {
  return (
    field.fieldType === 'checkbox' &&
    LEGAL_ATTESTATION.test(`${field.label} ${field.helpText ?? ''}`)
  );
}

/**
 * Wordings that identify a sensitive question even when the canonical mapping
 * missed it. "Are you Hispanic/Latino?" names neither "race" nor "ethnicity",
 * and a question that slips past classification would otherwise be treated as
 * ordinary and answerable.
 */
const SENSITIVE_LABEL = new RegExp(
  [
    'hispanic',
    'latin[aox]',
    '\\brace\\b',
    'ethnic',
    '\\bgender\\b',
    'sexual orientation',
    'veteran',
    'disabilit',
    'religio',
    'citizen',
    'sponsor',
    'criminal|felony|convict',
    'security clearance',
    'salary|compensation expectation|desired pay',
  ].join('|'),
  'i',
);

export function isSensitiveQuestion(
  canonical: CanonicalQuestion | undefined,
  label?: string,
): boolean {
  if (canonical !== undefined && SENSITIVE_CANONICAL_QUESTIONS.includes(canonical)) return true;
  return label !== undefined && SENSITIVE_LABEL.test(label);
}

export interface ResolverInput {
  field: DetectedField;
  profile: Profile;
  answers: readonly ApprovedAnswer[];
  /** A value the user typed or picked for this field. Outranks everything but nothing overrides it. */
  override?: string | string[] | boolean;
  /** Grounded candidate produced upstream from saved data only. */
  aiSuggestion?: { value: string; reference: string } | undefined;
}

function resolution(
  input: Partial<UnresolvedFieldResolution> & { fieldId: string },
): UnresolvedFieldResolution {
  return unresolvedFieldResolutionSchema.parse({
    status: 'missing_information',
    source: 'none',
    confidence: 'low',
    requiresReview: true,
    sensitive: false,
    reason: 'No grounded value was available.',
    warnings: [],
    ...input,
  });
}

/**
 * Reads the one profile value that answers a question. Returns null when the
 * user has not saved it — a missing value is unanswerable, never substituted.
 */
export function structuredProfileValue(
  profile: Profile,
  canonical: CanonicalQuestion,
): { reference: string; value: string } | null {
  const personal = profile.personal;
  const address = personal.address;
  const education = profile.education[0];
  const eligibility = profile.eligibility;

  const table: Partial<
    Record<CanonicalQuestion, { reference: string; value: string | number | boolean | undefined }>
  > = {
    country: { reference: 'profile.personal.address.country', value: address.country },
    city: { reference: 'profile.personal.address.city', value: address.city },
    state: { reference: 'profile.personal.address.state', value: address.state },
    postal_code: { reference: 'profile.personal.address.postalCode', value: address.postalCode },
    address_line1: { reference: 'profile.personal.address.line1', value: address.line1 },
    linkedin: { reference: 'profile.personal.linkedin', value: personal.linkedin },
    github: { reference: 'profile.personal.github', value: personal.github },
    portfolio: { reference: 'profile.personal.portfolio', value: personal.portfolio },
    school: { reference: 'profile.education[0].institution', value: education?.institution },
    degree: { reference: 'profile.education[0].degree', value: education?.degree },
    major: { reference: 'profile.education[0].major', value: education?.major },
    minor: { reference: 'profile.education[0].minor', value: education?.minor },
    willing_to_relocate: {
      reference: 'profile.eligibility.willingToRelocate',
      value: eligibility.willingToRelocate,
    },
    willing_to_travel: {
      reference: 'profile.eligibility.willingToTravelPercent',
      value: eligibility.willingToTravelPercent,
    },
    earliest_start_date: {
      reference: 'profile.eligibility.earliestStartDate',
      value: eligibility.earliestStartDate,
    },
    internship_availability: {
      reference: 'profile.eligibility.internshipAvailability',
      value: eligibility.internshipAvailability,
    },
    how_did_you_hear: {
      reference: 'profile.preferences.discoverySource',
      value: profile.preferences.discoverySource,
    },
  };

  const found = table[canonical];
  if (!found) return null;
  const raw = found.value;
  if (raw === undefined || raw === '') return null;
  return { reference: found.reference, value: String(raw) };
}

/**
 * The website question, resolved in the documented order: personal website,
 * then portfolio, then GitHub. No URL is ever invented — when the user has saved
 * none of the three, the field is left blank.
 */
export function resolveWebsiteValue(
  profile: Profile,
): { reference: string; value: string; label: string } | null {
  const personal = profile.personal;
  const candidates: ReadonlyArray<{ reference: string; label: string; value?: string }> = [
    {
      reference: 'profile.personal.personalWebsite',
      label: 'personal website',
      value: personal.personalWebsite,
    },
    { reference: 'profile.personal.portfolio', label: 'portfolio', value: personal.portfolio },
    { reference: 'profile.personal.github', label: 'GitHub', value: personal.github },
  ];
  const found = candidates.find((candidate) => candidate.value && candidate.value.length > 0);
  return found?.value
    ? { reference: found.reference, value: found.value, label: found.label }
    : null;
}

function explicitApprovedAnswer(
  field: DetectedField,
  canonical: CanonicalQuestion | undefined,
  answers: readonly ApprovedAnswer[],
): ApprovedAnswer | null {
  const targets = new Set(
    [field.normalizedLabel, field.label.toLowerCase().trim(), canonical ?? ''].filter(Boolean),
  );
  const hits = answers.filter(
    (answer) =>
      targets.has(answer.canonicalQuestion.toLowerCase().trim()) ||
      answer.aliases.some((alias) => targets.has(alias.toLowerCase().trim())),
  );
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Resolves a field that the deterministic pass could not fill.
 *
 * Priority is strict and never reordered: an exact structured profile value
 * beats an approved answer, which beats a user override, which beats an AI
 * suggestion. A lower tier is consulted only when every higher tier produced
 * nothing, so a suggestion can never displace a value the user actually saved.
 */
export function resolveUnresolvedField(input: ResolverInput): UnresolvedFieldResolution {
  const { field, profile, answers, override, aiSuggestion } = input;
  const canonical = field.canonicalKey;
  const sensitive =
    isSensitiveQuestion(canonical, `${field.label} ${field.helpText ?? ''}`) ||
    isLegalAttestationField(field);
  const options = field.options ?? [];
  const hasOptions = options.length > 0;

  const matchAgainstOptions = (
    value: string,
  ): { value: string; label: string } | { failure: UnresolvedFieldResolution } | null => {
    if (!hasOptions) return null;
    const result = matchOption(value, options, {
      allowRegionSuffix: allowsRegionSuffix(canonical),
    });
    if (result.matched && result.option) {
      return { value: result.option.value, label: result.option.label };
    }
    return {
      failure: resolution({
        fieldId: field.id,
        status: 'needs_review',
        source: 'none',
        confidence: 'low',
        requiresReview: true,
        sensitive,
        reason: result.reason,
        warnings: result.ambiguous
          ? ['Several options matched equally; choose one manually.']
          : ['Pick the correct option manually.'],
      }),
    };
  };

  // ---- Sensitive questions and legal attestations -------------------------
  // Handled before every other tier so no later branch can reach them.
  if (sensitive) {
    if (isLegalAttestationField(field)) {
      return resolution({
        fieldId: field.id,
        status: 'prohibited',
        source: 'none',
        confidence: 'low',
        requiresReview: true,
        sensitive: true,
        reason: 'Legal attestations are never accepted automatically.',
        warnings: ['Read and tick this yourself if you agree.'],
      });
    }

    if (override !== undefined) {
      return resolution({
        fieldId: field.id,
        status: 'needs_review',
        proposedValue: override,
        source: 'user_override',
        sourceReference: `fillPlan.${field.id}.override`,
        confidence: 'high',
        requiresReview: true,
        sensitive: true,
        reason: 'Explicit user override for a sensitive question.',
        warnings: ['Sensitive answers always require your approval.'],
      });
    }

    const answer = explicitApprovedAnswer(field, canonical, answers);
    if (answer && answer.approved) {
      const raw =
        typeof answer.answer === 'boolean' ? (answer.answer ? 'Yes' : 'No') : String(answer.answer);
      const matched = matchAgainstOptions(raw);
      if (matched && 'failure' in matched) return matched.failure;

      // A sensitive answer may be filled without a second confirmation only when
      // the user marked it auto-fillable and it needs no review.
      const canAutoFill = answer.autoFillAllowed && !answer.requiresReview;
      return resolution({
        fieldId: field.id,
        status: canAutoFill ? 'resolved' : 'needs_review',
        proposedValue: matched ? matched.value : raw,
        ...(matched ? { matchedOption: { label: matched.label, value: matched.value } } : {}),
        source: 'approved_answer',
        sourceReference: `approvedAnswers.${answer.id}`,
        confidence: 'high',
        requiresReview: !canAutoFill,
        sensitive: true,
        reason: 'Explicit approved answer for a sensitive question.',
        warnings: [],
      });
    }

    return resolution({
      fieldId: field.id,
      status: 'missing_information',
      source: 'none',
      confidence: 'low',
      requiresReview: true,
      sensitive: true,
      reason: 'No explicit saved answer exists for this sensitive question.',
      warnings: [
        'Sensitive answers are never inferred from your name, location, school, or employment.',
        `Add an explicit answer in settings; the stored policy defaults to "${DEFAULT_SENSITIVE_POLICY}".`,
      ],
    });
  }

  // ---- Tier 1: exact structured profile value ----------------------------
  const website = canonical === 'website' ? resolveWebsiteValue(profile) : null;
  const websiteLabel = website?.label;
  const profileValue: { reference: string; value: string } | null =
    canonical === 'website'
      ? website
        ? { reference: website.reference, value: website.value }
        : null
      : canonical
        ? structuredProfileValue(profile, canonical)
        : null;

  if (profileValue) {
    const matched = matchAgainstOptions(profileValue.value);
    if (matched && 'failure' in matched) return matched.failure;
    const viaAlias = matched && matched.label.toLowerCase() !== profileValue.value.toLowerCase();
    return resolution({
      fieldId: field.id,
      status: 'resolved',
      proposedValue: matched ? matched.value : profileValue.value,
      ...(matched ? { matchedOption: { label: matched.label, value: matched.value } } : {}),
      source: 'profile',
      sourceReference: profileValue.reference,
      confidence: viaAlias ? 'medium' : 'high',
      // A profile-exact value on an unambiguous option needs no extra approval.
      requiresReview: false,
      sensitive: false,
      reason: websiteLabel
        ? `Saved ${websiteLabel} from your profile.`
        : `Saved value from ${profileValue.reference}.`,
      warnings: viaAlias && matched ? [`Matched the page option "${matched.label}".`] : [],
    });
  }

  // ---- Tier 2: explicit approved answer ----------------------------------
  const answer = explicitApprovedAnswer(field, canonical, answers);
  if (answer && answer.approved) {
    const raw =
      typeof answer.answer === 'boolean' ? (answer.answer ? 'Yes' : 'No') : String(answer.answer);
    const matched = matchAgainstOptions(raw);
    if (matched && 'failure' in matched) return matched.failure;
    return resolution({
      fieldId: field.id,
      status: answer.autoFillAllowed && !answer.requiresReview ? 'resolved' : 'needs_review',
      proposedValue: matched ? matched.value : raw,
      ...(matched ? { matchedOption: { label: matched.label, value: matched.value } } : {}),
      source: 'approved_answer',
      sourceReference: `approvedAnswers.${answer.id}`,
      confidence: 'high',
      requiresReview: !answer.autoFillAllowed || answer.requiresReview,
      sensitive: false,
      reason: 'Matched a saved approved answer.',
      warnings: [],
    });
  }

  // ---- Tier 3: explicit user override ------------------------------------
  if (override !== undefined) {
    const raw = typeof override === 'boolean' ? (override ? 'Yes' : 'No') : String(override);
    const matched = Array.isArray(override) ? null : matchAgainstOptions(raw);
    if (matched && 'failure' in matched) return matched.failure;
    return resolution({
      fieldId: field.id,
      status: 'needs_review',
      proposedValue: matched ? matched.value : override,
      ...(matched ? { matchedOption: { label: matched.label, value: matched.value } } : {}),
      source: 'user_override',
      sourceReference: `fillPlan.${field.id}.override`,
      confidence: 'high',
      requiresReview: true,
      sensitive: false,
      reason: 'Explicit user override.',
      warnings: ['Edited values require your approval before filling.'],
    });
  }

  // ---- Tier 4: grounded AI suggestion ------------------------------------
  // Reached only when every tier above found nothing, and only for questions on
  // the allow-list. Never auto-approved.
  if (aiSuggestion && canonical && AI_SUGGESTIBLE_QUESTIONS.includes(canonical)) {
    const matched = matchAgainstOptions(aiSuggestion.value);
    if (matched && 'failure' in matched) return matched.failure;
    return resolution({
      fieldId: field.id,
      status: 'needs_review',
      proposedValue: matched ? matched.value : aiSuggestion.value,
      ...(matched ? { matchedOption: { label: matched.label, value: matched.value } } : {}),
      source: 'ai_suggestion',
      sourceReference: aiSuggestion.reference,
      confidence: 'medium',
      requiresReview: true,
      sensitive: false,
      reason: 'Suggested from your saved data; approve it before it is used.',
      warnings: ['AI suggestions are never filled without your approval.'],
    });
  }

  // ---- Tier 5: manual review ---------------------------------------------
  return resolution({
    fieldId: field.id,
    status: 'missing_information',
    source: 'none',
    confidence: 'low',
    requiresReview: true,
    sensitive: false,
    reason: canonical
      ? `No saved value exists for "${canonical}".`
      : 'This question did not match any saved profile field or approved answer.',
    warnings: hasOptions ? ['Choose one of the detected options manually.'] : [],
  });
}
