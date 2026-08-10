import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  profileSchema,
  type DetectedField,
  type FillRunReport,
  type Profile,
  type RunTrace,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { runApplicationAutofill } from '../../extension/src/autofill/orchestrator.js';
import { icimsScan } from './icimsScanFixture.js';
import { profileFixture } from './popupFixtures.js';

/**
 * One engine drives an option control. Proved, not assumed.
 *
 * Two paths were live in the same run. The deterministic plan sent
 * `select_option` through `executor/domExecutor` →
 * `executor/dropdownEngine`, and the dedicated pass then drove the same control
 * again through `dropdown/*`. That is worse than duplicated work: re-selecting a
 * value a control already holds fires `change`, and a page that rebuilds its
 * dependent list on that event discards the answer chosen moments earlier — so
 * the second engine could undo the first one's work while both reported
 * success.
 *
 * Nothing here stubs an executor. The plan carries a real option action, the
 * real content script receives the real `EXECUTE_FILL_PLAN`, and the assertion
 * is over what the shipped code did with it.
 */

let contentListener:
  | ((
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | undefined)
  | null = null;

function toFrame(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (!contentListener) {
      resolve(undefined);
      return;
    }
    contentListener(message, {}, resolve);
  });
}

vi.mock('../../extension/src/background/frames.js', () => ({
  sendToFrame: (_tabId: number, _frameId: number, message: unknown) => toFrame(message),
  tellEveryFrame: () => Promise.resolve([]),
  discoverFrames: () => Promise.resolve([{ frameId: 0, url: 'https://employer.example/apply' }]),
}));

const FRAMES = [{ frameId: 0, url: 'https://employer.example/apply', topFrame: true }];

/** One text control and one custom dropdown. Both must end up answered. */
const FIXTURE = `
  <form>
    <label for="firstName">First Name *</label>
    <input id="firstName" name="firstName" required />
    <label for="state">State/Province *</label>
    <select id="state" name="state" required>
      <option value="" selected>No Selection</option>
      <option value="CA">California</option>
      <option value="NJ">New Jersey</option>
    </select>
  </form>`;

function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
  });
}

interface Outcome {
  trace: RunTrace;
  /** The action ids the orchestrator asked to have approved. */
  approvedIds: string[];
  /** What the *real* content-script executor did with each action. */
  executionStatuses: Map<string, string>;
  /** Results carrying a dropdown trace — only the old engine produces those. */
  legacyDropdownResults: number;
}

beforeAll(async () => {
  const runtime = {
    onMessage: {
      addListener: (fn: typeof contentListener) => {
        contentListener = fn;
      },
    },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://sole/${path}`,
    id: 'sole',
    lastError: undefined,
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime };
  await import('../../extension/src/content/index.js');
});

/**
 * A run whose plan holds one text action and one option action.
 *
 * `withDropdownStage: false` reproduces the world before the dedicated pass was
 * wired in, where the old executor is the only engine there is — so the same
 * plan is used for both, and the difference in the results is entirely the
 * deferral.
 */
async function run(withDropdownStage: boolean): Promise<Outcome> {
  document.body.innerHTML = FIXTURE;
  const profile = applicant();
  const outcome: Outcome = {
    trace: null as unknown as RunTrace,
    approvedIds: [],
    executionStatuses: new Map(),
    legacyDropdownResults: 0,
  };

  const scanNow = async (): Promise<readonly DetectedField[]> => {
    const { fields } = await scanDom(document, 'page-sole', new AbortController().signal);
    return fields;
  };

  const { runDropdownAutofill, dropdownSeedsByFrame } =
    await import('../../extension/src/background/dropdownAcrossFrames.js');

  let lastScan: ReturnType<typeof icimsScan> | null = null;
  let lastPlan: { id: string; actions: Array<{ id: string; fieldId: string }> } | null = null;
  const approvals = new Map<string, boolean>();

  const buildPlan = (scan: ReturnType<typeof icimsScan>): unknown => {
    const first = scan.fields.find((field) => /first name/i.test(field.label));
    const state = scan.fields.find((field) => /state/i.test(field.label));
    return {
      id: 'plan-sole',
      scanId: scan.id,
      ats: 'icims',
      domain: new URL(scan.url).hostname,
      createdAt: '2026-08-10T09:00:00.000Z',
      updatedAt: '2026-08-10T09:00:00.000Z',
      url: scan.url,
      actions: [
        ...(first
          ? [
              {
                id: 'action-first',
                fieldId: first.id,
                question: first.question,
                fieldType: first.fieldType,
                action: 'fill_text',
                proposedValue: 'Robin',
                source: 'profile',
                confidence: 0.99,
                sensitive: false,
                requiresReview: false,
                approved: approvals.get('action-first') ?? false,
                reason: 'The saved legal first name.',
                warnings: [],
              },
            ]
          : []),
        ...(state
          ? [
              {
                id: 'action-state',
                fieldId: state.id,
                question: state.question,
                fieldType: state.fieldType,
                action: 'select_option',
                proposedValue: 'NJ',
                matchedOption: { label: 'New Jersey', value: 'NJ' },
                source: 'profile',
                confidence: 0.95,
                sensitive: false,
                requiresReview: false,
                approved: approvals.get('action-state') ?? false,
                reason: 'The saved home state.',
                warnings: [],
              },
            ]
          : []),
      ],
      warnings: [],
      statistics: {
        total: 2,
        ready: 2,
        approved: 0,
        review: 0,
        missingInformation: 0,
        skipped: 0,
        unsupported: 0,
        sensitive: 0,
      },
    };
  };

  await runApplicationAutofill({
    buildId: 'sole-executor-build',
    onTrace: (trace) => {
      outcome.trace = trace;
    },
    loadSettings: () =>
      Promise.resolve({ ...DEFAULT_AUTOFILL_SETTINGS, applicationAutofillEnabled: true }),
    scan: async () => {
      lastScan = icimsScan(await scanNow());
      return { scan: lastScan };
    },
    plan: async () => {
      const scan = lastScan ?? icimsScan(await scanNow());
      lastPlan = buildPlan(scan) as typeof lastPlan;
      return { plan: lastPlan as never };
    },
    approve: (map) => {
      for (const [id, approved] of map) {
        approvals.set(id, approved);
        if (approved) outcome.approvedIds.push(id);
      }
      return Promise.resolve({});
    },
    // The real executor, through the real content-script handler. The plan is
    // rebuilt so it carries the approval flags the orchestrator just set — the
    // same thing the server does in production.
    execute: async () => {
      const scan = lastScan ?? icimsScan(await scanNow());
      const reply = (await toFrame({
        type: 'EXECUTE_FILL_PLAN',
        runId: 'run-sole',
        scan,
        plan: buildPlan(scan),
        documentContents: [],
        // The frame's own URL, which is what the shipped identity check compares
        // against when it is present. jsdom's document lives at a different
        // origin from the fixture's recorded scan URL, and without this the real
        // handler correctly refuses to fill a page that is not the one scanned.
        frameUrl: window.location.href,
      })) as { type?: string; report?: FillRunReport } | undefined;
      const report = reply?.report;
      if (!report) return {};
      for (const result of report.results) {
        outcome.executionStatuses.set(result.actionId, result.status);
        if (result.dropdown !== undefined) outcome.legacyDropdownResults += 1;
      }
      return { report };
    },
    highlight: () => Promise.resolve({}),
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    ...(withDropdownStage
      ? {
          runDropdownStage: async (scan) => {
            const result = await runDropdownAutofill({
              tabId: 1,
              frames: FRAMES,
              runId: 'run-sole',
              profile,
              approvedAnswers: [],
              companyName: 'Quanta Robotics',
              seedsByFrame: dropdownSeedsByFrame(scan),
            });
            return result.results;
          },
        }
      : {}),
    now: () => new Date().toISOString(),
  });

  return outcome;
}

