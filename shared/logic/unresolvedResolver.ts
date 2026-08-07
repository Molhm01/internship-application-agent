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
import { activeEducationEntry, currentEnrollment, degreeAnswersFor } from './degreeLevel.js';

/**
 * Questions the resolver may never propose a value for, whatever the model
 * concludes.
 *
 * This used to be the opposite list — an allow-list of nineteen questions, and
 * everything else was refused for want of an exact saved answer. That made the
 * agent useless on ordinary forms: a page could ask twenty-six perfectly
 * answerable questions and get twenty-six "no saved answer applies" cards,
 * because the *wording* had not been anticipated. Understanding a question is
 * what the model is for.
 *
 * Inverting it moves the judgement to where it belongs. Anything here is a fact
 * about the applicant's life or legal position that cannot be derived, only
 * known — inventing one is a misrepresentation with consequences, not a wrong
 * guess. Anything not here may be reasoned about, and still never fills without
 * the user's approval.
 */
export const AI_PROHIBITED_QUESTIONS: readonly CanonicalQuestion[] = [
  // Employment and education history: dates, employers, and credentials are
  // matters of record.
  'employer',
  'job_title',
  'employment_start_date',
  'employment_end_date',
  // How a role was classified and why it ended are matters of record too, and
  // the model has no honest way to reach either: an employer named "Freelance"
  // is not evidence about how the work was classified, and nothing at all
  // implies a reason for leaving. With no saved fact these are the applicant's
  // to answer, and the reason they are shown must say so rather than blaming a
  // page analysis that was never going to help.
  'employment_type',
  'reason_for_leaving',
  'employment_history',
  'years_of_experience',
  'school',
  'gpa',
  // `highest_degree_awarded` is deliberately *not* here. It is derivable from
  // the education the user already saved — an entry marked completed, or one
  // whose graduation date has passed — so refusing it told someone with a full
  // education section that their own highest qualification was "a fact only you
  // can confirm". What must never happen is *inventing* one, and
  // `degreeAnswersFor` cannot: with no evidence of completion it yields nothing.
  'graduation_date',
  'graduation_month',
  'graduation_year',
  'education_start_date',
  // The education credentials themselves. `school` and `gpa` were already here;
  // the degree being studied for, the level it sits at, and the subject are the
  // same kind of fact and were not — so a form asking "Current Degree Program"
  // on a profile the lookup had failed to read reached the model.
  'degree',
  'degree_level',
  'major',
  'minor',
  // The kind of institution, and whether the qualification was awarded. Both
  // read off the saved education record; neither is ever guessed at.
  'education_type',
  'graduated',
  // Enrolment now, and enrolment during a term the employer has not stated.
  'education_status',
  'enrolled_during_internship',
  // Availability. A model asked "When can you start?" answers with the date it
  // believes today to be, which is exactly how an internship availability date
  // became the current date on a live application.
  'earliest_start_date',
  'internship_availability',
  // Who vouches for the applicant, and how.
  'referral',
  'referral_name',
  'referral_email',
  'referral_relationship',
  'employee_referral',
  'family_member_employed',
  'previously_employed',
  'previously_applied',
  'previously_interviewed',
  // Legal position. Every one of these is governed by the sensitive-answer
  // policy as well; they are named here so the prohibition survives a
  // classification miss.
  'work_authorization',
  'sponsorship_required',
  'citizenship',
  'security_clearance',
  'criminal_history',
  'salary_expectation',
  'salary_minimum',
  // Protected characteristics.
  'gender',
  'transgender',
  'race_ethnicity',
  'hispanic_latino',
  'veteran_status',
  'disability_status',
  'sexual_orientation',
  'religion',
  'medical_information',
  // Consent is the applicant's to give.
  'terms_attestation',
  'signature',
  'marketing_text_consent',
];

/**
 * True when the resolver may reason about this question at all.
 *
 * An unrecognized question — `canonical` absent or `unknown` — is answerable:
 * that is precisely the case the model exists for, and refusing it was the rule
 * that produced a page of unanswered ordinary questions.
 */
