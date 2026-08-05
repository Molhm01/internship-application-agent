import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  pendingResults,
  profileSchema,
  questionIdentity,
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
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The acceptance gates, run once against the fixture and asserted on.
 *
 * Everything here is measured from the employer form's own DOM and from the
 * report the run produced — never from a planner called directly. The live
 * failure was a run that reported plausible-looking work over an untouched
 * page, so a plan is not evidence of anything and is not treated as evidence
 * here.
 *
 * The fixture's `Country`/`State` dependency is wired up in the same way the
 * page wires it, because jsdom does not execute scripts injected through
 * `innerHTML`. What is under test is the run coming back for State after
 * Country lands, which is the sequencing, not the listener.
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
      phone: '+1 201 555 0134',
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

/** The page's own Country → State effect, which jsdom will not run for us. */
function wireCountryToState(): void {
  const country = document.getElementById('country') as HTMLSelectElement;
  country.addEventListener('change', () => {
    const state = document.getElementById('stateProvince') as HTMLSelectElement;
    const rows =
      country.value === 'US'
        ? ([
            ['NJ', 'New Jersey'],
            ['NY', 'New York'],
            ['PA', 'Pennsylvania'],
          ] as const)
        : ([] as const);
    state.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = rows.length ? 'Please select' : 'Select a country first';
    state.append(placeholder);
    for (const [value, label] of rows) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      state.append(option);
    }
  });
}

let report: ApplicationAutofillReport;
let trace: RunTrace;
let executions: number;
let wallClockMs: number;

