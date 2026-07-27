import { describe, expect, it } from 'vitest';
import { profileSchema, type ApprovedAnswer, type DetectedField } from '@internship-agent/shared';
import { MATCH_CONFIDENCE, matchField } from '../../extension/src/matcher/deterministicMatcher.js';

const NOW = '2026-07-26T12:00:00.000Z';
const profile = profileSchema.parse({
  updatedAt: NOW,
  personal: {
    legalFirstName: 'Jordan',
    email: 'jordan@example.com',
    phone: '+16175550142',
    address: {},
  },
  education: [{ id: 'edu-1', institution: 'Example University', gpa: 3.8 }],
  sensitivePolicies: [{ category: 'gender', policy: 'review_required' }],
});
const field = (
  canonicalKey: DetectedField['canonicalKey'],
  label = canonicalKey ?? 'Unknown',
): DetectedField => ({
  id: `field-${canonicalKey ?? 'unknown'}`,
  pageId: 'page-1',
  label,
  normalizedLabel: label.replaceAll('_', ' '),
  question: label,
  ...(canonicalKey ? { canonicalKey } : {}),
  fieldType: 'text',
  selector: '#field',
  required: false,
  visible: true,
  disabled: false,
  confidence: 1,
  sourceSignals: ['label_for'],
  warnings: [],
  metadata: {},
});

const approved = (overrides: Partial<ApprovedAnswer> = {}): ApprovedAnswer => ({
  id: 'answer-1',
  canonicalQuestion: 'Are you legally authorized to work in the United States?',
  aliases: ['work authorization'],
  answerType: 'boolean',
  answer: true,
  category: 'eligibility',
  approved: true,
  autoFillAllowed: true,
  sensitive: false,
  tailoringAllowed: false,
  requiresReview: false,
  lastUpdatedAt: NOW,
  ...overrides,
});

describe('deterministic field matcher', () => {
  it('resolves exact canonical profile paths with fixed confidence', () => {
    const match = matchField(field('first_name'), profile, []);
    expect(match.sourceReference).toBe('profile.personal.legalFirstName');
    expect(match.formattedValue).toBe('Jordan');
    expect(match.confidence).toBe(MATCH_CONFIDENCE.exact);
  });

  it('uses only an approved answer for work authorization', () => {
    expect(matchField(field('work_authorization'), profile, []).matched).toBe(false);
    const match = matchField(
      field('work_authorization', 'Are you legally authorized to work in the United States?'),
      profile,
      [approved()],
    );
    expect(match.source).toBe('approved_answer');
    expect(match.formattedValue).toBe(true);
  });

  it('never infers sensitive answers and respects explicit policy', () => {
    const match = matchField(field('gender', 'Gender'), profile, []);
    expect(match.matched).toBe(false);
    expect(match.sensitive).toBe(true);
    expect(match.requiresReview).toBe(true);
  });

  it('requires review for sensitive approved answers and legal attestations', () => {
    const sensitive = matchField(field('gender', 'Gender'), profile, [
      approved({
        canonicalQuestion: 'Gender',
        aliases: [],
        answerType: 'single_select',
        answer: 'Woman',
        sensitive: true,
        requiresReview: true,
      }),
    ]);
    expect(sensitive.requiresReview).toBe(true);

    const legal = matchField(
      { ...field(undefined, 'I certify this is accurate'), fieldType: 'checkbox' },
      profile,
      [],
    );
    expect(legal.matched).toBe(false);
    expect(legal.requiresReview).toBe(true);
  });

  it('marks explicit edits as user overrides', () => {
    const match = matchField(field('email'), profile, [], 'edited@example.com');
    expect(match.source).toBe('user_override');
    expect(match.confidence).toBe(1);
    expect(match.requiresReview).toBe(true);
  });

  it('uses only an explicit discovery-source preference for how-did-you-hear fields', () => {
    expect(
      matchField(field('how_did_you_hear', 'How did you hear about us?'), profile, []).matched,
    ).toBe(false);
    const configured = profileSchema.parse({
      ...profile,
      preferences: { ...profile.preferences, discoverySource: 'University career center' },
    });
    expect(
      matchField(field('how_did_you_hear', 'How did you hear about us?'), configured, []),
    ).toMatchObject({
      source: 'profile',
      sourceReference: 'profile.preferences.discoverySource',
      formattedValue: 'University career center',
    });
  });

  it('uses only explicit profile availability and never guesses it', () => {
    expect(
      matchField(field('internship_availability', 'Are you available?'), profile, []).matched,
    ).toBe(false);
    const configured = profileSchema.parse({
      ...profile,
      eligibility: { ...profile.eligibility, internshipAvailability: 'Yes' },
    });
    expect(
      matchField(field('internship_availability', 'Are you available?'), configured, []),
    ).toMatchObject({
      source: 'profile',
      sourceReference: 'profile.eligibility.internshipAvailability',
      formattedValue: 'Yes',
    });
  });

  it('recognizes sensitive labels outside the canonical scanner vocabulary', () => {
    const religion = matchField(field(undefined, 'Religious affiliation'), profile, []);
    expect(religion.sensitive).toBe(true);
    expect(religion.requiresReview).toBe(true);
    const edited = matchField(
      field(undefined, 'Medical information'),
      profile,
      [],
      'Explicit user response',
    );
    expect(edited.source).toBe('user_override');
    expect(edited.sensitive).toBe(true);
    expect(edited.requiresReview).toBe(true);
  });
});
