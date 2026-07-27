import { describe, expect, it } from 'vitest';
import { formatValue, matchOption, type DetectedField } from '@internship-agent/shared';

const field = (overrides: Partial<DetectedField> = {}): DetectedField => ({
  id: 'field-1',
  pageId: 'page-1',
  label: 'Phone',
  normalizedLabel: 'phone',
  question: 'Phone',
  fieldType: 'tel',
  selector: '#phone',
  required: false,
  visible: true,
  disabled: false,
  confidence: 1,
  sourceSignals: ['label_for'],
  warnings: [],
  metadata: {},
  ...overrides,
});

describe('deterministic formatters', () => {
  it('formats phone placeholders without changing the stored value', () => {
    expect(
      formatValue(
        field({ canonicalKey: 'phone', placeholder: '(555) 555-5555' }),
        '+1 617 555 0142',
      ),
    ).toBe('(617) 555-0142');
  });

  it('formats native and display dates', () => {
    expect(
      formatValue(field({ fieldType: 'date', canonicalKey: 'earliest_start_date' }), '2028-05-10'),
    ).toBe('2028-05-10');
    expect(
      formatValue(field({ fieldType: 'text', canonicalKey: 'graduation_date' }), '2028-05'),
    ).toBe('May 2028');
  });

  it('matches exact aliases and rejects ambiguity', () => {
    expect(
      matchOption('United States', [
        { label: 'United States of America', value: 'US' },
        { label: 'Canada', value: 'CA' },
      ]).option,
    ).toEqual({ label: 'United States of America', value: 'US' });
    expect(
      matchOption("Bachelor's", [
        { label: "Bachelor's Degree", value: 'bs' },
        { label: 'Bachelor’s Degree', value: 'ba' },
      ]).ambiguous,
    ).toBe(true);
    expect(matchOption('Maybe', [{ label: 'Yes', value: 'yes' }]).matched).toBe(false);
  });
});