function stateControl(): HTMLSelectElement {
  return document.getElementById('state') as HTMLSelectElement;
}

describe('the deterministic stage defers every option action', () => {
  it('never approves the option action for the old executor', async () => {
    const outcome = await run(true);
    expect(outcome.approvedIds).toContain('action-first');
    expect(outcome.approvedIds).not.toContain('action-state');
  });

  it('records the deferral, and no legacy option execution at all', async () => {
    const outcome = await run(true);
    expect(outcome.trace.optionActionsDeferred).toBeGreaterThan(0);
    // The claim in one number: the old in-executor dropdown engine ran zero
    // times. A `FillExecutionResult` carrying a `dropdown` trace can only have
    // come from it.
    expect(outcome.trace.legacyOptionExecutions).toBe(0);
    expect(outcome.legacyDropdownResults).toBe(0);
  });

  it('leaves the option action skipped in the executor’s own report', async () => {
    const outcome = await run(true);
    expect(outcome.executionStatuses.get('action-state')).toBe('skipped');
    // …while the text action goes through the executor exactly as before.
    expect(outcome.executionStatuses.get('action-first')).toBe('verified');
  });

  it('still answers the control — through the dedicated engine', async () => {
    await run(true);
    expect(stateControl().value).toBe('NJ');
  });

  it('reports the control once, from the dropdown engine', async () => {
    const outcome = await run(true);
    const state = outcome.trace.fields.filter((field) => /state/i.test(field.label));
    expect(state).toHaveLength(1);
    expect(state[0]!.dropdownEngineCalled).toBe(true);
    expect(state[0]!.dropdownExecutorCalled).toBe(true);
    expect(state[0]!.finalStatus).toBe('FILLED_VERIFIED');
  });

  it('selects into the control exactly once across the whole run', async () => {
    const outcome = await run(true);
    const traces = outcome.trace.dropdownEngineTraces.filter((entry) =>
      /state/i.test(entry.question),
    );
    // The run makes more than one pass over the page, and the dropdown stage
    // visits every menu on each — correctly, because a control it answered
    // earlier has to be *observed* to still hold the answer. So there is a
    // trace per visit, and exactly one of them selected anything: re-selecting
    // a value a control already holds fires `change`, and a page that rebuilds
    // its dependent list on that event throws away the answer.
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.filter((entry) => entry.clickAttempted)).toHaveLength(1);
    expect(traces.filter((entry) => entry.selected)).toHaveLength(1);
    expect(traces.every((entry) => entry.engineCalled)).toBe(true);
    expect(traces.at(-1)!.verified).toBe(true);
  });
});

describe('without the dedicated pass there is still exactly one engine', () => {
  it('lets the old executor answer the control rather than deferring to nothing', async () => {
    const outcome = await run(false);
    // Deferring to a stage that will never run would simply stop answering
    // dropdowns, so the deferral is conditional on the pass being wired in.
    expect(outcome.trace.optionActionsDeferred).toBe(0);
    expect(outcome.approvedIds).toContain('action-state');
    expect(stateControl().value).toBe('NJ');
  });
});

describe('the text stage is untouched by any of this', () => {
  it('fills and verifies the text control in both worlds', async () => {
    for (const withStage of [true, false]) {
      await run(withStage);
      expect((document.getElementById('firstName') as HTMLInputElement).value).toBe('Robin');
    }
  });
});
