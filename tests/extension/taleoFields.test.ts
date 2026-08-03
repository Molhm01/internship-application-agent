import { describe, expect, it } from 'vitest';
import {
  auditRequiredFields,
  describeAudit,
  companyOverride,
  isCompanyRelationshipQuestion,
  matchCanonicalQuestion,
  matchOption,
  profileSchema,
  resolveCompanyQuestion,
  resolveWebsiteValue,
  type CompanyRelationship,
  type DetectedField,
} from '@internship-agent/shared';

/**
 * The fields the observed Taleo run got wrong.
 *
 * Each test below names one of them. They are grouped by the mistake rather
 * than by the module, because the mistake is the thing that must not come back.
 */

function field(overrides: Partial<DetectedField> & { id: string }): DetectedField {
  return {
    pageId: 'page-1',
    label: '',
    normalizedLabel: '',
    question: '',
    fieldType: 'text',
    selector: `#${overrides.id}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

describe('reading a Taleo label as the question it actually is', () => {
  const cases: Array<[string, string]> = [
    ['Name Suffix', 'name_suffix'],
    ['Suffix', 'name_suffix'],
    ['I have no middle name', 'no_middle_name'],
    ['Address Line 2', 'address_line2'],
    ['Closest Metropolitan Area', 'metro_region'],
    ['Metropolitan Area', 'metro_region'],
    ['Highest Degree Awarded', 'highest_degree_awarded'],
    ['Degree Attained', 'highest_degree_awarded'],
    ['Industry', 'industry'],
    ['Job Location', 'preferred_locations'],
    ['Which locations interest you?', 'preferred_locations'],
    ['Date Available', 'earliest_start_date'],
    ['Minimum Salary', 'salary_minimum'],
    ['Desired Salary', 'salary_expectation'],
    ['Have you previously been employed by this company?', 'previously_employed'],
    ['Have you ever applied to this company before?', 'previously_applied'],
    ['Have you previously interviewed with us?', 'previously_interviewed'],
    ['Does a family member work here?', 'family_member_employed'],
    ['Do you have an employee referral?', 'employee_referral'],
    ["Referral's Name", 'referral_name'],
    ['Referral Email', 'referral_email'],
    ['Relationship to Referral', 'referral_relationship'],
    ['Are you willing to receive promotional text messages?', 'marketing_text_consent'],
    ['How did you hear about this job?', 'how_did_you_hear'],
  ];

  for (const [label, expected] of cases) {
    it(`reads "${label}" as ${expected}`, () => {
      expect(matchCanonicalQuestion(label).question).toBe(expected);
    });
  }

  it('keeps the degree being pursued distinct from the one already awarded', () => {
    expect(matchCanonicalQuestion('Degree').question).toBe('degree');
    expect(matchCanonicalQuestion('Highest Degree Awarded').question).toBe(
      'highest_degree_awarded',
    );
  });

  it('keeps the middle-name box distinct from the no-middle-name checkbox', () => {
    expect(matchCanonicalQuestion('Middle Name').question).toBe('middle_name');
    expect(matchCanonicalQuestion('I have no middle name').question).toBe('no_middle_name');
  });

  it('keeps the metro area distinct from the city', () => {
    expect(matchCanonicalQuestion('City').question).toBe('city');
    expect(matchCanonicalQuestion('Closest Metropolitan Area').question).not.toBe('city');
  });
});

describe('the website question uses the link the user chose', () => {
  const base = {
    version: 2,
    personal: {
      linkedin: 'https://www.linkedin.com/in/jordanellis',
      github: 'https://github.com/jordanellis',
      portfolio: 'https://jordanellis.dev',
      personalWebsite: 'https://jordan.example.com',
    },
    updatedAt: '2026-08-02T09:00:00.000Z',
  };

  it('honours an explicit choice over the fallback order', () => {
    const profile = profileSchema.parse({
      ...base,
      personal: { ...base.personal, preferredWebsiteField: 'github' },
    });
    expect(resolveWebsiteValue(profile)?.value).toBe('https://github.com/jordanellis');
  });

  it('falls back to the documented order when the user has not chosen', () => {
    expect(resolveWebsiteValue(profileSchema.parse(base))?.value).toBe(
      'https://jordan.example.com',
    );
  });

  it('falls through a chosen field the user left empty rather than blanking the answer', () => {
    const profile = profileSchema.parse({
      version: 2,
      personal: { portfolio: 'https://jordanellis.dev', preferredWebsiteField: 'github' },
      updatedAt: '2026-08-02T09:00:00.000Z',
    });
    expect(resolveWebsiteValue(profile)?.value).toBe('https://jordanellis.dev');
  });

  it('invents no URL when the user saved none', () => {
    const profile = profileSchema.parse({
      version: 2,
      updatedAt: '2026-08-02T09:00:00.000Z',
    });
    expect(resolveWebsiteValue(profile)).toBeNull();
  });
});

describe('questions only the user can answer', () => {
  const KNOWN: CompanyRelationship = {
    companyKey: 'acme corp',
    companyName: 'Acme Corp',
    previouslyEmployed: false,
    hasReferral: true,
    referralName: 'Dana Reed',
    referralRelationship: 'Former manager',
  };

  it('recognizes every company-relationship question', () => {
    expect(isCompanyRelationshipQuestion('previously_employed')).toBe(true);
    expect(isCompanyRelationshipQuestion('referral_name')).toBe(true);
    expect(isCompanyRelationshipQuestion('first_name')).toBe(false);
  });

  it('uses an explicit No rather than treating it as unknown', () => {
    const answer = resolveCompanyQuestion('previously_employed', KNOWN, 'Acme Corp');
    expect(answer.status).toBe('answered');
    if (answer.status !== 'answered') return;
    expect(answer.value).toBe(false);
  });

  it('asks rather than answering when the user never said', () => {
    const answer = resolveCompanyQuestion('previously_interviewed', KNOWN, 'Acme Corp');
    expect(answer.status).toBe('ask_user');
    if (answer.status !== 'ask_user') return;
    expect(answer.question).toContain('Acme Corp');
  });

  it('asks for every fact when nothing at all is known about the employer', () => {
    for (const question of [
      'previously_employed',
      'previously_applied',
      'previously_interviewed',
      'family_member_employed',
      'employee_referral',
    ] as const) {
      expect(resolveCompanyQuestion(question, undefined, 'Acme Corp').status).toBe('ask_user');
    }
  });

  it('never invents a referral name', () => {
    const answer = resolveCompanyQuestion('referral_name', KNOWN, 'Acme Corp');
    expect(answer.status).toBe('answered');
    if (answer.status !== 'answered') return;
    expect(answer.value).toBe('Dana Reed');
  });

  it('asks for a referral email it was never given, even though a referral exists', () => {
    expect(resolveCompanyQuestion('referral_email', KNOWN, 'Acme Corp').status).toBe('ask_user');
  });

  it('does not fill referral details when there is no referral', () => {
    const noReferral: CompanyRelationship = {
      companyKey: 'acme corp',
      companyName: 'Acme Corp',
      hasReferral: false,
    };
    // Not applicable is still not "blank" — it stays a question rather than
    // becoming an empty string typed into an employer's form.
    expect(resolveCompanyQuestion('referral_name', noReferral, 'Acme Corp').status).toBe(
      'ask_user',
    );
  });

  it('reads a company-specific override regardless of punctuation and case', () => {
    const withOverride: CompanyRelationship = {
      ...KNOWN,
      overrides: { 'Why this company?': 'Because of the avionics group.' },
    };
    expect(companyOverride(withOverride, 'why this company')).toBe(
      'Because of the avionics group.',
    );
    expect(companyOverride(withOverride, 'Why this role?')).toBeNull();
    expect(companyOverride(undefined, 'Why this company?')).toBeNull();
  });
});

describe('the required-field audit', () => {
  const required = [
    field({ id: 'a', label: 'First Name', required: true }),
    field({ id: 'b', label: 'Last Name', required: true }),
    field({ id: 'c', label: 'Why this company?', required: true }),
    field({ id: 'd', label: 'Optional note', required: false }),
  ];

  it('gives every required field exactly one terminal outcome', () => {
    const audit = auditRequiredFields({
      fields: required,
      results: [
        { fieldId: 'a', status: 'verified' },
        { fieldId: 'b', status: 'verified' },
        { fieldId: 'c', status: 'needs_review', reason: 'Needs your review.' },
      ],
    });
    expect(audit.verdicts).toHaveLength(3);
    expect(audit.verdicts.map((verdict) => verdict.outcome)).toEqual([
      'FILLED_VERIFIED',
      'FILLED_VERIFIED',
      'USER_CONFIRMATION_REQUIRED',
    ]);
    expect(audit.complete).toBe(false);
  });

  it('never silently ignores a required field the run did not reach', () => {
    const audit = auditRequiredFields({ fields: required, results: [] });
    // Three required fields, three verdicts. None is missing from the report.
    expect(audit.verdicts).toHaveLength(3);
    expect(audit.outstanding).toHaveLength(3);
    expect(audit.verdicts[0]?.reason).toMatch(/did not reach/i);
  });

  it('does not count "filled" as verified, because a rerender can discard it', () => {
    const audit = auditRequiredFields({
      fields: [required[0]!],
      results: [{ fieldId: 'a', status: 'filled' }],
    });
    expect(audit.verdicts[0]?.outcome).toBe('USER_CONFIRMATION_REQUIRED');
    expect(audit.verdicts[0]?.reason).toMatch(/did not confirm/i);
  });

  it('marks unfilled fields as blocked when the page is blocked', () => {
    const audit = auditRequiredFields({
      fields: required,
      results: [{ fieldId: 'a', status: 'verified' }],
      blockedReason: 'This page has a CAPTCHA. Solve it yourself, then continue.',
    });
    expect(audit.verdicts.map((verdict) => verdict.outcome)).toEqual([
      'FILLED_VERIFIED',
      'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
      'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
    ]);
  });

  it('ignores hidden and disabled controls, which include honeypots', () => {
    const audit = auditRequiredFields({
      fields: [
        field({ id: 'trap', label: 'Leave this empty', required: true, visible: false }),
        field({ id: 'off', label: 'Locked', required: true, disabled: true }),
      ],
      results: [],
    });
    expect(audit.verdicts).toEqual([]);
    expect(audit.complete).toBe(true);
  });

  it('reports completion only when every required field is confirmed', () => {
    const audit = auditRequiredFields({
      fields: required,
      results: required.map((entry) => ({ fieldId: entry.id, status: 'verified' })),
    });
    expect(audit.complete).toBe(true);
    expect(describeAudit(audit)).toMatch(/All 3 required fields are filled and confirmed/);
  });

  it('summarizes what is left in one sentence', () => {
    const audit = auditRequiredFields({
      fields: required,
      results: [{ fieldId: 'a', status: 'verified' }],
    });
    expect(describeAudit(audit)).toBe('3 required fields: 1 confirmed, 2 still need you.');
  });
});

describe('a rule made specific enough not to swallow its neighbour', () => {
  it('keeps a relocation question about relocating, not about location preferences', () => {
    // The Taleo multi-select is labelled exactly "Job Location"; this sentence
    // contains those words and is a different question entirely.
    expect(matchCanonicalQuestion('Would you consider moving to the job location?').question).toBe(
      'willing_to_relocate',
    );
    expect(matchCanonicalQuestion('Job Location').question).toBe('preferred_locations');
  });

  it("keeps a referral's email off the applicant's own email field", () => {
    expect(matchCanonicalQuestion('Email Address').question).toBe('email');
    expect(matchCanonicalQuestion('Referral Email').question).toBe('referral_email');
  });

  it('keeps the desired salary distinct from the minimum', () => {
    expect(matchCanonicalQuestion('Desired Salary').question).toBe('salary_expectation');
    expect(matchCanonicalQuestion('Minimum Salary Requirement').question).toBe('salary_minimum');
  });
});

describe('selecting from a dropdown', () => {
  const options = [
    { label: 'Please choose', value: '', disabled: true },
    { label: 'Bachelor of Science', value: 'BS' },
    { label: 'Bachelor of Arts', value: 'BA' },
    { label: "Master's Degree", value: 'MS' },
  ];

  it('never falls back to the first option when nothing matches', () => {
    const result = matchOption('Associate Degree', options);
    expect(result.matched).toBe(false);
    // The failure mode this guards is picking options[0] — here a disabled
    // placeholder — and reporting it as an answer.
    expect(result.option).toBeUndefined();
  });

  it('refuses to resolve on a shared prefix alone', () => {
    const result = matchOption('Bachelor', options);
    expect(result.matched).toBe(false);
  });

  it('takes an exact option when there is exactly one', () => {
    const result = matchOption('Bachelor of Science', options);
    expect(result.matched).toBe(true);
    expect(result.option?.value).toBe('BS');
  });

  it('matches on the underlying value as readily as the label', () => {
    expect(matchOption('BA', options).option?.label).toBe('Bachelor of Arts');
  });

  it('ignores case and punctuation the page chose', () => {
    expect(matchOption('masters degree', options).option?.value).toBe('MS');
  });

  it('reports ambiguity rather than picking one of several equal candidates', () => {
    const duplicated = [
      { label: 'Remote', value: 'remote-us' },
      { label: 'Remote', value: 'remote-eu' },
    ];
    const result = matchOption('Remote', duplicated);
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it('proposes nothing for an empty value', () => {
    expect(matchOption('', options).matched).toBe(false);
  });
});
