import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  activeEducationEntry,
  currentEnrollment,
  degreeAnswersFor,
  detectedFieldSchema,
  educationLevelIntent,
  formatDateForField,
  formatValue,
  monthValueForField,
  matchCanonicalQuestion,
  parseStoredDate,
  profileSchema,
  requiredDateShape,
  resolveUnresolvedField,
  yearValue,
  type DetectedField,
  type Profile,
} from '@internship-agent/shared';
import { matchField } from '../../extension/src/matcher/deterministicMatcher.js';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';
import { emptyApplicationScan } from './popupFixtures.js';

/**
 * Phase 4: the education mapping, and the date fallbacks that had to stop.
 *
 * Two claims are under test throughout. The first is that the two degree facts
 * stay two facts — a bachelor's student holds a high-school diploma and is
 * studying for a bachelor's, and no question may be answered from the wrong one.
 * The second is that no date the profile does not state may reach a form: not
 * an invented day, not a model's guess, and above all not today's date.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'phase4-education.html',
);

/** The Phase 4 applicant: high school completed, bachelor's in progress. */
function applicant(overrides: Record<string, unknown> = {}): Profile {
  return profileFixture(overrides);
}

/** The same applicant with no saved availability, as the brief specifies. */
function withoutStartDate(): Profile {
  const base = applicant();
  return profileSchema.parse({
    ...base,
    eligibility: { ...base.eligibility, earliestStartDate: undefined },
  });
}

/**
 * The Phase 4 fixture profile exactly as the brief states it: one completed
 * high-school record, one bachelor's in progress, a school, a major, a GPA, a
 * graduation month and year — and no minor and no saved internship start date,
 * because the two questions those answer must stay the user's.
 */
function fixtureProfile(): Profile {
  const base = withoutStartDate();
  return profileSchema.parse({
    ...base,
    education: base.education.map((entry) => ({ ...entry, minor: undefined })),
  });
}

