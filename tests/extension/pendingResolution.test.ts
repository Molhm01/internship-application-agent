import { describe, expect, it } from 'vitest';
import {
  autofillFieldResultSchema,
  finalizePendingResult,
  isPendingResult,
  pendingResults,
  type AutofillFieldResult,
} from '@internship-agent/shared';

/**
 * A stage marker is not a verdict.
 *
 * The deterministic pass marks a field it could not settle as pending and hands
 * it to the batched analysis. When that analysis did not run, the marker was
 * rendered verbatim: eighteen cards reading `"<question>" is waiting on the
 * page analysis`, above a summary claiming nothing needed confirmation and
 * nothing had failed. These pin the distinction the runtime was missing.
 */

function result(overrides: Partial<AutofillFieldResult> = {}): AutofillFieldResult {
  return autofillFieldResultSchema.parse({
    fieldId: 'field-1',
    question: 'Are you willing to relocate?',
    action: 'missing_information',
    source: 'none',
    confidence: 0,
    sensitive: false,
    verification: 'not_attempted',
    reviewed: false,
    reason: '"Are you willing to relocate?" is waiting on the page analysis.',
    ...overrides,
  });
}

describe('1. a pending marker is recognizable', () => {
  it('recognizes the planner’s own wording', () => {
    expect(isPendingResult(result())).toBe(true);
  });

  it('does not mistake a real outcome for one', () => {
    expect(isPendingResult(result({ verification: 'verified' }))).toBe(false);
    expect(isPendingResult(result({ verification: 'failed' }))).toBe(false);
    expect(isPendingResult(result({ verification: 'optional_left_blank' }))).toBe(false);
  });

  it('does not mistake a genuine unanswerable question for one', () => {
    const genuine = result({
      reason: '"Have you worked here before?" is a fact only you can confirm.',
    });
    expect(isPendingResult(genuine)).toBe(false);
  });

  it('does not mistake an executed action for one', () => {
    expect(isPendingResult(result({ action: 'fill_text', verification: 'not_attempted' }))).toBe(
      false,
    );
  });

  it('finds every pending record in a batch', () => {
    const batch = [
      result({ fieldId: 'a' }),
      result({ fieldId: 'b', verification: 'verified' }),
      result({ fieldId: 'c' }),
    ];
    expect(pendingResults(batch).map((entry) => entry.fieldId)).toEqual(['a', 'c']);
  });
});

describe('2. a pending marker cannot survive into a finished run', () => {
  it('becomes a question for the user, naming the stage that did not run', () => {
    const finalized = finalizePendingResult(result(), 'analysis_unavailable');
    expect(isPendingResult(finalized)).toBe(false);
    expect(finalized.reviewReason).toBe('missing_information');
    expect(finalized.reason).toMatch(/could not run/i);
    // The old text must not survive anywhere in the finished record.
    expect(finalized.reason).not.toMatch(/waiting on the page analysis/i);
  });

  it('says something different when the analysis ran and had nothing', () => {
    const finalized = finalizePendingResult(result(), 'analysis_no_answer');
    expect(finalized.reason).toMatch(/nothing it could ground/i);
    expect(finalized.reason).not.toMatch(/waiting on/i);
  });

  it('says something different again when the run simply ended', () => {
    const finalized = finalizePendingResult(result(), 'run_ended');
    expect(finalized.reason).toMatch(/run ended/i);
  });

  it('is still a valid field result afterwards', () => {
    for (const cause of ['analysis_unavailable', 'analysis_no_answer', 'run_ended'] as const) {
      expect(() =>
        autofillFieldResultSchema.parse(finalizePendingResult(result(), cause)),
      ).not.toThrow();
    }
  });

  it('keeps the question and the field it belongs to', () => {
    const finalized = finalizePendingResult(result({ fieldId: 'field-9' }), 'run_ended');
    expect(finalized.fieldId).toBe('field-9');
    expect(finalized.question).toBe('Are you willing to relocate?');
  });

  it('leaves a batch with no pending records at all', () => {
    const batch = [result({ fieldId: 'a' }), result({ fieldId: 'b' })].map((entry) =>
      finalizePendingResult(entry, 'analysis_unavailable'),
    );
    expect(pendingResults(batch)).toEqual([]);
  });
});
