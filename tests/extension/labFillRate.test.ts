import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  applicationScanResultSchema,
  classifyPage,
  isPasswordField,
  isUsernameField,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import { collectNavigationControls, scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  isExecutable,
} from '../../extension/src/planner/deterministicPlanner.js';
import { decideApproval } from '../../extension/src/autofill/approvalPolicy.js';
import { attachBundleDocuments } from '../../extension/src/uploads/bundleUploads.js';
import { profileFixture } from './popupFixtures.js';
import type { ApplicationBundle } from '@internship-agent/shared';

/**
 * How much of the laboratory the agent actually fills, measured rather than
 * asserted.
 *
 * "Supported and safely answerable" deliberately excludes credentials, which
 * only the vault may fill, and sensitive questions with no saved preference,
 * which must be left alone. Those are counted separately and are expected to be
 * left for the user — a run that filled them would be a failure, not a success.
 */

const NOW = '2026-08-02T09:00:00.000Z';

const BUNDLE: ApplicationBundle = {
  id: 'bundle-lab-job',
  websiteJobId: 'job-lab',
  company: 'Northwind Robotics',
  jobTitle: 'Software Engineering Intern',
  jobDescription: 'Build robots.',
  officialApplicationUrl: 'https://careers.example.com/apply',
  resume: {
    kind: 'resume',
    filename: 'Resume-Northwind.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-lab-job:resume',
    byteLength: 100,
    generatedAt: NOW,
  },
  coverLetter: {
    kind: 'cover_letter',
    filename: 'Cover-Letter-Northwind.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-lab-job:cover_letter',
    byteLength: 90,
    generatedAt: NOW,
  },
  approvedAnswers: [],
  createdAt: NOW,
};

function load(name: string): void {
  const html = readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'lab', name), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '');
}

async function scanFixture(name: string): Promise<ApplicationScanResult> {
  load(name);
  const { fields } = await scanDom(document, 'page-lab', new AbortController().signal);
  return applicationScanResultSchema.parse({
    id: `scan-${name}`,
    createdAt: NOW,
    url: 'https://careers.example.com/apply',
    domain: 'careers.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'lab',
      supported: true,
    },
    jobContext: { company: 'Northwind Robotics' },
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: collectNavigationControls(document).length,
    },
    durationMs: 1,
    status: 'completed',
    readOnly: true,
  });
}

interface Coverage {
  /** Fields a saved profile value could correctly answer. */
  answerable: string[];
  filled: string[];
  leftForUser: string[];
  /** Fields correctly refused: protected, or a document not in the bundle. */
  correctlyRefused: string[];
}

/**
 * Questions the agent must *not* answer from a profile value, however much it
 * looks like it could.
 *
 * A saved "U.S. Citizen" does not entitle anything to tick "Yes, I am
 * permitted to work": that is an inference about immigration status, which is
 * precisely what the grounding rule forbids. Sponsorship is protected and is
 * shown for confirmation rather than disclosed automatically. Neither belongs
 * in the denominator of a fill rate — filling them would be the bug.
 */
function isCorrectRefusal(field: DetectedField, bundle: ApplicationBundle): boolean {
  const canonical = field.canonicalKey;
  if (canonical === 'work_authorization' || canonical === 'sponsorship_required') return true;
  if (canonical === 'citizenship' || canonical === 'security_clearance') return true;
  if (field.fieldType === 'file') {
    const wanted = /transcript|portfolio|writing sample/i.test(field.label);
    return wanted && !bundle.resume?.filename.includes('Transcript');
  }
  return false;
}

/**
 * Runs the deterministic path exactly as the orchestrator does, then reports
 * which fields ended up with an action the executor could apply.
 */
async function coverage(name: string): Promise<Coverage> {
  const scan = await scanFixture(name);
  let plan = buildDeterministicPlan(scan, profileFixture(), []);
  plan = attachBundleDocuments(plan, scan, BUNDLE);

  const fieldsById = new Map(scan.fields.map((field) => [field.id, field]));
  const answerable: string[] = [];
  const filled: string[] = [];
  const leftForUser: string[] = [];
  const correctlyRefused: string[] = [];

  for (const action of plan.actions) {
    const field = fieldsById.get(action.fieldId);
    if (!field) continue;
    // A credential is filled only by the vault, never from a profile.
    if (isPasswordField(field) || isUsernameField(field)) continue;

    const decision = decideApproval(action, DEFAULT_AUTOFILL_SETTINGS, field);
    const wouldFill = decision.approved && isExecutable(action);
    // Uploads default to manual attachment, so an approved upload action that
    // carries a document counts as filled for coverage purposes.
    const uploadReady = action.action === 'upload_file' && Boolean(action.documentId);

    if (isCorrectRefusal(field, BUNDLE)) {
      correctlyRefused.push(field.label);
      continue;
    }

    answerable.push(field.label);
    if (wouldFill || uploadReady) filled.push(field.label);
    else leftForUser.push(field.label);
  }

  return { answerable, filled, leftForUser, correctlyRefused };
}

