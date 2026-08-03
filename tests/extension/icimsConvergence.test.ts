import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  applicationScanResultSchema,
  autofillSettingsSchema,
  deterministicFillPlanSchema,
  fillRunReportSchema,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { decideApproval } from '../../extension/src/autofill/approvalPolicy.js';
import { runApplicationAutofill } from '../../extension/src/autofill/orchestrator.js';
import { profileFixture } from './popupFixtures.js';

/**
 * The live failure, reproduced against the real fixture.
 *
 * On careers2-quanta.icims.com the run filled two fields, reported six as
 * unfillable, and died with `MAX_ITERATIONS_REACHED`. The form was not
 * revealing new work on every pass — the loop simply could not tell that it had
 * already tried the six that never verify, so it retried them until the limit.
 *
 * This drives the orchestrator over the fixture with an executor that verifies
 * what the policy approved and fails everything else, which is exactly the live
 * shape.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

async function scanFixture(): Promise<ApplicationScanResult> {
  const html = readFileSync(FIXTURE, 'utf8');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
  return applicationScanResultSchema.parse({
    id: 'scan-icims',
    createdAt: new Date().toISOString(),
    url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
    domain: 'careers2-quanta.icims.com',
    ats: {
      id: 'icims',
      displayName: 'iCIMS',
      confidence: 0.98,
      detectionReason: 'hostname',
      supported: true,
    },
    jobContext: {},
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: fields.filter((field) => field.required).length,
      optional: fields.filter((field) => !field.required).length,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 5,
    status: 'completed',
    readOnly: true,
  });
}

/**
 * Runs the orchestrator over one stable page.
 *
 * The executor verifies whatever the approval policy approved and fails
 * anything else — the live behaviour, and the behaviour that used to loop.
 */
async function runOverFixture(scan: ApplicationScanResult) {
  const settings = autofillSettingsSchema.parse(DEFAULT_AUTOFILL_SETTINGS);
  const fieldsById = new Map(scan.fields.map((field) => [field.id, field]));
  const plan = deterministicFillPlanSchema.parse(
    buildDeterministicPlan(scan, profileFixture(), []),
  );
  let scans = 0;
  let plans = 0;
  let executions = 0;

  const report = await runApplicationAutofill({
    loadSettings: () => Promise.resolve(settings),
    scan: () => {
      scans += 1;
      return Promise.resolve({ scan });
    },
    plan: () => {
      plans += 1;
      return Promise.resolve({ plan });
    },
    approve: () => Promise.resolve({}),
    execute: () => {
      executions += 1;
      return Promise.resolve({
        report: fillRunReportSchema.parse({
          id: `run-${executions}`,
          planId: plan.id,
          scanId: scan.id,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          url: scan.url,
          ats: 'icims',
          totalActions: plan.actions.length,
          approvedActions: 0,
          verifiedActions: 0,
          failedActions: 0,
          reviewActions: 0,
          skippedActions: 0,
          unsupportedActions: 0,
          results: plan.actions.map((action) => {
            const approved = decideApproval(action, settings, fieldsById.get(action.fieldId));
            return {
              actionId: action.id,
              fieldId: action.fieldId,
              // The live shape: approved actions land, the rest do not — and
              // the ones that do not are what the loop kept retrying.
              status: approved.approved ? 'verified' : 'failed',
              attempts: 1,
              durationMs: 2,
            };
          }),
          status: 'completed',
          submitted: false,
        }),
      });
    },
    highlight: () => Promise.resolve({}),
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  });

  return { report, scans, plans, executions };
}

describe('the iCIMS fixture converges', () => {
  it('never reaches the iteration limit on a stable page', async () => {
    const scan = await scanFixture();
    const { report } = await runOverFixture(scan);

    // The headline. This is the exact error the live page produced.
    expect(report.error?.code).not.toBe('MAX_ITERATIONS_REACHED');
    expect(report.warnings.join(' ')).not.toMatch(/five passes/i);
    expect(report.status).not.toBe('failed');
  });

  it('settles in two passes rather than five', async () => {
    const scan = await scanFixture();
    const { report, executions } = await runOverFixture(scan);

    // One pass to act, one to confirm nothing new appeared. Five means the
    // fields that cannot verify are being retried, which is the bug.
    expect(report.iterations).toBeLessThanOrEqual(2);
    expect(executions).toBeLessThanOrEqual(1);
  });

  it('evaluates every detected field exactly once', async () => {
    const scan = await scanFixture();
    const { report } = await runOverFixture(scan);

    expect(report.results).toHaveLength(scan.fields.length);
    const ids = report.results.map((result) => result.fieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fills the fields it can and leaves only the genuinely unknown', async () => {
    const scan = await scanFixture();
    const { report } = await runOverFixture(scan);

    expect(report.fieldsVerified).toBeGreaterThanOrEqual(13);
    // Everything unfilled is reported, not silently dropped.
    const outstanding = report.results.filter((result) => result.verification !== 'verified');
    expect(report.results.length - report.fieldsVerified).toBe(outstanding.length);
  });

  it('never records a submission', async () => {
    const scan = await scanFixture();
    const { report } = await runOverFixture(scan);
    expect(report.submissionPrevented).toBe(true);
  });

  it('gives every required field a terminal outcome', async () => {
    const scan = await scanFixture();
    const { report } = await runOverFixture(scan);
    const required = scan.fields.filter(
      (field) => field.required && field.visible && !field.disabled,
    );
    expect(report.requiredFields).toHaveLength(required.length);
    for (const verdict of report.requiredFields) {
      expect([
        'FILLED_VERIFIED',
        'USER_CONFIRMATION_REQUIRED',
        'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
      ]).toContain(verdict.outcome);
    }
  });
});

describe('a page that genuinely keeps revealing work still iterates', () => {
  it('does not let convergence starve a real reveal', async () => {
    // Guarding the fix against overcorrection: the ledger must not turn a form
    // that really does reveal fields into a single-pass run.
    const base = await scanFixture();
    const extra: DetectedField = {
      ...base.fields[0]!,
      id: 'revealed-visa',
      selector: '#visaType',
      label: 'Visa Type',
      normalizedLabel: 'visa type',
      question: 'Visa Type',
      metadata: { name: 'visaType' },
    };
    const second = applicationScanResultSchema.parse({
      ...base,
      fields: [...base.fields, extra],
      statistics: { ...base.statistics, total: base.fields.length + 1 },
    });

    let call = 0;
    const settings = autofillSettingsSchema.parse(DEFAULT_AUTOFILL_SETTINGS);
    const plan = deterministicFillPlanSchema.parse(
      buildDeterministicPlan(second, profileFixture(), []),
    );
    const report = await runApplicationAutofill({
      loadSettings: () => Promise.resolve(settings),
      scan: () => {
        call += 1;
        return Promise.resolve({ scan: call === 1 ? base : second });
      },
      plan: () => Promise.resolve({ plan }),
      approve: () => Promise.resolve({}),
      execute: () => Promise.resolve({}),
      highlight: () => Promise.resolve({}),
      onProgress: () => undefined,
      isCancelled: () => false,
      waitForStability: () => Promise.resolve(),
      now: () => new Date().toISOString(),
    });

    // The new field appeared on the second scan, so the run looked again.
    expect(report.iterations).toBeGreaterThan(1);
  });
});
