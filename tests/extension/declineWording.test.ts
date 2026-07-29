import { describe, expect, it } from 'vitest';
import {
  CANONICAL_QUESTIONS,
  CANONICAL_QUESTION_SECTIONS,
  SENSITIVE_CANONICAL_QUESTIONS,
  canonicalQuestionFor,
  defaultPolicyFor,
  defaultPresetLibrary,
  intentForBooleanAnswer,
  isDeclinePhrasing,
  isProtectedQuestion,
  isSelfDescribePhrasing,
  matchOption,
  matchCanonicalQuestion,
  readBooleanAnswer,
  resolveSemanticOption,
  type CanonicalQuestion,
  type FieldOption,
} from '@internship-agent/shared';

const option = (label: string): FieldOption => ({ label, value: label });
const options = (...labels: string[]): FieldOption[] => labels.map(option);

/** The gender control exactly as the real application renders it. */
const GENDER_OPTIONS = options(
  'Man',
  'Non-binary',
  'Woman',
  'I prefer to self-describe',
  "I don't wish to answer",
);

/** The sexual-orientation control exactly as the real application renders it. */
const ORIENTATION_OPTIONS = options(
  'Asexual',
  'Bisexual and/or pansexual',
  'Gay',
  'Heterosexual',
  'Lesbian',
  'Queer',
  'I prefer to self-describe',
  "I don't wish to answer",
);

function declineOn(
  canonicalQuestion: CanonicalQuestion,
  available: readonly FieldOption[],
): ReturnType<typeof resolveSemanticOption> {
  return resolveSemanticOption({
    fieldId: 'field-1',
    question: 'Voluntary self-identification',
    canonicalQuestion,
    options: available,
    canonicalIntent: 'prefer_not_to_answer',
    source: 'sensitive_policy',
    sourceReference: 'presets.decline',
  });
}

describe('decline maps onto the real screenshot wording', () => {
  it('selects "I don\'t wish to answer" for gender', () => {
    const result = declineOn('gender', GENDER_OPTIONS);
    expect(result.status).toBe('matched');
    expect(result.selectedOption?.label).toBe("I don't wish to answer");
  });

  it('selects "I don\'t wish to answer" for sexual orientation', () => {
    const result = declineOn('sexual_orientation', ORIENTATION_OPTIONS);
    expect(result.status).toBe('matched');
    expect(result.selectedOption?.label).toBe("I don't wish to answer");
  });

  it('never selects an option that discloses a protected trait', () => {
    for (const available of [GENDER_OPTIONS, ORIENTATION_OPTIONS]) {
      const chosen = declineOn('gender', available).selectedOption?.label;
      expect([
        'Man',
        'Woman',
        'Non-binary',
        'Gay',
        'Lesbian',
        'Queer',
        'Heterosexual',
      ]).not.toContain(chosen);
    }
  });

  it('never chooses "I prefer to self-describe", which answers nothing', () => {
    for (const available of [GENDER_OPTIONS, ORIENTATION_OPTIONS]) {
      expect(declineOn('gender', available).selectedOption?.label).not.toBe(
        'I prefer to self-describe',
      );
    }
    expect(isSelfDescribePhrasing('I prefer to self-describe')).toBe(true);
    expect(isDeclinePhrasing('I prefer to self-describe')).toBe(false);
  });

  /** Every wording the brief and the fixtures use. */
  const WORDINGS = [
    "I don't wish to answer",
    'I do not wish to answer',
    'I do not wish to self-identify',
    "I don't wish to self-identify",
    'Prefer not to answer',
    'Decline to self-identify',
    'Choose not to disclose',
    'I prefer not to disclose',
    'Decline to answer',
    'I prefer not to answer',
    'Prefer not to say',
    'I do not want to answer',
    'Opt out of answering',
    'Not specified',
  ];

  it.each(WORDINGS)('recognizes "%s" as declining', (wording) => {
    expect(isDeclinePhrasing(wording)).toBe(true);
  });

  it.each(WORDINGS)('maps a saved decline onto a form worded "%s"', (wording) => {
    const available = options('Yes', 'No', wording);
    const result = declineOn('veteran_status', available);
    expect(result.status).toBe('matched');
    expect(result.selectedOption?.label).toBe(wording);
  });

  it('matches a decline through the plain option matcher too', () => {
    const result = matchOption('Decline to answer', GENDER_OPTIONS);
    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe("I don't wish to answer");
  });

  it('leaves the field unresolved when the form offers no way to decline', () => {
    const result = declineOn('gender', options('Man', 'Woman', 'Non-binary'));
    expect(result.status).toBe('missing_information');
    expect(result.selectedOption).toBeUndefined();
    expect(result.reason).toContain('no way to decline');
  });

  it('reports ambiguity rather than picking between two decline options', () => {
    const result = declineOn(
      'disability_status',
      options('Yes', 'No', 'Prefer not to answer', 'Decline to self-identify'),
    );
    expect(result.status).toBe('ambiguous');
    expect(result.selectedOption).toBeUndefined();
  });
});