export function mayReasonAbout(canonical: CanonicalQuestion | undefined): boolean {
  if (canonical === undefined) return true;
  return !AI_PROHIBITED_QUESTIONS.includes(canonical);
}

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
  const education = activeEducationEntry(profile);
  const educationIndex = education ? profile.education.indexOf(education) : -1;
  const educationRef = (key: string): string => `profile.education[${educationIndex}].${key}`;
  const degrees = degreeAnswersFor(profile);
  const enrollment = currentEnrollment(profile);
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
    school: { reference: educationRef('institution'), value: education?.institution },
    // The degree in progress, never whichever education row was entered first.
    // This entry read `education[0].degree` with no preference for the explicit
    // profile field at all, so the second tier could contradict the first and
    // answer "Current Degree Program" with a completed high-school diploma.
    degree: {
      reference: profile.currentDegreeInProgress
        ? 'profile.currentDegreeInProgress'
        : educationRef('degree'),
      value: degrees.currentDegreeInProgress,
    },
    degree_level: {
      reference: educationRef('degreeLevel'),
      value: education?.degreeLevel ?? degrees.currentDegreeInProgress,
    },
    major: { reference: educationRef('major'), value: education?.major },
    minor: { reference: educationRef('minor'), value: education?.minor },
    gpa: { reference: educationRef('gpa'), value: education?.gpa },
    education_status: {
      reference: enrollment?.reference ?? 'profile.education',
      value: enrollment?.enrolled,
    },
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
    // The credential actually awarded — never the one being studied for, which
    // is what `degree` above answers. Derived from the saved education when
    // Internship Pilot has not set the field explicitly, and absent when
    // nothing establishes it.
    highest_degree_awarded: {
      reference: 'profile.highestCompletedDegree',
      value: degreeAnswersFor(profile).highestCompletedDegree,
    },
  };

  const found = table[canonical];
  if (!found) return null;
  const raw = found.value;
  if (raw === undefined || raw === '') return null;
  return { reference: found.reference, value: String(raw) };
}

/**
 * The website question.
 *
 * The user's own choice wins. `preferredWebsiteField` exists precisely because
 * a fixed precedence picks the wrong link for people whose GitHub matters more
 * than their portfolio, and a form with one "Website" box gives them no way to
 * correct it afterwards.
 *
 * Only when they have not chosen does the documented fallback order apply:
 * personal website, then portfolio, then GitHub. No URL is ever invented — with
 * none of them saved, the field is left blank.
 */
export function resolveWebsiteValue(
  profile: Profile,
): { reference: string; value: string; label: string } | null {
  const personal = profile.personal;
  const candidates: ReadonlyArray<{
    key: 'website' | 'portfolio' | 'github' | 'linkedin';
    reference: string;
    label: string;
    value?: string;
  }> = [
    {
      key: 'website',
      reference: 'profile.personal.personalWebsite',
      label: 'personal website',
      value: personal.personalWebsite,
    },
    {
      key: 'portfolio',
      reference: 'profile.personal.portfolio',
      label: 'portfolio',
      value: personal.portfolio,
    },
    {
      key: 'github',
      reference: 'profile.personal.github',
      label: 'GitHub',
      value: personal.github,
    },
    {
      key: 'linkedin',
      reference: 'profile.personal.linkedin',
      label: 'LinkedIn',
      value: personal.linkedin,
    },
  ];

  const chosen = personal.preferredWebsiteField
    ? candidates.find(
        (candidate) => candidate.key === personal.preferredWebsiteField && candidate.value,
      )
    : undefined;
  // A chosen field that is empty falls through rather than blanking the answer:
  // the preference says which link they prefer, not that the others are wrong.
  const found =
    chosen ??
    candidates.slice(0, 3).find((candidate) => candidate.value && candidate.value.length > 0);
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
  // Reached only when every tier above found nothing, and refused only for the
  // facts nobody may invent. A question whose wording nothing anticipated is
  // reasoned about here rather than handed back as unanswerable. Never
  // auto-approved: the user still confirms it before it is written.
  // A date control is refused structurally, whatever the question turned out to
  // be called. The prohibition list above covers every date question this build
  // has a name for; this covers the ones it does not, and it is the reason a
  // wording nobody anticipated can no longer arrive on a form as today's date.
  if (aiSuggestion && (field.fieldType === 'date' || field.fieldType === 'month')) {
    return resolution({
      fieldId: field.id,
      status: 'missing_information',
      source: 'none',
      confidence: 'low',
      requiresReview: true,
      sensitive: false,
      reason: 'A date is a matter of record and is never suggested. Enter or confirm it yourself.',
      warnings: ['Dates are never generated, and never defaulted to today.'],
    });
  }
  if (aiSuggestion && mayReasonAbout(canonical)) {
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
