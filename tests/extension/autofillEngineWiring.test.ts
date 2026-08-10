import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  profileSchema,
  type DetectedField,
  type EngineMarker,
  type Profile,
  type RunTrace,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { runApplicationAutofill } from '../../extension/src/autofill/orchestrator.js';
import { icimsScan } from './icimsScanFixture.js';
import { profileFixture } from './popupFixtures.js';

/**
 * The wiring between the button and the engines, proved rather than assumed.
 *
 * This file exists because of a failure the whole rest of the suite was blind
 * to. The Dropdown Engine was complete and correct — discovery, resolution,
 * dependency ordering, a frame-side executor that opened, enumerated, matched,
 * selected and verified, strict schemas between the halves, and tests over all
 * of it, green. On a live application it changed nothing at all, because no
 * production module imported it and the content script had no handler for
 * either message it sends. Every test that exercised the engine called it
 * directly, so every test passed while the button never reached it.
 *
 * So nothing here calls an engine directly. The run goes through the real
 * orchestrator, the real worker-side pass, the real cross-frame messages, and
 * the real content-script listener, and the evidence is the fixture's own DOM
 * plus the run's own trace.
 */

/**
 * The listener the production content script registers, captured at import.
 *
 * A shim would defeat the point: the claim being tested is that the *shipped*
 * handler answers these two message types, and a stand-in that answers them
 * proves only that the stand-in does.
 */