function field(overrides: Partial<DetectedField> & { label: string }): DetectedField {
  const label = overrides.label;
  const match = matchCanonicalQuestion(label);
  return detectedFieldSchema.parse({
    id: `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    pageId: 'page-phase4',
    normalizedLabel: label.toLowerCase().trim(),
    ...(match.question !== 'unknown' ? { canonicalKey: match.question } : {}),
    question: label,
    fieldType: 'text',
    selector: '#control',
    required: true,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    ...overrides,
  });
}

function canonicalOf(label: string): string {
  return matchCanonicalQuestion(label).question;
}

function valueFor(target: DetectedField, profile: Profile = applicant()) {
  return matchField(target, profile, []);
}

describe('education question intent', () => {
  it('classifies every "completed" wording as the awarded credential', () => {
    for (const label of [
      'Highest degree completed',
      'Highest degree earned',
      'Highest degree awarded',
      'Highest level of education completed',
      'Highest completed education',
      'Highest Level of Education',
    ]) {
      expect(canonicalOf(label), label).toBe('highest_degree_awarded');
    }
  });

  it('classifies every "current" wording as the degree in progress', () => {
    for (const label of [
      'Current degree',
      'Degree currently pursuing',
      'Current academic program',
      'Degree in progress',
      'Current education program',
    ]) {
      expect(canonicalOf(label), label).toBe('degree');
    }
  });

  it('reads a bare education-level question as a level held, not a level pursued', () => {
    expect(educationLevelIntent({ label: 'Highest Level of Education' })).toBe('completed');
    expect(educationLevelIntent({ label: 'Level of Education' })).toBe('completed');
  });

  it('reads a level question the page phrases as current as a current one', () => {
    expect(
      educationLevelIntent({ label: 'Highest level of education you are currently pursuing' }),
    ).toBe('current');
    expect(
      educationLevelIntent({
        label: 'Level of education',
        optionLabels: ['Currently enrolled — undergraduate', 'Currently enrolled — graduate'],
      }),
    ).toBe('current');
  });
});

describe('completed versus current degree', () => {
  it('answers the highest completed degree with the high-school diploma', () => {
    const match = valueFor(
      field({
        label: 'Highest Degree Completed',
        fieldType: 'select',
        options: [
          { label: 'High School', value: 'hs' },
          { label: "Bachelor's Degree", value: 'bachelors' },
        ],
      }),
    );
    expect(match.matched).toBe(true);
    expect(match.rawValue).toBe('High School');
    expect(match.sourceReference).toBe('profile.highestCompletedDegree');
  });

  it("answers the current degree program with the bachelor's", () => {
    const match = valueFor(
      field({
        label: 'Current Degree Program',
        fieldType: 'select',
        options: [
          { label: 'High School', value: 'hs' },
          { label: "Bachelor's Degree", value: 'bachelors' },
        ],
      }),
    );
    expect(match.matched).toBe(true);
    expect(match.rawValue).toBe("Bachelor's Degree");
    expect(match.sourceReference).toBe('profile.currentDegreeInProgress');
  });

  it('never merges the two facts', () => {
    const answers = degreeAnswersFor(applicant());
    expect(answers.highestCompletedDegree).toBe('High School');
    expect(answers.currentDegreeInProgress).toBe("Bachelor's Degree");
  });

  it('claims no completed degree when nothing establishes one', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      highestCompletedDegree: undefined,
      education: [
        {
          id: 'e1',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          coursework: [],
        },
      ],
    });
    expect(degreeAnswersFor(profile).highestCompletedDegree).toBeUndefined();
  });
});

describe('the active education record', () => {
  it('is the degree in progress, not whichever row was entered first', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      education: [
        {
          id: 'e-hs',
          institution: 'Clifton High School',
          degree: 'High School',
          status: 'completed',
          coursework: [],
        },
        {
          id: 'e-uni',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          major: 'Computer Science',
          graduationDate: '2027-05',
          status: 'in_progress',
          coursework: [],
        },
      ],
    });
    expect(activeEducationEntry(profile)?.institution).toBe('Rutgers University');
    expect(valueFor(field({ label: 'School' }), profile).rawValue).toBe('Rutgers University');
    expect(valueFor(field({ label: 'Field of Study' }), profile).rawValue).toBe('Computer Science');
  });
});

describe('education field aliases', () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ['School', 'school'],
    ['University', 'school'],
    ['College', 'school'],
    ['Institution', 'school'],
    ['Educational Institution', 'school'],
    ['Degree', 'degree'],
    ['Degree Type', 'degree'],
    ['Program', 'degree'],
    ['Qualification', 'degree'],
    ['Major', 'major'],
    ['Field of Study', 'major'],
    ['Area of Study', 'major'],
    ['Concentration', 'major'],
    ['Minor', 'minor'],
    ['Secondary Field', 'minor'],
    ['GPA', 'gpa'],
    ['Grade Point Average', 'gpa'],
    ['Cumulative GPA', 'gpa'],
    ['Graduation Date', 'graduation_date'],
    ['Expected Graduation Date', 'graduation_date'],
    ['Anticipated Graduation Date', 'graduation_date'],
    ['Degree Completion Date', 'graduation_date'],
    ['Anticipated Degree Completion Date', 'graduation_date'],
    ['Enrollment Date', 'education_start_date'],
    ['Program Start Date', 'education_start_date'],
  ];

  for (const [label, expected] of table) {
    it(`maps "${label}" to ${expected}`, () => {
      expect(canonicalOf(label)).toBe(expected);
    });
  }

  it('keeps an employment date out of the education block', () => {
    expect(canonicalOf('Employment Start Date')).toBe('employment_start_date');
    expect(canonicalOf('Earliest Internship Start Date')).toBe('earliest_start_date');
  });
});

describe('current university student', () => {
  const options = [
    { label: 'Yes', value: 'yes' },
    { label: 'No', value: 'no' },
  ];

  for (const label of [
    'Are you currently a university student?',
    'Are you currently enrolled?',
    'Are you pursuing a degree?',
  ]) {
    it(`recognizes "${label}" as a question about enrolment now`, () => {
      expect(canonicalOf(label)).toBe('education_status');
    });
  }

  it('answers Yes from an active education record', () => {
    const match = valueFor(
      field({
        label: 'Are you currently a university student?',
        fieldType: 'select',
        options,
      }),
    );
    expect(match.matched).toBe(true);
    expect(match.rawValue).toBe(true);
  });

  it('answers No only when every saved record is finished', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      education: [
        {
          id: 'e1',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          status: 'completed',
          coursework: [],
        },
      ],
    });
    expect(currentEnrollment(profile)?.enrolled).toBe(false);
  });

  it('answers nothing at all when the profile establishes neither', () => {
    const profile = profileSchema.parse({ ...applicant(), education: [] });
    expect(currentEnrollment(profile)).toBeNull();
  });

  it('never derives enrolment from a school name alone', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      education: [{ id: 'e1', institution: 'Rutgers University', coursework: [] }],
    });
    expect(currentEnrollment(profile)).toBeNull();
  });

  it('treats enrolment during a future internship as a separate, unanswerable question', () => {
    expect(canonicalOf('Will you be enrolled during the internship?')).toBe(
      'enrolled_during_internship',
    );
    const match = valueFor(
      field({
        label: 'Will you be enrolled during the internship?',
        fieldType: 'select',
        options,
      }),
    );
    expect(match.matched).toBe(false);
  });
});

describe('date formats', () => {
  const cases: ReadonlyArray<readonly [string, Partial<DetectedField>, string]> = [
    ['iso month control', { fieldType: 'month' }, '2027-05'],
    ['MM/YYYY text box', { placeholder: 'MM/YYYY' }, '05/2027'],
    ['Month YYYY text box', { placeholder: 'Month YYYY' }, 'May 2027'],
    ['pattern-stated MM/YYYY', { pattern: '\\d{2}/\\d{4}' }, '05/2027'],
    ['a box already holding YYYY-MM', { currentValue: '2024-09' }, '2027-05'],
  ];

  for (const [name, overrides, expected] of cases) {
    it(`writes a saved 2027-05 into ${name} as ${expected}`, () => {
      const target = field({ label: 'Expected Graduation Date', ...overrides });
      const outcome = formatDateForField(target, '2027-05');
      expect(outcome.kind).toBe('value');
      expect(outcome.kind === 'value' ? outcome.value : '').toBe(expected);
    });
  }

  it('writes a full saved date into a native date control unchanged', () => {
    const target = field({ label: 'Expected Graduation Date', fieldType: 'date' });
    const outcome = formatDateForField(target, '2027-05-15');
    expect(outcome).toEqual({ kind: 'value', value: '2027-05-15', shape: 'iso_full' });
  });

  it('reads the required shape from the control rather than from the question', () => {
    expect(requiredDateShape(field({ label: 'Graduation Date', fieldType: 'date' }))).toBe(
      'iso_full',
    );
    expect(requiredDateShape(field({ label: 'Graduation Date', fieldType: 'month' }))).toBe(
      'iso_month',
    );
    expect(requiredDateShape(field({ label: 'Graduation Date', placeholder: 'MM/DD/YYYY' }))).toBe(
      'us_full',
    );
  });

  it('spells the month the way the control spells it', () => {
    const named = field({
      label: 'Graduation Month',
      fieldType: 'select',
      options: [
        { label: 'April', value: 'April' },
        { label: 'May', value: 'May' },
      ],
    });
    const numbered = field({
      label: 'Graduation Month',
      fieldType: 'select',
      options: [
        { label: '04', value: '04' },
        { label: '05', value: '05' },
      ],
    });
    expect(monthValueForField(named, '2027-05')).toBe('May');
    expect(monthValueForField(numbered, '2027-05')).toBe('05');
    expect(monthValueForField(field({ label: 'Graduation Month' }), '2027-05')).toBe('05');
    expect(yearValue('2027-05')).toBe('2027');
  });
});

describe('invalid and missing dates', () => {
  it('reads only the three shapes the profile can hold', () => {
    expect(parseStoredDate('2027-05')).toEqual({ year: '2027', month: '05' });
    expect(parseStoredDate('2027-05-15')).toEqual({ year: '2027', month: '05', day: '15' });
    expect(parseStoredDate('2027')).toEqual({ year: '2027' });
    for (const invalid of ['Spring 2027', 'n/a', '', 'May 2027', '2027-13', 'today']) {
      expect(parseStoredDate(invalid), invalid).toBeNull();
    }
  });

  it('requires confirmation rather than inventing a day', () => {
    const target = field({ label: 'Degree Completion Date', fieldType: 'date' });
    const outcome = formatDateForField(target, '2027-05');
    expect(outcome.kind).toBe('confirmation_required');
    expect(outcome.kind === 'confirmation_required' ? outcome.reason : '').toContain(
      'never chosen for you',
    );
  });

  it('requires confirmation for an unparsable saved date, with a sanitized reason', () => {
    const target = field({ label: 'Graduation Date', placeholder: 'MM/YYYY' });
    const outcome = formatDateForField(target, 'Spring 2027');
    expect(outcome.kind).toBe('confirmation_required');
    const reason = outcome.kind === 'confirmation_required' ? outcome.reason : '';
    expect(reason).toContain('not a date this build can read');
    expect(reason).not.toContain('Spring 2027');
  });

  it('requires confirmation for a missing date', () => {
    const target = field({ label: 'Graduation Date', placeholder: 'MM/YYYY' });
    expect(formatDateForField(target, undefined).kind).toBe('confirmation_required');
  });

  it('leaves a graduation control unanswered rather than filled, when a day is demanded', () => {
    const match = valueFor(field({ label: 'Degree Completion Date', fieldType: 'date' }));
    expect(match.matched).toBe(false);
    expect(match.requiresReview).toBe(true);
    expect(match.reason).toContain('never chosen for you');
  });
});

describe('no current-date fallback survives', () => {
  /**
   * The failure, stated as a test: with the clock at a known moment, no
   * formatter, matcher or resolver may produce that moment as a value.
   */
  const TODAY = '2026-08-06';

  it('never formats a value equal to today', () => {
    for (const shape of [
      { fieldType: 'date' as const },
      { fieldType: 'month' as const },
      { placeholder: 'MM/DD/YYYY' },
      { placeholder: 'Month YYYY' },
      {},
    ]) {
      for (const stored of [undefined, '', 'n/a', 'Spring 2027']) {
        const outcome = formatDateForField(field({ label: 'Graduation Date', ...shape }), stored);
        expect(outcome.kind).toBe('confirmation_required');
      }
    }
    expect(TODAY).toBe('2026-08-06');
  });

  it('leaves an unsaved internship start date to the user', () => {
    const match = valueFor(
      field({ label: 'Earliest Internship Start Date', fieldType: 'date' }),
      withoutStartDate(),
    );
    expect(match.matched).toBe(false);
    expect(match.requiresReview).toBe(true);
    expect(match.reason).toContain('never guessed or defaulted to today');
  });

  it('never uses the graduation date to answer an availability question', () => {
    const match = valueFor(
      field({ label: 'Earliest Internship Start Date', fieldType: 'date' }),
      withoutStartDate(),
    );
    expect(match.rawValue).toBeUndefined();
  });

  it('refuses a suggested value for any date control, whatever the question is called', () => {
    const resolution = resolveUnresolvedField({
      field: field({ label: 'When would you be free to begin?', fieldType: 'date' }),
      profile: withoutStartDate(),
      answers: [],
      aiSuggestion: { value: '2026-08-06', reference: 'analysis.q1' },
    });
    expect(resolution.status).toBe('missing_information');
    expect(resolution.proposedValue).toBeUndefined();
    expect(resolution.reason).toContain('never suggested');
  });

  it('refuses to reason about a factual date question at all', () => {
    const resolution = resolveUnresolvedField({
      field: field({ label: 'Earliest Internship Start Date', fieldType: 'text' }),
      profile: withoutStartDate(),
      answers: [],
      aiSuggestion: { value: '2026-08-06', reference: 'analysis.q1' },
    });
    expect(resolution.proposedValue).toBeUndefined();
  });

  it('has no clock in the module that turns a date into a value', () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'shared',
        'logic',
        'dateValues.ts',
      ),
      'utf8',
    );
    // Comments name the failure, so only executable references are searched for.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['Date.now(', 'new Date(', 'Date.parse(']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('never formats a date through the old day-inventing path', () => {
    const target = field({ label: 'Graduation Date', fieldType: 'date' });
    // `formatValue` is what the matcher used to reach; it now delegates, and a
    // month-and-year value is returned untouched rather than given a first.
    expect(formatValue(target, '2027-05')).not.toBe('2027-05-01');
  });
});

describe('the Phase 4 fixture, scanned and planned', () => {
  async function planFixture(profile: Profile) {
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
      /<!doctype html>/i,
      '',
    );
    const scan = await scanDom(document, 'page-phase4', new AbortController().signal);
    const base = emptyApplicationScan('https://portal.example.com/apply');
    const full = { ...base, fields: scan.fields };
    return { scan, plan: buildDeterministicPlan(full, profile, []) };
  }

  function actionFor(
    plan: Awaited<ReturnType<typeof planFixture>>['plan'],
    fields: DetectedField[],
    elementId: string,
  ) {
    const target = fields.find((entry) => entry.metadata.elementId === elementId);
    expect(target, `no field scanned for #${elementId}`).toBeDefined();
    const action = plan.actions.find((entry) => entry.fieldId === target!.id);
    expect(action, `no action planned for #${elementId}`).toBeDefined();
    return action!;
  }

  it('plans every education fact from the saved record, and no date from the clock', async () => {
    const { scan, plan } = await planFixture(fixtureProfile());
    const fields = scan.fields;

    expect(actionFor(plan, fields, 'school').proposedValue).toBe('Rutgers University');
    expect(actionFor(plan, fields, 'major').proposedValue).toBe('Computer Science');
    expect(actionFor(plan, fields, 'gpa').proposedValue).toBe('3.7');
    expect(actionFor(plan, fields, 'highestDegree').matchedOption?.value).toBe('hs');
    expect(actionFor(plan, fields, 'currentDegree').matchedOption?.value).toBe('bachelors');
    expect(actionFor(plan, fields, 'gradMonth').matchedOption?.value).toBe('May');
    expect(actionFor(plan, fields, 'gradYear').matchedOption?.value).toBe('2027');
    expect(actionFor(plan, fields, 'gradDateText').proposedValue).toBe('05/2027');
    expect(actionFor(plan, fields, 'currentStudent').matchedOption?.value).toBe('yes');

    // The native date control demands a day nobody stored.
    const native = actionFor(plan, fields, 'gradDateNative');
    expect(native.proposedValue).toBeUndefined();
    expect(native.requiresReview).toBe(true);

    // The optional minor is finished work, not outstanding work.
    expect(actionFor(plan, fields, 'minor').action).toBe('skip');

    // Availability, with nothing saved behind it.
    const start = actionFor(plan, fields, 'earliestStart');
    expect(start.proposedValue).toBeUndefined();
    expect(start.requiresReview).toBe(true);

    // Nothing anywhere in the plan is today's date, in any shape.
    const values = plan.actions
      .map((action) => JSON.stringify(action.proposedValue ?? ''))
      .join(' ');
    for (const shape of ['2026-08-06', '08/06/2026', 'August 2026', '2026-08']) {
      expect(values, shape).not.toContain(shape);
    }
  });

  it('fills the graduation date from the stored value when a day is not demanded', async () => {
    const { scan, plan } = await planFixture(applicant());
    expect(actionFor(plan, scan.fields, 'gradDateText').proposedValue).toBe('05/2027');
  });
});
