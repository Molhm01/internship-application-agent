import { DEFAULT_SENSITIVE_POLICY, type SensitiveCategory } from '../constants/ats.js';
import type { CanonicalQuestion } from '../constants/questions.js';
import type { ApprovedAnswer } from '../schemas/answers.js';
import type { CompanyRelationship } from '../schemas/applicationBundle.js';
import type { EducationEntry, ExperienceEntry, Profile } from '../schemas/profile.js';
import type { IntendedAnswerSource } from '../schemas/dropdownRun.js';
import { aliasesFor } from './dropdownAliases.js';
import {
  isCompanyRelationshipQuestion,
  resolveCompanyQuestion,
  companyOverride,
} from './companyRelationship.js';
import { sensitiveCategoryForQuestion } from './questionModel.js';

/**
 * What a dropdown *should* say, decided before its list is ever opened.
 *
 * This is the half of the engine that can get somebody into trouble, so it is
 * the half with the fewest moving parts. It reads saved facts and restates them.
 * It has no default, no fallback value, and no rule that consults one field to
 * guess another's answer — the only derivations it performs are named, listed
 * below, and each is a restatement rather than an inference:
 *
 *   - a graduation question answered from a stored `status`
 *   - an education-place question answered from the applicant's own address,
 *     when the education record itself records no place
 *   - a degree-level question answered from the record's stored degree
 *
 * Everything else either finds a fact or asks. That asymmetry is deliberate:
 * a wrong answer on an application is worse in kind than an unanswered one, and
 * `USER_CONFIRMATION_REQUIRED` is a complete, honest outcome rather than a
 * failure to be avoided.
 *
 * ## What is never resolved here
 *
 * Protected characteristics, legal attestations, and anything about the
 * applicant's relationship with this specific employer. Those need a stored
 * policy or a stored employer fact, and absent one the answer is the applicant's
 * to give — `resolveCompanyQuestion` and `sensitivePolicies` are the only doors,
 * and neither has a fallback behind it.
 */

export interface IntendedAnswerInput {
  canonicalQuestion: CanonicalQuestion;
  /** The question as the page words it, for the confirmation prompt. */
  label: string;
  /** The heading the control sits under, for record disambiguation. */
  sectionContext: string;
  /** Which repeated block this control belongs to, when there are several. */
  recordIndex?: number | undefined;
  profile: Profile;
  approvedAnswers: readonly ApprovedAnswer[];
  /** The employer this application is for, for employer-specific facts. */
  companyName: string;
  companyRelationship?: CompanyRelationship | undefined;
}

export interface IntendedAnswer {
  /** The answer to reach. Empty exactly when confirmation is required. */
  intendedAnswer: string;
  source: IntendedAnswerSource;
  /** Other wordings of the same fact, most specific first. */
  alternativeValues: readonly string[];
  searchText?: string;
  requiresUserConfirmation: boolean;
  confirmationPrompt?: string;
  sensitive: boolean;
  allowOtherFallback: boolean;
}

function ask(reason: string, sensitive = false): IntendedAnswer {
  return {
    intendedAnswer: '',
    source: 'none',
    alternativeValues: [],
    requiresUserConfirmation: true,
    confirmationPrompt: reason,
    sensitive,
    allowOtherFallback: false,
  };
}

function answer(
  value: string,
  source: IntendedAnswerSource,
  extras: Partial<IntendedAnswer> = {},
): IntendedAnswer {
  const trimmed = value.trim();
  return {
    intendedAnswer: trimmed,
    source,
    // Widened through the alias table by default, so a saved "Freelance" can
    // still reach a list that only says "Self-Employed". Aliases are exact
    // restatements; nothing here reaches the scored semantic path.
    alternativeValues: aliasesFor(trimmed).slice(1),
    requiresUserConfirmation: false,
    sensitive: false,
    allowOtherFallback: false,
    ...extras,
  };
}

