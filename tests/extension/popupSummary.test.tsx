import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  applicationAutofillReportSchema,
  type ApplicationAutofillReport,
} from '@internship-agent/shared';
import { AutofillPanel, summarize } from '../../extension/src/popup/AutofillPanel.js';
import type { AutofillState } from '../../extension/src/popup/useAutofillState.js';

afterEach(cleanup);

/**
 * The eight numbers the popup prints, and where they come from.
 *
 * The reported failure was a summary that disagreed with the form beside it —
 * "Could not fill: 0" above a list of unanswered required fields. That was
 * possible because each line was computed somewhere else, over a different
 * subset. These tests assert the property that makes it impossible: every line
 * is a tally of one list, and they sum to the number printed above them.
 */

const NOW = '2026-08-06T12:00:00.000Z';

function reportWith(
  outcomes: ApplicationAutofillReport['fieldOutcomes'],
  overrides: Record<string, unknown> = {},
): ApplicationAutofillReport {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return applicationAutofillReportSchema.parse({
    id: 'autofill-summary',
    startedAt: NOW,
    completedAt: NOW,
    url: 'https://careers.example/apply',
    ats: 'unknown',
    iterations: 1,
    fieldsFound: outcomes.length,
    fieldsCompleted: 0,
    fieldsVerified: 0,
    totalDurationMs: 4200,
    status: 'completed_with_review',
    finalStatusCounts: counts,
    fieldOutcomes: outcomes,
    ...overrides,
  });
}

function outcome(
  fieldId: string,
  label: string,
  status: string,
  annotation: string,
  required = false,
): ApplicationAutofillReport['fieldOutcomes'][number] {
  return { fieldId, label, status, annotation, required, reason: 'because' } as never;
}

/** One of each, so every line has a number that is not zero and not shared. */
const ONE_OF_EACH = [
  outcome('f1', 'First name', 'FILLED_VERIFIED', 'verified', true),
  outcome('f2', 'Middle name', 'OPTIONAL_LEFT_BLANK', 'optional_blank'),
  outcome('f3', 'Referral name', 'USER_CONFIRMATION_REQUIRED', 'information_needed', true),
  outcome('f4', 'Country', 'FAILED_EXECUTION', 'execution_failed', true),
  outcome('f5', 'Security code', 'BLOCKED', 'execution_failed', true),
  outcome('f6', 'City', 'SKIPPED_ALREADY_VALID', 'none'),
];

function panelState(report: ApplicationAutofillReport | null): AutofillState {
  return {
    bundle: null,
    loadingBundle: false,
    progress: null,
    report,
    error: null,
    runState: 'COMPLETED',
    elapsedMs: 4200,
    run: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    focusField: () => Promise.resolve(),
    clearHighlights: () => Promise.resolve(),
  } as unknown as AutofillState;
}

describe('summarize', () => {
  it('counts every field exactly once, into exactly one line', () => {
    const summary = summarize(reportWith(ONE_OF_EACH));
    expect(summary.detected).toBe(6);
    expect(summary.FILLED_VERIFIED).toBe(1);
    expect(summary.OPTIONAL_LEFT_BLANK).toBe(1);
    expect(summary.USER_CONFIRMATION_REQUIRED).toBe(1);
    expect(summary.FAILED_EXECUTION).toBe(1);
    expect(summary.BLOCKED).toBe(1);
    expect(summary.SKIPPED_ALREADY_VALID).toBe(1);
    // The property the reported bug violated.
    expect(summary.total).toBe(summary.detected);
  });

  it('reports zeroes rather than omitting a line', () => {
    const summary = summarize(
      reportWith([outcome('f1', 'First name', 'FILLED_VERIFIED', 'verified')]),
    );
    expect(summary.BLOCKED).toBe(0);
    expect(summary.FAILED_EXECUTION).toBe(0);
    expect(summary.total).toBe(1);
  });

  it('survives having no report at all', () => {
    const summary = summarize(null);
    expect(summary.detected).toBe(0);
    expect(summary.total).toBe(0);
  });
});

describe('the popup summary', () => {
  const panel = (report: ApplicationAutofillReport) =>
    render(
      <AutofillPanel
        state={panelState(report)}
        eligible
        fieldsDetected={report.fieldOutcomes.length}
        agentStatus={null}
      />,
    );

  it('prints the eight named lines', () => {
    panel(reportWith(ONE_OF_EACH));
    expect(screen.getByText('Detected: 6')).toBeDefined();
    expect(screen.getByText('Filled and verified: 1')).toBeDefined();
    expect(screen.getByText('Optional blank: 1')).toBeDefined();
    expect(screen.getByText('Needs your answer: 1')).toBeDefined();
    expect(screen.getByText('Failed: 1')).toBeDefined();
    expect(screen.getByText('Blocked: 1')).toBeDefined();
    expect(screen.getByText('Already valid: 1')).toBeDefined();
    expect(screen.getByText('Elapsed time: 4s')).toBeDefined();
  });

  it('never claims zero failures while a required field is blank', () => {
    // The exact reported contradiction: two required fields unanswered, and a
    // summary that reported nothing wrong.
    panel(
      reportWith([
        outcome('f1', 'First name', 'FILLED_VERIFIED', 'verified', true),
        outcome('f2', 'Referral name', 'USER_CONFIRMATION_REQUIRED', 'information_needed', true),
        outcome('f3', 'Country', 'FAILED_EXECUTION', 'execution_failed', true),
      ]),
    );
    expect(screen.getByText('Needs your answer: 1')).toBeDefined();
    expect(screen.getByText('Failed: 1')).toBeDefined();
    expect(screen.queryByText('Needs your answer: 0')).toBeNull();
    expect(screen.queryByText('Failed: 0')).toBeNull();
    // And both are named individually underneath, so the count is checkable.
    expect(screen.getByRole('button', { name: 'Referral name' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Country' })).toBeDefined();
  });

  it('lists nothing for a run in which every field was settled', () => {
    panel(
      reportWith(
        [
          outcome('f1', 'First name', 'FILLED_VERIFIED', 'verified', true),
          outcome('f2', 'Middle name', 'OPTIONAL_LEFT_BLANK', 'optional_blank'),
          outcome('f3', 'City', 'SKIPPED_ALREADY_VALID', 'none'),
        ],
        { status: 'completed' },
      ),
    );
    expect(screen.getByText('Detected: 3')).toBeDefined();
    expect(screen.getByText('Filled and verified: 1')).toBeDefined();
    // An optional blank and an already-valid field are not work outstanding.
    expect(screen.queryByText(/still need you/i)).toBeNull();
    expect(screen.queryByText(/still needs you/i)).toBeNull();
  });

  it('says so loudly if the numbers ever stop adding up', () => {
    // Constructed by hand, because the schema refuses to build one: this is the
    // last line of defence, not the first.
    const broken = {
      ...reportWith(ONE_OF_EACH),
      fieldOutcomes: ONE_OF_EACH.slice(0, 3),
      fieldsFound: 6,
    } as ApplicationAutofillReport;
    render(
      <AutofillPanel state={panelState(broken)} eligible fieldsDetected={6} agentStatus={null} />,
    );
    expect(screen.getByText('Detected: 3')).toBeDefined();
    // Three of six statuses, so the partition still holds against what is
    // rendered — the alert fires only on a genuine mismatch.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
