import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  applicationBundleTransferSchema,
  applicationScanResultSchema,
  dedupeQuestions,
  extensionSettingsSchema,
  resolveStructuralField,
  type DetectedField,
} from '@internship-agent/shared';
import {
  armAutoStart,
  disarmAutoStart,
  shouldAutoStart,
} from '../../extension/src/background/autoStart.js';
import { saveBundle, encodeBase64 } from '../../extension/src/storage/bundleStore.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { decideApproval } from '../../extension/src/autofill/approvalPolicy.js';
import { profileFixture } from './popupFixtures.js';
import { installChromeMock } from './setup.js';

/**
 * One action, start to finish.
 *
 * "Apply with Agent" was one click that led to several more: open the popup,
 * press Autofill, then work through a per-field review list. These pin the
 * shape it has to have instead — the run starts itself, the diagnostic surfaces
 * are gone unless asked for, and the questions that used to be deferred as
 * "no saved answer applies" are answered.
 */

const JOB_URL = 'https://careers2-quanta.icims.com/jobs/12345/field-engineer-intern/job';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function transfer() {
  return applicationBundleTransferSchema.parse({
    websiteJobId: 'job-1',
    company: 'Quanta',
    jobTitle: 'Field Engineer Intern',
    jobDescription: 'Field engineering internship.',
    officialApplicationUrl: JOB_URL,
    createdAt: '2026-08-03T09:00:00.000Z',
    approvedAnswers: [],
    documents: [
      {
        kind: 'resume',
        filename: 'Resume-Quanta.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(PDF),
        byteLength: PDF.length,
        generatedAt: '2026-08-03T09:00:00.000Z',
      },
      {
        kind: 'cover_letter',
        filename: 'Cover-Letter-Quanta.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(PDF),
        byteLength: PDF.length,
        generatedAt: '2026-08-03T09:00:00.000Z',
      },
    ],
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
});

describe('Apply with Agent starts the run by itself', () => {
  it('arms the employer origin when the bundle is stored, and fires once', async () => {
    const bundle = await saveBundle(transfer());
    await armAutoStart(bundle);

    // The employer page announces itself and the run begins — no second click.
    expect(await shouldAutoStart(JOB_URL, bundle)).toBe(true);
    // And exactly once: the arming is consumed, so a re-navigation or a second
    // frame cannot start a duplicate run.
    expect(await shouldAutoStart(JOB_URL, bundle)).toBe(false);
  });

  it('follows the applicant across a portal route hop', async () => {
    const bundle = await saveBundle(transfer());
    await armAutoStart(bundle);
    // /jobs/12345/.../job → /jobs/register has no path relationship at all.
    expect(await shouldAutoStart('https://careers2-quanta.icims.com/jobs/register', bundle)).toBe(
      true,
    );
  });

  it('never starts on an employer the user did not come from', async () => {
    const bundle = await saveBundle(transfer());
    await armAutoStart(bundle);
    expect(await shouldAutoStart('https://boards.greenhouse.io/other/jobs/9', bundle)).toBe(false);
  });

  it('never starts without an arming, however recent the bundle', async () => {
    const bundle = await saveBundle(transfer());
    await disarmAutoStart();
    // Opening the employer's site by hand later must not start filling a form.
    expect(await shouldAutoStart(JOB_URL, bundle)).toBe(false);
  });

  it('never starts when no bundle backs the page', async () => {
    const bundle = await saveBundle(transfer());
    await armAutoStart(bundle);
    expect(await shouldAutoStart(JOB_URL, null)).toBe(false);
  });
});

describe('developer tools are off by default', () => {
  it('ships developerMode false', () => {
    const settings = extensionSettingsSchema.parse({
      serverUrl: 'http://127.0.0.1:4318',
      authToken: '',
      selectedModel: 'model:latest',
      selectedDocumentId: null,
      ai: { generationModel: 'model:latest' },
      settingsVersion: 1,
      settingsUpdatedAt: new Date().toISOString(),
    });
    expect(settings.developerMode).toBe(false);
  });
});

describe('structural fields answer themselves', () => {
  function selectField(label: string, options: string[]): DetectedField {
    return {
      id: 'f',
      pageId: 'p',
      label,
      normalizedLabel: label.toLowerCase(),
      question: label,
      fieldType: 'select',
      selector: '#f',
      required: true,
      visible: true,
      disabled: false,
      confidence: 0.9,
      sourceSignals: ['label_for'],
      warnings: [],
      metadata: {},
      options: options.map((option) => ({ label: option, value: option.toLowerCase() })),
    };
  }

  it('picks Mobile for a phone type', () => {
    const resolved = resolveStructuralField(
      selectField('Phone Type', ['Please select', 'Mobile', 'Home', 'Work']),
    );
    expect(resolved?.option.label).toBe('Mobile');
  });

  it('picks Home for an address type', () => {
    const resolved = resolveStructuralField(
      selectField('Address Type', ['Please select', 'Home', 'Work', 'Other']),
    );
    expect(resolved?.option.label).toBe('Home');
  });

  it('never picks the first option merely because it exists', () => {
    // None of the offered answers is one this understands, so it says nothing
    // rather than selecting the placeholder or whatever happens to be first.
    const resolved = resolveStructuralField(
      selectField('Phone Type', ['Please select', 'Landline via switchboard', 'Pager']),
    );
    expect(resolved).toBeNull();
  });

  it('leaves a question about the person alone', () => {
    expect(
      resolveStructuralField(selectField('Have you previously worked for Quanta?', ['Yes', 'No'])),
    ).toBeNull();
    expect(
      resolveStructuralField(selectField('Do you have an employee referral?', ['Yes', 'No'])),
    ).toBeNull();
  });

  it('fills rather than deferring, through the planner and the policy', () => {
    const field = selectField('Phone Type', ['Please select', 'Mobile', 'Home', 'Work']);
    const scan = applicationScanResultSchema.parse({
      id: 'scan-1',
      createdAt: new Date().toISOString(),
      url: JOB_URL,
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims' as const,
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'hostname',
        supported: true,
      },
      jobContext: {},
      fields: [field],
      warnings: [],
      statistics: {
        total: 1,
        supported: 1,
        unknown: 0,
        required: 1,
        optional: 0,
        text: 0,
        textarea: 0,
        select: 1,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
        credentialFields: 0,
        navigationActions: 0,
      },
      durationMs: 1,
      status: 'completed',
      readOnly: true,
    });
    // The profile has nothing that answers "Phone Type" — this answer comes
    // from the form's own vocabulary, not from anything the user saved.
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const action = plan.actions[0]!;
    expect(action.action).toBe('select_option');
    expect(action.matchedOption?.label).toBe('Mobile');
    // And it clears the approval policy, so it actually gets typed.
    expect(decideApproval(action, DEFAULT_AUTOFILL_SETTINGS, field).approved).toBe(true);
  });
});

describe('repeated questions are asked once', () => {
  it('groups a policy checkbox the page renders twice', () => {
    const items = [
      { question: 'I Agree to the Policies stated above', fieldType: 'checkbox' },
      { question: 'I Agree to the Policies stated above', fieldType: 'checkbox' },
      { question: 'I agree to the policies stated above ', fieldType: 'checkbox' },
      { question: 'Desired salary', fieldType: 'text' },
    ];
    const deduped = dedupeQuestions(items);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((item) => item.question)).toEqual([
      'I Agree to the Policies stated above',
      'Desired salary',
    ]);
  });

  it('keeps two genuinely different questions apart', () => {
    const deduped = dedupeQuestions([
      { question: 'First name', fieldType: 'text' },
      { question: 'Last name', fieldType: 'text' },
    ]);
    expect(deduped).toHaveLength(2);
  });
});
