import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  profileSchema,
  type ApplicationScanResult,
  type DeterministicFillPlan,
  type FillRunReport,
  type Profile,
  type RepeatedSectionKind,
  type RunTrace,
} from '@internship-agent/shared';
import { countRepeatedBlocks, scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  setActionApproval,
} from '../../extension/src/planner/deterministicPlanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import {
  runApplicationAutofill,
  type RepeatedSectionOutcome,
} from '../../extension/src/autofill/orchestrator.js';
import { awaitDependentOptions } from '../../extension/src/content/dependentOptions.js';
import { growRepeatedSection } from '../../extension/src/content/repeatedSections.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The two release-blocking shapes, driven end to end through the real pipeline.
 *
 * Long option lists whose answer sits below the fold, and repeating sections
 * that start with one block and have to be grown to hold every saved record.
 *
 * Every assertion is about what the employer's form actually holds when the run
 * stops. A report claiming three jobs were filled over a page showing one is
 * exactly the failure being pinned.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'lincoln-repeaters.html',
);

/**
 * jsdom has no layout: every rect is zero and nothing ever scrolls. The rect is
 * stubbed so the visibility checks behave as they do in a browser, and
 * `scrollHeight`/`clientHeight` are given values so a `.menu` box is genuinely
 * scrollable — otherwise the below-the-fold case could not exist here at all.
 */
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 160,
    height: 24,
    top: 0,
    left: 0,
    right: 160,
    bottom: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

/** Three jobs, two schools, two projects. */
function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      email: 'robin.vale@example.com',
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
        startDate: '2026-06',
        endDate: '2026-08',
        current: false,
        employmentType: 'Internship',
        reasonForLeaving: 'Returned to school',
        responsibilities: [],
        achievements: [],
      },
      {
        id: 'experience-2',
        employer: 'Emberfell Systems',
        title: 'Lab Assistant',
        startDate: '2025-09',
        endDate: '2026-05',
        current: false,
        responsibilities: [],
        achievements: [],
      },
      {
        id: 'experience-3',
        employer: 'Tidewatch Repair',
        title: 'PC Technician',
        startDate: '2024-06',
        endDate: '2025-08',
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
        major: 'Electrical Engineering',
        graduationDate: '2027-05',
        status: 'in_progress',
        coursework: [],
        honors: [],
        activities: [],
      },
      {
        id: 'education-2',
        institution: 'Clifton Technical High School',
        degree: 'High School Diploma',
        major: 'General Studies',
        graduationDate: '2023-06',
        status: 'completed',
        coursework: [],
        honors: [],
        activities: [],
      },
    ],
    projects: [
      {
        id: 'project-1',
        name: 'Actuator Test Rig',
        description: 'A bench rig for repeatable actuator measurements.',
        technologies: ['Python'],
        url: 'https://example.com/rig',
        accomplishments: [],
      },
      {
        id: 'project-2',
        name: 'Signal Plotter',
        description: 'A plotting tool for lab signal captures.',
        technologies: ['TypeScript'],
        url: 'https://example.com/plotter',
        accomplishments: [],
      },
    ],
  });
}

interface Harness {
  trace: RunTrace | undefined;
  repeats: RepeatedSectionOutcome[];
  aiRequests: number;
}

async function runAgainstFixture(profile: Profile): Promise<Harness> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }

  let current: DeterministicFillPlan | null = null;
  let trace: RunTrace | undefined;
  let repeats: RepeatedSectionOutcome[] = [];

  await runApplicationAutofill({
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
    // Offered whatever is left and never satisfied, so nothing here can pass by
    // way of a model.
    analyze: () => Promise.resolve({ ran: false }),
    growRepeatedSections: async (_scan: ApplicationScanResult) => {
      const counts: Record<RepeatedSectionKind, number> = {
        experience: profile.experience.length,
        education: profile.education.length,
        projects: profile.projects.length,
      };
      const outcomes: RepeatedSectionOutcome[] = [];
      for (const kind of ['experience', 'education', 'projects'] as const) {
        // Counted synchronously from the live DOM, so the wait after each Add
        // press observes the block the page actually produced.
        const outcome = await growRepeatedSection({
          document,
          kind,
          recordCount: counts[kind],
          countBlocks: (which) => countRepeatedBlocks(document, which),
        });
        outcomes.push({
          kind,
          recordCount: counts[kind],
          blocksBefore: outcome.blocksBefore,
          blocksAfter: countRepeatedBlocks(document, kind),
          addPressesPerformed: outcome.addPressesPerformed,
          mappings: outcome.plan.mappings,
        });
      }
      repeats = outcomes;
      return outcomes;
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
    buildId: 'repeater-fixture',
    onTrace: (produced) => {
      trace = produced;
    },
    now: () => new Date().toISOString(),
  });

  return { trace, repeats, aiRequests: trace?.aiRequests ?? 0 };
}

function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
    ? element.value
    : '';
}