describe('question-aware yes and no', () => {
  it('reads a bare Yes as the meaning the question asks about', () => {
    expect(intentForBooleanAnswer('work_authorization', true)).toBe('authorized');
    expect(intentForBooleanAnswer('work_authorization', false)).toBe('not_authorized');
    // The same "Yes" means the opposite kind of thing here.
    expect(intentForBooleanAnswer('sponsorship_required', true)).toBe('sponsorship_required');
    expect(intentForBooleanAnswer('sponsorship_required', false)).toBe('sponsorship_not_required');
    expect(intentForBooleanAnswer('willing_to_relocate', true)).toBe('willing_to_relocate');
    // A question with no special meaning keeps the plain intent.
    expect(intentForBooleanAnswer('minimum_age', true)).toBe('affirmative');
  });

  it('matches a saved Yes to the sentence this form uses', () => {
    const result = resolveSemanticOption({
      fieldId: 'field-auth',
      question: 'Are you legally authorized to work in the United States?',
      canonicalQuestion: 'work_authorization',
      options: options('I am legally authorized to work', 'I am not authorized to work'),
      intendedAnswer: 'Yes',
      source: 'approved_answer',
    });
    expect(result.status).toBe('matched');
    expect(result.selectedOption?.label).toBe('I am legally authorized to work');
  });

  it('does not carry a Yes from one question onto another', () => {
    const result = resolveSemanticOption({
      fieldId: 'field-sponsor',
      question: 'Will you now or in the future require sponsorship?',
      canonicalQuestion: 'sponsorship_required',
      options: options('I am legally authorized to work', 'I am not authorized to work'),
      intendedAnswer: 'Yes',
      source: 'approved_answer',
    });
    // Authorization wording answers an authorization question, not this one.
    expect(result.status).not.toBe('matched');
    expect(result.selectedOption).toBeUndefined();
  });

  it('reads only plain booleans as booleans', () => {
    expect(readBooleanAnswer('Yes')).toBe(true);
    expect(readBooleanAnswer(' no ')).toBe(false);
    expect(readBooleanAnswer(true)).toBe(true);
    // A substantive answer is never coerced into a yes or a no.
    expect(readBooleanAnswer('I am not a protected veteran')).toBeNull();
    expect(readBooleanAnswer('Yes, I have a disability')).toBeNull();
  });
});

describe('protected traits are never inferred', () => {
  const IDENTIFYING = ['Jordan Rivera', 'Clifton, New Jersey', 'NJIT', 'Software Intern'];

  it.each(IDENTIFYING)('answers nothing from "%s"', (evidence) => {
    for (const canonicalQuestion of [
      'gender',
      'transgender',
      'race_ethnicity',
      'hispanic_latino',
      'sexual_orientation',
      'veteran_status',
      'disability_status',
    ] as const) {
      const result = resolveSemanticOption({
        fieldId: 'field-x',
        question: 'Voluntary self-identification',
        canonicalQuestion,
        options: GENDER_OPTIONS,
        intendedAnswer: evidence,
        source: 'profile',
      });
      expect(result.status, `${canonicalQuestion} must not resolve from ${evidence}`).not.toBe(
        'matched',
      );
      expect(result.selectedOption).toBeUndefined();
    }
  });

  it('requires review for every protected question it does resolve', () => {
    const result = resolveSemanticOption({
      fieldId: 'field-g',
      question: 'Gender',
      canonicalQuestion: 'gender',
      options: GENDER_OPTIONS,
      intendedAnswer: 'Woman',
      source: 'approved_answer',
    });
    expect(result.sensitive).toBe(true);
    expect(result.requiresReview).toBe(true);
  });
});