beforeAll(async () => {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  wireCountryToState();

  const profile = applicant();
  let current: DeterministicFillPlan | null = null;
  let captured: RunTrace | null = null;
  executions = 0;
  const started = Date.now();

  report = await runApplicationAutofill({
    buildId: 'acceptance.s3.20260805000000',
    onTrace: (value) => {
      captured = value;
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
      for (const [id, approved] of decisions) next = setActionApproval(next, id, approved);
      current = next;
      return Promise.resolve({});
    },
    execute: async () => {
      executions += 1;
      const plan = current;
      if (!plan) return {};
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
      const byId = new Map(fields.map((entry) => [entry.id, entry]));
      const results: FillRunReport['results'] = [];
      // One result per action, exactly as the content script produces them —
      // including the passive ones. An action that is not approved comes back
      // `skipped`, a `manual_review` action comes back `needs_review`. This
      // harness used to return results only for the actions it executed, which
      // is why a real run could downgrade twenty-four verified fields on the
      // following pass and this suite stayed green.
      for (const action of plan.actions) {
        const field = byId.get(action.fieldId);
        if (!field) continue;
        if (action.action === 'manual_review' || action.action === 'unsupported') {
          results.push({
            actionId: action.id,
            fieldId: action.fieldId,
            status: action.action === 'unsupported' ? 'unsupported' : 'needs_review',
            attempts: 0,
            durationMs: 0,
          });
          continue;
        }
        if (!action.approved || action.action === 'skip') {
          results.push({
            actionId: action.id,
            fieldId: action.fieldId,
            status: 'skipped',
            attempts: 0,
            durationMs: 0,
          });
          continue;
        }
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

  wallClockMs = Date.now() - started;
  if (!captured) throw new Error('the run produced no trace');
  trace = captured;
}, 60_000);

function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element.value
    : '';
}

describe('GATE B — the fixture DOM after one click', () => {
  it.each([
    ['firstName', 'Molhm'],
    ['lastName', 'Ellis'],
    ['email', 'molhm@example.com'],
    ['phoneType', 'mobile'],
    ['phoneNumber', '+12015550134'],
    ['addressType', 'home'],
    ['addressLine1', '48 Maple Avenue'],
    ['city', 'Clifton'],
    ['postalCode', '07011'],
    ['country', 'US'],
    ['stateProvince', 'NJ'],
    ['source', 'internet'],
    ['educationLevel', 'hs'],
    ['school', 'Rutgers University'],
    ['degreeType', 'bachelor'],
    ['major', 'Computer Science'],
    ['gpa', '3.7'],
    ['expEmployer', 'Northwind Robotics'],
    ['expTitle', 'Engineering Intern'],
    ['expLocation', 'Newark, New Jersey'],
  ])('%s holds %s', (id, expected) => {
    expect(value(id)).toBe(expected);
  });

  it('leaves the optional fields correctly blank', () => {
    expect(value('middleName')).toBe('');
    expect(value('addressLine2')).toBe('');
  });

  it('never touches a credential or a consent on its own', () => {
    // Both are policy, not capability. An employer password is written only by
    // the account path, from the vault, and only with explicit permission; a
    // policy agreement is never ticked on anyone's behalf.
    expect(value('password')).toBe('');
    expect(value('passwordReenter')).toBe('');
    expect((document.getElementById('policyAgreement') as HTMLInputElement).checked).toBe(false);
  });
});

describe('GATE C — the counts', () => {
  it('verifies at least 90% of the fields it had an answer for', () => {
    // The denominator is deliberately "fields a source actually grounded", not
    // "fields on the page". A page holds questions no saved data answers — a
    // credential the vault owns, a consent nobody may tick for you, an upload
    // with no document chosen, a free-text question needing interpretation —
    // and counting those as failures would make the number say something false
    // about a run that behaved correctly.
    const grounded = trace.fields.filter((field) => field.plannerSource !== 'none');
    const settled = grounded.filter(
      (field) => field.verification === 'verified' || field.verification === 'optional_left_blank',
    );
    expect(grounded.length).toBeGreaterThan(15);
    expect(settled.length / grounded.length).toBeGreaterThanOrEqual(0.9);
  });

  it('loses no field to a rejected action or a missing mapping', () => {
    // This is the stronger claim, and the one that matters: of the eight ways a
    // field can be lost between the scan and the page, none of the mechanical
    // ones occurred. What is left outstanding is left outstanding on purpose.
    expect(trace.fields.filter((field) => field.contractResult === 'rejected')).toEqual([]);
    expect(
      trace.fields.filter((field) => field.plannerSource !== 'none' && field.intent === undefined),
    ).toEqual([]);
  });

  it('invokes the executor for every action it planned and approved', () => {
    // "A function returned successfully" is not evidence a field was filled,
    // and neither is "an action was planned". Every field the report calls
    // verified must have gone through the executor.
    const verified = trace.fields.filter((field) => field.verification === 'verified');
    expect(verified.every((field) => field.executorAttempted)).toBe(true);
    expect(verified.length).toBeGreaterThanOrEqual(20);
  });

  it('never lets a later refusal overwrite what an earlier pass verified', () => {
    // The failure this pins: on the pass that re-approved only the one control
    // the page had just revealed, every other action came back `skipped`, which
    // was read as "executed, not verified". Twenty-five verified fields were
    // reported as one, over a page that was correctly filled the whole time.
    const filled = report.results.filter((result) => result.verification === 'verified');
    expect(filled.length).toBeGreaterThanOrEqual(20);
    expect(report.fieldsVerified).toBe(filled.length);
    // And no field the executor refused may claim it was attempted.
    for (const field of trace.fields) {
      if (field.plannedAction !== 'manual_review') continue;
      expect(field.executorAttempted, `${field.fieldId} claimed an attempt`).toBe(false);
    }
  });

  it('counts the documents it actually attached', () => {
    // Read off the verified results rather than left at its default. The popup
    // renders this as "Documents uploaded", and it said 0 beside two files
    // sitting in the employer's own upload controls.
    expect(report.documentsAttached).toBe(
      report.results.filter(
        (result) => result.action === 'upload_file' && result.verification === 'verified',
      ).length,
    );
  });

  it('gives every required field a valid final outcome', () => {
    expect(report.requiredFields.length).toBeGreaterThan(0);
    for (const verdict of report.requiredFields) {
      expect([
        'FILLED_VERIFIED',
        'USER_CONFIRMATION_REQUIRED',
        'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
      ]).toContain(verdict.outcome);
    }
  });

  it('leaves no field in a temporary state', () => {
    expect(pendingResults(report.results)).toEqual([]);
    const reasons = report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/waiting on/i);
  });

  it('turns no section heading into a question', () => {
    const questions = report.results.map((result) => result.question);
    for (const heading of ['Addresses (1)* required.', 'Phones (1)', 'Enable AI Autofill']) {
      expect(questions).not.toContain(heading);
    }
    expect(questions.join(' ')).not.toMatch(/some required information is missing/i);
  });

  it('reports no duplicate question', async () => {
    const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
    expect(new Set(fields.map(questionIdentity)).size).toBe(fields.length);
    expect(fields.filter((field) => field.label === 'Highest Level of Education')).toHaveLength(1);
  });

  it('records no submission', () => {
    expect(report.submissionPrevented).toBe(true);
    expect(document.getElementById('createAccount')).not.toBeNull();
  });

  it('reconciles its own counters against its own results', () => {
    expect(report.fieldsVerified).toBe(
      report.results.filter((result) => result.verification === 'verified').length,
    );
    expect(report.userInputRequired).toBe(
      report.requiredFields.filter((verdict) => verdict.outcome === 'USER_CONFIRMATION_REQUIRED')
        .length,
    );
  });

  it('gives every outstanding field a reason that names a cause and an action', () => {
    for (const verdict of report.requiredFields) {
      if (verdict.outcome === 'FILLED_VERIFIED') continue;
      expect(verdict.reason.length, `${verdict.label} had no reason`).toBeGreaterThan(20);
      // Never the stage marker, and never a bare failure.
      expect(verdict.reason).not.toMatch(/waiting on|^error|^failed$/i);
    }
  });
});

describe('GATE D — performance', () => {
  it('finishes the whole fixture run well under thirty seconds', () => {
    expect(wallClockMs).toBeLessThan(30_000);
    expect(report.totalDurationMs).toBeLessThan(30_000);
  });

  it('needs no second click', () => {
    expect(['completed', 'completed_with_review']).toContain(report.status);
    expect(report.error?.code).not.toBe('MAX_ITERATIONS_REACHED');
  });

  it('does not re-execute what already verified', () => {
    // The live run burned all five passes re-attempting an identical failing
    // set. One executing pass plus at most one confirming pass is the budget.
    expect(executions).toBeLessThanOrEqual(2);
    expect(report.iterations).toBeLessThanOrEqual(3);
  });

  it('makes at most one analysis request for the page', () => {
    expect(trace.aiRequests).toBeLessThanOrEqual(1);
  });
});

describe('GATE — the dependent control filled in the same click', () => {
  it('chose the country first and then the state it produced', () => {
    // "State/Province" before "Country" offers one option — "Select a country
    // first" — and matching against it produced "No option on the page matched
    // New Jersey", which blamed the profile for the page's ordering.
    expect(value('country')).toBe('US');
    expect(value('stateProvince')).toBe('NJ');
    const reasons = report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/no option on the page matched ['"]?new jersey/i);
  });

  it('never searched a text control for an option', () => {
    const reasons = report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/no option on the page matched ['"]?molhm/i);
  });
});
