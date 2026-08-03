import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  applicationScanResultSchema,
  detectedFieldSchema,
  isPasswordField,
  isUsernameField,
  type DetectedField,
} from '@internship-agent/shared';
import { selectAdapter } from '../../extension/src/scanner/adapters.js';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildAnalysisRequest } from '../../extension/src/analysis/formAnalysis.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';

/**
 * The iCIMS account-creation page, end to end.
 *
 * This is the page the live failure happened on. It is here as a fixture so the
 * whole path — hostname detection, DOM scan, schema validation, planning, and
 * the AI request — is exercised against the real shape rather than against a
 * simplification that would not have caught the bug.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

/** Every field the fixture asks for, by the label a person reads. */
const EXPECTED_QUESTIONS = [
  'Username',
  'Password',
  'Confirm Password',
  'Email Address',
  'First Name',
  'Middle Name',
  'Last Name',
  'Phone Type',
  'Phone Number',
  'Address Type',
  'Address Line 1',
  'Address Line 2',
  'City',
  'State/Province',
  'Postal Code',
  'Country',
  'Resume',
  'How did you hear about us?',
  'Are you willing to relocate?',
] as const;

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
}

async function scanFields(): Promise<DetectedField[]> {
  const controller = new AbortController();
  return (await scanDom(document, 'page-icims', controller.signal)).fields;
}

function labelled(fields: DetectedField[], label: string): DetectedField | undefined {
  const wanted = label.toLowerCase().replace(/\s+/g, ' ').trim();
  return fields.find(
    (field) =>
      field.label
        .toLowerCase()
        .replace(/[*\s]+/g, ' ')
        .trim()
        .replace(/ $/, '') === wanted,
  );
}

beforeEach(() => {
  loadFixture();
});

describe('detecting the page', () => {
  it.each([
    'careers2-quanta.icims.com',
    'careers-quanta.icims.com',
    'jobs-company.icims.com',
    'careers.icims.eu',
  ])('detects %s as iCIMS', (hostname) => {
    const selected = selectAdapter({
      url: `https://${hostname}/jobs/12345/login`,
      hostname,
      title: document.title,
      bodyText: document.body.textContent ?? '',
      document,
    });
    expect(selected.adapter.id).toBe('icims');
    expect(selected.adapter.displayName).toBe('iCIMS');
    expect(selected.detection.confidence).toBeGreaterThan(0.9);
  });

  it('still detects iCIMS from DOM markers when the hostname is a vanity domain', () => {
    const selected = selectAdapter({
      url: 'https://careers.quanta.example/apply',
      hostname: 'careers.quanta.example',
      title: document.title,
      bodyText: document.body.textContent ?? '',
      document,
    });
    // The fixture carries iCIMS_ class markers, which is the second signal.
    expect(selected.adapter.id).toBe('icims');
  });
});

describe('scanning the account-creation form', () => {
  it('finds every question the page asks', async () => {
    const fields = await scanFields();
    const missing = EXPECTED_QUESTIONS.filter((label) => !labelled(fields, label));
    expect(missing, `these questions were not found: ${missing.join(', ')}`).toEqual([]);
  });

  it('finds all nineteen of them', async () => {
    expect(EXPECTED_QUESTIONS).toHaveLength(19);
    expect((await scanFields()).length).toBeGreaterThanOrEqual(EXPECTED_QUESTIONS.length);
  });

  it('emits the password and its confirmation as password fields', async () => {
    const fields = await scanFields();
    const password = labelled(fields, 'Password');
    const confirm = labelled(fields, 'Confirm Password');
    expect(password?.fieldType).toBe('password');
    expect(confirm?.fieldType).toBe('password');
    expect(isPasswordField(password!)).toBe(true);
  });

  it('recognizes the username box as a username, not as a plain question', async () => {
    expect(isUsernameField(labelled(await scanFields(), 'Username')!)).toBe(true);
  });

  it('keeps Phone Type distinct from Phone Number', async () => {
    const fields = await scanFields();
    expect(labelled(fields, 'Phone Type')?.fieldType).toBe('select');
    expect(labelled(fields, 'Phone Number')?.fieldType).toBe('tel');
  });

  it('keeps Address Type distinct from the address lines', async () => {
    const fields = await scanFields();
    expect(labelled(fields, 'Address Type')?.fieldType).toBe('select');
    expect(labelled(fields, 'Address Line 1')?.fieldType).toBe('text');
    expect(labelled(fields, 'Address Line 2')?.fieldType).toBe('text');
  });

  it('reads every option of every dropdown rather than the first', async () => {
    const source = labelled(await scanFields(), 'How did you hear about us?');
    const values = source?.options?.map((option) => option.value) ?? [];
    expect(values).toEqual(['', 'job-board', 'referral', 'university', 'linkedin']);
  });

  it('marks the required fields as required', async () => {
    const fields = await scanFields();
    for (const label of ['Username', 'Password', 'Email Address', 'First Name', 'Resume']) {
      expect(labelled(fields, label)?.required, `${label} should be required`).toBe(true);
    }
    expect(labelled(fields, 'Middle Name')?.required).toBe(false);
  });

  it('sees the résumé upload as a file control', async () => {
    expect(labelled(await scanFields(), 'Resume')?.fieldType).toBe('file');
  });
});

