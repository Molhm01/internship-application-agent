import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  detectedFieldSchema,
  plannedAnswerSchema,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import { isFinalSubmissionStage } from '../../extension/src/autofill/orchestrator.js';
import { decideApproval } from '../../extension/src/autofill/approvalPolicy.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { DEFAULT_AUTOFILL_SETTINGS } from '@internship-agent/shared';
import { profileFixture } from './popupFixtures.js';

/**
 * The guarantees that must hold no matter what the page, the model, or the
 * settings say. Each is asserted against behaviour, not against a comment.
 */

const EXTENSION_SOURCE = path.resolve(process.cwd(), 'extension/src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  const label = overrides.label ?? 'Question';
  return detectedFieldSchema.parse({
    id: overrides.id ?? 'field-1',
    pageId: 'page-1',
    label,
    normalizedLabel: label.toLowerCase(),
    question: label,
    fieldType: 'text',
    selector: `#${overrides.id ?? 'field-1'}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  });
}

function scanOf(fields: DetectedField[], url: string): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: 'scan-1',
    createdAt: '2026-08-02T09:00:00.000Z',
    url,
    domain: new URL(url).hostname,
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
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
      text: fields.length,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
    },
    durationMs: 2,
    status: 'completed',
    readOnly: true,
  });
}

describe('the application is never submitted', () => {
  it('has no submit call anywhere in the extension source', () => {
    for (const file of sourceFiles(EXTENSION_SOURCE)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('requestSubmit(');
      expect(source, file).not.toMatch(/\bform\.submit\s*\(/);
      expect(source, file).not.toMatch(/HTMLFormElement\.prototype\.submit/);
    }
  });

  it('stops on a review-and-submit step rather than acting on it', () => {
    expect(
      isFinalSubmissionStage(scanOf([], 'https://boards.example.com/apply/review-and-submit')),
    ).toBe(true);
    expect(
      isFinalSubmissionStage(scanOf([], 'https://boards.example.com/apply/submit-application')),
    ).toBe(true);
  });

  it('does not mistake an ordinary step with questions for the final step', () => {
    expect(
      isFinalSubmissionStage(
        scanOf([field({ label: 'First name' })], 'https://boards.example.com/apply/submit-application'),
      ),
    ).toBe(false);
  });
});

describe('CAPTCHA and MFA are never bypassed', () => {
  it('has no CAPTCHA or one-time-code solving anywhere in the source', () => {
    for (const file of sourceFiles(EXTENSION_SOURCE)) {
      const source = readFileSync(file, 'utf8');
      // Detecting them by name is required; solving them is not implemented and
      // must not be. These are the calls a bypass would need.
      expect(source, file).not.toMatch(/2captcha|anti-?captcha|capsolver|solveRecaptcha/i);
      expect(source, file).not.toMatch(/grecaptcha\.(execute|getResponse)/);
      expect(source, file).not.toMatch(/\botpauth:|totp\(|generateTotp/i);
    }
  });
});

describe('honeypots and disabled controls', () => {
  it('never reports a honeypot or a disabled control as answerable', async () => {
    document.documentElement.innerHTML = `
      <body><form>
        <label for="real">Email</label><input id="real" type="email">
        <div style="position:absolute;left:-9999px">
          <label for="trap">Leave blank</label><input id="trap" name="bot-field">
        </div>
        <label for="hidden-trap">Fax number</label>
        <input id="hidden-trap" name="fax-number">
        <label for="off">Referral code</label><input id="off" disabled>
      </form></body>`;
    const result = await scanDom(document, 'page-1', new AbortController().signal);
    const labels = result.fields.map((entry) => entry.label);
    expect(labels).toContain('Email');
    expect(labels).not.toContain('Leave blank');
    expect(labels).not.toContain('Fax number');
    expect(labels).not.toContain('Referral code');
  });
});

describe('sensitive answers are never inferred', () => {
  it.each([
    'Gender',
    'Race / Ethnicity',
    'Are you Hispanic or Latino?',
    'Veteran status',
    'Disability status',
    'Sexual orientation',
    'Are you a citizen of this country?',
    'Do you require visa sponsorship?',
    'Have you ever been convicted of a felony?',
    'Do you hold an active security clearance?',
    'What are your salary expectations?',
  ])('leaves "%s" for the user with no saved preference', (label) => {
    const target = field({
      id: 'sensitive',
      label,
      fieldType: 'select',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    const plan = buildDeterministicPlan(
      scanOf([target], 'https://boards.example.com/apply'),
      profileFixture(),
      [],
    );
    const action = plan.actions[0]!;
    expect(action.proposedValue, label).toBeUndefined();
    const decision = decideApproval(action, DEFAULT_AUTOFILL_SETTINGS, target);
    expect(decision.approved, label).toBe(false);
  });

  it('never auto-approves a legal attestation', () => {
    const target = field({
      id: 'attest',
      label: 'I certify that the information I have provided is accurate.',
      fieldType: 'checkbox',
    });
    const plan = buildDeterministicPlan(
      scanOf([target], 'https://boards.example.com/apply'),
      profileFixture(),
      [],
    );
    const decision = decideApproval(plan.actions[0]!, DEFAULT_AUTOFILL_SETTINGS, target);
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('manual_required');
  });
});

describe('the model cannot express a DOM operation', () => {
  it('has no field for a selector, a script, or an event', () => {
    const keys = Object.keys(
      plannedAnswerSchema.parse({
        questionId: 'question-a',
        action: 'SET_TEXT',
        value: 'x',
        confidence: 0.5,
      }),
    );
    for (const forbidden of ['selector', 'script', 'javascript', 'code', 'event', 'xpath']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is never evaluated anywhere in the extension', () => {
    for (const file of sourceFiles(EXTENSION_SOURCE)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\beval\s*\(/);
      expect(source, file).not.toMatch(/new\s+Function\s*\(/);
      expect(source, file).not.toMatch(/\bsetTimeout\s*\(\s*['"`]/);
    }
  });
});