describe('canonical taxonomy', () => {
  it('classifies every question category the brief names', () => {
    const cases: ReadonlyArray<readonly [string, CanonicalQuestion]> = [
      ['Gender', 'gender'],
      ['Do you identify as transgender?', 'transgender'],
      ['Sexual Orientation', 'sexual_orientation'],
      ['Race', 'race_ethnicity'],
      ['Ethnicity', 'race_ethnicity'],
      ['Are you Hispanic/Latino?', 'hispanic_latino'],
      ['Veteran Status', 'veteran_status'],
      ['Disability Status', 'disability_status'],
      ['Country', 'country'],
      ['State', 'state'],
      ['City', 'city'],
      ['Phone Country Code', 'phone_country_code'],
      ['Are you legally authorized to work in the US?', 'work_authorization'],
      ['Will you require sponsorship?', 'sponsorship_required'],
      ['When are you available to start?', 'earliest_start_date'],
      ['How did you hear about this job?', 'how_did_you_hear'],
      ['School', 'school'],
      ['Degree', 'degree'],
      ['Major', 'major'],
      ['GPA', 'gpa'],
      ['Graduation Date', 'graduation_date'],
    ];

    for (const [label, expected] of cases) {
      expect(matchCanonicalQuestion(label).question, `"${label}"`).toBe(expected);
    }
  });

  it('keeps transgender separate from gender in both directions', () => {
    expect(matchCanonicalQuestion('Do you identify as transgender?').question).toBe('transgender');
    expect(matchCanonicalQuestion('Gender').question).toBe('gender');
    expect(SENSITIVE_CANONICAL_QUESTIONS).toContain('transgender');
  });

  it('resolves alternative spellings onto one canonical identifier', () => {
    expect(canonicalQuestionFor('race')).toBe('race_ethnicity');
    expect(canonicalQuestionFor('veteran')).toBe('veteran_status');
    expect(canonicalQuestionFor('cv')).toBe('resume');
    expect(canonicalQuestionFor('why_company')).toBe('why_this_company');
    expect(canonicalQuestionFor('gender')).toBe('gender');
    expect(canonicalQuestionFor('not_a_question')).toBeNull();
  });

  it('gives every canonical question a section', () => {
    for (const question of CANONICAL_QUESTIONS) {
      expect(CANONICAL_QUESTION_SECTIONS[question], question).toBeDefined();
    }
  });
});

describe('preset library', () => {
  const now = '2026-07-29T00:00:00.000Z';

  it('defaults every protected question to declining', () => {
    const presets = defaultPresetLibrary(now);
    for (const question of [
      'gender',
      'transgender',
      'sexual_orientation',
      'race_ethnicity',
      'hispanic_latino',
      'veteran_status',
      'disability_status',
    ] as const) {
      const preset = presets.find((entry) => entry.canonicalQuestion === question);
      expect(preset, question).toBeDefined();
      expect(preset?.intent).toBe('prefer_not_to_answer');
      expect(preset?.sensitive).toBe(true);
      expect(isProtectedQuestion(question)).toBe(true);
    }
  });

  it('never creates a preset that is configured but answers nothing', () => {
    for (const preset of defaultPresetLibrary(now)) {
      expect(Boolean(preset.value ?? preset.intent), preset.canonicalQuestion).toBe(true);
    }
  });

  it('keeps legally weighty questions off automatic fill', () => {
    expect(defaultPolicyFor('terms_attestation')).toBe('always_manual');
    expect(defaultPolicyFor('signature')).toBe('always_manual');
    expect(defaultPolicyFor('work_authorization')).toBe('review_before_fill');
    expect(defaultPolicyFor('sponsorship_required')).toBe('review_before_fill');
    expect(defaultPolicyFor('citizenship')).toBe('review_before_fill');
    // An unconfigured question is shown, never filled silently.
    expect(defaultPolicyFor('unknown')).toBe('review_before_fill');
  });

  it('fills ordinary identity fields without a confirmation step', () => {
    expect(defaultPolicyFor('first_name')).toBe('auto_fill_exact');
    expect(defaultPolicyFor('email')).toBe('auto_fill_exact');
    expect(defaultPolicyFor('phone_country_code')).toBe('auto_fill_exact');
  });
});
