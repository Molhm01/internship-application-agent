import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_BADGES,
  ANNOTATION_BY_FINAL_STATUS,
  ANNOTATION_COLOURS,
  ANNOTATION_KINDS,
  FINAL_FIELD_STATUSES,
  RUNNING_FIELD_STATUSES,
  annotationFor,
  assertNoTemporaryStatuses,
  countFinalStatuses,
  isDrawnAnnotation,
  isFinalFieldStatus,
  isRunningFieldStatus,
  isSettledStatus,
  resolveFinalFieldStatus,
  resolveRunningFieldStatus,
  unsettledFieldIds,
  type FinalFieldStatus,
} from '@internship-agent/shared';

/**
 * The status model on its own, without a page, a planner, or a run.
 *
 * The three reported failures were all the same defect: a field's meaning was
 * decided in more than one place, so the page, the popup and the report could
 * each hold a different opinion about the same control. Everything asserted
 * here is a property of the model itself, which is what makes those opinions
 * impossible rather than merely currently-consistent.
 */

describe('the final status vocabulary', () => {
  it('is closed, and shares no member with the temporary vocabulary', () => {
    expect(FINAL_FIELD_STATUSES).toEqual([
      'FILLED_VERIFIED',
      'OPTIONAL_LEFT_BLANK',
      'USER_CONFIRMATION_REQUIRED',
      'FAILED_EXECUTION',
      'BLOCKED',
      'SKIPPED_ALREADY_VALID',
    ]);
    expect(RUNNING_FIELD_STATUSES).toEqual([
      'PENDING_SCAN',
      'PENDING_RESOLUTION',
      'PENDING_EXECUTION',
      'PENDING_VERIFICATION',
    ]);
    // No status may be both a stage and a verdict. If this ever overlaps, the
    // completion check silently stops catching a whole class of pending field.
    for (const status of FINAL_FIELD_STATUSES) {
      expect(isRunningFieldStatus(status), `${status} is both final and temporary`).toBe(false);
    }
    for (const status of RUNNING_FIELD_STATUSES) {
      expect(isFinalFieldStatus(status), `${status} is both final and temporary`).toBe(false);
    }
  });

  it('gives every final status exactly one annotation, colour, and badge', () => {
    for (const status of FINAL_FIELD_STATUSES) {
      const annotation = ANNOTATION_BY_FINAL_STATUS[status];
      expect(ANNOTATION_KINDS, `${status} maps to no annotation`).toContain(annotation);
      expect(ANNOTATION_COLOURS[annotation]).toBeTruthy();
      expect(ANNOTATION_BADGES[annotation]).toBeDefined();
    }
  });

  it('assigns the colours the page marks are specified in', () => {
    // Green filled, grey optional, orange needs-you, purple decision, red
    // failed, and nothing at all for a field the agent did not touch.
    expect(ANNOTATION_BY_FINAL_STATUS.FILLED_VERIFIED).toBe('verified');
    expect(ANNOTATION_BY_FINAL_STATUS.OPTIONAL_LEFT_BLANK).toBe('optional_blank');
    expect(ANNOTATION_BY_FINAL_STATUS.USER_CONFIRMATION_REQUIRED).toBe('information_needed');
    expect(ANNOTATION_BY_FINAL_STATUS.FAILED_EXECUTION).toBe('execution_failed');
    expect(ANNOTATION_BY_FINAL_STATUS.BLOCKED).toBe('execution_failed');
    expect(ANNOTATION_BY_FINAL_STATUS.SKIPPED_ALREADY_VALID).toBe('none');
    expect(isDrawnAnnotation('none')).toBe(false);
    for (const kind of ANNOTATION_KINDS.filter((entry) => entry !== 'none')) {
      expect(isDrawnAnnotation(kind)).toBe(true);
    }
  });

  it('sends a sensitive unanswered question to purple, not orange', () => {
    expect(annotationFor('USER_CONFIRMATION_REQUIRED', false)).toBe('information_needed');
    expect(annotationFor('USER_CONFIRMATION_REQUIRED', true)).toBe('sensitive_decision');
    // Sensitivity never overrides an outcome that already happened: a verified
    // field is verified whatever the question was about.
    expect(annotationFor('FILLED_VERIFIED', true)).toBe('verified');
    expect(annotationFor('SKIPPED_ALREADY_VALID', true)).toBe('none');
  });
});

