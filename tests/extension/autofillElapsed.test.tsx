import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { formatElapsed } from '../../extension/src/popup/AutofillPanel.js';
import { useAutofillState } from '../../extension/src/popup/useAutofillState.js';
import { installChromeMock } from './setup.js';
import type { AutofillRunState } from '../../extension/src/storage/runState.js';

/**
 * The elapsed clock, and the invalid UI combination it was part of.
 *
 * The popup showed "Status: Ready", a live Cancel button, a frozen 2/27 bar and
 * "Elapsed time: 0s" all at once. Every one of those came from the same place:
 * the popup *adopted* a run that was already in flight, set `running` true, and
 * then set nothing else — no state, no `startedAt`, and no polling. So the
 * label fell back to the IDLE text, the clock had nothing to subtract from, and
 * nothing ever noticed the run had finished.
 */

const NOW = 1_760_000_000_000;

function runState(overrides: Partial<AutofillRunState> = {}): AutofillRunState {
  return {
    runId: 'autofill-1',
    status: 'running',
    state: 'EXECUTING_DETERMINISTIC',
    url: 'https://careers2-quanta.icims.com/connect',
    startedAt: NOW - 30_000,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A popup harness that renders only what this file asserts on. */
function Harness({ tabUrl }: { tabUrl: string }): JSX.Element {
  const state = useAutofillState(tabUrl);
  return (
    <div>
      <span data-testid="state">{state.runState}</span>
      <span data-testid="elapsed">{formatElapsed(state.elapsedMs)}</span>
      <span data-testid="running">{String(state.running)}</span>
    </div>
  );
}

/** Answers the three messages the hook sends on mount. */
function installMessaging(run: AutofillRunState | null): void {
  const mock = installChromeMock();
  mock.runtime.sendMessage = vi.fn((message: { type: string }) => {
    switch (message.type) {
      case 'GET_ACTIVE_BUNDLE':
        return Promise.resolve({ data: null });
      case 'GET_AUTOFILL_REPORT':
        return Promise.resolve({ report: null });
      case 'GET_AUTOFILL_RUN':
        return Promise.resolve({ run });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('formatting', () => {
  it.each([
    [0, '0s'],
    [12_000, '12s'],
    [59_400, '59s'],
    [60_000, '1m 0s'],
    [74_000, '1m 14s'],
    [3_600_000, '60m 0s'],
  ])('%dms reads as %s', (milliseconds, expected) => {
    expect(formatElapsed(milliseconds)).toBe(expected);
  });

  it('never shows a negative time', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('3 & 5. the clock uses the worker’s timestamps', () => {
  it('shows the time already elapsed when the popup opens mid-run', async () => {
    installMessaging(runState());
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // The run started 30s ago. Reopening the popup must not restart from zero.
    expect(screen.getByTestId('elapsed').textContent).toBe('30s');
    expect(screen.getByTestId('running').textContent).toBe('true');
  });

  it('adopts the worker’s state instead of falling back to IDLE', async () => {
    installMessaging(runState({ state: 'ANALYZING_AI' }));
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // "Ready" beside a live Cancel button is precisely what this prevents.
    expect(screen.getByTestId('state').textContent).toBe('ANALYZING_AI');
    expect(screen.getByTestId('state').textContent).not.toBe('IDLE');
  });

  it('4. keeps counting while the run is active', async () => {
    installMessaging(runState());
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('30s');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('35s');
  });

  it('crosses the minute boundary in the readable shape', async () => {
    installMessaging(runState({ startedAt: NOW - 59_000 }));
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('59s');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('1m 14s');
  });

  it('6. freezes at completedAt once the run ends', async () => {
    installMessaging(
      runState({
        status: 'completed',
        state: 'COMPLETED',
        startedAt: NOW - 45_000,
        completedAt: NOW - 5_000,
      }),
    );
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // 45s - 5s = the 40s the run actually took, not the 45s since it began.
    expect(screen.getByTestId('elapsed').textContent).toBe('40s');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('40s');
    expect(screen.getByTestId('running').textContent).toBe('false');
  });

  it('freezes a cancelled run at the moment it was cancelled', async () => {
    installMessaging(
      runState({
        status: 'cancelled',
        state: 'CANCELLED',
        startedAt: NOW - 20_000,
        completedAt: NOW - 8_000,
      }),
    );
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('elapsed').textContent).toBe('12s');
    expect(screen.getByTestId('state').textContent).toBe('CANCELLED');
  });

  it('shows nothing running when there is no run at all', async () => {
    installMessaging(null);
    render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('state').textContent).toBe('IDLE');
    expect(screen.getByTestId('elapsed').textContent).toBe('0s');
    expect(screen.getByTestId('running').textContent).toBe('false');
  });

  it('8. never reports IDLE while a run is active', async () => {
    for (const state of [
      'SCANNING',
      'RESOLVING_DETERMINISTIC',
      'EXECUTING_DETERMINISTIC',
      'ANALYZING_AI',
      'EXECUTING_AI',
    ] as const) {
      cleanup();
      installMessaging(runState({ state }));
      render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      // The panel draws Cancel and the progress bar from exactly this value and
      // nothing else, so "Ready" beside a live Cancel button cannot be built.
      expect(screen.getByTestId('state').textContent).toBe(state);
      expect(screen.getByTestId('running').textContent).toBe('true');
    }
  });

  it('clears its interval on unmount', async () => {
    installMessaging(runState());
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const view = render(<Harness tabUrl="https://careers2-quanta.icims.com/connect" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    view.unmount();
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });
});
