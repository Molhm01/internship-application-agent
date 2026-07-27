import { describe, expect, it, vi } from 'vitest';
import {
  applicationScanResultSchema,
  deterministicFillPlanSchema,
  type DeterministicFillAction,
  type DetectedField,
} from '@internship-agent/shared';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import { validatePageIdentity } from '../../extension/src/executor/pageProtection.js';

const field = (
  id: string,
  fieldType: DetectedField['fieldType'],
  selector = `#${id}`,
  overrides: Partial<DetectedField> = {},
): DetectedField => ({
  id,
  pageId: 'page-1',
  label: id,
  normalizedLabel: id,
  question: id,
  fieldType,
  selector,
  required: false,
  visible: true,
  disabled: false,
  confidence: 1,
  sourceSignals: ['label_for'],
  warnings: [],
  metadata: {
    tagName: fieldType === 'textarea' ? 'textarea' : fieldType === 'select' ? 'select' : 'input',
  },
  ...overrides,
});

const action = (
  target: DetectedField,
  kind: DeterministicFillAction['action'],
  value: DeterministicFillAction['proposedValue'],
  overrides: Partial<DeterministicFillAction> = {},
): DeterministicFillAction => ({
  id: `action-${target.id}`,
  fieldId: target.id,
  question: target.question,
  fieldType: target.fieldType,
  action: kind,
  proposedValue: value,
  source: 'profile',
  confidence: 1,
  sensitive: false,
  requiresReview: false,
  approved: true,
  reason: 'unit test',
  warnings: [],
  ...overrides,
});

describe('deterministic DOM executor', () => {
  it('uses native setters, framework events, and verification for text/date values', async () => {
    document.body.innerHTML =
      '<label for="name">name</label><input id="name"><label for="date">date</label><input id="date" type="date">';
    const controlled = document.querySelector<HTMLInputElement>('#name')!;
    const listener = vi.fn((event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      queueMicrotask(() => {
        controlled.value = value;
      });
    });
    controlled.addEventListener('input', listener);
    const nameField = field('name', 'text');
    const result = await executeDomAction(
      document,
      nameField,
      action(nameField, 'fill_text', 'Jordan'),
      new AbortController().signal,
    );
    expect(result.status).toBe('verified');
    expect(result.attempts).toBe(1);
    expect(controlled.value).toBe('Jordan');
    expect(listener).toHaveBeenCalled();

    const dateField = field('date', 'date');
    const dateResult = await executeDomAction(
      document,
      dateField,
      action(dateField, 'set_date', '2028-05-10'),
      new AbortController().signal,
    );
    expect(dateResult.status).toBe('verified');
  });

  it('fills and verifies select, radio, single checkbox, and checkbox groups', async () => {
    document.body.innerHTML = `
      <select id="country"><option value="">Choose</option><option value="US">USA</option></select>
      <input id="yes" type="radio" name="answer" value="yes"><input type="radio" name="answer" value="no">
      <input id="accepted" type="checkbox">
      <input id="ts" type="checkbox" name="languages" value="ts"><input type="checkbox" name="languages" value="py">
    `;
    const country = field('country', 'select', '#country', {
      options: [{ label: 'USA', value: 'US' }],
      metadata: { tagName: 'select' },
    });
    expect(
      (
        await executeDomAction(
          document,
          country,
          action(country, 'select_option', 'US', {
            matchedOption: { label: 'USA', value: 'US' },
          }),
          new AbortController().signal,
        )
      ).status,
    ).toBe('verified');

    const radio = field('radio', 'radio', '#yes', {
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    expect(
      (
        await executeDomAction(
          document,
          radio,
          action(radio, 'choose_radio', 'yes', {
            matchedOption: { label: 'Yes', value: 'yes' },
          }),
          new AbortController().signal,
        )
      ).status,
    ).toBe('verified');

    const checkbox = field('accepted', 'checkbox');
    expect(
      (
        await executeDomAction(
          document,
          checkbox,
          action(checkbox, 'toggle_checkbox', true),
          new AbortController().signal,
        )
      ).status,
    ).toBe('verified');

    const group = field('languages', 'multi_select', '#ts');
    expect(
      (
        await executeDomAction(
          document,
          group,
          action(group, 'toggle_checkbox', ['ts']),
          new AbortController().signal,
        )
      ).status,
    ).toBe('verified');
    expect(document.querySelector<HTMLInputElement>('input[value="py"]')?.checked).toBe(false);
  });

  it('fails verification visibly and never exceeds two attempts', async () => {
    document.body.innerHTML = '<input id="rejected">';
    const input = document.querySelector<HTMLInputElement>('#rejected')!;
    input.addEventListener('input', () => queueMicrotask(() => (input.value = '')));
    const rejected = field('rejected', 'text');
    const result = await executeDomAction(
      document,
      rejected,
      action(rejected, 'fill_text', 'value'),
      new AbortController().signal,
    );
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('VALUE_NOT_VERIFIED');
    expect(result.attempts).toBe(2);
  });
});

describe('page change protection', () => {
  it('requires URL, domain, scan id, and plan identity to match', () => {
    const scan = applicationScanResultSchema.parse({
      id: 'scan-1',
      createdAt: '2026-07-26T12:00:00.000Z',
      url: 'https://example.test/apply',
      domain: 'example.test',
      ats: {
        id: 'generic',
        displayName: 'Generic',
        confidence: 1,
        detectionReason: 'test',
        supported: true,
      },
      jobContext: { sourceUrl: 'https://example.test/apply' },
      fields: [],
      warnings: [],
      statistics: {
        total: 0,
        supported: 0,
        unknown: 0,
        required: 0,
        optional: 0,
        text: 0,
        textarea: 0,
        select: 0,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
      },
      durationMs: 1,
      status: 'completed',
      readOnly: true,
    });
    const plan = deterministicFillPlanSchema.parse({
      id: 'plan-1',
      scanId: scan.id,
      createdAt: scan.createdAt,
      updatedAt: scan.createdAt,
      url: scan.url,
      domain: scan.domain,
      ats: 'generic',
      actions: [],
      warnings: [],
      statistics: { total: 0, ready: 0, review: 0, skipped: 0, unsupported: 0, sensitive: 0 },
    });
    expect(validatePageIdentity(scan.url, scan, plan).valid).toBe(true);
    expect(validatePageIdentity('https://example.test/other', scan, plan).valid).toBe(false);
  });
});
