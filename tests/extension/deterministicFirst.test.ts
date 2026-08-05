import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  profileSchema,
  type AutofillPhase,
  type DeterministicFillPlan,
  type FillRunReport,
  type Profile,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  setActionApproval,
} from '../../extension/src/planner/deterministicPlanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import { runApplicationAutofill } from '../../extension/src/autofill/orchestrator.js';
import { stateForPhase } from '../../extension/src/storage/runState.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The order the run works in, pinned.
 *
 * The live symptom was a form that sat visibly untouched for twenty-seven
 * seconds. The cause was not slowness: the batched model call lived *inside*
 * `plan()`, so nothing at all was written until the model answered — including
 * the dozen fields the saved profile could have filled in under a second, and
 * including the case where the model never answered, which left the page blank
 * and the run reporting eighteen unresolved questions.
 *
 * These drive the real orchestrator with an `analyze` step that is deliberately
 * slow, deliberately failing, or absent, and assert on the fixture's own DOM.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Molhm',
      legalLastName: 'Ellis',
      email: 'molhm@example.com',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
    highestCompletedDegree: 'High School',
    currentDegreeInProgress: "Bachelor's Degree",
    preferences: {},
  });
}

interface Observed {
  phases: AutofillPhase[];
  /** What the page held at the moment `analyze` was called. */
  atAnalysisTime: Record<string, string>;
  analyzeCalls: number;
}

function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element.value
    : '';
}

const WATCHED = ['firstName', 'lastName', 'email', 'city', 'postalCode', 'addressLine1'];

/**
 * Runs the orchestrator with an `analyze` step under the caller's control.
 *
 * `analyze: 'none'` omits it entirely — the no-local-model case, which must
 * still fill everything the profile answers.
 */
async function run(mode: 'ok' | 'fails' | 'none'): Promise<Observed> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  const profile = applicant();
  let current: DeterministicFillPlan | null = null;
  const observed: Observed = { phases: [], atAnalysisTime: {}, analyzeCalls: 0 };

  const analyze = (): Promise<{
    plan?: DeterministicFillPlan;
    ran: boolean;
    error?: undefined;
  }> => {
    observed.analyzeCalls += 1;
    // The page as it stands *now* — before the analysis has contributed
    // anything. Everything the profile could answer must already be here.
    for (const id of WATCHED) observed.atAnalysisTime[id] = value(id);
    if (mode === 'fails') return Promise.resolve({ ran: false });
    return Promise.resolve({ ran: true, ...(current ? { plan: current } : {}) });
  };

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
    ...(mode === 'none' ? {} : { analyze }),
    approve: (decisions) => {
      if (!current) return Promise.resolve({});
      let next = current;
      for (const [id, approved] of decisions) next = setActionApproval(next, id, approved);
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
          startedAt: '2026-08-05T09:00:00.000Z',
          completedAt: '2026-08-05T09:00:01.000Z',
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
    onProgress: (progress) => observed.phases.push(progress.phase),
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  });

  return observed;
}

describe('the saved profile is written before the model is asked anything', () => {
  it('has already filled the personal fields by the time analysis starts', async () => {
    const observed = await run('ok');
    expect(observed.analyzeCalls).toBeGreaterThan(0);
    // This is the assertion the whole restructure exists for.
    expect(observed.atAnalysisTime.firstName).toBe('Molhm');
    expect(observed.atAnalysisTime.lastName).toBe('Ellis');
    expect(observed.atAnalysisTime.email).toBe('molhm@example.com');
    expect(observed.atAnalysisTime.city).toBe('Clifton');
    expect(observed.atAnalysisTime.postalCode).toBe('07011');
    expect(observed.atAnalysisTime.addressLine1).toBe('48 Maple Avenue');
  });

  it('reports filling before it reports analyzing', async () => {
    const observed = await run('ok');
    const firstFill = observed.phases.indexOf('filling');
    const firstAnalyze = observed.phases.indexOf('analyzing');
    expect(firstFill).toBeGreaterThanOrEqual(0);
    expect(firstAnalyze).toBeGreaterThan(firstFill);
  });

  it('names the analysis as its own stage, not as "matching profile information"', async () => {
    const observed = await run('ok');
    // The popup used to show the resolving label throughout a sixty-second
    // model call, which is a truthful label for the stage and a useless one for
    // the wait.
    expect(observed.phases).toContain('analyzing');
    expect(stateForPhase('analyzing')).toBe('ANALYZING_AI');
  });
});

describe('a failed or absent analysis costs nothing already filled', () => {
  it('keeps every deterministic answer when the analysis fails', async () => {
    await run('fails');
    expect(value('firstName')).toBe('Molhm');
    expect(value('lastName')).toBe('Ellis');
    expect(value('email')).toBe('molhm@example.com');
    expect(value('country')).toBe('US');
  });

  it('fills the same fields when there is no analysis step at all', async () => {
    const observed = await run('none');
    expect(observed.analyzeCalls).toBe(0);
    expect(value('firstName')).toBe('Molhm');
    expect(value('city')).toBe('Clifton');
    expect(value('postalCode')).toBe('07011');
  });
});

describe('the run states follow the work', () => {
  it('passes through the deterministic states before the AI ones', async () => {
    const observed = await run('ok');
    const states = observed.phases.map(stateForPhase);
    const firstDeterministicFill = states.indexOf('EXECUTING_DETERMINISTIC');
    const firstAnalysis = states.indexOf('ANALYZING_AI');
    expect(firstDeterministicFill).toBeGreaterThanOrEqual(0);
    expect(firstAnalysis).toBeGreaterThan(firstDeterministicFill);
  });
});
