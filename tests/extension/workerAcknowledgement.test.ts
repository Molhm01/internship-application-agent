import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRun,
  finishRun,
  loadRun,
  recordProgress,
  startRun,
} from '../../extension/src/storage/runState.js';
import { installChromeMock } from './setup.js';

/**
 * The bug this file exists for.
 *
 * `RUN_APPLICATION_AUTOFILL` held one `sendMessage` open for the entire run —
 * scan, AI batch, fill, verify, rescan, up to five passes — against the default
 * fifteen-second deadline. That deadline is shorter than a single AI batch, so
 * on a real form the call *always* failed with
 * "no response within 15000ms". Nothing was broken, which is exactly why
 * reloading the extension never helped.
 *
 * These pin the replacement: acknowledge immediately, report through state that
 * survives the service worker being suspended underneath it.
 */

const SOURCE_ROOT = join(process.cwd(), 'extension', 'src');

beforeEach(() => {
  installChromeMock();
});

describe('the message deadline can no longer be shorter than the work', () => {
  it('does not hold the autofill request open for the run', () => {
    const background = readFileSync(join(SOURCE_ROOT, 'background', 'index.ts'), 'utf8');
    // The handler returns an acceptance, not the run's result.
    expect(background).toMatch(/case 'RUN_APPLICATION_AUTOFILL':\s*\n\s*return acceptAutofillRun/);
    expect(background).toMatch(/accepted: true/);
    // And the run itself is started without being awaited.
    //
    // Which run that is became a choice when Agent Mode replaced the whole-page
    // pipeline as the production path: the worker resolves one or the other
    // *before* starting either, so the two can never run over one page at once.
    // The property this test is about is unchanged — the message handler does
    // not wait for whichever one it started.
    expect(background).toMatch(
      /void \(useLegacy \? runAutofill\(targetUrl, runId\) : runAgentAutofill\(targetUrl, runId\)\)/,
    );
  });

  it('registers the message listener at the top level, before any async setup', () => {
    const background = readFileSync(join(SOURCE_ROOT, 'background', 'index.ts'), 'utf8');
    // A listener registered inside a promise chain is absent for the first
    // moments after a worker restart, and every message sent in that window
    // resolves with `undefined`.
    const listenerIndex = background.indexOf('chrome.runtime.onMessage.addListener');
    expect(listenerIndex).toBeGreaterThan(-1);
    // The registration must sit at column zero — not nested inside a callback,
    // a `then`, or an initialization function.
    const line = background.slice(0, listenerIndex).split('\n').pop();
    expect(line).toBe('');
    // No top-level await anywhere before it, which would delay the whole module.
    expect(background.slice(0, listenerIndex)).not.toMatch(/^await /m);
  });

  it('answers a liveness ping before anything that could fail', () => {
    const background = readFileSync(join(SOURCE_ROOT, 'background', 'index.ts'), 'utf8');
    const ping = background.indexOf(`case 'WORKER_PING':`);
    const autofill = background.indexOf(`case 'RUN_APPLICATION_AUTOFILL':`);
    expect(ping).toBeGreaterThan(-1);
    expect(ping).toBeLessThan(autofill);
  });

  it('does not blame a stale install for a timeout the worker survived', () => {
    const messaging = readFileSync(join(SOURCE_ROOT, 'messaging', 'messages.ts'), 'utf8');
    // A ping decides which of the two diagnoses is given.
    expect(messaging).toMatch(/await workerResponds\(\)/);
    expect(messaging).toMatch(/is running but did not answer/);
  });

  it('polls the run rather than awaiting it in the popup', () => {
    const hook = readFileSync(join(SOURCE_ROOT, 'popup', 'useAutofillState.ts'), 'utf8');
    expect(hook).toMatch(/GET_AUTOFILL_RUN/);
    // The old shape — reading `report` straight off the send — is gone.
    expect(hook).not.toMatch(/if \('report' in response\)/);
  });
});

describe('run state survives a worker restart', () => {
  it('records progress durably and reports it back', async () => {
    await startRun('run-1', 'https://careers2-quanta.icims.com/jobs/1');
    await recordProgress('run-1', {
      runId: 'run-1',
      phase: 'filling',
      iteration: 1,
      message: 'Filling fields',
      fieldsCompleted: 4,
      fieldsTotal: 26,
    });

    // A restarted worker holds nothing in memory; this is the only surviving
    // record, and it is enough for the popup to show where the run got to.
    const recovered = await loadRun();
    expect(recovered?.status).toBe('running');
    expect(recovered?.progress?.fieldsCompleted).toBe(4);
    expect(recovered?.progress?.fieldsTotal).toBe(26);
    expect(recovered?.url).toBe('https://careers2-quanta.icims.com/jobs/1');
  });

  it('reports a run whose worker vanished as failed rather than as still running', async () => {
    await startRun('run-2', 'https://careers2-quanta.icims.com/jobs/1');
    // Age the record past the staleness ceiling, which is what a killed worker
    // leaves behind: a `running` row nobody will ever update again.
    const stored = await chrome.storage.local.get('autofillRun');
    const stale = stored.autofillRun as Record<string, unknown>;
    await chrome.storage.local.set({
      autofillRun: { ...stale, updatedAt: Date.now() - 11 * 60 * 1000 },
    });

    const recovered = await loadRun();
    expect(recovered?.status).toBe('failed');
    // Leaving the popup on "Filling information…" forever is the worst
    // available outcome, so the run says it stopped.
    expect(recovered?.error?.message).toMatch(/stopped unexpectedly/i);
  });

  it('ignores a late update from a run that already finished', async () => {
    await startRun('run-3', 'https://example.com/apply');
    await finishRun('run-3', {
      error: {
        code: 'AUTOFILL_CANCELLED',
        message: 'You cancelled this run.',
        recoverable: true,
        suggestedAction: 'Start it again.',
        debugContext: {},
      },
    });
    // A progress message from a different run must not resurrect anything.
    await recordProgress('run-OTHER', {
      runId: 'run-OTHER',
      phase: 'filling',
      iteration: 1,
      message: 'Filling fields',
      fieldsCompleted: 1,
      fieldsTotal: 1,
    });

    const recovered = await loadRun();
    expect(recovered?.runId).toBe('run-3');
    expect(recovered?.status).toBe('cancelled');
    expect(recovered?.progress).toBeUndefined();
  });

  it('clears cleanly', async () => {
    await startRun('run-4', 'https://example.com/apply');
    await clearRun();
    expect(await loadRun()).toBeNull();
  });

  it('rejects a stored record that does not match the schema', async () => {
    await chrome.storage.local.set({ autofillRun: { runId: 42, status: 'sideways' } });
    expect(await loadRun()).toBeNull();
  });
});

describe('the generated service worker carries the fix', () => {
  it('ships the acknowledgement and the run store in background.js', () => {
    // The built bundle is the final authority: a fix that exists only in source
    // is a fix Chrome never runs.
    const bundle = readFileSync(join(process.cwd(), 'extension', 'dist', 'background.js'), 'utf8');
    expect(bundle).toMatch(/accepted/);
    expect(bundle).toMatch(/WORKER_PING/);
    expect(bundle).toMatch(/GET_AUTOFILL_RUN/);
    expect(bundle).toMatch(/autofillRun/);
  });
});
