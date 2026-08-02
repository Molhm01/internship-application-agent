import { describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  detectedFieldSchema,
  type ApplicationBundle,
  type ApplicationScanResult,
  type DetectedField,
  type SavedDocument,
} from '@internship-agent/shared';
import {
  attachBundleDocuments,
  classifyUploadField,
  isBundleDocumentReference,
  uploadFields,
} from '../../extension/src/uploads/bundleUploads.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';

const NOW = '2026-08-02T09:00:00.000Z';

function fileField(overrides: Partial<DetectedField> = {}): DetectedField {
  const label = overrides.label ?? 'Resume';
  return detectedFieldSchema.parse({
    id: overrides.id ?? 'upload-1',
    pageId: 'page-1',
    label,
    normalizedLabel: label.toLowerCase(),
    // The question is the label unless a test says otherwise; defaulting it to
    // "Resume" would make every unlabelled-slot test silently pass.
    question: label,
    fieldType: 'file',
    selector: `#${overrides.id ?? 'upload-1'}`,
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

function scanOf(fields: DetectedField[]): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: 'scan-1',
    createdAt: NOW,
    url: 'https://boards.example.com/apply',
    domain: 'boards.example.com',
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
      supported: 0,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: fields.length,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 3,
    status: 'completed',
    readOnly: true,
  });
}

const BUNDLE: ApplicationBundle = {
  id: 'bundle-xyz-job-42',
  websiteJobId: 'job-42',
  company: 'Northwind Robotics',
  jobTitle: 'SWE Intern',
  jobDescription: '',
  officialApplicationUrl: 'https://boards.example.com/apply',
  resume: {
    kind: 'resume',
    filename: 'Resume-Northwind-Robotics.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-xyz-job-42:resume',
    byteLength: 120,
    generatedAt: NOW,
  },
  coverLetter: {
    kind: 'cover_letter',
    filename: 'Cover-Letter-Northwind-Robotics.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-xyz-job-42:cover_letter',
    byteLength: 90,
    generatedAt: NOW,
  },
  approvedAnswers: [],
  createdAt: NOW,
};

