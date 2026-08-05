import {
  DEFAULT_SENSITIVE_POLICY,
  SENSITIVE_CANONICAL_QUESTIONS,
  degreeAnswersFor,
  fieldMatchSchema,
  formatValue,
  locationSearchText,
  normalizeLabel,
  resolveDialCode,
  resolveWebsiteValue,
  splitPhoneNumber,
  wholePhoneNumber,
  type ApprovedAnswer,
  type CanonicalQuestion,
  type DetectedField,
  type FieldMatch,
  type Profile,
  type SensitiveCategory,
} from '@internship-agent/shared';

/**
 * Facts about the form as a whole that change what a single field should hold.
 * A phone number is written differently when the page also has a country-code
 * control, and that is a property of the page, not of the field.
 */
export interface MatchContext {
  /** True when the same form has a separate phone country-code control. */
  hasPhoneCountryCodeField?: boolean;
}

export const MATCH_CONFIDENCE = {
  exact: 1,
  semantic: 0.9,
  synonym: 0.7,
  none: 0,
} as const;

const SEMANTIC_TO_CANONICAL: Readonly<Record<string, CanonicalQuestion>> = {
  first_name: 'first_name',
  middle_name: 'middle_name',
  last_name: 'last_name',
  preferred_name: 'preferred_name',
  email: 'email',
  phone: 'phone',
  address: 'address_line1',
  city: 'city',
  state: 'state',
  postal_code: 'postal_code',
  country: 'country',
  linkedin: 'linkedin',
  github: 'github',
  portfolio: 'portfolio',
  website: 'website',
  school: 'school',
  degree: 'degree',
  major: 'major',
  gpa: 'gpa',
  graduation_date: 'graduation_date',
  work_authorization: 'work_authorization',
  sponsorship: 'sponsorship_required',
  demographic: 'unknown',
  other: 'unknown',
};

const LABEL_SYNONYMS: Readonly<Record<string, CanonicalQuestion>> = {
  'given name': 'first_name',
  'legal given name': 'first_name',
  surname: 'last_name',
  'family name': 'last_name',
  'preferred first name': 'preferred_name',
  'email address': 'email',
  'telephone number': 'phone',
  'mobile number': 'phone',
  'linked in profile': 'linkedin',
  'github profile': 'github',
  'portfolio url': 'portfolio',
  university: 'school',
  institution: 'school',
  'field of study': 'major',
  'grade point average': 'gpa',
  'graduation month and year': 'graduation_date',
  'authorized to work': 'work_authorization',
  'require sponsorship': 'sponsorship_required',
};