let contentListener:
  | ((
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | undefined)
  | null = null;

/** Delivers one worker message to the content script and awaits its reply. */
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

/**
 * Country and State, wired the way an employer form wires them: the region list
 * does not exist until a country has been chosen. Nothing about this fixture is
 * special-cased anywhere in the extension.
 */
const FIXTURE = `
  <form>
    <label for="firstName">First Name *</label>
    <input id="firstName" name="firstName" required />
    <label for="country">Country *</label>
    <select id="country" name="country" required>
      <option value="">Select…</option>
      <option value="CA">Canada</option>
      <option value="US">United States of America</option>
    </select>
    <label for="state">State/Province *</label>
    <select id="state" name="state" data-depends-on="country" required>
      <option value="">Select a country first</option>
    </select>
  </form>`;

const REGIONS: Record<string, readonly string[]> = {
  US: ['California', 'New Jersey', 'New York'],
  CA: ['Alberta', 'Ontario'],
};

function mountFixture(): void {
  document.body.innerHTML = FIXTURE;
  const country = document.getElementById('country') as HTMLSelectElement;
  const state = document.getElementById('state') as HTMLSelectElement;
  country.addEventListener('change', () => {
    state.innerHTML = '<option value="">Select…</option>';
    for (const region of REGIONS[country.value] ?? []) {
      const option = document.createElement('option');
      option.value = region;
      option.textContent = region;
      state.append(option);
    }
  });
}

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

interface RunOutcome {
  status: string;
  trace: RunTrace;
  markers: EngineMarker[];
  /** How many times each engine dependency was invoked, for the one-click gate. */
  invocations: { dropdown: number; dependency: number };
  phases: string[];
  /** The phase reported at the moment the dropdown stage returned. */
  phaseWhenDropdownsFinished: string | null;
}

/**
 * One "Autofill Application" run, with the deterministic plan deliberately
 * empty.
 *
 * Empty because the claim under test is about the *engines*, and a planner that
 * happened to answer Country would make a dead Dropdown Engine look alive —
 * which is precisely the confusion this file exists to end. Everything these
 * controls receive, they receive from the Dropdown and Dependency Engines.
 */
async function run(
  options: { cancelAfterDropdowns?: boolean; staleFailureAfterDropdowns?: boolean } = {},
): Promise<RunOutcome> {
  mountFixture();
  const profile = applicant();
  const outcome: RunOutcome = {
    status: '',
    trace: null as unknown as RunTrace,
    markers: [],
    invocations: { dropdown: 0, dependency: 0 },
    phases: [],
    phaseWhenDropdownsFinished: null,
  };
  let cancelled = false;
  let dropdownsDone = false;

  const scanNow = async (): Promise<readonly DetectedField[]> => {
    const { fields } = await scanDom(document, 'page-wiring', new AbortController().signal);
    return fields;
  };

  const { runDropdownAutofill } =
    await import('../../extension/src/background/dropdownAcrossFrames.js');
  const { runDependencyResolution } =
    await import('../../extension/src/background/dependenciesAcrossFrames.js');

  const report = await runApplicationAutofill({
    buildId: 'wiring-test-build',
    onTrace: (trace) => {
      outcome.trace = trace;
      outcome.markers = trace.engineInvocations.map((entry) => entry.marker);
    },
    loadSettings: () =>
      Promise.resolve({ ...DEFAULT_AUTOFILL_SETTINGS, applicationAutofillEnabled: true }),
    scan: async () => ({ scan: icimsScan(await scanNow()) }),
    plan: async () => {
      const scan = icimsScan(await scanNow());
      return {
        plan: {
          id: 'plan-wiring',
          scanId: scan.id,
          createdAt: '2026-08-10T09:00:00.000Z',
          url: scan.url,
          actions: options.staleFailureAfterDropdowns && dropdownsDone ? staleFailure(scan) : [],
          warnings: [],
          statistics: {
            total: 0,
            approved: 0,
            requiresReview: 0,
            sensitive: 0,
            byAction: {},
            bySource: {},
          },
        } as never,
      };
    },
    approve: () => Promise.resolve({}),
    execute: () =>
      Promise.resolve({
        report: {
          id: 'fill-wiring',
          planId: 'plan-wiring',
          startedAt: '2026-08-10T09:00:00.000Z',
          completedAt: '2026-08-10T09:00:01.000Z',
          url: 'https://employer.example/apply',
          results: options.staleFailureAfterDropdowns && dropdownsDone ? staleResults() : [],
          statistics: { attempted: 0, verified: 0, failed: 0, cancelled: 0 },
          submitted: false as const,
          warnings: [],
        } as never,
      }),
    highlight: () => Promise.resolve({}),
    onProgress: (progress) => outcome.phases.push(progress.phase),
    isCancelled: () => cancelled,
    waitForStability: () => Promise.resolve(),
    runDropdownStage: async () => {
      outcome.invocations.dropdown += 1;
      const result = await runDropdownAutofill({
        tabId: 1,
        frames: FRAMES,
        runId: 'run-wiring',
        profile,
        approvedAnswers: [],
        companyName: 'Quanta Robotics',
      });
      dropdownsDone = true;
      outcome.phaseWhenDropdownsFinished = outcome.phases.at(-1) ?? null;
      if (options.cancelAfterDropdowns) cancelled = true;
      return result.results;
    },
    resolveDependencies: async (scan) => {
      outcome.invocations.dependency += 1;
      const fieldsByFrame = new Map<number, DetectedField[]>([[0, [...scan.fields]]]);
      const result = await runDependencyResolution({
        tabId: 1,
        frames: FRAMES,
        runId: 'run-wiring',
        profile,
        approvedAnswers: [],
        companyName: 'Quanta Robotics',
        fieldsByFrame,
      });
      return [...result.edges];
    },
    now: () => new Date().toISOString(),
  });

  expect(report.submissionPrevented).toBe(true);
  outcome.status = report.status;
  return outcome;
}

/**
 * A plan action that claims the State control failed, produced *after* the
 * Dropdown Engine verified it.
 *
 * This is the overwrite the precedence rule exists to refuse: the planner built
 * it from a scan taken before the region list existed, so its verdict is older
 * evidence than the DOM verification, however much later it arrives.
 */
function staleFailure(scan: { fields: readonly DetectedField[] }): unknown[] {
  const state = scan.fields.find((field) => field.selector.includes('state'));
  if (!state) return [];
  return [
    {
      id: 'action-stale-state',
      fieldId: state.id,
      question: state.question,
      action: 'select_option',
      proposedValue: 'New Jersey',
      source: 'profile',
      confidence: 0.9,
      sensitive: false,
      approved: true,
      reason: 'A plan built before the region list existed.',
      warnings: [],
    },
  ];
}

function staleResults(): unknown[] {
  return [
    {
      actionId: 'action-stale-state',
      fieldId: 'stale',
      status: 'failed',
      expectedValue: 'New Jersey',
      attempts: 1,
      durationMs: 3,
      error: {
        code: 'OPTION_NOT_FOUND',
        message: 'No option on the page matched "New Jersey".',
        recoverable: true,
        suggestedAction: 'Choose it yourself.',
        debugContext: {},
      },
    },
  ];
}

/** The five stages one control passed, read off the run's own trace and the DOM. */
function stagesFor(trace: RunTrace, label: RegExp) {
  const field = trace.fields.find((entry) => label.test(entry.label));
  return {
    found: field !== undefined,
    engineCalled: field?.dropdownEngineCalled ?? false,
    executorCalled: field?.dropdownExecutorCalled ?? false,
    optionsFound: (field?.dropdown?.optionCount ?? 0) > 0,
    verified: field?.finalStatus === 'FILLED_VERIFIED',
    status: field?.finalStatus ?? 'ABSENT',
  };
}

function displayed(id: string): string {
  const control = document.getElementById(id);
  return control instanceof HTMLSelectElement
    ? (control.selectedOptions[0]?.textContent?.trim() ?? '')
    : '';
}

beforeAll(async () => {
  // The content script is loaded the way Chrome loads it: imported for its side
  // effects, registering its own listener against a stubbed `chrome`.
  const runtime = {
    onMessage: {
      addListener: (fn: typeof contentListener) => {
        contentListener = fn;
      },
    },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://wiring/${path}`,
    id: 'wiring',
    lastError: undefined,
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime };
  await import('../../extension/src/content/index.js');
});

describe('the content script answers the messages the engines send', () => {
  it('registers a listener at load', () => {
    expect(contentListener).not.toBeNull();
  });

  it('describes this frame’s option controls without opening any of them', async () => {
    mountFixture();
    const reply = (await toFrame({ type: 'DISCOVER_DROPDOWNS', runId: 'r' })) as {
      dropdowns: Array<{ label: string; selector: string }>;
    };
    expect(reply.dropdowns.length).toBeGreaterThanOrEqual(2);
    expect(reply.dropdowns.some((entry) => /country/i.test(entry.label))).toBe(true);
    // Read-only: the page must look exactly as it did.
    expect(displayed('country')).toBe('Select…');
  });
});

describe('one click reaches every engine and waits for each', () => {
  it('emits a paired marker for every engine, ending with RUN_COMPLETED', async () => {
    const outcome = await run();
    expect(outcome.markers[0]).toBe('AUTOFILL_ORCHESTRATOR_STARTED');
    expect(outcome.markers).toContain('TEXT_STAGE_STARTED');
    expect(outcome.markers).toContain('TEXT_STAGE_FINISHED');
    expect(outcome.markers).toContain('DROPDOWN_ENGINE_STARTED');
    expect(outcome.markers).toContain('DROPDOWN_ENGINE_FINISHED');
    expect(outcome.markers).toContain('DEPENDENCY_ENGINE_STARTED');
    expect(outcome.markers).toContain('DEPENDENCY_ENGINE_FINISHED');
    expect(outcome.markers).toContain('FINAL_AUDIT_STARTED');
    expect(outcome.markers).toContain('FINAL_AUDIT_FINISHED');
    expect(outcome.markers.at(-1)).toBe('RUN_COMPLETED');

    // Every STARTED has its FINISHED, which is what "the run waited" means.
    const opened = outcome.markers.filter((marker) => marker.endsWith('_STARTED'));
    const closed = outcome.markers.filter((marker) => marker.endsWith('_FINISHED'));
    expect(closed.length).toBe(opened.length - 1); // the orchestrator's own start
  });

  it('runs the dropdown stage before the dependency stage', async () => {
    const outcome = await run();
    expect(outcome.markers.indexOf('DROPDOWN_ENGINE_FINISHED')).toBeLessThan(
      outcome.markers.indexOf('DEPENDENCY_ENGINE_STARTED'),
    );
  });

  it('cannot reach the final audit before the engines have finished', async () => {
    const outcome = await run();
    const audit = outcome.markers.indexOf('FINAL_AUDIT_STARTED');
    expect(outcome.markers.lastIndexOf('DROPDOWN_ENGINE_FINISHED')).toBeLessThan(audit);
    expect(outcome.markers.lastIndexOf('DEPENDENCY_ENGINE_FINISHED')).toBeLessThan(audit);
  });

  it('starts at most one primary pass of each engine per pass of the loop', async () => {
    const outcome = await run();
    const passes = new Set(
      outcome.trace.engineInvocations
        .filter((entry) => entry.marker === 'DROPDOWN_ENGINE_STARTED')
        .map((entry) => entry.pass),
    );
    expect(outcome.invocations.dropdown).toBe(passes.size);
    expect(outcome.invocations.dependency).toBeLessThanOrEqual(outcome.invocations.dropdown);
  });

  it('keeps the popup in a running state while the dropdowns are driven', async () => {
    const outcome = await run();
    expect(outcome.phases).toContain('filling_dropdowns');
    // The run was still working when the dropdown stage returned — it had not
    // already reported a terminal phase behind the engine's back.
    expect(['completed', 'completed_with_review', 'failed']).not.toContain(
      outcome.phaseWhenDropdownsFinished,
    );
  });
});

describe('Country and State, driven end to end by one run', () => {
  it('selects and verifies Country through the engine and the frame executor', async () => {
    const outcome = await run();
    const country = stagesFor(outcome.trace, /country/i);
    expect(country.found).toBe(true);
    expect(country.engineCalled).toBe(true);
    expect(country.executorCalled).toBe(true);
    expect(country.optionsFound).toBe(true);
    expect(country.verified).toBe(true);
    expect(displayed('country')).toBe('United States of America');
  });

  it('waits for Country, then selects and verifies State', async () => {
    const outcome = await run();
    const state = stagesFor(outcome.trace, /state\/province/i);
    expect(state.engineCalled).toBe(true);
    expect(state.executorCalled).toBe(true);
    expect(state.verified).toBe(true);
    // The proof that the ordering held: the region list did not exist until
    // Country landed, so a State holding New Jersey can only have been driven
    // afterwards.
    expect(displayed('state')).toBe('New Jersey');
  });

  it('records the dependency edge it drove', async () => {
    const outcome = await run();
    const edge = outcome.trace.dependencies.find((entry) => entry.dependent.intent === 'state');
    expect(edge, 'the run recorded no Country → State edge').toBeTruthy();
  });
});

describe('an older verdict never overwrites a newer verification', () => {
  it('keeps a dropdown-verified control verified when a stale plan calls it failed', async () => {
    const outcome = await run({ staleFailureAfterDropdowns: true });
    const state = stagesFor(outcome.trace, /state\/province/i);
    expect(state.verified).toBe(true);
    expect(state.status).toBe('FILLED_VERIFIED');
    expect(displayed('state')).toBe('New Jersey');
  });
});

describe('cancelling stops the run without leaving an engine running', () => {
  it('finishes the engine it is inside and starts no further one', async () => {
    const outcome = await run({ cancelAfterDropdowns: true });
    expect(outcome.status).toBe('cancelled');
    // The dropdown pass it was inside completed rather than being abandoned
    // mid-menu, and the dependency pass it had not reached never opened one.
    expect(outcome.invocations.dropdown).toBe(1);
    expect(outcome.invocations.dependency).toBe(0);
  });
});
