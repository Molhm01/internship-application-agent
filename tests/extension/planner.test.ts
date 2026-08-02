import { describe, expect, it } from 'vitest';
import {
  approvedAnswerSchema,
  applicationScanResultSchema,
  deterministicFillPlanSchema,
  profileSchema,
  type ApplicationScanResult,
  type SavedDocument,
} from '@internship-agent/shared';
import {
  approveSafeActions,
  buildDeterministicPlan,
  resetActionOverride,
  setActionApproval,
  updateActionOverride,
} from '../../extension/src/planner/deterministicPlanner.js';

const NOW = '2026-07-26T12:00:00.000Z';
const scan: ApplicationScanResult = applicationScanResultSchema.parse({
  id: 'scan-1',
  createdAt: NOW,
  url: 'https://example.test/apply',
  domain: 'example.test',
  ats: {
    id: 'generic',
    displayName: 'Generic HTML form',
    confidence: 1,
    detectionReason: 'fixture',
    supported: true,
  },
  jobContext: { sourceUrl: 'https://example.test/apply' },
  fields: [
    {
      id: 'first',
      pageId: 'page-1',
      label: 'First name',
      normalizedLabel: 'first name',
      canonicalKey: 'first_name',
      fieldType: 'text',
      question: 'First name',
      selector: '#first',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
    },
    {
      id: 'legal',
      pageId: 'page-1',
      label: 'I certify this is accurate',
      normalizedLabel: 'i certify this is accurate',
      fieldType: 'checkbox',
      question: 'I certify this is accurate',
      selector: '#legal',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['wrapped_label'],
    },
    {
      id: 'file',
      pageId: 'page-1',
      label: 'Resume',
      normalizedLabel: 'resume',
      canonicalKey: 'resume',
      fieldType: 'file',
      question: 'Resume',
      selector: '#resume',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
    },
  ],
  warnings: [],
  statistics: {
    total: 3,
    supported: 2,
    unknown: 0,
    required: 3,
    optional: 0,
    text: 1,
    textarea: 0,
    select: 0,
    combobox: 0,
    radio: 0,
    checkbox: 1,
    file: 1,
  },
  durationMs: 10,
  status: 'completed',
  readOnly: true,
});
const profile = profileSchema.parse({
  updatedAt: NOW,
  personal: { legalFirstName: 'Jordan', address: {} },
});
const selectedResume: SavedDocument = {
  id: 'document-1',
  name: 'Internship Resume',
  type: 'resume',
  filePath: 'C:\\private\\document-1-resume.pdf',
  fileName: 'document-1-resume.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  tags: [],
  targetRoles: [],
  targetIndustries: [],
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('deterministic fill planner', () => {
  it('validates plans and separates ready, review, and missing-information actions', () => {
    const plan = buildDeterministicPlan(scan, profile, []);
    expect(deterministicFillPlanSchema.safeParse(plan).success).toBe(true);
    // An upload field with no chosen document is missing information, not
    // unsupported: the executor can drive it as soon as a resume is selected.
    expect(plan.statistics).toMatchObject({
      total: 3,
      ready: 1,
      review: 1,
      missingInformation: 1,
      unsupported: 0,
    });
    expect(plan.actions.find((action) => action.fieldId === 'legal')?.action).toBe('manual_review');
    expect(plan.actions.find((action) => action.fieldId === 'file')?.action).toBe(
      'missing_information',
    );
    expect(plan.actions.find((action) => action.fieldId === 'file')?.reason).toContain(
      'No approved document selected',
    );
    expect(plan.actions.every((action) => !action.approved)).toBe(true);
  });

  it('assigns every action to exactly one statistics bucket', () => {
    const plan = buildDeterministicPlan(scan, profile, []);
    const { total, ready, approved, review, missingInformation, skipped, unsupported } =
      plan.statistics;
    expect(ready + approved + review + missingInformation + skipped + unsupported).toBe(total);
  });

  it('approves only safe high-confidence actions', () => {
    const approved = approveSafeActions(buildDeterministicPlan(scan, profile, []));
    expect(approved.actions.find((action) => action.fieldId === 'first')?.approved).toBe(true);
    expect(approved.actions.find((action) => action.fieldId === 'legal')?.approved).toBe(false);
    expect(approved.actions.find((action) => action.fieldId === 'file')?.approved).toBe(false);
  });

  it('proposes a selected resume but requires explicit upload approval', () => {
    const plan = buildDeterministicPlan(scan, profile, [], selectedResume);
    const upload = plan.actions.find((action) => action.fieldId === 'file');
    expect(upload).toMatchObject({
      action: 'upload_file',
      source: 'document',
      documentId: 'document-1',
      documentName: 'Internship Resume',
      requiresReview: true,
      approved: false,
    });
    expect(
      approveSafeActions(plan).actions.find((action) => action.fieldId === 'file')?.approved,
    ).toBe(false);
    expect(
      setActionApproval(plan, upload!.id, true).actions.find((action) => action.id === upload!.id),
    ).toMatchObject({ approved: true });
  });

  it('builds a standalone plan from the saved profile, approved answers, and résumé', () => {
    const standaloneScan = applicationScanResultSchema.parse({
      ...scan,
      fields: [
        scan.fields[0],
        {
          ...scan.fields[0],
          id: 'why-company',
          label: 'Why this company?',
          normalizedLabel: 'why this company',
          canonicalKey: 'why_this_company',
          question: 'Why this company?',
          selector: '#why-company',
        },
        scan.fields[2],
      ],
    });
    const answer = approvedAnswerSchema.parse({
      id: 'answer-1',
      canonicalQuestion: 'Why this company?',
      normalizedQuestion: 'why this company',
      aliases: [],
      answerType: 'text',
      answer: 'I value the company mission.',
      category: 'motivation',
      approved: true,
      autoFillAllowed: true,
      sensitive: false,
      tailoringAllowed: false,
      requiresReview: false,
      lastUpdatedAt: NOW,
    });

    const plan = buildDeterministicPlan(standaloneScan, profile, [answer], selectedResume);

    expect(plan.actions.find((action) => action.fieldId === 'first')?.source).toBe('profile');
    expect(plan.actions.find((action) => action.fieldId === 'why-company')).toMatchObject({
      source: 'approved_answer',
      proposedValue: 'I value the company mission.',
    });
    expect(plan.actions.find((action) => action.fieldId === 'file')).toMatchObject({
      source: 'document',
      documentId: 'document-1',
    });
  });

  it('persists approval mutations and resets user overrides', () => {
    const initial = buildDeterministicPlan(scan, profile, []);
    const first = initial.actions.find((action) => action.fieldId === 'first')!;
    const approved = setActionApproval(initial, first.id, true);
    expect(approved.actions.find((action) => action.id === first.id)?.approved).toBe(true);
    const overridden = updateActionOverride(approved, scan.fields[0]!, first.id, 'Taylor');
    expect(overridden.actions.find((action) => action.id === first.id)?.source).toBe(
      'user_override',
    );
    expect(overridden.actions.find((action) => action.id === first.id)?.approved).toBe(false);
    const reset = resetActionOverride(overridden, scan.fields[0]!, first.id);
    expect(reset.actions.find((action) => action.id === first.id)?.source).toBe('profile');
    expect(reset.actions.find((action) => action.id === first.id)?.proposedValue).toBe('Jordan');
  });
});
