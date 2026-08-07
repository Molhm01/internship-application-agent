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
 * The live application that regressed, reproduced control by control and driven
 * through the real pipeline.
 *
 * Every assertion is about what the employer's form actually holds when the run
 * stops, or about the outcome the run recorded for a control it deliberately did
 * not touch. Those two are the whole subject: the live failures were a form that
 * stayed at "No Selection" while the report said work had failed, and — worse —
 * a form that stated things about the applicant that nobody had said.
 *
 * No model is involved anywhere here. `analyze` is not supplied, so a run that
 * needed one would show up as an unanswered field rather than passing quietly.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'lincoln-application.html',
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
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
      return { scan: icimsScan(fields) };
    },
    plan: async () => {
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
      current = buildDeterministicPlan(icimsScan(fields), profile, []);
      return { plan: current };
    },
    // Counted, never satisfied. If any of these fields needed a model to be
    // answered, this test would say so instead of quietly passing.
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
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
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
    buildId: 'lincoln-fixture',
    onTrace: (produced) => {
      trace = produced;
    },
    now: () => new Date().toISOString(),
  });

  return { report, trace, analyses };
}

function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
    ? element.value
    : '';
}

/** The final status the run recorded for the control with this label. */
function statusOf(harness: Harness, label: RegExp): string | undefined {
  return harness.trace?.fields.find((entry) => label.test(entry.label))?.finalStatus;
}

let base: Harness;

beforeAll(async () => {
  vi.useRealTimers();
  base = await runAgainstFixture(applicant());
}, 180_000);

describe('profile', () => {
  it('keeps the text fields that already worked', () => {
    expect(value('firstName')).toBe('Robin');
    expect(value('lastName')).toBe('Vale');
    expect(value('email')).toBe('robin.vale@example.com');
    expect(value('addressLine1')).toBe('48 Maple Avenue');
    expect(value('city')).toBe('Clifton');
    expect(value('postalCode')).toBe('07011');
    expect(value('country')).toBe('US');
  });

  it('fills State from the list the page produced after Country', () => {
    // The reported failure: Country became United States and State stayed at
    // "No Selection", because the control the page rebuilt was a different
    // element from the one the first scan recorded.
    expect(value('state')).toBe('NJ');
  });
});

describe('company-specific questions nobody can answer', () => {
  const unanswerable: ReadonlyArray<[string, RegExp]> = [
    ['priorEmployment', /ever worked for/i],
    ['employmentRestriction', /employment restriction/i],
    ['relativesEmployed', /relatives or household members/i],
  ];

  for (const [id, label] of unanswerable) {
    it(`leaves "${id}" for the applicant instead of failing`, () => {
      expect(value(id)).toBe('');
      // The whole distinction: nothing is stored, so this is the user's to
      // answer. It is not a write the page rejected.
      expect(statusOf(base, label)).toBe('USER_CONFIRMATION_REQUIRED');
    });
  }

  it('never answers prior employment from an unrelated employment fact', () => {
    // The live run answered "have you ever worked for this company" from
    // `experience[0].current === false` — asserting to an employer that the
    // applicant had never worked there, on the strength of nobody having asked.
    expect(value('priorEmployment')).not.toBe('no');
    expect(value('priorEmployment')).not.toBe('yes');
  });
});

describe('conditional children', () => {
  it('leaves the relatives detail box untouched while its parent is unanswered', () => {
    // The worst thing the live run did: it typed the applicant's own name here,
    // because the label contains the word "name", while the question above it
    // had no answer at all.
    expect(value('relativeDetails')).toBe('');
  });

  it('does not report an inactive conditional child as a failure', () => {
    expect(statusOf(base, /provide the name, location/i)).not.toBe('FAILED_EXECUTION');
  });

  it('refuses the write at the executor even when handed an approved action', async () => {
    // The runtime assertion, exercised directly: the planner is not trusted to
    // be the only thing standing between an unanswered parent and a filled
    // child.
    const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
    const child = fields.find((field) => /provide the name, location/i.test(field.label));
    expect(child?.dependsOn).toBeDefined();

    const outcome = await executeDomAction(
      document,
      child!,
      {
        id: 'action-forced',
        fieldId: child!.id,
        question: child!.question,
        fieldType: child!.fieldType,
        action: 'fill_text',
        proposedValue: 'Someone Else',
        source: 'profile',
        confidence: 1,
        sensitive: false,
        requiresReview: false,
        approved: true,
        reason: 'forced',
        warnings: [],
      },
      new AbortController().signal,
      [],
    );

    expect(outcome.status).toBe('needs_review');
    expect(outcome.error?.code).toBe('PARENT_ANSWER_REQUIRED');
    expect(value('relativeDetails')).toBe('');
  });
});

