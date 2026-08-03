import { describe, expect, it } from 'vitest';
import {
  QuestionLedger,
  optionSignature,
  questionIdentity,
  questionSignature,
  type DetectedField,
} from '@internship-agent/shared';

/**
 * The loop has to converge.
 *
 * `MAX_ITERATIONS_REACHED — stopped after five passes` was not a form that kept
 * revealing work. It was a loop whose only exit condition was "did this pass
 * approve any action whose field is not yet verified" — and a field that is
 * approved, written, and then *fails verification* is never verified. So every
 * pass re-approved and re-executed the identical failing set, learned nothing,
 * and exhausted the limit. On the live iCIMS page the six unfillable fields
 * drove exactly that, which is why only two fields ever landed.
 *
 * These pin the ledger that replaced the check.
 */

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    pageId: 'page-1',
    label: 'First Name',
    normalizedLabel: 'first name',
    question: 'First Name',
    fieldType: 'text',
    selector: '#first-name',
    required: true,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: { name: 'firstName', elementId: 'firstName' },
    ...overrides,
  };
}

describe('a question that cannot be filled is attempted once, not five times', () => {
  it('stops offering a field whose fill failed verification', () => {
    const ledger = new QuestionLedger();
    const unfillable = field({ question: 'Middle Name', normalizedLabel: 'middle name' });

    expect(ledger.shouldAttempt(unfillable)).toBe(true);
    ledger.record(unfillable, 'unverified');

    // This is the exact case that looped. Nothing about the field changed, so
    // re-running the planner, the model and the executor over it would produce
    // the identical failure — five times, then the limit.
    expect(ledger.shouldAttempt(unfillable)).toBe(false);
    expect(ledger.shouldAttempt(unfillable)).toBe(false);
    expect(ledger.attemptsFor(unfillable)).toBe(1);
  });

  it('stops offering a field that filled and verified', () => {
    const ledger = new QuestionLedger();
    const target = field();
    ledger.record(target, 'verified');
    expect(ledger.shouldAttempt(target)).toBe(false);
    expect(ledger.isVerified(target)).toBe(true);
  });

  it('does retry a question whose options repopulated', () => {
    const ledger = new QuestionLedger();
    const state = field({
      question: 'State',
      normalizedLabel: 'state',
      fieldType: 'select',
      metadata: { name: 'state' },
      options: [],
    });
    ledger.record(state, 'unverified');
    expect(ledger.shouldAttempt(state)).toBe(false);

    // A dependent dropdown that fills in after Country is answered is genuinely
    // new work, and must not be starved by the convergence check.
    const populated = { ...state, options: [{ label: 'Texas', value: 'TX' }] };
    expect(ledger.shouldAttempt(populated)).toBe(true);
  });

  it('does retry a question that has just become required', () => {
    const ledger = new QuestionLedger();
    const optional = field({ required: false });
    ledger.record(optional, 'unverified');
    expect(ledger.shouldAttempt({ ...optional, required: true })).toBe(true);
  });
});

describe('identity survives a rerender', () => {
  it('is unchanged when the framework regenerates the scanner id and selector', () => {
    const before = field({ id: 'field-1', selector: '#first-name' });
    // Same control, re-rendered: the scanner's own id and the selector move,
    // the employer's `name` does not.
    const after = field({ id: 'field-47', selector: 'form > div:nth-child(3) input' });
    expect(questionIdentity(after)).toBe(questionIdentity(before));
  });

  it('separates two questions that share a label but nothing else', () => {
    const home = field({
      question: 'Phone Number',
      normalizedLabel: 'phone number',
      metadata: { name: 'homePhone' },
    });
    const mobile = field({
      question: 'Phone Number',
      normalizedLabel: 'phone number',
      metadata: { name: 'mobilePhone' },
    });
    expect(questionIdentity(home)).not.toBe(questionIdentity(mobile));
  });

  it('separates two unlabelled questions the markup does not name', () => {
    // With nothing identifying in the markup, the selector discriminates.
    // Merging them would make a genuinely new field look already-attempted,
    // which is a worse failure than attempting one field twice.
    const first = field({ metadata: {}, selector: '#a', question: 'Question' });
    const second = field({ metadata: {}, selector: '#b', question: 'Question' });
    expect(questionIdentity(first)).not.toBe(questionIdentity(second));
  });

  it('reads an option signature independently of order', () => {
    const ascending = field({
      fieldType: 'select',
      options: [
        { label: 'Alabama', value: 'AL' },
        { label: 'Texas', value: 'TX' },
      ],
    });
    const descending = field({
      fieldType: 'select',
      options: [
        { label: 'Texas', value: 'TX' },
        { label: 'Alabama', value: 'AL' },
      ],
    });
    expect(optionSignature(ascending)).toBe(optionSignature(descending));
    expect(questionSignature(ascending)).toBe(questionSignature(descending));
  });
});

describe('the delta after a rescan', () => {
  it('reports only questions never seen before', () => {
    const ledger = new QuestionLedger();
    const existing = field({ metadata: { name: 'firstName' } });
    const revealed = field({
      question: 'Visa Type',
      normalizedLabel: 'visa type',
      metadata: { name: 'visaType' },
    });

    ledger.observe(existing);
    // A rescan of a 26-field page returns all 26; only the new one is work.
    const unseen = ledger.unseen([existing, revealed]);
    expect(unseen).toHaveLength(1);
    expect(unseen[0]?.question).toBe('Visa Type');

    ledger.observe(revealed);
    expect(ledger.unseen([existing, revealed])).toHaveLength(0);
  });

  it('does not count a re-rendered page as new work', () => {
    const ledger = new QuestionLedger();
    const page = [
      field({ metadata: { name: 'firstName' } }),
      field({
        question: 'Last Name',
        normalizedLabel: 'last name',
        metadata: { name: 'lastName' },
      }),
    ];
    for (const entry of page) ledger.observe(entry);

    // The same page, re-rendered with fresh scanner ids and selectors. This is
    // what a debounced rescan actually returns, and counting it as new work is
    // what kept the loop running.
    const rerendered = page.map((entry, index) => ({
      ...entry,
      id: `regenerated-${index}`,
      selector: `form > div:nth-child(${index + 9}) input`,
    }));
    expect(ledger.unseen(rerendered)).toHaveLength(0);
  });
});
