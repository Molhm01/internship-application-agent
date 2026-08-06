import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  FINAL_FIELD_STATUSES,
  RUNNING_FIELD_STATUSES,
  applicationScanResultSchema,
  assertNoTemporaryStatuses,
  classifyPage,
  isSettledStatus,
  pendingResults,
  profileSchema,
  type ApplicationAutofillReport,
  type ApplicationScanResult,
  type DetectedField,
  type DeterministicFillPlan,
  type FillRunReport,
  type FinalFieldStatus,
  type Profile,
  type RunTrace,
} from '@internship-agent/shared';
import { collectNavigationControls, scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  setActionApproval,
} from '../../extension/src/planner/deterministicPlanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import {
  runApplicationAutofill,
  type HighlightPlan,
} from '../../extension/src/autofill/orchestrator.js';
import { profileFixture } from './popupFixtures.js';

/**
 * The candidate-profile fixture, run through the real pipeline.
 *
 * The page is built so that each of the six final statuses is reached by one
 * named control, which is what makes this file able to assert *which* fields
 * ended where rather than how many did. "Twenty-eight verified" is satisfied by
 * a run that filled the wrong twenty-eight.
 *
 * The scanner, the planner, the DOM executor and the orchestrator are all the
 * real modules. Only the transport between them is stubbed: there is no second
 * autofill implementation in this file.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'diagnostic-trace.html',
);

const URL = 'https://careers.halden.example/apply/applications-engineering-intern';

/** The applicant the fixture is written against. Deliberately has no middle name. */
function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Molhm',
      middleName: '',
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
  });
}

function scanFor(fields: readonly DetectedField[]): ApplicationScanResult {
  const count = (type: DetectedField['fieldType']): number =>
    fields.filter((field) => field.fieldType === type).length;
  return applicationScanResultSchema.parse({
    id: 'scan-diagnostic-fixture',
    createdAt: '2026-08-06T09:00:00.000Z',
    url: URL,
    domain: 'careers.halden.example',
    ats: {
      id: 'unknown',
      displayName: 'Generic',
      confidence: 0.4,
      detectionReason: 'no named ATS matched careers.halden.example',
      supported: true,
    },
    jobContext: {},
    fields,
    navigation: classifyPage({
      url: URL,
      title: 'Applications Engineering Intern',
      bodyText: document.body?.textContent?.slice(0, 20_000) ?? '',
      fields,
      controls: collectNavigationControls(document),
    }),
    warnings: [],
    durationMs: 12,
    status: 'completed',
    readOnly: true,
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: count('unknown'),
      required: fields.filter((field) => field.required).length,
      optional: fields.filter((field) => !field.required).length,
      text: count('text'),
      textarea: count('textarea'),
      select: count('select') + count('multi_select'),
      combobox: count('combobox'),
      radio: count('radio'),
      checkbox: count('checkbox'),
      file: count('file'),
      credentialFields: count('password'),
      navigationActions: 0,
      rawControls: fields.length,
      falseControlsRemoved: 0,
      duplicateControlsRemoved: 0,
      bySection: {},
    },
  });
}

interface Harness {
  report: ApplicationAutofillReport;
  trace: RunTrace;
  /** Every batch of marks the run asked the page to draw, in order. */
  annotationBatches: HighlightPlan[][];
}

async function runAgainstFixture(): Promise<Harness> {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  // The fixture's own script does not run under jsdom's `innerHTML`, so the
  // hostile dropdown is wired up here — same behaviour, same reason: an ATS
  // that re-renders a select after selection discards the value.
  const country = document.getElementById('country');
  if (country instanceof HTMLSelectElement) {
    country.addEventListener('change', () => {
      if (country.value !== '') country.value = '';
    });
  }

  const profile = applicant();
  let current: DeterministicFillPlan | null = null;
  let trace: RunTrace | null = null;
  const annotationBatches: HighlightPlan[][] = [];

  const report = await runApplicationAutofill({
    buildId: 'diagnostic-fixture',
    onTrace: (produced) => {
      trace = produced;
    },
    loadSettings: () =>
      Promise.resolve({ ...DEFAULT_AUTOFILL_SETTINGS, applicationAutofillEnabled: true }),
    scan: async () => {
      const { fields } = await scanDom(document, 'page-diagnostic', new AbortController().signal);
      return { scan: scanFor(fields) };
    },
    plan: async () => {
      const { fields } = await scanDom(document, 'page-diagnostic', new AbortController().signal);
      current = buildDeterministicPlan(scanFor(fields), profile, []);
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
      const { fields } = await scanDom(document, 'page-diagnostic', new AbortController().signal);
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
          id: 'fill-diagnostic',
          planId: plan.id,
          startedAt: '2026-08-06T09:00:00.000Z',
          completedAt: '2026-08-06T09:00:01.000Z',
          url: plan.url,
          results,
          submitted: false as const,
          warnings: [],
        } as unknown as FillRunReport,
      };
    },
    highlight: (requests) => {
      annotationBatches.push([...requests]);
      return Promise.resolve({});
    },
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  });

  expect(trace, 'the run produced no trace').not.toBeNull();
  return { report, trace: trace!, annotationBatches };
}

