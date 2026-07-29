import { describe, expect, it } from 'vitest';
import {
  defaultSensitivePresets,
  intentFromSavedText,
  isDeclinePhrasing,
  matchIntentToOption,
  resolveFromPreset,
  resolveSemanticOption,
  semanticOptionDecisionSchema,
  applicationPresetSchema,
  type ApplicationPreset,
  type FieldOption,
} from '@internship-agent/shared';

const NOW = '2026-07-29T12:00:00.000Z';

/** Every wording of "decline" observed across real application forms. */
const DECLINE_VARIANTS = [
  'Prefer not to answer',
  'I prefer not to answer',
  'I do not wish to answer',
  'I do not wish to self-identify',
  'Decline to self-identify',
  'Choose not to disclose',
  'I prefer not to disclose',
  'Opt out of answering',
  "I don't wish to answer",
];

function genderOptions(declineLabel: string): FieldOption[] {
  return [
    { label: 'Male', value: 'male' },
    { label: 'Female', value: 'female' },
    { label: 'Non-binary', value: 'nb' },
    { label: declineLabel, value: 'decline' },
  ];
}

describe('decline semantic matching', () => {
  it.each(DECLINE_VARIANTS)('maps a saved decline preference to "%s"', (declineLabel) => {
    const decision = resolveSemanticOption({
      fieldId: 'gender',
      question: 'Gender',
      canonicalQuestion: 'gender',
      options: genderOptions(declineLabel),
      canonicalIntent: 'prefer_not_to_answer',
      source: 'sensitive_policy',
    });

    expect(decision.status).toBe('matched');
    expect(decision.selectedOption?.label).toBe(declineLabel);
    // Never a demographic category.
    expect(['male', 'female', 'nb']).not.toContain(decision.selectedOption?.value);
  });

  it('recognizes every decline phrasing as declining', () => {
    for (const variant of DECLINE_VARIANTS) {
      expect(isDeclinePhrasing(variant), variant).toBe(true);
    }
    expect(isDeclinePhrasing('Male')).toBe(false);
  });

  it('reads a saved free-text answer as an intent', () => {
    expect(intentFromSavedText('Prefer not to say')).toBe('prefer_not_to_answer');
    expect(intentFromSavedText('Yes')).toBe('affirmative');
    expect(intentFromSavedText('No')).toBe('negative');
    expect(intentFromSavedText('Clifton')).toBeNull();
  });

  it('pauses the field when the form offers no way to decline', () => {
    const decision = resolveSemanticOption({
      fieldId: 'gender',
      question: 'Gender',
      canonicalQuestion: 'gender',
      options: [
        { label: 'Male', value: 'male' },
        { label: 'Female', value: 'female' },
      ],
      canonicalIntent: 'prefer_not_to_answer',
      source: 'sensitive_policy',
    });

    expect(decision.status).toBe('missing_information');
    expect(decision.selectedOption).toBeUndefined();
    expect(decision.reason).toContain('no way to decline');
  });

  it('refuses to pick when several options express the same preference', () => {
    const decision = resolveSemanticOption({
      fieldId: 'gender',
      question: 'Gender',
      canonicalQuestion: 'gender',
      options: [
        { label: 'Prefer not to answer', value: 'a' },
        { label: 'I do not wish to answer', value: 'b' },
      ],
      canonicalIntent: 'prefer_not_to_answer',
      source: 'sensitive_policy',
    });

    expect(decision.status).toBe('ambiguous');
    expect(decision.selectedOption).toBeUndefined();
  });
});

