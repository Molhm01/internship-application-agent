import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  describeRunTrace,
  profileSchema,
  runTraceSchema,
  traceOrigin,
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
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The run trace, produced by the real orchestrator over the real fixture.
 *
 * The question this exists to answer is the one that was unanswerable during
 * the live failure: twenty-seven fields detected and two filled looks identical
 * whether the cause was a missing profile value, a missing intent mapping, an
 * action the contract rejected, an executor never invoked, a DOM write that
 * failed, a verification that failed, an analysis that never ran, or a run that
 * ended early. Those are eight different repairs.
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

async function traceFor(): Promise<RunTrace> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  const profile = applicant();
  let current: DeterministicFillPlan | null = null;
  let captured: RunTrace | null = null;

  await runApplicationAutofill({
    buildId: 'testbuild.s3.20260805000000',
    onTrace: (trace) => {
      captured = trace;
    },
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
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  });

  if (!captured) throw new Error('the run produced no trace');
  return captured;
}

let trace: RunTrace;

beforeEach(async () => {
  trace = await traceFor();
});

describe('the run produces one trace', () => {
  it('validates against its own schema', () => {
    expect(() => runTraceSchema.parse(trace)).not.toThrow();
  });

  it('names the build it ran as', () => {
    // Attributing a report to the wrong bundle is what made three rounds of
    // repairs look ineffective.
    expect(trace.buildId).toBe('testbuild.s3.20260805000000');
  });

  it('records one entry per normalized question', () => {
    expect(trace.fields).toHaveLength(trace.normalizedQuestions);
    expect(trace.normalizedQuestions).toBeGreaterThan(10);
  });
});

describe('the trace separates detection from normalization', () => {
  it('reports more raw controls than questions, and says what was removed', () => {
    // "27 fields detected" could not distinguish 27 questions from 20 questions
    // plus 4 headings and 3 duplicates. These three numbers do.
    expect(trace.rawControls).toBeGreaterThanOrEqual(trace.normalizedQuestions);
    expect(trace.falseControlsRemoved + trace.duplicateControlsRemoved).toBeGreaterThan(0);
  });

  it('counts the required questions separately', () => {
    expect(trace.requiredQuestions).toBeGreaterThan(0);
    expect(trace.requiredQuestions).toBeLessThanOrEqual(trace.normalizedQuestions);
  });
});

describe('the trace says where each field went', () => {
  it('records a contract verdict for every field', () => {
    for (const field of trace.fields) {
      expect(['accepted', 'repaired', 'rejected', 'not_applicable']).toContain(
        field.contractResult,
      );
    }
  });

  it('never claims the executor ran on a field that was never planned', () => {
    for (const field of trace.fields) {
      if (field.executorAttempted) expect(field.plannedAction).toBeDefined();
    }
  });

  it('verifies far more than the two fields the live run managed', () => {
    expect(trace.deterministicVerified).toBeGreaterThanOrEqual(8);
  });

  it('reconciles verified fields with the executor having been invoked', () => {
    const verified = trace.fields.filter((field) => field.verification === 'verified');
    expect(verified.every((field) => field.executorAttempted)).toBe(true);
  });
});

describe('the trace carries nothing personal', () => {
  it('records an origin, never a full URL', () => {
    expect(trace.origin).toBe(traceOrigin(trace.origin));
    expect(trace.origin).not.toMatch(/\?|#/);
  });

  it('holds no value from the page or the profile anywhere in it', () => {
    const serialized = JSON.stringify(trace);
    for (const secret of [
      'Molhm',
      'Ellis',
      'molhm@example.com',
      '48 Maple Avenue',
      'Clifton',
      '07011',
    ]) {
      expect(serialized, `the trace leaked "${secret}"`).not.toContain(secret);
    }
  });

  it('is stripped by its own schema rather than by convention', () => {
    // Strict: a caller that attaches a value loses the parse, not the value.
    expect(() => runTraceSchema.parse({ ...trace, profileEmail: 'molhm@example.com' })).toThrow();
  });
});

describe('the trace explains itself', () => {
  it('names at least one cause in words', () => {
    const lines = describeRunTrace(trace);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).toMatch(/field|analysis|action/i);
  });

  it('reports at most one AI request for the page', () => {
    // One batched analysis per stable page. One call per field is what made a
    // run take minutes.
    expect(trace.aiRequests).toBeLessThanOrEqual(1);
  });
});