describe('the scan survives every validating boundary', () => {
  it('passes detectedFieldSchema for every field, password included', async () => {
    for (const field of await scanFields()) {
      const parsed = detectedFieldSchema.safeParse(field);
      expect(parsed.success, `${field.label} (${field.fieldType}) was rejected`).toBe(true);
    }
  });

  it('passes the whole scan-result schema — the boundary that produced INVALID_SCAN_RESULT', async () => {
    const fields = await scanFields();
    const parsed = applicationScanResultSchema.safeParse({
      id: 'scan-icims',
      createdAt: '2026-08-02T09:00:00.000Z',
      url: 'https://careers2-quanta.icims.com/jobs/12345/login',
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'hostname careers2-quanta.icims.com matches iCIMS',
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
        file: 1,
        credentialFields: fields.filter(isPasswordField).length,
        navigationActions: 0,
      },
      durationMs: 4,
      status: 'completed',
      readOnly: true,
    });
    if (!parsed.success) {
      throw new Error(
        `The scan-result schema rejected the iCIMS page: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} (${issue.code})`)
          .join(', ')}`,
      );
    }
    expect(parsed.success).toBe(true);
  });

  it('still rejects a field type nothing emits', async () => {
    // The contract must stay a contract; accepting everything would pass every
    // other test in this file for the wrong reason.
    const [first] = await scanFields();
    expect(detectedFieldSchema.safeParse({ ...first, fieldType: 'quantum_flux' }).success).toBe(
      false,
    );
    expect(FIELD_TYPES).not.toContain('quantum_flux');
  });
});

describe('the password never leaves the deterministic path', () => {
  it('is not described to the model, and neither is the username', async () => {
    const fields = await scanFields();
    const scan = applicationScanResultSchema.parse({
      id: 'scan-icims',
      createdAt: '2026-08-02T09:00:00.000Z',
      url: 'https://careers2-quanta.icims.com/jobs/12345/login',
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'test',
        supported: true,
      },
      jobContext: {},
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
        file: 1,
        credentialFields: 2,
        navigationActions: 0,
      },
      durationMs: 4,
      status: 'completed',
      readOnly: true,
    });

    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const built = buildAnalysisRequest({ scan, plan, profile: profileFixture(), answers: [] });

    const questions = built.questions.map((question) => question.questionText);
    expect(questions).not.toContain('Password');
    expect(questions).not.toContain('Confirm Password');
    expect(questions).not.toContain('Username');

    // Nothing password-shaped anywhere in the serialized request.
    const serialized = JSON.stringify(built.request ?? {});
    expect(serialized).not.toMatch(/password/i);
  });

  it('plans no automatic value for the password field', async () => {
    const fields = await scanFields();
    const scan = applicationScanResultSchema.parse({
      id: 'scan-icims-2',
      createdAt: '2026-08-02T09:00:00.000Z',
      url: 'https://careers2-quanta.icims.com/jobs/12345/login',
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'test',
        supported: true,
      },
      jobContext: {},
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
        file: 1,
        credentialFields: 2,
        navigationActions: 0,
      },
      durationMs: 4,
      status: 'completed',
      readOnly: true,
    });

    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const passwordFields = fields.filter(isPasswordField).map((field) => field.id);
    for (const action of plan.actions) {
      if (!passwordFields.includes(action.fieldId)) continue;
      // The vault fills this, and only after the user has enabled it.
      expect(action.proposedValue).toBeUndefined();
      expect(action.action).not.toBe('fill_text');
    }
  });
});
