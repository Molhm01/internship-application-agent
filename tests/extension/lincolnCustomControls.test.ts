import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  profileSchema,
  type ApplicationAutofillReport,
  type DeterministicFillPlan,
  type FillRunReport,
  type Profile,
  type RunTrace,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  setActionApproval,
} from '../../extension/src/planner/deterministicPlanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import { runApplicationAutofill } from '../../extension/src/autofill/orchestrator.js';
import { awaitDependentOptions } from '../../extension/src/content/dependentOptions.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The same application as `lincolnApplication.test.ts`, on the control types the
 * live portal actually renders.
 *
 * That suite proves the *decisions*: State follows Country, a conditional child
 * stays blank until its parent activates it, Education Type is read off the
 * saved record. It proves them over native `<select>` elements, which the
 * executor drives synchronously — nothing to open, no list to wait for, no
 * trigger text to re-read.
 *
 * The live "Autofill failed" badges were on the other kind. So every option
 * control here is a custom widget: ARIA comboboxes that render their list on
 * open, menus mounted into a portal, a React-style control that replaces its own
 * trigger text, a searchable list that exists only once queried, and a list
 * whose options arrive a frame late. The dependency chain runs three deep —
 * Education Country produces Education State, which produces the School list.
 *
 * No model is involved. `analyze` is counted and never satisfied, so a field
 * that needed one would show up as unanswered rather than passing quietly.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'lincoln-custom-controls.html',
);

/**
 * jsdom reports a zero-size rect for every element, so the layout-based
 * visibility checks would reject the whole page. Stubbing it models a laid-out
 * browser; nothing under test changes.
 */
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 160,
    height: 32,
    top: 0,
    left: 0,
    right: 160,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

/** One job, one in-progress degree — the shape the live profile had. */
function applicant(overrides: Partial<Profile> = {}): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      email: 'robin.vale@example.com',
      phone: '+1 201 555 0134',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
    experience: [
      {
        id: 'experience-1',
        employer: 'Northwind Robotics',
        title: 'Engineering Intern',
        location: 'Newark, New Jersey',
        startDate: '2026-06',
        endDate: '2026-08',
        current: false,
        employmentType: 'Internship',
        reasonForLeaving: 'Returned to school',
        responsibilities: [],
        achievements: [],
      },
    ],
    education: [
      {
        id: 'education-1',
        institution: 'Rutgers University',
        degree: "Bachelor's Degree",
        major: 'Computer Science',
        graduationDate: '2027-05',
        status: 'in_progress',
        coursework: [],
        honors: [],
        activities: [],
      },
    ],
    ...overrides,
  });
}

interface Harness {
  report: ApplicationAutofillReport;
  trace: RunTrace | undefined;
  analyses: number;
}

