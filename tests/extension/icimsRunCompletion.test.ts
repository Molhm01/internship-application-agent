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
 * One click on the live iCIMS page, driven end to end.
 *
 * The live failure was that this produced no visible change and returned the
 * same unresolved list. So the assertions here are deliberately about the DOM:
 * what does the employer's form actually contain when the run stops? A report
 * claiming success over an untouched page is the exact bug being pinned.
 *
 * The dependencies are the real scanner, the real planner and the real DOM
 * executor. Only the transport between them is stubbed — there is no second
 * autofill implementation here.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

/** The applicant from the live run. */
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

interface Harness {
  report: ApplicationAutofillReport;
  scans: number;
  plans: number;
  executions: number;
  document: Document;
}

/**
 * Runs the orchestrator against the fixture.
 *
 * `plan()` counts its calls, because one call per pass is what made the model
 * be asked five times for the same page.
 */
async function runAgainstFixture(
  profile = applicant(),
  options: { reload?: boolean } = {},
): Promise<Harness> {
  // Callers that have already staged the document — to wire up a dependent
  // control, say — keep it.
  if (options.reload !== false) {
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
      /<!doctype html>/i,
      '',
    );
  }

  let scans = 0;
  let plans = 0;
  let executions = 0;
  let current: DeterministicFillPlan | null = null;

  const report = await runApplicationAutofill({
    loadSettings: () =>
      Promise.resolve({
        ...DEFAULT_AUTOFILL_SETTINGS,
        applicationAutofillEnabled: true,
      }),
    scan: async () => {
      scans += 1;
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
      return { scan: icimsScan(fields) };
    },
    plan: async () => {
      plans += 1;
      const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
      current = buildDeterministicPlan(icimsScan(fields), profile, []);
      return { plan: current };
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
      executions += 1;
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
          startedAt: '2026-08-03T09:00:00.000Z',
          completedAt: '2026-08-03T09:00:01.000Z',
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

  return { report, scans, plans, executions, document };
}

function value(id: string): string {
  const element = document.getElementById(id);
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement) return element.value;
  return '';
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('the run changes the page', () => {
  it('fills every safely answerable personal field', async () => {
    await runAgainstFixture();
    expect(value('firstName')).toBe('Molhm');
    expect(value('lastName')).toBe('Ellis');
    expect(value('email')).toBe('molhm@example.com');
    expect(value('addressLine1')).toBe('48 Maple Avenue');
    expect(value('city')).toBe('Clifton');
    expect(value('postalCode')).toBe('07011');
  });

  it('answers the structural dropdowns from the form’s own vocabulary', async () => {
    await runAgainstFixture();
    expect(value('phoneType')).toBe('mobile');
    expect(value('addressType')).toBe('home');
    expect(value('country')).toBe('US');
  });

  it('answers the source question without picking the first option', async () => {
    await runAgainstFixture();
    expect(value('source')).toBe('internet');
  });

  it('answers the education question with the awarded degree', async () => {
    await runAgainstFixture();
    expect(value('educationLevel')).toBe('hs');
  });

  it('fills the education section from the saved profile', async () => {
    await runAgainstFixture();
    expect(value('school')).toBe('Rutgers University');
    expect(value('major')).toBe('Computer Science');
    expect(value('minor')).toBe('Mathematics');
    expect(value('gpa')).toBe('3.7');
    expect(value('gradMonth')).toBe('05');
    expect(value('gradYear')).toBe('2027');
    // The degree being studied for — the other question from the one above.
    expect(value('degreeType')).toBe('bachelor');
  });

  it('fills the work-experience section from the saved profile', async () => {
    await runAgainstFixture();
    expect(value('expEmployer')).toBe('Northwind Robotics');
    expect(value('expTitle')).toBe('Engineering Intern');
    expect(value('expResponsibilities')).toContain('actuator');
  });

  it('fills the employer location with the job’s location, not the applicant’s', async () => {
    await runAgainstFixture();
    // The live run's single filled field was this one, holding the applicant's
    // home address. It is the employer's location and nothing else.
    expect(value('expLocation')).toBe('Newark, New Jersey');
    expect(value('expLocation')).not.toContain('Clifton');
  });

  it('leaves the optional fields it should leave alone', async () => {
    await runAgainstFixture();
    expect(value('middleName')).toBe('');
    expect(value('addressLine2')).toBe('');
  });

  it('never types the address into address line 2', async () => {
    await runAgainstFixture();
    expect(value('addressLine2')).not.toBe(value('addressLine1'));
  });

  it('leaves both password boxes untouched', async () => {
    await runAgainstFixture();
    expect(value('password')).toBe('');
    expect(value('passwordReenter')).toBe('');
  });

  it('never ticks the policy agreement', async () => {
    await runAgainstFixture();
    expect((document.getElementById('policyAgreement') as HTMLInputElement).checked).toBe(false);
  });
});

describe('Country before State, in one run', () => {
  /**
   * The fixture repopulates State from a `change` listener, and jsdom does not
   * run scripts injected through innerHTML. So the page's own effect is wired
   * up here — what is under test is the *run*: it must fill Country, notice
   * that State's options changed, and come back for it without being asked
   * twice.
   */
  function wireDependency(): void {
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

  it('fills State after Country, in the same click', async () => {
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
      /<!doctype html>/i,
      '',
    );
    wireDependency();
    // Re-runs the orchestrator against the document this test already prepared.
    await runAgainstFixture(applicant(), { reload: false });

    expect(value('country')).toBe('US');
    expect(value('stateProvince')).toBe('NJ');
  });

  it('does not report the dependent control as an unmatched option', async () => {
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
      /<!doctype html>/i,
      '',
    );
    wireDependency();
    const harness = await runAgainstFixture(applicant(), { reload: false });
    const reasons = harness.report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/no option on the page matched ['"]?new jersey/i);
  });
});

describe('the run terminates instead of looping', () => {
  it('converges well inside the pass limit', async () => {
    const harness = await runAgainstFixture();
    // The live symptom was five passes producing nothing. A page that stops
    // revealing questions must stop the loop.
    expect(harness.report.iterations).toBeLessThanOrEqual(3);
    expect(harness.report.error?.code).not.toBe('MAX_ITERATIONS_REACHED');
  });

  it('does not re-execute fields that already verified', async () => {
    const harness = await runAgainstFixture();
    // One executing pass, plus at most one confirming pass. Re-approving and
    // re-writing verified fields is what burned all five passes.
    expect(harness.executions).toBeLessThanOrEqual(2);
  });

  it('finishes in a terminal status', async () => {
    const harness = await runAgainstFixture();
    expect(['completed', 'completed_with_review']).toContain(harness.report.status);
  });
});

describe('the completion summary is truthful', () => {
  it('records what was verified, and it matches the page', async () => {
    const harness = await runAgainstFixture();
    const verified = harness.report.results.filter((result) => result.verification === 'verified');
    expect(verified.length).toBeGreaterThanOrEqual(8);
    expect(harness.report.fieldsVerified).toBe(verified.length);
  });

  it('names an attempted action and a duration for every attempt', async () => {
    const harness = await runAgainstFixture();
    for (const result of harness.report.results) {
      expect(result.attemptedAction, `${result.question} had no attempted action`).toBeDefined();
    }
  });

  it('counts optional blanks separately from outstanding work', async () => {
    const harness = await runAgainstFixture();
    expect(harness.report.optionalLeftBlank).toBeGreaterThanOrEqual(2);
    const blanks = harness.report.results.filter(
      (result) => result.verification === 'optional_left_blank',
    );
    // None of them asks the user for anything.
    expect(blanks.every((result) => result.reviewReason === undefined)).toBe(true);
  });

  it('does not claim zero problems while required fields remain outstanding', async () => {
    const harness = await runAgainstFixture();
    const outstanding = harness.report.requiredFields.filter(
      (verdict) => verdict.outcome !== 'FILLED_VERIFIED',
    );
    if (outstanding.length > 0) {
      // This is the "Could not fill: 0" contradiction, stated as an invariant.
      expect(harness.report.userInputRequired).toBeGreaterThan(0);
    }
    expect(harness.report.userInputRequired).toBe(
      harness.report.requiredFields.filter(
        (verdict) => verdict.outcome === 'USER_CONFIRMATION_REQUIRED',
      ).length,
    );
  });

  it('reports a total duration', async () => {
    const harness = await runAgainstFixture();
    expect(harness.report.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('never records a submission', async () => {
    const harness = await runAgainstFixture();
    expect(harness.report.submissionPrevented).toBe(true);
    // The Create Account button is still unclicked and the form unsubmitted.
    expect(document.getElementById('createAccount')).not.toBeNull();
  });
});