describe('laboratory coverage', () => {
  it('fills at least 90% of the safely answerable fields on a plain application', async () => {
    const result = await coverage('native-application.html');
    const rate = result.filled.length / result.answerable.length;

    // Reported so a regression names what stopped being filled.
    if (rate < 0.9) {
      throw new Error(
        `Filled ${result.filled.length}/${result.answerable.length}. Not filled: ${result.leftForUser.join(', ')}`,
      );
    }
    expect(result.answerable.length).toBeGreaterThan(15);
    // Every refusal is deliberate and named, not an accidental gap.
    expect(result.correctlyRefused).toEqual(
      expect.arrayContaining([
        'Do you currently have permission to work in the country of employment?',
        'Would the company need to sponsor your employment authorization, now or in the future?',
        'Academic transcript',
      ]),
    );
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it('attaches both tailored documents on that application', async () => {
    const result = await coverage('native-application.html');
    expect(result.filled).toContain('Resume / CV');
    expect(result.filled).toContain('Covering letter');
    // The transcript is not in the bundle and is correctly refused.
    expect(result.correctlyRefused).toContain('Academic transcript');
  });

  it('leaves every protected question with no saved preference for the user', async () => {
    const scan = await scanFixture('sensitive-and-custom.html');
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const fieldsById = new Map(scan.fields.map((field) => [field.id, field]));

    const sensitiveLabels = [
      'Gender',
      'Race / Ethnicity',
      'Are you Hispanic or Latino?',
      'Veteran status',
      'Disability status',
      'Sexual orientation',
      'What are your salary expectations?',
      'Do you currently hold an active security clearance?',
    ];

    for (const label of sensitiveLabels) {
      const action = plan.actions.find((entry) => fieldsById.get(entry.fieldId)?.label === label);
      expect(action, label).toBeDefined();
      const decision = decideApproval(
        action!,
        DEFAULT_AUTOFILL_SETTINGS,
        fieldsById.get(action!.fieldId),
      );
      expect(decision.approved, label).toBe(false);
      expect(action!.proposedValue, label).toBeUndefined();
    }
  });

  it('fills nothing at all on a sign-in page', async () => {
    const scan = await scanFixture('taleo-login.html');
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const fieldsById = new Map(scan.fields.map((field) => [field.id, field]));

    for (const action of plan.actions) {
      const decision = decideApproval(
        action,
        DEFAULT_AUTOFILL_SETTINGS,
        fieldsById.get(action.fieldId),
      );
      expect(decision.approved, action.question).toBe(false);
    }

    const state = classifyPage({
      url: 'https://careers.example.taleo.net/login',
      title: document.title,
      bodyText: document.body.textContent ?? '',
      fields: scan.fields,
      controls: collectNavigationControls(document),
    });
    expect(state.kind).toBe('login');
  });

  it('never proposes acting on a control that would submit', async () => {
    for (const fixture of ['native-application.html', 'taleo-review.html']) {
      const scan = await scanFixture(fixture);
      const state = classifyPage({
        url: 'https://careers.example.com/apply',
        title: document.title,
        bodyText: document.body.textContent ?? '',
        fields: scan.fields,
        controls: collectNavigationControls(document),
      });
      const plan = buildDeterministicPlan(scan, profileFixture(), []);
      const submitting = state.actions.filter((action) => action.endsApplication);
      // The submit control is recognized, and no plan action targets it.
      for (const action of submitting) {
        expect(plan.actions.some((entry) => entry.fieldId === action.selector)).toBe(false);
      }
    }
  });
});

/** Counted for the record so the report can state a measured number. */
describe('measured coverage', () => {
  it('reports the numbers', async () => {
    const rows: string[] = [];
    for (const fixture of [
      'native-application.html',
      'custom-controls.html',
      'sensitive-and-custom.html',
      'workday-step.html',
      'taleo-create-account.html',
    ]) {
      const result = await coverage(fixture);
      rows.push(
        `${fixture}: ${result.filled.length}/${result.answerable.length} answerable filled, ` +
          `${result.correctlyRefused.length} correctly refused`,
      );
    }
    console.info(`[lab coverage]\n${rows.join('\n')}`);
    expect(rows).toHaveLength(5);
  });
});

/** Keeps the unused-import guard honest about DetectedField. */
export type _Field = DetectedField;