describe('protected traits are never inferred', () => {
  it('never selects a demographic value without a saved answer', () => {
    const decision = resolveSemanticOption({
      fieldId: 'race',
      question: 'Race/Ethnicity',
      canonicalQuestion: 'race_ethnicity',
      options: [
        { label: 'Asian', value: 'asian' },
        { label: 'White', value: 'white' },
        { label: 'Two or more races', value: 'multi' },
      ],
      source: 'none',
    });

    expect(decision.status).toBe('missing_information');
    expect(decision.selectedOption).toBeUndefined();
  });

  it('always requires review before disclosing a sensitive value', () => {
    const decision = resolveSemanticOption({
      fieldId: 'gender',
      question: 'Gender',
      canonicalQuestion: 'gender',
      options: genderOptions('Prefer not to answer'),
      intendedAnswer: 'Female',
      source: 'approved_answer',
    });

    expect(decision.status).toBe('matched');
    expect(decision.sensitive).toBe(true);
    expect(decision.requiresReview).toBe(true);
  });

  it('rejects a decision naming an option the page never offered', () => {
    const parsed = semanticOptionDecisionSchema.safeParse({
      fieldId: 'gender',
      question: 'Gender',
      canonicalQuestion: 'gender',
      availableOptions: [{ label: 'Male', value: 'male', disabled: false }],
      intendedAnswer: 'Female',
      selectedOption: { label: 'Female', value: 'female' },
      source: 'ai_semantic_match',
      confidence: 'medium',
      requiresReview: true,
      sensitive: true,
      reason: 'invented',
      warnings: [],
      status: 'matched',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects selecting a disabled option', () => {
    const parsed = semanticOptionDecisionSchema.safeParse({
      fieldId: 'country',
      question: 'Country',
      canonicalQuestion: 'country',
      availableOptions: [{ label: 'Select…', value: '', disabled: true }],
      intendedAnswer: 'Select…',
      selectedOption: { label: 'Select…', value: '' },
      source: 'profile',
      confidence: 'high',
      requiresReview: false,
      sensitive: false,
      reason: 'placeholder',
      warnings: [],
      status: 'matched',
    });

    expect(parsed.success).toBe(false);
  });

  it('skips disabled options when matching', () => {
    const decision = resolveSemanticOption({
      fieldId: 'country',
      question: 'Country',
      canonicalQuestion: 'country',
      options: [
        { label: 'United States', value: 'placeholder', disabled: true },
        { label: 'United States of America', value: 'US' },
      ],
      intendedAnswer: 'United States',
      source: 'profile',
    });

    expect(decision.selectedOption?.value).toBe('US');
  });
});

describe('question-aware yes/no matching', () => {
  it('maps an authorization intent to its own phrasing', () => {
    const decision = resolveSemanticOption({
      fieldId: 'auth',
      question: 'Are you legally authorized to work in the United States?',
      canonicalQuestion: 'work_authorization',
      options: [
        { label: 'Yes, I am authorized to work', value: 'yes' },
        { label: 'No, I am not authorized to work', value: 'no' },
      ],
      canonicalIntent: 'authorized',
      source: 'approved_answer',
    });

    expect(decision.selectedOption?.value).toBe('yes');
  });

  it('maps sponsorship-not-required to the negative option, not a bare yes', () => {
    const decision = resolveSemanticOption({
      fieldId: 'sponsor',
      question: 'Will you now or in the future require sponsorship?',
      canonicalQuestion: 'sponsorship_required',
      options: [
        { label: 'Yes, I will require sponsorship', value: 'yes' },
        { label: 'No, I will not require sponsorship', value: 'no' },
      ],
      canonicalIntent: 'sponsorship_not_required',
      source: 'approved_answer',
    });

    expect(decision.selectedOption?.value).toBe('no');
  });

  it('distinguishes the two intents on the same wording', () => {
    const options: FieldOption[] = [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ];
    expect(matchIntentToOption('sponsorship_required', options).option?.value).toBe('yes');
    expect(matchIntentToOption('sponsorship_not_required', options).option?.value).toBe('no');
  });
});

describe('country, state, and location matching', () => {
  it('normalizes a saved country to the page wording', () => {
    const decision = resolveSemanticOption({
      fieldId: 'country',
      question: 'Country',
      canonicalQuestion: 'country',
      options: [
        { label: 'United States of America', value: 'US' },
        { label: 'United States Minor Outlying Islands', value: 'UM' },
        { label: 'United States Virgin Islands', value: 'VI' },
      ],
      intendedAnswer: 'United States',
      source: 'profile',
    });

    expect(decision.status).toBe('matched');
    expect(decision.selectedOption?.value).toBe('US');
  });

  it('matches a city that carries a region suffix and asks for confirmation', () => {
    const decision = resolveSemanticOption({
      fieldId: 'city',
      question: 'Location (City)',
      canonicalQuestion: 'city',
      options: [
        { label: 'Clifton, New Jersey, United States', value: 'nj' },
        { label: 'Newark, New Jersey, United States', value: 'newark' },
      ],
      intendedAnswer: 'Clifton',
      source: 'profile',
    });

    expect(decision.selectedOption?.value).toBe('nj');
    // Region was inferred, so the user confirms it.
    expect(decision.requiresReview).toBe(true);
  });

  it('rejects an ambiguous city across states', () => {
    const decision = resolveSemanticOption({
      fieldId: 'city',
      question: 'Location (City)',
      canonicalQuestion: 'city',
      options: [
        { label: 'Clifton, New Jersey, United States', value: 'nj' },
        { label: 'Clifton, Colorado, United States', value: 'co' },
        { label: 'Clifton, Arizona, United States', value: 'az' },
      ],
      intendedAnswer: 'Clifton',
      source: 'profile',
    });

    expect(decision.status).toBe('ambiguous');
    expect(decision.selectedOption).toBeUndefined();
  });
});

describe('application presets', () => {
  function preset(overrides: Partial<ApplicationPreset> = {}): ApplicationPreset {
    return applicationPresetSchema.parse({
      id: 'preset-gender',
      canonicalQuestion: 'gender',
      intent: 'prefer_not_to_answer',
      aliases: [],
      sensitive: true,
      autofillPolicy: 'prefer_not_to_answer',
      requiresReview: false,
      lastUpdatedAt: NOW,
      ...overrides,
    });
  }

  it('ships a decline preset for every voluntary self-identification question', () => {
    const presets = defaultSensitivePresets(NOW);
    const questions = presets.map((entry) => entry.canonicalQuestion);

    expect(questions).toEqual(
      expect.arrayContaining([
        'gender',
        'race_ethnicity',
        'hispanic_latino',
        'veteran_status',
        'disability_status',
      ]),
    );
    expect(presets.every((entry) => entry.intent === 'prefer_not_to_answer')).toBe(true);
  });

  it('fills a decline preset without further confirmation', () => {
    const decision = resolveFromPreset(preset(), {
      fieldId: 'gender',
      question: 'Gender',
      options: genderOptions('I do not wish to self-identify'),
    });

    expect(decision.status).toBe('matched');
    expect(decision.selectedOption?.label).toBe('I do not wish to self-identify');
    expect(decision.requiresReview).toBe(false);
  });

  it('refuses a sensitive preset that would disclose a value automatically', () => {
    const parsed = applicationPresetSchema.safeParse({
      id: 'preset-bad',
      canonicalQuestion: 'gender',
      value: 'Female',
      aliases: [],
      sensitive: true,
      autofillPolicy: 'auto_fill_semantic',
      requiresReview: false,
      lastUpdatedAt: NOW,
    });

    expect(parsed.success).toBe(false);
  });

  it('honours a leave-blank preset by selecting nothing', () => {
    const decision = resolveFromPreset(preset({ autofillPolicy: 'leave_blank' }), {
      fieldId: 'gender',
      question: 'Gender',
      options: genderOptions('Prefer not to answer'),
    });

    expect(decision.status).toBe('prohibited');
    expect(decision.selectedOption).toBeUndefined();
  });

  it('honours an always-manual preset', () => {
    const decision = resolveFromPreset(preset({ autofillPolicy: 'always_manual' }), {
      fieldId: 'gender',
      question: 'Gender',
      options: genderOptions('Prefer not to answer'),
    });

    expect(decision.status).toBe('missing_information');
    expect(decision.requiresReview).toBe(true);
  });

  it('requires a preset to carry either a value or an intent', () => {
    const parsed = applicationPresetSchema.safeParse({
      id: 'preset-empty',
      canonicalQuestion: 'country',
      aliases: [],
      sensitive: false,
      autofillPolicy: 'auto_fill_exact',
      requiresReview: false,
      lastUpdatedAt: NOW,
    });

    expect(parsed.success).toBe(false);
  });

  it('reviews a non-exact match under an auto_fill_exact policy', () => {
    const decision = resolveFromPreset(
      preset({
        id: 'preset-country',
        canonicalQuestion: 'country',
        value: 'United States',
        intent: undefined,
        sensitive: false,
        autofillPolicy: 'auto_fill_exact',
      }),
      {
        fieldId: 'country',
        question: 'Country',
        options: [{ label: 'United States of America', value: 'US' }],
      },
    );

    expect(decision.status).toBe('matched');
    // Matched through an alias rather than literally, so it is confirmed.
    expect(decision.requiresReview).toBe(true);
  });
});
