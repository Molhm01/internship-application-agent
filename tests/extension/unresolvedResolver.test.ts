import { describe, expect, it } from 'vitest';
import {
  matchOption,
  profileSchema,
  resolveUnresolvedField,
  resolveWebsiteValue,
  unresolvedFieldResolutionSchema,
  type ApprovedAnswer,
  type DetectedField,
  type FieldOption,
  type Profile,
} from '@internship-agent/shared';

const NOW = '2026-07-29T12:00:00.000Z';

function profileWith(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    updatedAt: NOW,
    personal: {
      legalFirstName: 'Jordan',
      legalLastName: 'Rivera',
      address: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
      linkedin: 'https://www.linkedin.com/in/example',
      portfolio: 'https://portfolio.example.com',
    },
    ...overrides,
  });
}

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    pageId: 'page-1',
    label: 'Country',
    normalizedLabel: 'country',
    question: 'Country',
    fieldType: 'combobox',
    selector: '#country',
    required: true,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    canonicalKey: 'country',
    ...overrides,
  };
}

function answer(overrides: Partial<ApprovedAnswer> = {}): ApprovedAnswer {
  return {
    id: 'answer-1',
    canonicalQuestion: 'gender',
    aliases: [],
    answerType: 'single_select',
    answer: 'Woman',
    category: 'demographics',
    approved: true,
    autoFillAllowed: false,
    sensitive: true,
    tailoringAllowed: false,
    requiresReview: true,
    lastUpdatedAt: NOW,
    ...overrides,
  };
}

const COUNTRY_OPTIONS: FieldOption[] = [
  { label: 'Canada', value: 'CA' },
  { label: 'United States of America', value: 'US' },
  { label: 'United Kingdom', value: 'UK' },
];

describe('resolution priority', () => {
  it('resolves an exact structured profile value first', () => {
    const result = resolveUnresolvedField({
      field: field({ options: COUNTRY_OPTIONS }),
      profile: profileWith(),
      answers: [],
    });

    expect(unresolvedFieldResolutionSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('resolved');
    expect(result.source).toBe('profile');
    expect(result.sourceReference).toBe('profile.personal.address.country');
    expect(result.matchedOption?.label).toBe('United States of America');
  });

  it('never lets an AI suggestion override a saved profile value', () => {
    const result = resolveUnresolvedField({
      field: field({ options: COUNTRY_OPTIONS }),
      profile: profileWith(),
      answers: [],
      aiSuggestion: { value: 'Canada', reference: 'ai.guess' },
    });

    expect(result.source).toBe('profile');
    expect(result.matchedOption?.value).toBe('US');
  });

  it('never lets an AI suggestion override an approved answer', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: 'how_did_you_hear',
        label: 'How did you hear about us?',
        normalizedLabel: 'how did you hear about us',
      }),
      profile: profileWith(),
      answers: [
        answer({
          id: 'answer-hear',
          canonicalQuestion: 'how did you hear about us',
          answer: 'University career fair',
          category: 'general',
          sensitive: false,
          autoFillAllowed: true,
          requiresReview: false,
        }),
      ],
      aiSuggestion: { value: 'LinkedIn', reference: 'ai.guess' },
    });

    expect(result.source).toBe('approved_answer');
    expect(result.proposedValue).toBe('University career fair');
  });

  it('falls back to an AI suggestion only when nothing saved answers the question', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: 'referral',
        label: 'Referral source',
        normalizedLabel: 'referral source',
        fieldType: 'text',
      }),
      profile: profileWith(),
      answers: [],
      aiSuggestion: { value: 'University career fair', reference: 'profile.education[0]' },
    });

    expect(result.source).toBe('ai_suggestion');
    expect(result.status).toBe('needs_review');
    expect(result.requiresReview).toBe(true);
  });

  it('reports missing information rather than guessing', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: 'salary_expectation',
        label: 'Desired salary',
        normalizedLabel: 'desired salary',
        fieldType: 'text',
      }),
      profile: profileWith(),
      answers: [],
    });

    expect(result.status).toBe('missing_information');
    expect(result.proposedValue).toBeUndefined();
  });
});