async function runAgainstFixture(profile: Profile): Promise<Harness> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  // jsdom does not execute inline scripts assigned through innerHTML, so the
  // fixture's own behaviour is re-attached here rather than simulated.
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }

  let current: DeterministicFillPlan | null = null;
  let trace: RunTrace | undefined;
  let analyses = 0;

  const report = await runApplicationAutofill({
    loadSettings: () =>
      Promise.resolve({ ...DEFAULT_AUTOFILL_SETTINGS, applicationAutofillEnabled: true }),
    scan: async () => {
      const { fields } = await scanDom(document, 'page-custom', new AbortController().signal);
      return { scan: icimsScan(fields) };
    },
    plan: async () => {
      const { fields } = await scanDom(document, 'page-custom', new AbortController().signal);
      current = buildDeterministicPlan(icimsScan(fields), profile, []);
      return { plan: current };
    },
    analyze: () => {
      analyses += 1;
      return Promise.resolve({ ran: false });
    },
    approve: (decisions) => {
      if (!current) return Promise.resolve({});
      let next = current;
      for (const [actionId, approved] of decisions) {
        next = setActionApproval(next, actionId, approved);
      }
      current = next;
      return Promise.resolve({});
    },
    execute: async () => {
      const plan = current;
      if (!plan) return {};
      const { fields } = await scanDom(document, 'page-custom', new AbortController().signal);
      const byId = new Map(fields.map((entry) => [entry.id, entry]));
      const results: FillRunReport['results'] = [];
      for (const action of plan.actions) {
        if (!action.approved) continue;
        const field = byId.get(action.fieldId);
        if (!field) continue;
        results.push(
          await executeDomAction(document, field, action, new AbortController().signal, []),
        );
      }
      return {
        report: {
          id: 'fill-1',
          planId: plan.id,
          startedAt: '2026-08-07T09:00:00.000Z',
          completedAt: '2026-08-07T09:00:01.000Z',
          url: plan.url,
          results,
          statistics: {
            attempted: results.length,
            verified: results.filter((entry) => entry.status === 'verified').length,
            failed: results.filter((entry) => entry.status === 'failed').length,
            cancelled: 0,
          },
          submitted: false as const,
          warnings: [],
        } as unknown as FillRunReport,
      };
    },
    highlight: () => Promise.resolve({}),
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    awaitDependentOptions: (selectors) => awaitDependentOptions(document, selectors, 2000),
    buildId: 'lincoln-custom-fixture',
    onTrace: (produced) => {
      trace = produced;
    },
    now: () => new Date().toISOString(),
  });

  return { report, trace, analyses };
}

/** What a typed control holds. */
function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
    ? element.value
    : '';
}

/**
 * What a custom control *displays*.
 *
 * The whole reason this fixture exists: a widget of this shape holds no value at
 * all, so the only evidence it was filled is the text its trigger now shows —
 * which is also the only evidence the employer's own page has.
 */