/**
 * The education record a control belongs to.
 *
 * A page with several education blocks says which one it is asking about by
 * position, and that answer is used verbatim. A page with a *single* block is
 * asking about the qualification the applicant is currently studying for — that
 * is what an internship application means by "Education" — and answering it from
 * whichever record happens to be stored first put a completed High School entry
 * into "Current Degree Program" over a Bachelor's still in progress.
 */
function educationRecord(input: IntendedAnswerInput): EducationEntry | undefined {
  const records = input.profile.education;
  if (records.length === 0) return undefined;
  if (input.recordIndex !== undefined) return records[input.recordIndex] ?? records[0];
  return records.find((entry) => entry.status === 'in_progress') ?? records[0];
}

function experienceRecord(input: IntendedAnswerInput): ExperienceEntry | undefined {
  const records = input.profile.experience;
  if (records.length === 0) return undefined;
  return records[input.recordIndex ?? 0] ?? records[0];
}

/**
 * The stored policy for a protected characteristic, or nothing.
 *
 * `review_required` is the default for a category with no stored policy, and it
 * is also what an unrecognised policy falls back to. There is no path through
 * this function that produces an answer the user did not explicitly record.
 */
function sensitiveAnswer(
  category: SensitiveCategory,
  input: IntendedAnswerInput,
): IntendedAnswer | undefined {
  const stored = input.profile.sensitivePolicies.find((entry) => entry.category === category);
  const policy = stored?.policy ?? DEFAULT_SENSITIVE_POLICY;
  if (policy === 'approved_auto_fill' && stored?.value?.trim()) {
    return answer(stored.value, 'saved_preference', { sensitive: true });
  }
  if (policy === 'decline_to_answer') {
    // The one semantic mapping permitted on a sensitive control: "Decline to
    // answer" is a *choice about disclosure*, not a claim about identity, so
    // reaching the form's own wording for it invents nothing. Matching it is
    // the alias table's job; deciding to is this line.
    return answer('Decline to answer', 'saved_preference', { sensitive: true });
  }
  return undefined;
}

/**
 * An answer the user approved for this wording previously.
 *
 * Both flags are required, not just `approved`: an answer the user vetted but
 * did not authorise for automatic filling is exactly the answer that must still
 * be shown to them, and reading only `approved` would fill it silently. A
 * `multi_select` is ignored here — a list of values is not one option, and
 * flattening it would put a comma-joined string into a single-choice control.
 */
function approved(input: IntendedAnswerInput): string | undefined {
  const wanted = normalizeWording(input.label);
  if (wanted.length === 0) return undefined;
  const hit = input.approvedAnswers.find((entry) => {
    if (!entry.approved || !entry.autoFillAllowed) return false;
    const wordings = [entry.canonicalQuestion, entry.normalizedQuestion ?? '', ...entry.aliases];
    return wordings.some((wording) => normalizeWording(wording) === wanted);
  });
  if (!hit) return undefined;
  if (typeof hit.answer === 'string') return hit.answer.trim() || undefined;
  if (typeof hit.answer === 'boolean') return hit.answer ? 'Yes' : 'No';
  if (typeof hit.answer === 'number') return String(hit.answer);
  return undefined;
}