describe('sensitive field prohibition', () => {
  const sensitiveFields = [
    { canonicalKey: 'gender' as const, label: 'Gender' },
    { canonicalKey: 'race_ethnicity' as const, label: 'Are you Hispanic/Latino?' },
    { canonicalKey: 'veteran_status' as const, label: 'Veteran status' },
    { canonicalKey: 'disability_status' as const, label: 'Disability status' },
  ];

  it.each(sensitiveFields)('never infers $canonicalKey', ({ canonicalKey, label }) => {
    const result = resolveUnresolvedField({
      field: field({ canonicalKey, label, normalizedLabel: label.toLowerCase() }),
      profile: profileWith(),
      answers: [],
      // Even offered a suggestion, a sensitive field must refuse it.
      aiSuggestion: { value: 'Woman', reference: 'ai.inference' },
    });

    expect(result.status).toBe('missing_information');
    expect(result.source).toBe('none');
    expect(result.sensitive).toBe(true);
    expect(result.proposedValue).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('never inferred');
  });

  it('uses an explicit approved sensitive answer and still requires review', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: 'gender',
        label: 'Gender',
        normalizedLabel: 'gender',
        options: [
          { label: 'Woman', value: 'woman' },
          { label: 'Man', value: 'man' },
          { label: 'Decline to self identify', value: 'decline' },
        ],
      }),
      profile: profileWith(),
      answers: [answer()],
    });

    expect(result.source).toBe('approved_answer');
    expect(result.status).toBe('needs_review');
    expect(result.requiresReview).toBe(true);
    expect(result.matchedOption?.value).toBe('woman');
  });

  it('auto-fills a sensitive answer only when explicitly marked auto-fillable', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: 'veteran_status',
        label: 'Veteran status',
        normalizedLabel: 'veteran status',
      }),
      profile: profileWith(),
      answers: [
        answer({
          canonicalQuestion: 'veteran status',
          answer: 'I am not a protected veteran',
          autoFillAllowed: true,
          requiresReview: false,
        }),
      ],
    });

    expect(result.status).toBe('resolved');
    expect(result.requiresReview).toBe(false);
  });

  it('never accepts a legal attestation automatically', () => {
    const result = resolveUnresolvedField({
      field: field({
        canonicalKey: undefined,
        fieldType: 'checkbox',
        label: 'I certify that the information provided is accurate',
        normalizedLabel: 'i certify that the information provided is accurate',
      }),
      profile: profileWith(),
      answers: [],
    });

    expect(result.status).toBe('prohibited');
    expect(result.proposedValue).toBeUndefined();
  });

  it('rejects a resolution that pairs a sensitive field with an AI suggestion', () => {
    const parsed = unresolvedFieldResolutionSchema.safeParse({
      fieldId: 'f',
      status: 'needs_review',
      proposedValue: 'Woman',
      source: 'ai_suggestion',
      confidence: 'medium',
      requiresReview: true,
      sensitive: true,
      reason: 'should be impossible',
      warnings: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('website fallback order', () => {
  it('prefers the personal website', () => {
    const site = resolveWebsiteValue(
      profileWith({
        personal: {
          personalWebsite: 'https://jordan.example.com',
          portfolio: 'https://portfolio.example.com',
          github: 'https://github.com/example',
          address: {},
        },
      }),
    );
    expect(site?.value).toBe('https://jordan.example.com');
  });

  it('falls back to the portfolio, then GitHub', () => {
    const portfolio = resolveWebsiteValue(
      profileWith({
        personal: {
          portfolio: 'https://portfolio.example.com',
          github: 'https://github.com/example',
          address: {},
        },
      }),
    );
    expect(portfolio?.value).toBe('https://portfolio.example.com');

    const github = resolveWebsiteValue(
      profileWith({ personal: { github: 'https://github.com/example', address: {} } }),
    );
    expect(github?.value).toBe('https://github.com/example');
  });

  it('invents nothing when no link is saved', () => {
    expect(resolveWebsiteValue(profileWith({ personal: { address: {} } }))).toBeNull();
  });
});

describe('option matching', () => {
  it('matches a country through a documented alias', () => {
    const result = matchOption('United States', COUNTRY_OPTIONS);
    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe('United States of America');
    expect(result.confidence).toBe('medium');
    expect(result.aliasUsed).toContain('United States');
  });

  it('matches a city that carries a region suffix', () => {
    const result = matchOption(
      'Clifton',
      [
        { label: 'Clifton, New Jersey, United States', value: 'clifton-nj' },
        { label: 'Newark, New Jersey, United States', value: 'newark-nj' },
      ],
      { allowRegionSuffix: true },
    );
    expect(result.matched).toBe(true);
    expect(result.option?.value).toBe('clifton-nj');
  });

  it('refuses an ambiguous city rather than picking one', () => {
    const result = matchOption(
      'Springfield',
      [
        { label: 'Springfield, Illinois, United States', value: 'springfield-il' },
        { label: 'Springfield, Missouri, United States', value: 'springfield-mo' },
      ],
      { allowRegionSuffix: true },
    );
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.option).toBeUndefined();
  });

  it('does not use the region-suffix rule unless the question allows it', () => {
    const result = matchOption('Clifton', [
      { label: 'Clifton, New Jersey, United States', value: 'clifton-nj' },
    ]);
    expect(result.matched).toBe(false);
  });

  it('maps state abbreviations to full names and back', () => {
    expect(matchOption('NJ', [{ label: 'New Jersey', value: 'NJ-full' }]).option?.value).toBe(
      'NJ-full',
    );
    expect(matchOption('New Jersey', [{ label: 'NJ', value: 'nj' }]).option?.value).toBe('nj');
  });

  it('maps degree and boolean aliases', () => {
    expect(
      matchOption('Bachelor of Science', [{ label: "Bachelor's Degree", value: 'bachelors' }])
        .option?.value,
    ).toBe('bachelors');
    expect(matchOption(true, [{ label: 'Yes', value: 'yes' }]).option?.value).toBe('yes');
    expect(matchOption(false, [{ label: 'No', value: 'no' }]).option?.value).toBe('no');
  });

  it('prefers a literal match over an alias', () => {
    const result = matchOption('US', [
      { label: 'US', value: 'literal' },
      { label: 'United States of America', value: 'alias' },
    ]);
    expect(result.option?.value).toBe('literal');
    expect(result.confidence).toBe('high');
  });
});
