import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  applicationBundleSchema,
  applicationScanResultSchema,
  applicationBundleTransferSchema,
  bundleMatchesUrl,
  bundleSharesPortal,
  detectedFieldSchema,
  type ApplicationBundle,
  type ApplicationBundleTransfer,
  type SavedDocument,
} from '@internship-agent/shared';
import { attachBundleDocuments } from '../../extension/src/uploads/bundleUploads.js';
import {
  bundleForUrl,
  encodeBase64,
  rememberPortalJourney,
  saveBundle,
} from '../../extension/src/storage/bundleStore.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';
import { installChromeMock } from './setup.js';

/**
 * The application bundle has to survive the walk from the job posting to the
 * account form.
 *
 * iCIMS sends the applicant from `/jobs/12345/job` to `/jobs/login` and then to
 * `/jobs/register`. None of those share a path prefix, so a path-based bundle
 * lookup drops the tailored documents at exactly the step where the account is
 * being created for them — and the panel goes from naming the job to "No
 * application loaded".
 */

const NOW = '2026-08-03T09:00:00.000Z';
const JOB_URL = 'https://careers2-quanta.icims.com/jobs/12345/field-engineer-intern/job';

function bundle(overrides: Partial<ApplicationBundle> = {}): ApplicationBundle {
  return applicationBundleSchema.parse({
    id: 'bundle-quanta',
    websiteJobId: 'job-1',
    company: 'Quanta',
    jobTitle: 'Field Engineer Intern',
    jobDescription: '',
    officialApplicationUrl: JOB_URL,
    approvedAnswers: [],
    resume: {
      kind: 'resume',
      filename: 'Resume-Quanta-Field-Engineer-Intern.pdf',
      mimeType: 'application/pdf',
      bytesReference: 'bundle-quanta:resume',
      byteLength: 1024,
      generatedAt: NOW,
    },
    coverLetter: {
      kind: 'cover_letter',
      filename: 'Cover-Letter-Quanta-Field-Engineer-Intern.pdf',
      mimeType: 'application/pdf',
      bytesReference: 'bundle-quanta:cover_letter',
      byteLength: 2048,
      generatedAt: NOW,
    },
    createdAt: NOW,
    ...overrides,
  });
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function transfer(): ApplicationBundleTransfer {
  return applicationBundleTransferSchema.parse({
    websiteJobId: 'job-1',
    company: 'Quanta',
    jobTitle: 'Field Engineer Intern',
    jobDescription: '',
    officialApplicationUrl: JOB_URL,
    createdAt: NOW,
    approvedAnswers: [],
    documents: [
      {
        kind: 'resume',
        filename: 'Resume-Quanta-Field-Engineer-Intern.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(PDF),
        byteLength: PDF.length,
        generatedAt: NOW,
      },
      {
        kind: 'cover_letter',
        filename: 'Cover-Letter-Quanta-Field-Engineer-Intern.pdf',
        mimeType: 'application/pdf',
        contentBase64: encodeBase64(PDF),
        byteLength: PDF.length,
        generatedAt: NOW,
      },
    ],
  });
}

beforeEach(() => {
  // A clean database per test; IndexedDB otherwise persists across the file.
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
});

describe('a bundle across an account-route navigation', () => {
  const hops = [
    ['the sign-in page', 'https://careers2-quanta.icims.com/jobs/login'],
    ['the New User page', 'https://careers2-quanta.icims.com/jobs/register'],
    ['the account form', 'https://careers2-quanta.icims.com/connect?jobid=12345'],
    [
      'the application form',
      'https://careers2-quanta.icims.com/jobs/12345/field-engineer-intern/candidate',
    ],
  ] as const;

  for (const [name, url] of hops) {
    it(`still belongs to this application on ${name}`, async () => {
      installChromeMock();
      await saveBundle(transfer());
      // What the background records the moment it takes a route.
      await rememberPortalJourney(url);
      const found = await bundleForUrl(url);
      expect(found?.company).toBe('Quanta');
    });
  }

  it('keeps the tailored résumé and cover letter available across every hop', async () => {
    installChromeMock();
    await saveBundle(transfer());
    for (const [, url] of hops) {
      await rememberPortalJourney(url);
      const found = await bundleForUrl(url);
      expect(found?.resume?.filename).toBe('Resume-Quanta-Field-Engineer-Intern.pdf');
      expect(found?.coverLetter?.filename).toBe('Cover-Letter-Quanta-Field-Engineer-Intern.pdf');
    }
  });

  it('does not follow the applicant onto a different employer', async () => {
    installChromeMock();
    await saveBundle(transfer());
    await rememberPortalJourney(hops[0][1]);
    expect(await bundleForUrl('https://careers2-other.icims.com/jobs/login')).toBeNull();
    expect(await bundleForUrl('https://boards.greenhouse.io/other/jobs/9')).toBeNull();
  });

  it('does not follow the applicant to a page the agent never routed them to', async () => {
    installChromeMock();
    await saveBundle(transfer());
    // No journey recorded: the user simply browsed to another posting on the
    // same portal. Same origin is not, on its own, the same application.
    expect(await bundleForUrl('https://careers2-quanta.icims.com/jobs/999/other/job')).toBeNull();
  });

  it('leaves the strict page match unchanged, so history lookups stay isolated', () => {
    expect(bundleSharesPortal(bundle(), 'https://careers2-quanta.icims.com/jobs/login')).toBe(true);
    expect(bundleMatchesUrl(bundle(), 'https://careers2-quanta.icims.com/jobs/login')).toBe(false);
    expect(bundleSharesPortal(bundle(), 'https://boards.greenhouse.io/other/jobs/9')).toBe(false);
  });
});

describe('the default résumé is never substituted for a tailored one', () => {
  const resumeField = detectedFieldSchema.parse({
    id: 'resume-upload',
    pageId: 'page-1',
    label: 'Attach Resume',
    normalizedLabel: 'attach resume',
    question: 'Attach Resume',
    fieldType: 'file',
    selector: '#resume',
    required: true,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
  });

  const scan = applicationScanResultSchema.parse({
    id: 'scan-1',
    createdAt: NOW,
    url: JOB_URL,
    domain: 'careers2-quanta.icims.com',
    ats: {
      id: 'icims',
      displayName: 'iCIMS',
      confidence: 0.98,
      detectionReason: 'hostname',
      supported: true,
    },
    jobContext: {},
    fields: [resumeField],
    warnings: [],
    statistics: {
      total: 1,
      supported: 0,
      unknown: 0,
      required: 1,
      optional: 0,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 1,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 3,
    status: 'completed',
    readOnly: true,
  });

  /** The generic saved résumé the planner reaches for when nothing better exists. */
  const masterResume: SavedDocument = {
    id: 'document-master',
    name: 'Master Resume',
    type: 'resume',
    filePath: 'C:\\private\\master.pdf',
    fileName: 'Generic-Resume.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 200,
    tags: [],
    targetRoles: [],
    targetIndustries: [],
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  function planFor(withBundle: ApplicationBundle) {
    const plan = buildDeterministicPlan(scan, profileFixture(), [], masterResume);
    return attachBundleDocuments(plan, scan, withBundle);
  }

  it('marks the upload as missing rather than attaching the default', () => {
    const action = planFor(bundle({ resume: undefined })).actions.find(
      (candidate) => candidate.fieldId === 'resume-upload',
    )!;

    expect(action.action).toBe('missing_information');
    expect(action.requiresReview).toBe(true);
    expect(action.reason).toMatch(/no tailored résumé/i);
    expect(action.warnings.join(' ')).toMatch(/default résumé was not used/i);
    // The generic document must not survive as the thing that gets uploaded.
    expect(JSON.stringify(action)).not.toContain('Generic-Resume.pdf');
    // Not merely relabelled: the pointer the executor would resolve is gone.
    // The provenance in `sourceReference` stays, because explaining where the
    // rejected suggestion came from is the point of the review entry.
    expect(action.documentId).toBeUndefined();
    expect(action.documentName).toBeUndefined();
  });

  it('attaches the tailored résumé when the bundle carries one', () => {
    const action = planFor(bundle()).actions.find(
      (candidate) => candidate.fieldId === 'resume-upload',
    )!;
    expect(action.action).toBe('upload_file');
    expect(action.documentName).toBe('Resume-Quanta-Field-Engineer-Intern.pdf');
    expect(action.documentId).toBe('bundle-quanta:resume');
  });
});