describe('work experience', () => {
  it('fills the block that has a saved record', () => {
    expect(value('employer0')).toBe('Northwind Robotics');
    expect(value('title0')).toBe('Engineering Intern');
  });

  it('fills both saved dates, and invents neither', () => {
    expect(value('from0')).toBe('2026-06');
    expect(value('to0')).toBe('2026-08');
  });

  it('leaves the blocks with no saved record completely untouched', () => {
    // The live form carried three employer blocks and one saved job. Every one
    // of these used to be filled from that same job.
    for (const id of [
      'employer1',
      'title1',
      'from1',
      'to1',
      'employer2',
      'title2',
      'from2',
      'to2',
    ]) {
      expect(value(id)).toBe('');
    }
  });

  it('numbers the repeated blocks, and records each one separately', () => {
    const employers = (base.trace?.fields ?? [])
      .filter((entry) => entry.intent === 'employer')
      .map((entry) => entry.recordIndex);
    // Three blocks, three distinct indices. This is what makes "one employer
    // filled into three blocks" distinguishable from "three employers filled".
    expect(employers).toEqual([undefined, 1, 2]);
  });

  it('counts an empty extra block as deliberately blank, not as outstanding work', () => {
    const extras = (base.trace?.fields ?? []).filter(
      (entry) => entry.recordIndex !== undefined && entry.intent === 'employer',
    );
    expect(extras).not.toEqual([]);
    for (const entry of extras) {
      expect(entry.finalStatus).toBe('OPTIONAL_LEFT_BLANK');
    }
  });

  it('leaves Employment Type and Reason for Leaving to the applicant when nothing is saved', () => {
    expect(value('employmentType0')).toBe('');
    expect(value('reason0')).toBe('');
    expect(statusOf(base, /^Employment Type$/)).toBe('USER_CONFIRMATION_REQUIRED');
    expect(statusOf(base, /^Reason for Leaving$/)).toBe('USER_CONFIRMATION_REQUIRED');
  });

  it('never infers an employment type from the company name', async () => {
    const freelance = await runAgainstFixture(
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
    expect(value('employer0')).toBe('Freelance');
    // "Freelance" as an employer is not a statement about how the work was
    // classified, and the form offers Self-Employed and Contract separately.
    expect(value('employmentType0')).toBe('');
    expect(statusOf(freelance, /^Employment Type$/)).toBe('USER_CONFIRMATION_REQUIRED');
  });
});

describe('work experience with the facts saved', () => {
  it('selects the saved employment type and reason for leaving', async () => {
    await runAgainstFixture(
      applicant({
        experience: [
          {
            id: 'experience-1',
            employer: 'Northwind Robotics',
            title: 'Engineering Intern',
            startDate: '2026-06',
            endDate: '2026-08',
            current: false,
            employmentType: 'Internship',
            reasonForLeaving: 'Returned to school',
            responsibilities: [],
            achievements: [],
          },
        ],
      }),
    );

    expect(value('employmentType0')).toBe('intern');
    expect(value('reason0')).toBe('school');
  });
});

describe('education', () => {
  it('selects the education type from the saved record', () => {
    expect(value('educationType')).toBe('college');
  });

  it('selects the education country', () => {
    expect(value('educationCountry')).toBe('US');
  });

  it('selects the education state from the list that country produced', () => {
    expect(value('educationState')).toBe('NJ');
  });

  it('answers Graduated? No for a degree still in progress', () => {
    expect(value('graduated')).toBe('no');
  });

  it('answers Graduated? Yes for a completed degree', async () => {
    await runAgainstFixture(
      applicant({
        education: [
          {
            id: 'education-1',
            institution: 'Rutgers University',
            degree: "Bachelor's Degree",
            major: 'Computer Science',
            graduationDate: '2025-05',
            status: 'completed',
            coursework: [],
            honors: [],
            activities: [],
          },
        ],
      }),
    );
    expect(value('graduated')).toBe('yes');
  });
});

describe('the school dropdown and its Other box', () => {
  it('selects the exact school when the list offers it, and leaves Other blank', () => {
    expect(value('school')).toBe('rutgers');
    expect(value('schoolOther')).toBe('');
  });

  it('selects Other first, then fills the free-text box', async () => {
    await runAgainstFixture(
      applicant({
        education: [
          {
            id: 'education-1',
            institution: 'New Jersey Institute of Technology',
            degree: "Bachelor's Degree",
            major: 'Computer Science',
            graduationDate: '2027-05',
            status: 'in_progress',
            coursework: [],
            honors: [],
            activities: [],
          },
        ],
      }),
    );

    // Both halves, and in this order. The live run filled the free-text box
    // while the dropdown above it still said "No Selection", which the employer
    // reads as no school named at all.
    expect(value('school')).toBe('other');
    expect(value('schoolOther')).toBe('New Jersey Institute of Technology');
  });
});

describe('the area-of-study dropdown and its Other box', () => {
  it('selects Other, then fills the free-text box, for a subject the form omits', () => {
    expect(value('areaOfStudy')).toBe('other');
    expect(value('areaOfStudyOther')).toBe('Computer Science');
  });

  it('selects the exact subject when the list offers it', async () => {
    await runAgainstFixture(
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
    expect(value('areaOfStudy')).toBe('nursing');
    expect(value('areaOfStudyOther')).toBe('');
  });
});

describe('the run as a whole', () => {
  it('answers all of this without a model', () => {
    // The batched analysis is *offered* whatever is left — the company-specific
    // questions, which no analysis can answer either — and it returns `ran:
    // false` here, so no request is made and no answer comes from one. Every
    // field this test asserts on was settled deterministically.
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

  it('does not stop at the first field it cannot answer', () => {
    // `priorEmployment` sits above the whole education section and is
    // unanswerable. If one such field could stop a pass, none of this would be
    // filled.
    expect(value('educationCountry')).toBe('US');
    expect(value('graduated')).toBe('no');
  });

  it('never clicks submit', () => {
    expect(document.body.getAttribute('data-submitted')).toBeNull();
  });
});