function displayed(id: string): string {
  const root = document.getElementById(id);
  const label = root?.querySelector('[data-selected-label], .singleValue, .value');
  return (label?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The final status the run recorded for the control with this label. */
function statusOf(harness: Harness, label: RegExp): string | undefined {
  return harness.trace?.fields.find((entry) => label.test(entry.label))?.finalStatus;
}

/** The mark the run left on the control with this label. */
function annotationOf(harness: Harness, label: RegExp): string | undefined {
  return harness.trace?.fields.find((entry) => label.test(entry.label))?.annotation;
}

let base: Harness;

beforeAll(async () => {
  vi.useRealTimers();
  base = await runAgainstFixture(applicant());
}, 180_000);

describe('the text fields that already worked', () => {
  it('keeps filling them', () => {
    expect(value('firstName')).toBe('Robin');
    expect(value('lastName')).toBe('Vale');
    expect(value('email')).toBe('robin.vale@example.com');
    expect(value('addressLine1')).toBe('48 Maple Avenue');
    expect(value('city')).toBe('Clifton');
    expect(value('postalCode')).toBe('07011');
  });
});

describe('Country and its dependent State, both custom controls', () => {
  it('selects the country by opening the list and clicking the real option', () => {
    expect(displayed('country')).toBe('United States of America');
    expect(statusOf(base, /^Country/)).toBe('FILLED_VERIFIED');
  });

  it('selects the state from the list the country produced', () => {
    // The reported live failure, on the control shape it actually failed on:
    // the State menu does not exist until Country has settled, and its contents
    // are decided by what Country settled on.
    expect(displayed('state')).toBe('New Jersey');
    expect(statusOf(base, /State\/Province/)).toBe('FILLED_VERIFIED');
  });

  it('leaves no successful control wearing a failure mark', () => {
    expect(annotationOf(base, /^Country/)).toBe('verified');
    expect(annotationOf(base, /State\/Province/)).toBe('verified');
  });
});

describe('company-specific questions on custom controls', () => {
  const unanswerable: ReadonlyArray<[string, RegExp]> = [
    ['priorEmployment', /ever worked for/i],
    ['employmentRestriction', /employment restriction/i],
    ['relativesEmployed', /relatives or household members/i],
  ];

  for (const [id, label] of unanswerable) {
    it(`leaves "${id}" for the applicant instead of guessing`, () => {
      expect(displayed(id)).toBe('');
      expect(statusOf(base, label)).toBe('USER_CONFIRMATION_REQUIRED');
    });
  }
});

describe('the conditional child of a custom parent', () => {
  it('stays blank while its parent is unanswered', () => {
    expect(value('relativeDetails')).toBe('');
  });

  it('never receives the applicant’s own legal name', () => {
    expect(value('relativeDetails')).not.toContain('Robin');
    expect(value('relativeDetails')).not.toContain('Vale');
  });

  it('is not reported as a failed write', () => {
    expect(statusOf(base, /provide the name, location/i)).not.toBe('FAILED_EXECUTION');
  });
});

describe('work experience on custom controls', () => {
  it('fills the text and date fields', () => {
    expect(value('employer0')).toBe('Northwind Robotics');
    expect(value('title0')).toBe('Engineering Intern');
    expect(value('from0')).toBe('2026-06');
    expect(value('to0')).toBe('2026-08');
  });

  it('selects the saved employment type through the control’s own menu', () => {
    expect(displayed('employmentType0')).toBe('Internship');
    expect(statusOf(base, /^Employment Type$/)).toBe('FILLED_VERIFIED');
  });

  it('selects the saved reason for leaving', () => {
    expect(displayed('reason0')).toBe('Returned to school');
    expect(statusOf(base, /^Reason for Leaving$/)).toBe('FILLED_VERIFIED');
  });

  it('asks rather than guessing when neither fact is saved', async () => {
    const bare = await runAgainstFixture(
      applicant({
        experience: [
          {
            id: 'experience-1',
            employer: 'Freelance',
            title: 'PC Builder and Repair Technician',
            current: false,
            responsibilities: [],
            achievements: [],
          },
        ],
      }),
    );
    // "Freelance" as an employer is not a statement about how the work was
    // classified, and this list offers Self-Employed and Contract separately.
    expect(displayed('employmentType0')).toBe('');
    expect(displayed('reason0')).toBe('');
    expect(statusOf(bare, /^Employment Type$/)).toBe('USER_CONFIRMATION_REQUIRED');
    expect(statusOf(bare, /^Reason for Leaving$/)).toBe('USER_CONFIRMATION_REQUIRED');
  }, 120_000);

  it('leaves the end date of a current role correctly blank, and never dates it today', async () => {
    const current = await runAgainstFixture(
      applicant({
        experience: [
          {
            id: 'experience-1',
            employer: 'Northwind Robotics',
            title: 'Engineering Intern',
            startDate: '2026-06',
            current: true,
            responsibilities: [],
            achievements: [],
          },
        ],
      }),
    );
    expect(value('from0')).toBe('2026-06');
    expect(value('to0')).toBe('');
    // The form's own mechanism for "still here" is used instead.
    expect((document.getElementById('currentlyEmployed0') as HTMLInputElement).checked).toBe(true);
    // And the empty End Date is finished work, not an orange badge asking the
    // applicant to contradict what they just told the form.
    expect(statusOf(current, /^End Date$/)).toBe('OPTIONAL_LEFT_BLANK');
    expect(annotationOf(current, /^End Date$/)).toBe('optional_blank');
  }, 120_000);
});

describe('the education dependency chain, three controls deep', () => {
  it('selects an Education Type in the list’s own vocabulary', () => {
    // The saved record says "Bachelor's Degree" and this list names programmes.
    // A value answering "College/University" matches nothing here, which is
    // exactly what left the live control at No Selection.
    expect(displayed('educationType')).toBe("Bachelor's Degree Program (or equivalent)");
    expect(statusOf(base, /^Education Type/)).toBe('FILLED_VERIFIED');
  });

  it('selects the education country', () => {
    expect(displayed('educationCountry')).toBe('United States of America');
  });

  it('selects the education state from the list that country produced', () => {
    expect(displayed('educationState')).toBe('New Jersey');
  });

  it('selects the school from the list that state produced', () => {
    // The school list is empty for every query until a state is settled, so
    // this passing means the three controls ran in the right order.
    expect(value('school')).toBe('Rutgers University');
    expect(statusOf(base, /School\/Institution Name \*/)).toBe('FILLED_VERIFIED');
  });

  it('answers Graduated? No for a degree still in progress', () => {
    expect(displayed('graduated')).toBe('No');
  });

  it('answers Graduated? Yes for a completed degree', async () => {
    await runAgainstFixture(
      applicant({
        education: [
          {
            id: 'education-1',
            institution: 'Rutgers University',
            degree: "Bachelor's Degree",
            major: 'Nursing',
            graduationDate: '2025-05',
            status: 'completed',
            coursework: [],
            honors: [],
            activities: [],
          },
        ],
      }),
    );
    expect(displayed('graduated')).toBe('Yes');
  }, 120_000);
});

describe('the "If other" boxes', () => {
  it('leaves the school box blank, and unmarked, when the school was found', () => {
    expect(value('schoolOther')).toBe('');
    // The repair: this used to wear an orange "Information needed" badge beside
    // a School control that had already been filled correctly.
    expect(statusOf(base, /If other, enter School/i)).toBe('OPTIONAL_LEFT_BLANK');
    expect(annotationOf(base, /If other, enter School/i)).toBe('optional_blank');
  });

  it('fills the area-of-study box only after Other is actually selected', async () => {
    // Its own run rather than the shared one: every case in this file drives the
    // same global document, so reading it after another case has re-run the
    // fixture asserts against that case's page.
    const unlisted = await runAgainstFixture(applicant());
    // Computer Science is not on this list, so the form's own escape hatch is
    // the honest answer — and the free-text box fills only once it is chosen.
    expect(displayed('areaOfStudy')).toBe('Other');
    expect(value('areaOfStudyOther')).toBe('Computer Science');
    expect(statusOf(unlisted, /If other, enter Area of Study/i)).toBe('FILLED_VERIFIED');
  }, 120_000);

  it('leaves the area-of-study box blank, and unmarked, when the subject was found', async () => {
    const listed = await runAgainstFixture(
      applicant({
        education: [
          {
            id: 'education-1',
            institution: 'Rutgers University',
            degree: "Bachelor's Degree",
            major: 'Nursing',
            graduationDate: '2027-05',
            status: 'in_progress',
            coursework: [],
            honors: [],
            activities: [],
          },
        ],
      }),
    );
    expect(displayed('areaOfStudy')).toBe('Nursing');
    expect(value('areaOfStudyOther')).toBe('');
    expect(statusOf(listed, /If other, enter Area of Study/i)).toBe('OPTIONAL_LEFT_BLANK');
    expect(annotationOf(listed, /If other, enter Area of Study/i)).toBe('optional_blank');
  }, 120_000);
});

describe('the run as a whole', () => {
  it('answers all of this without a model', () => {
    expect(base.trace?.aiRequests).toBe(0);
    expect(base.trace?.aiActionsReturned).toBe(0);
    expect(base.trace?.aiActionsVerified).toBe(0);
  });

  it('leaves no field in a temporary status', () => {
    const pending = (base.trace?.fields ?? []).filter((entry) =>
      entry.finalStatus.startsWith('PENDING_'),
    );
    expect(pending).toEqual([]);
  });

  it('leaves no verified field wearing a failure or information-needed mark', () => {
    const filled = (base.trace?.fields ?? []).filter(
      (entry) => entry.finalStatus === 'FILLED_VERIFIED',
    );
    expect(filled.length).toBeGreaterThan(0);
    for (const entry of filled) expect(entry.annotation).toBe('verified');
  });

  it('never clicks submit', () => {
    expect(document.body.getAttribute('data-submitted')).toBeNull();
  });
});
