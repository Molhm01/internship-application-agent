import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOFILL_RUN_STATES,
  activeRun,
  clearRun,
  finishRun,
  loadRun,
  recordProgress,
  recordState,
  startRun,
  stateForPhase,
  type AutofillRunPhaseState,
} from '../../extension/src/storage/runState.js';
import {
  AnalysisMemo,
  analysisFingerprint,
  beginAnalysisScope,
  endAnalysisScope,
  analysisScope,
} from '../../extension/src/analysis/analysisMemo.js';
import { installChromeMock } from './setup.js';
import type { AutofillProgress, NormalizedQuestion } from '@internship-agent/shared';

/**
 * The run lifecycle, and the loop it replaces.
 *
 * One click used to be able to become several runs: `acceptAutofillRun` never
 * checked whether one was already in flight, so a second click minted a second
 * id, overwrote the stored run, and left the first orchestrator running
 * invisibly against the same page. Every test here is about that, or about the
 * repeated model calls that made the window wide enough to hit.
 */

function progress(phase: AutofillProgress['phase']): AutofillProgress {
  return {
    runId: 'run-1',
    phase,
    iteration: 1,
    message: phase,
    fieldsCompleted: 0,
    fieldsTotal: 10,
  };
}

beforeEach(() => {
  installChromeMock();
});

describe('1–6. one click, one run', () => {
  it('starts in SCANNING and holds the lock', async () => {
    await startRun('run-1', 'https://careers2-quanta.icims.com/connect');
    const run = await loadRun();
    expect(run?.state).toBe('SCANNING');
    expect(run?.status).toBe('running');
    expect((await activeRun())?.runId).toBe('run-1');
  });

  it('reports no active run before anything starts', async () => {
    expect(await activeRun()).toBeNull();
  });

  it('releases the lock on completion, and returns to no active run', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await finishRun('run-1', { report: undefined, error: undefined });
    expect((await loadRun())?.state).toBe('COMPLETED');
    expect(await activeRun()).toBeNull();
  });

  it('releases the lock on failure', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await finishRun('run-1', {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'boom',
        recoverable: true,
        suggestedAction: 'Try again.',
        debugContext: {},
      },
    });
    expect((await loadRun())?.state).toBe('FAILED');
    expect((await loadRun())?.status).toBe('failed');
    expect(await activeRun()).toBeNull();
  });

  it('releases the lock on cancellation, and calls it cancelled rather than failed', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await finishRun('run-1', {
      error: {
        code: 'AUTOFILL_CANCELLED',
        message: 'You cancelled this run.',
        recoverable: true,
        suggestedAction: 'Start it again when you are ready.',
        debugContext: {},
      },
    });
    expect((await loadRun())?.state).toBe('CANCELLED');
    expect((await loadRun())?.status).toBe('cancelled');
    expect(await activeRun()).toBeNull();
  });

  it('never resurrects a finished run from a late progress message', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await finishRun('run-1', { report: undefined });
    // The orchestrator's last `onProgress` can land after the outcome is
    // written. It must not put the run back into an active state — that is a
    // silent restart, and the button would re-disable itself forever.
    await recordProgress('run-1', progress('filling'));
    expect((await loadRun())?.state).toBe('EXECUTING_DETERMINISTIC');
    // …but the status stays terminal, so the lock is not retaken.
    expect((await loadRun())?.status).toBe('completed');
    expect(await activeRun()).toBeNull();
  });

  it('ignores updates addressed to a different run', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await recordState('run-2', 'EXECUTING_DETERMINISTIC');
    expect((await loadRun())?.state).toBe('SCANNING');
  });

  it('gives up a run whose worker died, so the lock cannot be held forever', async () => {
    await startRun('run-1', 'https://example.com/apply');
    const stored = await chrome.storage.local.get('autofillRun');
    const run = stored.autofillRun as { updatedAt: number };
    await chrome.storage.local.set({
      autofillRun: { ...run, updatedAt: Date.now() - 11 * 60 * 1000 },
    });
    expect((await loadRun())?.status).toBe('failed');
    expect(await activeRun()).toBeNull();
  });

  it('clears cleanly', async () => {
    await startRun('run-1', 'https://example.com/apply');
    await clearRun();
    expect(await loadRun()).toBeNull();
  });
});

