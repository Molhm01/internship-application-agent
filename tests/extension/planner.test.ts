import { describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  deterministicFillPlanSchema,
  profileSchema,
  type ApplicationScanResult,
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

describe('deterministic fill planner', () => {
  it('validates plans and separates ready, review, and unsupported actions', () => {
    const plan = buildDeterministicPlan(scan, profile, []);
    expect(deterministicFillPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.statistics).toMatchObject({ total: 3, ready: 1, review: 1, unsupported: 1 });
    expect(plan.actions.find((action) => action.fieldId === 'legal')?.action).toBe('manual_review');
    expect(plan.actions.find((action) => action.fieldId === 'file')?.action).toBe('unsupported');
    expect(plan.actions.every((action) => !action.approved)).toBe(true);
  });

  it('approves only safe high-confidence actions', () => {
    const approved = approveSafeActions(buildDeterministicPlan(scan, profile, []));
    expect(approved.actions.find((action) => action.fieldId === 'first')?.approved).toBe(true);
    expect(approved.actions.find((action) => action.fieldId === 'legal')?.approved).toBe(false);
    expect(approved.actions.find((action) => action.fieldId === 'file')?.approved).toBe(false);
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