describe('resolving a final status', () => {
  const field = (required: boolean) =>
    ({ required }) as unknown as Parameters<typeof resolveFinalFieldStatus>[0]['field'];
  const result = (verification: string, extra: Record<string, unknown> = {}) =>
    ({ verification, ...extra }) as unknown as Parameters<
      typeof resolveFinalFieldStatus
    >[0]['result'];

  it('calls a verified write FILLED_VERIFIED', () => {
    expect(resolveFinalFieldStatus({ result: result('verified') })).toBe('FILLED_VERIFIED');
  });

  it('separates a value the page already held from one the agent wrote', () => {
    expect(
      resolveFinalFieldStatus({ result: result('verified'), alreadyValidBeforeRun: true }),
    ).toBe('SKIPPED_ALREADY_VALID');
  });

  it('does not let a stale review flag survive a successful write', () => {
    // This is the reported bug, stated as a property: verification wins over
    // anything the planner decided before the executor ran.
    expect(
      resolveFinalFieldStatus({
        field: field(true),
        result: result('verified', { reviewReason: 'missing_information' }),
      }),
    ).toBe('FILLED_VERIFIED');
  });

  it('calls an unconfirmed write a failed execution, not an open question', () => {
    // The user must be told the page discarded the value, not asked to answer
    // it from scratch — those need different actions from them.
    expect(resolveFinalFieldStatus({ result: result('failed') })).toBe('FAILED_EXECUTION');
    expect(resolveFinalFieldStatus({ result: result('unverified') })).toBe('FAILED_EXECUTION');
  });

  it('treats a deliberately empty optional field as finished work', () => {
    expect(resolveFinalFieldStatus({ result: result('optional_left_blank') })).toBe(
      'OPTIONAL_LEFT_BLANK',
    );
    // An optional field the run never reached is blank on purpose too.
    expect(resolveFinalFieldStatus({ field: field(false) })).toBe('OPTIONAL_LEFT_BLANK');
  });

  it('never lets a required field with no result disappear', () => {
    expect(resolveFinalFieldStatus({ field: field(true) })).toBe('USER_CONFIRMATION_REQUIRED');
  });

  it('lets a block beat everything except a write that already verified', () => {
    expect(resolveFinalFieldStatus({ field: field(true), blocked: true })).toBe('BLOCKED');
    expect(resolveFinalFieldStatus({ result: result('verified'), blocked: true })).toBe(
      'FILLED_VERIFIED',
    );
  });
});

describe('resolving a temporary status', () => {
  it('names the stage a field is actually waiting in', () => {
    expect(
      resolveRunningFieldStatus({
        planned: false,
        executionAttempted: false,
        verificationObserved: false,
      }),
    ).toBe('PENDING_RESOLUTION');
    expect(
      resolveRunningFieldStatus({
        planned: true,
        executionAttempted: false,
        verificationObserved: false,
      }),
    ).toBe('PENDING_EXECUTION');
    expect(
      resolveRunningFieldStatus({
        planned: true,
        executionAttempted: true,
        verificationObserved: false,
      }),
    ).toBe('PENDING_VERIFICATION');
  });
});

describe('the completion gate', () => {
  it('accepts a run whose fields all reached a verdict', () => {
    const outcomes = FINAL_FIELD_STATUSES.map((status, index) => ({
      fieldId: `field-${index}`,
      status,
    }));
    expect(unsettledFieldIds(outcomes)).toEqual([]);
    expect(() => assertNoTemporaryStatuses(outcomes)).not.toThrow();
  });

  it('refuses a run holding any temporary status', () => {
    for (const status of RUNNING_FIELD_STATUSES) {
      expect(() => assertNoTemporaryStatuses([{ fieldId: 'field-1', status }])).toThrow(
        /temporary status/i,
      );
      expect(unsettledFieldIds([{ fieldId: 'field-1', status }])).toEqual(['field-1']);
    }
  });

  it('does not confuse "the run is unfinished" with "the work is unfinished"', () => {
    // A field needing the user is settled: the run finished, the form did not.
    // Conflating the two is what would make an honest report unpublishable.
    const outcomes = [
      { fieldId: 'a', status: 'USER_CONFIRMATION_REQUIRED' },
      { fieldId: 'b', status: 'FAILED_EXECUTION' },
    ];
    expect(() => assertNoTemporaryStatuses(outcomes)).not.toThrow();
    expect(unsettledFieldIds(outcomes)).toEqual([]);
    expect(isSettledStatus('USER_CONFIRMATION_REQUIRED')).toBe(false);
    expect(isSettledStatus('FAILED_EXECUTION')).toBe(false);
  });

  it('counts settled work as filled, already-correct, or correctly blank', () => {
    expect(isSettledStatus('FILLED_VERIFIED')).toBe(true);
    expect(isSettledStatus('SKIPPED_ALREADY_VALID')).toBe(true);
    expect(isSettledStatus('OPTIONAL_LEFT_BLANK')).toBe(true);
    expect(isSettledStatus('BLOCKED')).toBe(false);
  });
});

describe('counting final statuses', () => {
  it('partitions the fields, so the counts always sum to the list', () => {
    const outcomes = (
      [
        'FILLED_VERIFIED',
        'FILLED_VERIFIED',
        'OPTIONAL_LEFT_BLANK',
        'USER_CONFIRMATION_REQUIRED',
        'FAILED_EXECUTION',
        'SKIPPED_ALREADY_VALID',
      ] as FinalFieldStatus[]
    ).map((status, index) => ({
      fieldId: `field-${index}`,
      label: `Question ${index}`,
      status,
      annotation: ANNOTATION_BY_FINAL_STATUS[status],
      required: false,
      reason: '',
    }));
    const counts = countFinalStatuses(outcomes);
    expect(counts.FILLED_VERIFIED).toBe(2);
    expect(counts.BLOCKED).toBe(0);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(outcomes.length);
    // Every status is present as a key, so a zero is a reported zero rather
    // than a missing line.
    expect(Object.keys(counts).sort()).toEqual([...FINAL_FIELD_STATUSES].sort());
  });
});