function outcomeFor(harness: Harness, kind: RepeatedSectionKind): RepeatedSectionOutcome {
  const found = harness.repeats.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no repeat outcome for ${kind}`);
  return found;
}

let base: Harness;

beforeAll(async () => {
  vi.useRealTimers();
  base = await runAgainstFixture(applicant());
}, 300_000);

describe('repeated work experience', () => {
  it('grows one block into three, pressing Add exactly twice', () => {
    const outcome = outcomeFor(base, 'experience');
    expect(outcome.recordCount).toBe(3);
    expect(outcome.blocksBefore).toBe(1);
    expect(outcome.blocksAfter).toBe(3);
    expect(outcome.addPressesPerformed).toBe(2);
  });

  it('maps each saved job to its own block, with no record used twice', () => {
    expect(value('employer0')).toBe('Northwind Robotics');
    expect(value('employer1')).toBe('Emberfell Systems');
    expect(value('employer2')).toBe('Tidewatch Repair');
    expect(value('title0')).toBe('Engineering Intern');
    expect(value('title1')).toBe('Lab Assistant');
    expect(value('title2')).toBe('PC Technician');
    expect(new Set([value('employer0'), value('employer1'), value('employer2')]).size).toBe(3);
  });

  it('uses each block’s own saved dates, and invents none', () => {
    expect(value('from0')).toBe('2026-06');
    expect(value('to0')).toBe('2026-08');
    expect(value('from1')).toBe('2025-09');
    expect(value('to1')).toBe('2026-05');
    expect(value('from2')).toBe('2024-06');
    expect(value('to2')).toBe('2025-08');
  });

  it('selects a saved employment type and reason, and leaves unsaved ones alone', () => {
    expect(value('employmentType0')).toBe('intern');
    expect(value('reason0')).toBe('school');
    // Records 2 and 3 record neither, so neither is guessed at.
    expect(value('employmentType1')).toBe('');
    expect(value('reason1')).toBe('');
  });

  it('records one mapping per saved record', () => {
    const outcome = outcomeFor(base, 'experience');
    expect(outcome.mappings.map((entry) => entry.status)).toEqual([
      'MATCHED_EXISTING_BLOCK',
      'CREATED_NEW_BLOCK',
      'CREATED_NEW_BLOCK',
    ]);
  });
});

describe('repeated education', () => {
  it('grows one block into two, pressing Add once', () => {
    const outcome = outcomeFor(base, 'education');
    expect(outcome.recordCount).toBe(2);
    expect(outcome.blocksBefore).toBe(1);
    expect(outcome.blocksAfter).toBe(2);
    expect(outcome.addPressesPerformed).toBe(1);
  });

  it('answers Education Type from each block’s own record', () => {
    // The live failure: the list names degree *programmes*, and a value naming a
    // kind of institution matched none of them.
    expect(value('educationType0')).toBe('bach');
    expect(value('educationType1')).toBe('hs');
  });

  it('answers Graduated? from each block’s own status', () => {
    expect(value('graduated0')).toBe('no');
    expect(value('graduated1')).toBe('yes');
  });

  it('does not resolve every education control from education[0]', () => {
    expect(value('educationType0')).not.toBe(value('educationType1'));
    expect(value('graduated0')).not.toBe(value('graduated1'));
  });
});

describe('repeated projects', () => {
  it('grows one block into two, pressing Add once', () => {
    const outcome = outcomeFor(base, 'projects');
    expect(outcome.recordCount).toBe(2);
    expect(outcome.blocksBefore).toBe(1);
    expect(outcome.blocksAfter).toBe(2);
    expect(outcome.addPressesPerformed).toBe(1);
  });

  it('keeps the two projects distinct', () => {
    expect(value('projectName0')).toBe('Actuator Test Rig');
    expect(value('projectName1')).toBe('Signal Plotter');
    expect(value('projectUrl0')).not.toBe(value('projectUrl1'));
  });
});

describe('long option lists', () => {
  it('selects a country from a list that needs scrolling', () => {
    expect(value('country')).toBe('US');
  });

  it('fills State from the list the country produced', () => {
    expect(value('state')).toBe('NJ');
  });

  it('selects the education country and its dependent state', () => {
    expect(value('educationCountry0')).toBe('US');
    expect(value('educationState0')).toBe('NJ');
  });

  it('finds a field of study that sits far below the initial viewport', () => {
    // "Electrical Engineering" is entry 46 of a 66-entry list, well past the
    // first screenful. It used to report OPTION_NOT_FOUND and fall through to
    // the "Other" box with the answer in hand.
    expect(value('areaOfStudy0')).toBe('electrical_engineering');
    expect(value('areaOther0')).toBe('');
  });

  it('selects the exact school when the list offers it', () => {
    expect(value('school0')).toBe('rutgers_university');
    expect(value('schoolOther0')).toBe('');
  });

  it('falls back to Other, and only then fills the free-text box', () => {
    // The second record's school is not on the list.
    expect(value('school1')).toBe('other_not_listed');
    expect(value('schoolOther1')).toBe('Clifton Technical High School');
  });
});

describe('the run as a whole', () => {
  it('needs no model for any of this', () => {
    expect(base.aiRequests).toBe(0);
    expect(base.trace?.aiActionsVerified).toBe(0);
  });

  it('leaves no field in a temporary status', () => {
    const pending = (base.trace?.fields ?? []).filter((entry) =>
      entry.finalStatus.startsWith('PENDING_'),
    );
    expect(pending).toEqual([]);
  });

  it('never clicks submit', () => {
    expect(document.body.getAttribute('data-submitted')).toBeNull();
  });
});