function normalizeWording(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Resolves one dropdown's intended answer, or says who has to.
 *
 * Order is the priority in the specification: an explicit fact, then a saved
 * preference, then an employer-specific fact, then a named derivation, and
 * finally the applicant. Nothing consults the page's option list — this decides
 * what is *true*, and which of the offered choices expresses it is the matcher's
 * separate question.
 */
export function resolveIntendedAnswer(input: IntendedAnswerInput): IntendedAnswer {
  const { canonicalQuestion: question, profile } = input;

  // ---- The applicant's own, whatever the question is. -----------------------
  const saved = approved(input);
  if (saved) return answer(saved, 'approved_answer');

  // ---- Protected characteristics and legal attestations. --------------------
  //
  // Checked before anything that could answer them, so no ordinary rule can
  // reach a sensitive question by accident.
  const category = sensitiveCategoryForQuestion(question, input.label);
  if (category) {
    return (
      sensitiveAnswer(category, input) ??
      ask(
        `"${input.label}" asks about ${category.replace(/_/g, ' ')}. Only you can answer it — the agent will not choose for you.`,
        true,
      )
    );
  }

  // ---- Facts about this specific employer. ---------------------------------
  if (isCompanyRelationshipQuestion(question)) {
    const override = companyOverride(input.companyRelationship, input.label);
    if (override) return answer(override, 'employer_fact');
    const resolved = resolveCompanyQuestion(question, input.companyRelationship, input.companyName);
    if (resolved.status === 'answered') {
      return answer(
        typeof resolved.value === 'boolean' ? (resolved.value ? 'Yes' : 'No') : resolved.value,
        'employer_fact',
      );
    }
    // Deliberately not derivable from the résumé. A work history that does not
    // mention this employer is not evidence the applicant never worked here —
    // it is evidence about a document, and answering "No" from it is exactly
    // the kind of confident wrong answer this engine exists to refuse.
    return ask(resolved.question);
  }

  const address = profile.personal.address;
  const education = educationRecord(input);
  const experience = experienceRecord(input);

  switch (question) {
    // ---- Place ------------------------------------------------------------
    case 'country':
      return address.country ? answer(address.country, 'profile_fact') : ask(input.label);
    case 'state':
      return address.state ? answer(address.state, 'profile_fact') : ask(input.label);
    case 'city':
      return address.city ? answer(address.city, 'profile_fact') : ask(input.label);

    // ---- Education --------------------------------------------------------
    case 'school':
      return education?.institution
        ? answer(education.institution, 'profile_fact', {
            // A searchable school list filters on what is typed, and a typed
            // full institution name is what makes its entry render at all.
            searchText: education.institution,
          })
        : ask(input.label);
    case 'major':
      return education?.major ? answer(education.major, 'profile_fact') : ask(input.label);
    case 'minor':
      return education?.minor ? answer(education.minor, 'profile_fact') : ask(input.label);
    case 'degree':
    case 'degree_level':
      return education?.degreeLevel
        ? answer(education.degreeLevel, 'profile_fact')
        : education?.degree
          ? // Named derivation: a record's stored degree restated as its level.
            answer(education.degree, 'derived_from_profile')
          : profile.currentDegreeInProgress
            ? answer(profile.currentDegreeInProgress, 'profile_fact')
            : ask(input.label);
    case 'highest_degree_awarded':
      // The highest credential *awarded*, never the one in progress. Answering
      // this with a degree still being studied for overstates the applicant's
      // qualifications, which is a misrepresentation rather than a rounding.
      return profile.highestCompletedDegree
        ? answer(profile.highestCompletedDegree, 'profile_fact')
        : ask(input.label);
    case 'education_type':
      // One question, two taxonomies. A form listing institutions wants
      // "College/University"; a form listing programmes wants the degree. Both
      // are offered and the page's own list decides which it is asking for.
      if (!education) return ask(input.label);
      return education.degreeLevel || education.degree
        ? answer('College/University', 'derived_from_profile', {
            alternativeValues: [
              education.degreeLevel ?? education.degree ?? '',
              ...aliasesFor('College/University').slice(1),
              ...aliasesFor(education.degreeLevel ?? education.degree ?? '').slice(1),
            ].filter((value) => value.trim().length > 0),
          })
        : answer('College/University', 'derived_from_profile');
    case 'graduated':
      // Named derivation, and a strict one: only a record that positively
      // states its status may answer. An absent `status` means the applicant
      // has not said, which is not the same as "not graduated".
      if (education?.status === 'completed') return answer('Yes', 'derived_from_profile');
      if (education?.status === 'in_progress') return answer('No', 'derived_from_profile');
      return ask(input.label);
    case 'education_status':
    case 'enrolled_during_internship':
      // The opposite question to "Graduated?", from the same fact, and it must
      // stay the opposite: "Are you currently a university student?" answered
      // from a degree in progress is *Yes*, and folding the two together
      // answered it No over an applicant who is plainly enrolled.
      //
      // Both readings are offered because forms word this control both ways —
      // some list Yes/No and some list the status itself — and the page's own
      // options decide which it is asking for.
      if (education?.status === 'in_progress') {
        return answer('Yes', 'derived_from_profile', {
          alternativeValues: ['In Progress', 'Currently Enrolled', 'Enrolled', 'Attending'],
        });
      }
      if (education?.status === 'completed') {
        return answer('No', 'derived_from_profile', {
          alternativeValues: ['Completed', 'Graduated', 'Not Enrolled'],
        });
      }
      return ask(input.label);

    // ---- Experience -------------------------------------------------------
    case 'employment_type':
      return experience?.employmentType
        ? answer(experience.employmentType, 'profile_fact')
        : ask(input.label);
    case 'reason_for_leaving':
      // Never invented. A role with no recorded reason is a question for the
      // applicant, not an opportunity for a plausible sentence.
      return experience?.reasonForLeaving
        ? answer(experience.reasonForLeaving, 'profile_fact')
        : ask(input.label);
    case 'currently_employed':
      return experience
        ? answer(experience.current ? 'Yes' : 'No', 'profile_fact')
        : ask(input.label);

    // ---- Contact ----------------------------------------------------------
    case 'phone_type':
      return profile.personal.phoneType
        ? answer(titleCase(profile.personal.phoneType), 'profile_fact')
        : ask(input.label);
    case 'address_type':
      return address.type ? answer(titleCase(address.type), 'profile_fact') : ask(input.label);
    case 'phone_country_code': {
      // The saved code, and the number it came from as a second reading.
      //
      // A combined phone widget renders this from the number beside it — "US
      // +1", with no menu behind it — so the answer has to be recognisable in
      // whatever the control is already displaying, or the engine opens
      // something that does not open. The dialling code and the country name
      // are both offered because forms label this control both ways.
      const code = profile.personal.phoneCountryCode?.trim();
      if (!code) return ask(input.label);
      const digits = code.replace(/[^0-9]/g, '');
      return answer(code.startsWith('+') ? code : `+${digits}`, 'profile_fact', {
        alternativeValues: [digits, `+${digits}`, address.country ?? ''].filter(
          (value) => value.trim().length > 0,
        ),
      });
    }

    // ---- Eligibility ------------------------------------------------------
    case 'work_authorization':
      return profile.eligibility.workAuthorization
        ? answer(profile.eligibility.workAuthorization, 'profile_fact')
        : ask(input.label);
    case 'willing_to_relocate':
      return typeof profile.eligibility.willingToRelocate === 'boolean'
        ? answer(profile.eligibility.willingToRelocate ? 'Yes' : 'No', 'profile_fact')
        : ask(input.label);
    case 'drivers_license':
      return typeof profile.eligibility.hasDriversLicense === 'boolean'
        ? answer(profile.eligibility.hasDriversLicense ? 'Yes' : 'No', 'profile_fact')
        : ask(input.label);
    case 'minimum_age':
      return typeof profile.eligibility.meetsMinimumAge === 'boolean'
        ? answer(profile.eligibility.meetsMinimumAge ? 'Yes' : 'No', 'profile_fact')
        : ask(input.label);

    // ---- Preferences ------------------------------------------------------
    case 'how_did_you_hear':
    case 'referral_source':
    case 'job_board_source':
      return profile.preferences.discoverySource
        ? answer(profile.preferences.discoverySource, 'saved_preference', {
            // The one place "Other" is welcome: a source list is a closed set
            // of the employer's own channels, and an applicant who found the
            // role somewhere not on it did genuinely find it somewhere else.
            allowOtherFallback: true,
          })
        : ask(input.label);
    case 'remote_availability':
      return profile.preferences.remotePreference &&
        profile.preferences.remotePreference !== 'no_preference'
        ? answer(titleCase(profile.preferences.remotePreference), 'saved_preference')
        : ask(input.label);

    default:
      return ask(input.label);
  }
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