const SENSITIVE_CATEGORY: Partial<Record<CanonicalQuestion, SensitiveCategory>> = {
  gender: 'gender',
  // Transgender status is a gender-identity question, so the gender disclosure
  // policy governs it. Without this mapping it had no category at all and fell
  // through to the default, ignoring an explicit saved decline.
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

function sensitiveCategoryFor(
  field: DetectedField,
  canonical: CanonicalQuestion | null,
): SensitiveCategory | undefined {
  const text = normalizeLabel(`${field.label} ${field.helpText ?? ''}`);
  if (canonical === 'race_ethnicity') return /\bethnic/.test(text) ? 'ethnicity' : 'race';
  if (canonical && SENSITIVE_CATEGORY[canonical]) return SENSITIVE_CATEGORY[canonical];
  const rules: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
    ['sexual_orientation', /\bsexual orientation\b/],
    // Before the gender rule: "Do you identify as transgender?" is governed by
    // the gender disclosure policy, and never by a gender answer.
    ['gender', /\btransgender\b/],
    ['veteran_status', /\b(veteran|military status)\b/],
    ['security_clearance', /\bsecurity clearance\b/],
    ['criminal_history', /\b(criminal|felony|conviction|convicted)\b/],
    ['salary_expectation', /\b(salary|compensation|desired pay|pay expectation)\b/],
    ['medical', /\b(medical|health condition|health information)\b/],
    ['disability', /\bdisabilit/],
    ['religion', /\b(religion|religious affiliation|faith)\b/],
    ['sponsorship', /\b(sponsor|sponsorship|visa support)\b/],
    ['citizenship', /\b(citizen|citizenship|nationality)\b/],
    ['ethnicity', /\bethnic/],
    // Hispanic/Latino is asked as its own question and names neither term.
    ['ethnicity', /\b(hispanic|latin[aox])\b/],
    ['race', /\brace\b/],
    ['gender', /\b(gender|sex)\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0];
}

const LEGAL_ATTESTATION =
  /\b(certify|attest|acknowledge|consent|agree|terms|conditions|accurate|truthful|electronic signature)\b/i;

function resolvedCanonical(field: DetectedField): {
  canonical: CanonicalQuestion | null;
  confidence: number;
  reason: string;
} {
  if (field.canonicalKey) {
    return {
      canonical: field.canonicalKey,
      confidence: MATCH_CONFIDENCE.exact,
      reason: `Exact canonical key "${field.canonicalKey}".`,
    };
  }
  if (field.semanticType) {
    const canonical = SEMANTIC_TO_CANONICAL[field.semanticType];
    if (canonical && canonical !== 'unknown') {
      return {
        canonical,
        confidence: MATCH_CONFIDENCE.semantic,
        reason: `Exact semantic type "${field.semanticType}".`,
      };
    }
  }
  const synonym =
    LABEL_SYNONYMS[field.normalizedLabel] ?? LABEL_SYNONYMS[normalizeLabel(field.label)];
  return synonym
    ? {
        canonical: synonym,
        confidence: MATCH_CONFIDENCE.synonym,
        reason: `Deterministic label synonym mapped to "${synonym}".`,
      }
    : {
        canonical: null,
        confidence: MATCH_CONFIDENCE.none,
        reason: 'No deterministic field rule matched.',
      };
}

function profileValue(
  profile: Profile,
  canonical: CanonicalQuestion,
  context: MatchContext = {},
): { reference: string; value: string | boolean | number } | null {
  const personal = profile.personal;
  const education = profile.education[0];
  const experience = profile.experience[0];
  // The applicant's stored code first, the residence country only as a
  // fallback. Deriving it from the country meant a profile with a phone and no
  // address had nothing to put in a country-code control — and the phone number
  // then went in whole, duplicating the prefix the control was already showing.
  const dialCode = resolveDialCode(personal);
  const direct: Partial<
    Record<CanonicalQuestion, { reference: string; value: string | boolean | number | undefined }>
  > = {
    first_name: { reference: 'profile.personal.legalFirstName', value: personal.legalFirstName },
    middle_name: { reference: 'profile.personal.legalMiddleName', value: personal.legalMiddleName },
    last_name: { reference: 'profile.personal.legalLastName', value: personal.legalLastName },
    preferred_name: { reference: 'profile.personal.preferredName', value: personal.preferredName },
    email: { reference: 'profile.personal.email', value: personal.email },
    // With a separate country-code control on the page, the dialling code goes
    // there and must not be repeated here. Without one, the whole saved number
    // is used unchanged. The stored profile value is never rewritten either way.
    phone: {
      reference: 'profile.personal.phone',
      value: personal.phone
        ? context.hasPhoneCountryCodeField
          ? splitPhoneNumber(personal.phone, dialCode).localNumber
          : wholePhoneNumber(personal.phone)
        : undefined,
    },
    // The stored code, or the one the stated country implies. Never read off
    // the digits of the number: a number beginning "1" is not evidence of a
    // country, and guessing one here would put a wrong code on the application.
    phone_country_code: {
      reference: personal.phoneCountryCode
        ? 'profile.personal.phoneCountryCode'
        : 'profile.personal.address.country',
      value: dialCode ?? undefined,
    },
    // Which kind of phone and address a repeating contact block is recording.
    // Both are stored answers; neither is inferred from the other fields, so a
    // form asking "Phone type" on a profile that never said gets no answer.
    phone_type: { reference: 'profile.personal.phoneType', value: personal.phoneType },
    address_type: { reference: 'profile.personal.address.type', value: personal.address.type },
    // A combined location control wants the whole place, assembled only from
    // values the profile already holds.
    current_location: {
      reference: 'profile.personal.address',
      value:
        locationSearchText({
          city: personal.address.city,
          state: personal.address.state,
        }) || undefined,
    },
    address_line1: { reference: 'profile.personal.address.line1', value: personal.address.line1 },
    address_line2: { reference: 'profile.personal.address.line2', value: personal.address.line2 },
    city: { reference: 'profile.personal.address.city', value: personal.address.city },
    state: { reference: 'profile.personal.address.state', value: personal.address.state },
    postal_code: {
      reference: 'profile.personal.address.postalCode',
      value: personal.address.postalCode,
    },
    country: { reference: 'profile.personal.address.country', value: personal.address.country },
    linkedin: { reference: 'profile.personal.linkedin', value: personal.linkedin },
    github: { reference: 'profile.personal.github', value: personal.github },
    portfolio: { reference: 'profile.personal.portfolio', value: personal.portfolio },
    // Website falls back through the saved links in a fixed order rather than
    // being left blank when only a portfolio or GitHub exists. No URL is invented.
    website: (() => {
      const site = resolveWebsiteValue(profile);
      return site
        ? { reference: site.reference, value: site.value }
        : { reference: 'profile.personal.personalWebsite', value: undefined };
    })(),
    // ---- Experience -----------------------------------------------------
    //
    // Absent entirely until now, which is the bulk of the "extremely low
    // coverage" report: on a page with a work-history section, every one of
    // these fell through to "no saved value" while the profile held all of
    // them. The most recent role is used, because that is the one an
    // application's first experience block asks about.
    employer: { reference: 'profile.experience[0].employer', value: experience?.employer },
    job_title: { reference: 'profile.experience[0].title', value: experience?.title },
    // The job's location, never the applicant's address.
    experience_location: {
      reference: 'profile.experience[0].location',
      value: experience?.location,
    },
    employment_start_date: {
      reference: 'profile.experience[0].startDate',
      value: experience?.startDate,
    },
    employment_end_date: {
      reference: 'profile.experience[0].endDate',
      // A current role has no end date, and inventing one would misstate the
      // applicant's history.
      value: experience?.current ? undefined : experience?.endDate,
    },
    currently_employed: {
      reference: 'profile.experience[0].current',
      value: experience?.current,
    },
    responsibilities: {
      reference: 'profile.experience[0].responsibilities',
      value: experience?.responsibilities.length
        ? experience.responsibilities.join('\n')
        : undefined,
    },
    // `account_username` is deliberately absent. It is classified so the page
    // can be recognized as a login or a registration, but it is filled by the
    // account executor alongside the password — never by the ordinary plan.
    // Routing it through here would type an identifier into every *sign-in*
    // form the agent lands on, which is the one page it must leave alone.
    school: {
      reference: 'profile.education[0].institution',
      value: education?.institution,
    },
    // The degree being studied for. "Highest level of education" is the other
    // question and reads `highest_degree_awarded` above.
    degree: {
      reference: profile.currentDegreeInProgress
        ? 'profile.currentDegreeInProgress'
        : 'profile.education[0].degree',
      value: profile.currentDegreeInProgress ?? education?.degree,
    },
    major: { reference: 'profile.education[0].major', value: education?.major },
    minor: { reference: 'profile.education[0].minor', value: education?.minor },
    // The level, which is a different answer from the degree's full name. A
    // form offering "Bachelor's / Master's / Doctorate" wants this one.
    degree_level: {
      reference: 'profile.education[0].degreeLevel',
      value: education?.degreeLevel,
    },
    gpa: { reference: 'profile.education[0].gpa', value: education?.gpa },
    graduation_date: {
      reference: 'profile.education[0].graduationDate',
      value: education?.graduationDate,
    },
    // Forms that split graduation into two controls. Both read the one saved
    // date rather than asking the user to store it twice; a date with no month
    // yields no month, rather than a guessed one.
    graduation_month: {
      reference: 'profile.education[0].graduationDate',
      value: education?.graduationDate?.split('-')[1],
    },
    graduation_year: {
      reference: 'profile.education[0].graduationDate',
      value: education?.graduationDate?.split('-')[0],
    },
    // Explicitly saved on the profile. This is not a guess — it is the answer
    // the user wrote down — but it is still never *inferred* from anything
    // else, and a profile that does not state it leaves the field blank.
    work_authorization: {
      reference: 'profile.eligibility.workAuthorization',
      value: profile.eligibility.workAuthorization,
    },
    willing_to_relocate: {
      reference: 'profile.eligibility.willingToRelocate',
      value: profile.eligibility.willingToRelocate,
    },
    willing_to_travel: {
      reference: 'profile.eligibility.willingToTravelPercent',
      value: profile.eligibility.willingToTravelPercent,
    },
    drivers_license: {
      reference: 'profile.eligibility.hasDriversLicense',
      value: profile.eligibility.hasDriversLicense,
    },
    minimum_age: {
      reference: 'profile.eligibility.meetsMinimumAge',
      value: profile.eligibility.meetsMinimumAge,
    },
    earliest_start_date: {
      reference: 'profile.eligibility.earliestStartDate',
      value: profile.eligibility.earliestStartDate,
    },
    internship_availability: {
      reference: 'profile.eligibility.internshipAvailability',
      value: profile.eligibility.internshipAvailability,
    },
    how_did_you_hear: {
      reference: 'profile.preferences.discoverySource',
      value: profile.preferences.discoverySource,
    },
    // Present only when the user said they have no middle name. A blank middle
    // name is silence, not an answer, and cannot tick this box.
    no_middle_name: {
      reference: 'profile.personal.noMiddleName',
      value: personal.noMiddleName === true ? true : undefined,
    },
    name_suffix: { reference: 'profile.personal.suffix', value: personal.suffix },
    // Its own field, so a form asking for a metro area no longer gets the city
    // and no longer picks an unrelated location from a list.
    metro_region: {
      reference: 'profile.personal.address.metroRegion',
      value: personal.address.metroRegion,
    },
    // Deliberately not `education?.degree`: the degree being pursued is a
    // different answer, and substituting it would overstate the applicant's
    // qualifications. `degreeAnswersFor` reads the credential actually awarded,
    // and yields nothing when the profile establishes none.
    highest_degree_awarded: {
      reference: 'profile.highestCompletedDegree',
      value: degreeAnswersFor(profile).highestCompletedDegree,
    },
    salary_minimum: {
      reference: 'profile.preferences.salaryMinimum',
      value: profile.preferences.salaryMinimum,
    },
    salary_expectation: {
      reference: 'profile.preferences.salaryPreference',
      value: profile.preferences.salaryPreference,
    },
    // Opt-in only. `undefined` when absent, so the box stays unticked, and the
    // schema has no way to say "the user refused" because unticked covers both.
    marketing_text_consent: {
      reference: 'profile.preferences.marketingTextConsent',
      value: profile.preferences.marketingTextConsent === true ? true : undefined,
    },
    preferred_locations: {
      reference: 'profile.preferences.preferredLocations',
      value: profile.preferences.preferredLocations.length
        ? profile.preferences.preferredLocations.join(', ')
        : undefined,
    },
    security_clearance: {
      reference: 'profile.eligibility.securityClearanceStatus',
      value: profile.eligibility.securityClearanceStatus,
    },
  };
  const found = direct[canonical];
  return found?.value !== undefined && found.value !== ''
    ? { reference: found.reference, value: found.value }
    : null;
}

function answerMatch(
  field: DetectedField,
  canonical: CanonicalQuestion | null,
  answers: readonly ApprovedAnswer[],
): { answer: ApprovedAnswer; confidence: number; reason: string } | null {
  const targets = new Set(
    [
      field.normalizedLabel,
      normalizeLabel(field.label),
      canonical ? normalizeLabel(canonical) : '',
    ].filter(Boolean),
  );
  const matches = answers.flatMap((answer) => {
    const canonicalAnswer = normalizeLabel(answer.canonicalQuestion);
    if (targets.has(canonicalAnswer)) {
      return [
        {
          answer,
          confidence: MATCH_CONFIDENCE.exact,
          reason: 'Exact approved-answer question match.',
        },
      ];
    }
    if (answer.aliases.some((alias) => targets.has(normalizeLabel(alias)))) {
      return [
        {
          answer,
          confidence: MATCH_CONFIDENCE.exact,
          reason: 'Exact approved-answer alias match.',
        },
      ];
    }
    return [];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function unmatched(
  field: DetectedField,
  reason: string,
  options: Partial<FieldMatch> = {},
): FieldMatch {
  return fieldMatchSchema.parse({
    fieldId: field.id,
    matched: false,
    source: 'none',
    confidence: MATCH_CONFIDENCE.none,
    requiresReview: false,
    sensitive: false,
    reason,
    warnings: [],
    ...options,
  });
}

export function isLegalAttestation(field: DetectedField): boolean {
  return (
    field.fieldType === 'checkbox' &&
    LEGAL_ATTESTATION.test(`${field.label} ${field.helpText ?? ''}`)
  );
}

export function matchField(
  field: DetectedField,
  profile: Profile,
  answers: readonly ApprovedAnswer[],
  override?: string | string[] | boolean,
  context: MatchContext = {},
): FieldMatch {
  const resolved = resolvedCanonical(field);
  const approved = answerMatch(field, resolved.canonical, answers);
  const category = sensitiveCategoryFor(field, resolved.canonical);
  const sensitive = Boolean(
    category ||
    (resolved.canonical && SENSITIVE_CANONICAL_QUESTIONS.includes(resolved.canonical)) ||
    approved?.answer.sensitive,
  );
  const legal = isLegalAttestation(field);

  if (override !== undefined) {
    return fieldMatchSchema.parse({
      fieldId: field.id,
      matched: true,
      source: 'user_override',
      sourceReference: `fillPlan.actions.${field.id}.override`,
      rawValue: override,
      formattedValue: formatValue(field, override),
      confidence: MATCH_CONFIDENCE.exact,
      requiresReview: true,
      sensitive,
      reason: 'Explicit user override.',
      warnings: [
        'Edited values require explicit approval.',
        ...(sensitive ? ['This remains a sensitive field after editing.'] : []),
      ],
    });
  }

  if (sensitive) {
    const policyEntry = category
      ? profile.sensitivePolicies.find((entry) => entry.category === category)
      : undefined;
    const policy = policyEntry?.policy ?? DEFAULT_SENSITIVE_POLICY;
    if (policy === 'leave_blank') {
      return unmatched(field, 'Sensitive policy is leave_blank.', {
        sensitive: true,
        warnings: ['Sensitive value will be left blank by policy.'],
      });
    }
    if (policy === 'decline_to_answer' && policyEntry) {
      return fieldMatchSchema.parse({
        fieldId: field.id,
        matched: true,
        source: 'approved_answer',
        sourceReference: `profile.sensitivePolicies.${category}`,
        rawValue: 'Decline to answer',
        formattedValue: 'Decline to answer',
        confidence: MATCH_CONFIDENCE.exact,
        requiresReview: false,
        sensitive: true,
        reason: 'Explicit sensitive policy is decline_to_answer.',
        warnings: [],
      });
    }
    const policyValue =
      policy === 'approved_auto_fill' && policyEntry?.value
        ? {
            value: policyEntry.value,
            reference: `profile.sensitivePolicies.${category}`,
            reason: 'Explicit sensitive approved_auto_fill policy.',
          }
        : null;
    const candidate = policyValue
      ? policyValue
      : approved?.answer.approved && approved.answer.autoFillAllowed
        ? {
            value: approved.answer.answer,
            reference: `approvedAnswers.${approved.answer.id}`,
            reason: approved.reason,
          }
        : null;
    if (!candidate) {
      return unmatched(field, 'Sensitive question has no explicit approved value.', {
        sensitive: true,
        requiresReview: true,
        warnings: ['Sensitive answers are never inferred.'],
      });
    }
    return fieldMatchSchema.parse({
      fieldId: field.id,
      matched: true,
      source: 'approved_answer',
      sourceReference: candidate.reference,
      rawValue: candidate.value,
      formattedValue: formatValue(field, candidate.value),
      confidence: approved?.confidence ?? MATCH_CONFIDENCE.exact,
      requiresReview:
        policy !== 'approved_auto_fill' ||
        Boolean(approved?.answer.requiresReview) ||
        Boolean(approved?.answer.sensitive),
      sensitive: true,
      reason: candidate.reason,
      warnings: policy === 'review_required' ? ['Sensitive policy requires review.'] : [],
    });
  }

  const approvedOnly =
    // Work authorization is answered only from something the user explicitly
    // wrote: an approved answer, or the profile's own eligibility field. With
    // neither, it stays unanswered — it is never derived from citizenship,
    // location, school, or anything else that merely correlates with it.
    (resolved.canonical === 'work_authorization' && !profile.eligibility.workAuthorization) ||
    resolved.canonical === 'why_this_company' ||
    resolved.canonical === 'why_this_role' ||
    resolved.canonical === 'additional_information' ||
    legal;
  if (approved && approved.answer.approved && approved.answer.autoFillAllowed) {
    return fieldMatchSchema.parse({
      fieldId: field.id,
      matched: true,
      source: 'approved_answer',
      sourceReference: `approvedAnswers.${approved.answer.id}`,
      rawValue: approved.answer.answer,
      formattedValue: formatValue(field, approved.answer.answer),
      confidence: approved.confidence,
      requiresReview: approved.answer.requiresReview || legal,
      sensitive: approved.answer.sensitive,
      reason: approved.reason,
      warnings: legal ? ['Legal attestations always require explicit review.'] : [],
    });
  }
  if (approvedOnly) {
    return unmatched(
      field,
      legal
        ? 'Legal attestation has no explicit approved answer.'
        : 'This question requires an explicitly approved saved answer.',
      {
        requiresReview: true,
        warnings: legal
          ? ['Terms, consent, and attestations are never accepted automatically.']
          : ['No approved answer is eligible for autofill.'],
      },
    );
  }
  if (!resolved.canonical) return unmatched(field, resolved.reason);
  const value = profileValue(profile, resolved.canonical, context);
  if (!value) return unmatched(field, `No saved profile value exists for "${resolved.canonical}".`);
  return fieldMatchSchema.parse({
    fieldId: field.id,
    matched: true,
    source: 'profile',
    sourceReference: value.reference,
    rawValue: value.value,
    formattedValue: formatValue(field, value.value),
    confidence: resolved.confidence,
    requiresReview: resolved.confidence < 0.8,
    sensitive: false,
    reason: resolved.reason,
    warnings: [],
  });
}