describe('every phase maps onto exactly one run state', () => {
  it.each([
    ['preparing', 'SCANNING'],
    ['scanning', 'SCANNING'],
    ['rescanning', 'SCANNING'],
    ['normalizing', 'NORMALIZING'],
    ['filling_dropdowns', 'PROCESSING_DROPDOWNS'],
    ['rescanning_dependencies', 'RESCANNING_DEPENDENCIES'],
    ['discovering_options', 'RESOLVING_DETERMINISTIC'],
    ['resolving', 'RESOLVING_DETERMINISTIC'],
    ['analyzing', 'ANALYZING_AI'],
    ['generating', 'ANALYZING_AI'],
    ['planning', 'EXECUTING_DETERMINISTIC'],
    ['filling', 'EXECUTING_DETERMINISTIC'],
    ['verifying', 'VERIFYING_DETERMINISTIC'],
    ['filling_ai', 'EXECUTING_AI'],
    ['verifying_ai', 'VERIFYING_AI'],
    ['completed', 'COMPLETED'],
    ['completed_with_review', 'COMPLETED'],
    ['failed', 'FAILED'],
    ['cancelled', 'CANCELLED'],
  ] as const)('%s → %s', (phase, expected) => {
    expect(stateForPhase(phase)).toBe(expected);
  });

  it('names every state the popup can be asked to render', () => {
    const required: AutofillRunPhaseState[] = [
      'IDLE',
      'SCANNING',
      'NORMALIZING',
      'RESOLVING_DETERMINISTIC',
      // Deterministic execution and verification come before the AI states,
      // because that is the order the run works in: the saved profile is
      // written and confirmed on the page before the model is asked anything.
      'EXECUTING_DETERMINISTIC',
      'VERIFYING_DETERMINISTIC',
      'ANALYZING_AI',
      'EXECUTING_AI',
      'VERIFYING_AI',
      // The Dropdown Engine pass. A run is still working while it holds this
      // state, which is what stops the popup showing a summary over menus that
      // are still being opened.
      'PROCESSING_DROPDOWNS',
      'RESCANNING_DEPENDENCIES',
      'WAITING_FOR_USER',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ];
    expect([...AUTOFILL_RUN_STATES]).toEqual(required);
  });
});

describe('12 & 14. the same questions are not analyzed twice', () => {
  function question(overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion {
    return {
      questionId: 'question-1',
      fieldIds: ['field-1'],
      questionText: 'How did you hear about us?',
      contextualText: '',
      controlType: 'select',
      required: false,
      options: [
        { label: 'Internet Job Board', value: 'internet' },
        { label: 'Employee Referral', value: 'referral' },
      ],
      likelyIntent: 'how_did_you_hear',
      ...overrides,
    };
  }

  it('gives an unchanged question set the same fingerprint', () => {
    expect(analysisFingerprint('page-1', [question()])).toBe(
      analysisFingerprint('page-1', [question()]),
    );
  });

  it('does not care about document order', () => {
    const a = question({ questionId: 'question-1' });
    const b = question({ questionId: 'question-2' });
    expect(analysisFingerprint('page-1', [a, b])).toBe(analysisFingerprint('page-1', [b, a]));
  });

  it('changes when a dependent dropdown repopulates', () => {
    const before = question({ questionId: 'state', options: [] });
    const after = question({
      questionId: 'state',
      options: [
        { label: 'New Jersey', value: 'NJ' },
        { label: 'New York', value: 'NY' },
      ],
    });
    expect(analysisFingerprint('page-1', [before])).not.toBe(
      analysisFingerprint('page-1', [after]),
    );
  });

  it('changes when the page does', () => {
    expect(analysisFingerprint('page-1', [question()])).not.toBe(
      analysisFingerprint('page-2', [question()]),
    );
  });

  it('asks the model once for a stable page, however many passes run', () => {
    const memo = new AnalysisMemo();
    const fingerprint = analysisFingerprint('page-1', [question()]);
    let calls = 0;
    // Five passes, as the orchestrator's MAX_ITERATIONS allows.
    for (let pass = 0; pass < 5; pass += 1) {
      if (memo.shouldAnalyze(fingerprint)) {
        calls += 1;
        memo.record(fingerprint, true);
      }
    }
    expect(calls).toBe(1);
    expect(memo.analysisCount).toBe(1);
  });

  it('retries after a failed response rather than caching a non-answer', () => {
    const memo = new AnalysisMemo();
    const fingerprint = analysisFingerprint('page-1', [question()]);
    memo.record(fingerprint, false);
    expect(memo.shouldAnalyze(fingerprint)).toBe(true);
    memo.record(fingerprint, true);
    expect(memo.shouldAnalyze(fingerprint)).toBe(false);
  });

  it('analyzes again once the questions genuinely change', () => {
    const memo = new AnalysisMemo();
    memo.record(analysisFingerprint('page-1', [question()]), true);
    const revealed = analysisFingerprint('page-1', [
      question(),
      question({ questionId: 'question-2', questionText: 'Anything else?' }),
    ]);
    expect(memo.shouldAnalyze(revealed)).toBe(true);
  });

  it('starts a fresh memo per run, so a second click really does look again', () => {
    const first = beginAnalysisScope();
    const fingerprint = analysisFingerprint('page-1', [question()]);
    first.record(fingerprint, true);
    expect(analysisScope().shouldAnalyze(fingerprint)).toBe(false);

    endAnalysisScope();
    const second = beginAnalysisScope();
    expect(second.shouldAnalyze(fingerprint)).toBe(true);
    endAnalysisScope();
  });
});