/** The final status of the field whose label starts with `label`. */
function statusOf(report: ApplicationAutofillReport, label: string): FinalFieldStatus | undefined {
  return report.fieldOutcomes.find((outcome) =>
    outcome.label.toLowerCase().startsWith(label.toLowerCase()),
  )?.status;
}

function value(id: string): string {
  const element = document.getElementById(id);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value;
  }
  return '';
}

describe('the diagnostic-trace fixture', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await runAgainstFixture();
  });

  it('GATE 1 — gives every field exactly one final status', () => {
    expect(harness.report.fieldOutcomes.length).toBeGreaterThan(0);
    for (const outcome of harness.report.fieldOutcomes) {
      expect(FINAL_FIELD_STATUSES, `${outcome.label} had no final status`).toContain(
        outcome.status,
      );
    }
    // One record per field, and one field per record.
    expect(new Set(harness.report.fieldOutcomes.map((entry) => entry.fieldId)).size).toBe(
      harness.report.fieldOutcomes.length,
    );
    expect(harness.trace.fields).toHaveLength(harness.report.fieldOutcomes.length);
  });

  it('GATE 2 — leaves no field in a temporary state', () => {
    expect(pendingResults(harness.report.results)).toEqual([]);
    expect(harness.trace.pendingAtCompletion).toBe(0);
    for (const result of harness.report.results) {
      expect(result.verification).not.toBe('pending');
      expect(result.reason).not.toMatch(/waiting on/i);
    }
    // COMPLETED may not be claimed while a field is outstanding.
    if (harness.report.status === 'completed') {
      expect(harness.report.fieldOutcomes.every((entry) => isSettledStatus(entry.status))).toBe(
        true,
      );
    }
  });

  it('GATE 3 — a field that verifies loses its Information needed mark', () => {
    const last = harness.annotationBatches.at(-1) ?? [];
    expect(last.length).toBeGreaterThan(0);
    const verified = harness.report.fieldOutcomes.filter(
      (entry) => entry.status === 'FILLED_VERIFIED',
    );
    expect(verified.length).toBeGreaterThan(0);
    for (const outcome of verified) {
      expect(outcome.annotation).toBe('verified');
      const mark = last.find((request) => request.fieldId === outcome.fieldId);
      expect(mark, `${outcome.label} was never annotated`).toBeDefined();
      expect(mark!.annotation).toBe('verified');
      expect(mark!.badge).not.toMatch(/information needed/i);
    }
    // A field the agent did not touch carries no mark at all — but it is still
    // *sent*, so that whatever an earlier pass drew on it is removed. Omitting
    // it would leave the stale mark in place, which is the bug itself.
    for (const outcome of harness.report.fieldOutcomes.filter(
      (entry) => entry.status === 'SKIPPED_ALREADY_VALID',
    )) {
      expect(outcome.annotation).toBe('none');
      const mark = last.find((request) => request.fieldId === outcome.fieldId);
      expect(mark, `${outcome.label} was not sent for a redraw`).toBeDefined();
      expect(mark!.annotation).toBe('none');
    }
  });

  it('GATE 2b — no field holds a temporary status once the run has stopped', () => {
    for (const field of harness.trace.fields) {
      expect(RUNNING_FIELD_STATUSES, `${field.label} is still pending`).not.toContain(
        field.finalStatus,
      );
    }
    // And the model itself refuses the claim, so this cannot be argued away by
    // a future caller that assembles the report differently.
    expect(() =>
      assertNoTemporaryStatuses(
        harness.report.fieldOutcomes.map((entry) => ({
          fieldId: entry.fieldId,
          status: entry.status,
        })),
      ),
    ).not.toThrow();
    expect(() =>
      assertNoTemporaryStatuses([{ fieldId: 'field-x', status: 'PENDING_VERIFICATION' }]),
    ).toThrow(/temporary status/i);
  });

  it('GATE 4 — an optional blank field is not an error', () => {
    expect(statusOf(harness.report, 'Middle name')).toBe('OPTIONAL_LEFT_BLANK');
    expect(value('middleName')).toBe('');
    const outcome = harness.report.fieldOutcomes.find((entry) =>
      entry.label.startsWith('Middle name'),
    );
    expect(outcome!.annotation).toBe('optional_blank');
    // It is settled work. It must not appear in the outstanding count.
    expect(isSettledStatus(outcome!.status)).toBe(true);
  });

  it('GATE 5 — the counters equal the field results exactly', () => {
    const counted = (status: FinalFieldStatus): number =>
      harness.report.fieldOutcomes.filter((entry) => entry.status === status).length;
    expect(harness.report.fieldsFound).toBe(harness.report.fieldOutcomes.length);
    expect(harness.report.fieldsVerified).toBe(
      counted('FILLED_VERIFIED') + counted('SKIPPED_ALREADY_VALID'),
    );
    expect(harness.report.failedFields).toBe(counted('FAILED_EXECUTION'));
    expect(harness.report.optionalLeftBlank).toBe(counted('OPTIONAL_LEFT_BLANK'));
    expect(harness.report.userInputRequired).toBe(counted('USER_CONFIRMATION_REQUIRED'));
    expect(harness.report.blockedFields).toBe(counted('BLOCKED'));
    expect(
      Object.values(harness.report.finalStatusCounts).reduce((sum, count) => sum + count, 0),
    ).toBe(harness.report.fieldsFound);
    // The trace agrees with the report, because both read the same list.
    expect(harness.trace.finalStatusCounts).toEqual(harness.report.finalStatusCounts);
  });

  it('GATE 7 — never clicks the final Submit', () => {
    expect(harness.report.submissionPrevented).toBe(true);
    expect(document.getElementById('submitApplication')).not.toBeNull();
  });

  it('fills the three ordinary text fields and verifies them', () => {
    expect(value('firstName')).toBe('Molhm');
    expect(value('lastName')).toBe('Ellis');
    expect(value('email')).toBe('molhm@example.com');
    for (const label of ['First name', 'Last name', 'Email address']) {
      expect(statusOf(harness.report, label), label).toBe('FILLED_VERIFIED');
    }
  });

  it('hands the unanswerable required field back to the user, in orange', () => {
    const outcome = harness.report.fieldOutcomes.find((entry) =>
      entry.label.toLowerCase().includes('referred you'),
    );
    expect(outcome, 'the referral question was not reported').toBeDefined();
    expect(outcome!.status).toBe('USER_CONFIRMATION_REQUIRED');
    expect(outcome!.annotation).toBe('information_needed');
    expect(outcome!.required).toBe(true);
    // Nothing was invented for it.
    expect(value('referralName')).toBe('');
  });

  it('reports the dropdown the page refused as a failed execution, not a missing answer', () => {
    const outcome = harness.report.fieldOutcomes.find((entry) => entry.label === 'Country');
    expect(outcome, 'the country question was not reported').toBeDefined();
    // The page discards the selection, so the control ends empty — but the
    // agent did have an answer and did attempt the write. Blaming the profile
    // for a page defect is the distinction this asserts, and it is the whole
    // reason the executor's own attempt is recorded separately from the
    // planner's intent.
    expect(value('country')).toBe('');
    expect(outcome!.status).toBe('FAILED_EXECUTION');
    expect(outcome!.annotation).toBe('execution_failed');
    const traced = harness.trace.fields.find((entry) => entry.fieldId === outcome!.fieldId);
    expect(traced!.executorAttempted).toBe(true);
    expect(traced!.profileValueAvailable).toBe(true);
    expect(traced!.controlType).toBe('select');
  });

  it('leaves the already-correct field alone, unmarked, and says so', () => {
    expect(value('city')).toBe('Clifton');
    expect(statusOf(harness.report, 'City')).toBe('SKIPPED_ALREADY_VALID');
    const outcome = harness.report.fieldOutcomes.find((entry) => entry.label === 'City');
    // The user's own correct answer is not the agent's work, so it gets no tick.
    expect(outcome!.annotation).toBe('none');
  });

  it('marks a legal confirmation purple and never ticks it', () => {
    const box = document.getElementById('legalConfirmation');
    expect(box instanceof HTMLInputElement && box.checked, 'the agent ticked a legal consent').toBe(
      false,
    );
    const outcome = harness.report.fieldOutcomes.find((entry) =>
      entry.label.toLowerCase().includes('certify'),
    );
    expect(outcome, 'the legal confirmation was not reported').toBeDefined();
    expect(outcome!.status).toBe('USER_CONFIRMATION_REQUIRED');
    // Purple, not orange. "We have no value for this" and "this is a
    // declaration only you may make" are different requests.
    expect(outcome!.annotation).toBe('sensitive_decision');
    expect(outcome!.required).toBe(true);
  });

  it('stamps every field record with the run, the build, and the frame', () => {
    expect(harness.trace.fields.length).toBeGreaterThan(0);
    for (const field of harness.trace.fields) {
      expect(field.runId).toBe(harness.trace.runId);
      expect(field.buildId).toBe('diagnostic-fixture');
      expect(field.frameId).toBe(0);
      expect(field.plannerSource.length).toBeGreaterThan(0);
      expect(['accepted', 'repaired', 'rejected', 'not_applicable']).toContain(
        field.contractResult,
      );
    }
  });

  it('records a full diagnostic for every field, and no value anywhere', () => {
    for (const field of harness.trace.fields) {
      expect(field.fieldId).toMatch(/^field-/);
      expect(field.label.length).toBeGreaterThan(0);
      expect(typeof field.required).toBe('boolean');
      expect(typeof field.profileValueAvailable).toBe('boolean');
      expect(typeof field.executorAttempted).toBe('boolean');
      expect(field.controlType.length).toBeGreaterThan(0);
      expect(FINAL_FIELD_STATUSES).toContain(field.finalStatus);
    }
    // No answer, no address, no email address may appear anywhere in the trace.
    const serialized = JSON.stringify(harness.trace);
    for (const secret of ['Molhm', 'Ellis', 'molhm@example.com', '48 Maple Avenue', 'Clifton']) {
      expect(serialized, `the trace leaked ${secret}`).not.toContain(secret);
    }
  });
});