/** The generic server-registered résumé, which must lose to the tailored one. */
const MASTER_RESUME: SavedDocument = {
  id: 'document-master',
  name: 'Master Resume',
  type: 'resume',
  filePath: 'C:\\private\\master.pdf',
  fileName: 'master-resume.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 200,
  tags: [],
  targetRoles: [],
  targetIndustries: [],
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function bind(fields: DetectedField[], bundle = BUNDLE, master?: SavedDocument) {
  const scan = scanOf(fields);
  const plan = buildDeterministicPlan(scan, profileFixture(), [], master);
  return {
    scan,
    plan: attachBundleDocuments(plan, scan, bundle),
    before: plan,
  };
}

function actionFor(plan: ReturnType<typeof bind>['plan'], fieldId: string) {
  return plan.actions.find((action) => action.fieldId === fieldId);
}

describe('classifying an upload field', () => {
  it.each([
    ['Resume', 'resume'],
    ['Resume/CV', 'resume'],
    ['Curriculum Vitae', 'resume'],
    ['Cover Letter', 'cover_letter'],
    ['Covering letter (optional)', 'cover_letter'],
    ['Motivation letter', 'cover_letter'],
    ['Academic transcript', 'transcript'],
    ['Portfolio', 'portfolio'],
    ['Writing sample', 'portfolio'],
    ['Other supporting document', 'other'],
  ])('reads "%s" as %s', (label, expected) => {
    expect(
      classifyUploadField(
        fileField({ label, normalizedLabel: label.toLowerCase(), question: label }),
      ),
    ).toBe(expected);
  });

  it('reads the surrounding instructions when the label says nothing', () => {
    expect(
      classifyUploadField(
        fileField({
          label: 'Attach a file',
          normalizedLabel: 'attach a file',
          question: 'Attach a file',
          metadata: { uploadInstructions: 'Please upload your cover letter here — accepts .pdf' },
        }),
      ),
    ).toBe('cover_letter');
  });

  it('reports an unlabelled generic slot as unknown rather than guessing résumé', () => {
    expect(
      classifyUploadField(
        fileField({
          label: 'Upload document',
          normalizedLabel: 'upload document',
          question: 'Upload document',
        }),
      ),
    ).toBe('unknown');
  });

  it('lists only visible, enabled upload fields', () => {
    const scan = scanOf([
      fileField({ id: 'a' }),
      fileField({ id: 'b', visible: false }),
      fileField({ id: 'c', disabled: true }),
    ]);
    expect(uploadFields(scan).map((slot) => slot.field.id)).toEqual(['a']);
  });
});

describe('binding tailored documents to upload fields', () => {
  it('attaches the tailored résumé to the résumé field with its filename and bundle reference', () => {
    const { plan } = bind([
      fileField({ id: 'resume-field', label: 'Resume', normalizedLabel: 'resume' }),
    ]);
    const action = actionFor(plan, 'resume-field');
    expect(action?.action).toBe('upload_file');
    expect(action?.documentId).toBe('bundle-xyz-job-42:resume');
    expect(action?.documentName).toBe('Resume-Northwind-Robotics.pdf');
    expect(isBundleDocumentReference(action?.documentId)).toBe(true);
  });

  it('attaches the cover letter to the cover-letter field', () => {
    const { plan } = bind([
      fileField({ id: 'cover-field', label: 'Cover letter', normalizedLabel: 'cover letter' }),
    ]);
    const action = actionFor(plan, 'cover-field');
    expect(action?.documentId).toBe('bundle-xyz-job-42:cover_letter');
    expect(action?.documentName).toBe('Cover-Letter-Northwind-Robotics.pdf');
  });

  it('never puts the cover letter in the résumé field, or the résumé in the cover-letter field', () => {
    const { plan } = bind([
      fileField({ id: 'resume-field', label: 'Resume', normalizedLabel: 'resume' }),
      fileField({ id: 'cover-field', label: 'Cover letter', normalizedLabel: 'cover letter' }),
    ]);
    expect(actionFor(plan, 'resume-field')?.documentName).toContain('Resume');
    expect(actionFor(plan, 'resume-field')?.documentName).not.toContain('Cover');
    expect(actionFor(plan, 'cover-field')?.documentName).toContain('Cover');
    expect(actionFor(plan, 'cover-field')?.documentName).not.toMatch(/^Resume/);
  });

  it('uses the tailored résumé rather than the registered master résumé', () => {
    const { plan, before } = bind(
      [fileField({ id: 'resume-field', label: 'Resume', normalizedLabel: 'resume' })],
      BUNDLE,
      MASTER_RESUME,
    );
    // The deterministic planner had picked the master résumé; the bundle wins.
    expect(actionFor(before, 'resume-field')?.documentId).toBe('document-master');
    expect(actionFor(plan, 'resume-field')?.documentId).toBe('bundle-xyz-job-42:resume');
    expect(actionFor(plan, 'resume-field')?.documentName).not.toBe('Master Resume');
  });

  it('leaves a transcript field for the user instead of attaching something else', () => {
    const { plan } = bind([
      fileField({ id: 'transcript', label: 'Transcript', normalizedLabel: 'transcript' }),
    ]);
    const action = actionFor(plan, 'transcript');
    expect(action?.action).toBe('missing_information');
    expect(action?.documentId).toBeUndefined();
    expect(action?.reason).toContain('transcript');
  });

  it('says so when the form wants a cover letter and none was generated', () => {
    const { plan } = bind(
      [fileField({ id: 'cover-field', label: 'Cover letter', normalizedLabel: 'cover letter' })],
      { ...BUNDLE, coverLetter: undefined },
    );
    const action = actionFor(plan, 'cover-field');
    expect(action?.action).toBe('missing_information');
    expect(action?.reason).toContain('none was generated');
    expect(action?.warnings.join(' ')).toContain('Generate a tailored cover letter');
  });

  it('uses the résumé for a lone unlabelled slot, and flags it for confirmation', () => {
    const { plan } = bind([
      fileField({ id: 'only', label: 'Upload document', normalizedLabel: 'upload document' }),
    ]);
    const action = actionFor(plan, 'only');
    expect(action?.documentId).toBe('bundle-xyz-job-42:resume');
    expect(action?.requiresReview).toBe(true);
    expect(action?.warnings.join(' ')).toContain('one unlabelled upload');
  });

  it('does not assume the résumé when the lone slot mentions a cover letter', () => {
    const { plan } = bind([
      fileField({
        id: 'combined',
        label: 'Upload document',
        normalizedLabel: 'upload document',
        metadata: { nearbyText: 'Combine your resume and cover letter into one PDF.' },
      }),
    ]);
    // "resume and cover letter" reads as cover_letter first, which is the
    // conservative outcome: the user decides what a combined slot receives.
    expect(actionFor(plan, 'combined')?.documentName).not.toBe('Resume-Northwind-Robotics.pdf');
  });

  it('leaves an ambiguous slot alone when the page has several uploads', () => {
    const { plan } = bind([
      fileField({ id: 'resume-field', label: 'Resume', normalizedLabel: 'resume' }),
      fileField({ id: 'mystery', label: 'Upload document', normalizedLabel: 'upload document' }),
    ]);
    expect(actionFor(plan, 'resume-field')?.action).toBe('upload_file');
    const mystery = actionFor(plan, 'mystery');
    expect(mystery?.action).toBe('missing_information');
    expect(mystery?.reason).toContain('does not say which document it wants');
  });

  it('never approves an upload on its own', () => {
    const { plan } = bind([
      fileField({ id: 'resume-field', label: 'Resume', normalizedLabel: 'resume' }),
    ]);
    const action = actionFor(plan, 'resume-field');
    expect(action?.approved).toBe(false);
    expect(action?.requiresReview).toBe(true);
    expect(action?.warnings.join(' ')).toContain('never submit');
  });
});

describe('bundle document references', () => {
  it('recognizes a bundle reference and rejects a server document id', () => {
    expect(isBundleDocumentReference('bundle-xyz-job-42:resume')).toBe(true);
    expect(isBundleDocumentReference('bundle-xyz-job-42:cover_letter')).toBe(true);
    expect(isBundleDocumentReference('document-master')).toBe(false);
    expect(isBundleDocumentReference(undefined)).toBe(false);
    expect(isBundleDocumentReference('bundle-xyz:transcript')).toBe(false);
  });
});
