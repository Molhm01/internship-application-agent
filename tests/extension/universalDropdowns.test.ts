import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Every dropdown shape, driven through the real pipeline.
 *
 * Not the engine directly: the scanner, the planner, the approval policy, the
 * executor, the verifier and the orchestrator, in the order the worker runs
 * them. Calling the engine straight would prove the engine works and say
 * nothing about whether a field on a page reaches it — which was the actual
 * failure, and is exactly what a helper-level test cannot see.
 *
 * The assertions are about observed DOM state afterwards. A result object
 * claiming success over an untouched control is the bug being pinned.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'universal-dropdowns.html',
);

/**
 * jsdom reports a zero-size rect for every element, so the layout-based
 * visibility checks that keep a hidden option from being selected would reject
 * the whole page. Stubbing the rect models a laid-out browser; nothing under
 * test is changed by it.
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

function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      email: 'robin.vale@example.com',
      phone: '+1 201 555 0134',
      phoneType: 'mobile',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
  });
}

interface Harness {
  report: ApplicationAutofillReport;
  document: Document;
}

async function runAgainstFixture(profile = applicant()): Promise<Harness> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  // jsdom does not run the fixture's inline script when innerHTML is assigned,
  // so it is executed here — the page's own behaviour, not a substitute for it.
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }

  let current: DeterministicFillPlan | null = null;
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
    approve: (decisions) => {
      if (!current) return Promise.resolve({});
      let next = current;
      for (const [actionId, approved] of decisions)
        next = setActionApproval(next, actionId, approved);
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
          startedAt: '2026-08-06T09:00:00.000Z',
          completedAt: '2026-08-06T09:00:01.000Z',
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
    // The real dependent-options wait, so the Country → State cascade is
    // bridged by an observation rather than by a sleep.
    awaitDependentOptions: (selectors) => awaitDependentOptions(document, selectors, 2000),
    buildId: 'fixture-build',
    onTrace: (produced) => {
      trace = produced;
    },
    now: () => new Date().toISOString(),
  });

  return { report, document };
}

function selectValue(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement || element instanceof HTMLInputElement
    ? element.value
    : '';
}

function displayed(id: string): string {
  const root = document.getElementById(id);
  const label = root?.querySelector('[data-selected-label],.value,.singleValue');
  return (label?.textContent ?? '').trim();
}

/** The single record the run produced for one control. */
function outcomeFor(report: ApplicationAutofillReport, question: RegExp): string | undefined {
  return report.fieldOutcomes?.find((entry) => question.test(entry.label))?.status;
}

let harness: Harness;
let trace: RunTrace | undefined;

beforeEach(async () => {
  vi.useRealTimers();
  harness = await runAgainstFixture();
}, 120_000);

describe('native selects', () => {
  it('selects the country', () => {
    expect(selectValue('country')).toBe('US');
  });

  it('fills the state from the list the page produced after the country', () => {
    // The canonical acceptance case. The control the run finishes against is a
    // different element from the one the first scan saw.
    expect(selectValue('state')).toBe('NJ');
  });
});

describe('custom dropdowns', () => {
  it('drives an ARIA combobox whose listbox is rendered on open', () => {
    expect(displayed('phoneType')).toBe('Cell');
  });

  it('drives a React-style controlled dropdown', () => {
    expect(displayed('educationType')).not.toBe('');
  });

  it('drives a menu mounted into a portal', () => {
    expect(displayed('educationCountry')).toBe('United States of America');
  });

  it('drives the portal-rendered control that depends on the one above it', () => {
    expect(displayed('educationState')).toBe('New Jersey');
  });

  it('drives a searchable list that renders only what the query matches', () => {
    expect(selectValue('school')).toBe('Rutgers University');
  });

  it('discovers a lazily-mounted control instead of dropping it as an accordion', () => {
    // Its options do not exist until it opens, so the scanner used to classify
    // the trigger as a disclosure and leave the question out of the run
    // entirely — not failed, not outstanding, simply absent from the report
    // while sitting unanswered on the page.
    //
    // It is now discovered, opened, and its two lazily-mounted choices are
    // read. What it is *offered* is wrong — the intent mapping reads
    // "Graduated?" as the graduation date and hands a date to a Yes/No control
    // — and the engine's job is to refuse that rather than force something
    // through, which is what `OPTION_NOT_FOUND` over two discovered options
    // records. The intent mapping is education-phase work and is deliberately
    // untouched here.
    const record = trace?.fields.find((entry) => /graduated/i.test(entry.label));
    expect(record?.dropdown).toMatchObject({
      kind: 'aria_combobox',
      optionCount: 2,
      failureCode: 'OPTION_NOT_FOUND',
    });
    expect(displayed('graduated')).toBe('');
  });
});

describe('answers nobody has', () => {
  const unanswerable: ReadonlyArray<[string, RegExp]> = [
    ['employmentType', /employment type/i],
    ['reasonForLeaving', /reason for leaving/i],
    ['relativesEmployed', /relatives employed/i],
  ];

  for (const [id, question] of unanswerable) {
    it(`leaves "${id}" for the user rather than guessing`, () => {
      expect(selectValue(id)).toBe('');
      // The whole point of the split: unknown is the user's, not a failure.
      expect(outcomeFor(harness.report, question)).not.toBe('FAILED_EXECUTION');
    });
  }

  it('never infers a fictional sensitive answer', () => {
    expect(selectValue('fixtureHouse')).toBe('');
    expect(outcomeFor(harness.report, /fictional house/i)).not.toBe('FAILED_EXECUTION');
  });
});

describe('a known answer the list does not offer', () => {
  it('leaves the control alone and does not substitute a country', () => {
    expect(selectValue('birthCountry')).toBe('');
  });
});

describe('failure isolation', () => {
  it('fills the controls after an unanswerable one', () => {
    // `employmentType` sits above these and resolves to nothing. If one
    // unanswered control could stop the pass, they would all be empty.
    expect(selectValue('country')).toBe('US');
    expect(selectValue('school')).toBe('Rutgers University');
  });

  it('leaves no field in a temporary status', () => {
    const temporary = (harness.report.fieldOutcomes ?? []).filter((entry) =>
      entry.status.startsWith('PENDING_'),
    );
    expect(temporary).toEqual([]);
  });
});

describe('the diagnostic trace', () => {
  it('records the widget shape and the option count, and no answer', () => {
    const country = trace?.fields.find((entry) => /^Country \*/.test(entry.label));
    expect(country?.dropdown).toMatchObject({
      kind: 'native_select',
      matchMethod: 'literal',
    });
    expect(country?.dropdown?.optionCount).toBeGreaterThan(0);
    expect(country?.finalStatus).toBe('FILLED_VERIFIED');
  });

  it('names the stage a dropdown stopped at rather than a bare failure', () => {
    const birth = trace?.fields.find((entry) => /country of birth/i.test(entry.label));
    expect(birth?.dropdown?.failureCode).toBe('OPTION_NOT_FOUND');
  });

  it('carries no answer anywhere in it', () => {
    // The trace is a document people paste into bug reports. Nothing the
    // applicant answered may be in it, and the schema is what enforces that.
    const serialized = JSON.stringify(trace);
    for (const secret of ['Robin', 'Vale', 'robin.vale@example.com', '48 Maple Avenue', '07011']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('the application is never submitted', () => {
  it('does not click the submit button', () => {
    // The fixture's submit handler records the fact where a test can see it, so
    // this is evidence about the page rather than about a flag the run sets.
    expect(document.body.getAttribute('data-submitted')).toBeNull();
  });
});
