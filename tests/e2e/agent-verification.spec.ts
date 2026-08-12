import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * A visibly persisted action increments the production agent's verified count.
 *
 * ## The live failure
 *
 * A real Lincoln Electric run reported, from the service-worker console:
 *
 *     status: BLOCKED   observations: 7   actions: 6   verified: 0
 *     failureCode: undefined
 *
 * while text fields visibly filled on the page. Six writes reached the
 * employer's DOM and the run counted none of them, then gave up without saying
 * why.
 *
 * ## Why this goes through the shipped bundle
 *
 * Nothing here imports `extension/src`. The only input is one click on the
 * popup's own "Autofill Application" button; the evidence is the employer
 * page's DOM afterwards and the Agent Trace the run exports.
 *
 * That matters especially for an accounting repair. Every layer of it has unit
 * tests, and a verified counter that works when its helpers are called directly
 * and not through the production path would reproduce the original failure
 * exactly while showing green — which is the failure mode this project has
 * shipped before.
 *
 * ## What the fixture holds open
 *
 * Six text controls the profile can answer, four of them beside a permanent
 * "This field is required" hint and one of them reformatting what it stores;
 * and one dropdown that changes its displayed text and commits nothing. So the
 * run must produce six verified actions *and* one that correctly refuses to
 * verify — a build that simply counted every action would fail this as surely
 * as one that counted none.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/agent-verification.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RUN_BUDGET_MS = 90_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

const RESUME_BYTES = Buffer.from('%PDF-1.4\n% resume\n%%EOF');

const PROFILE = {
  updatedAt: '2026-08-05T00:00:00.000Z',
  personal: {
    legalFirstName: 'Robin',
    legalLastName: 'Vale',
    email: 'robin.vale@example.com',
    phone: '+1 201 555 0134',
    address: {
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      country: 'United States',
    },
  },
  education: [
    {
      id: 'education-1',
      institution: 'Rutgers University',
      degree: "Bachelor's Degree",
      major: 'Electrical Engineering',
      status: 'in_progress',
    },
  ],
  experience: [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ],
  preferences: {},
};

interface AgentActionTrace {
  step: number;
  decisionTool: string;
  targetControlType: string;
  targetIntent: string;
  logicalKey: string;
  actionAccepted: boolean;
  executionStarted: boolean;
  executionFinished: boolean;
  executionSuccess: boolean;
  domChanged: boolean;
  observationBefore: string;
  observationAfter: string;
  freshObservation: boolean;
  verificationStrategy: string;
  verificationExpectedState: string;
  verificationObservedState: string;
  verified: boolean;
  verification: string;
  errorCode?: string;
  durationMs: number;
}

interface AgentStep {
  step: number;
  decisionType: string;
  tool?: string;
  targetLabel: string;
  targetSection: string;
  executed: boolean;
  verification: string;
  errorCode?: string;
  observationId: string;
  action?: AgentActionTrace;
}

interface AgentTrace {
  runId: string;
  buildId: string;
  status: string;
  observationCount: number;
  actionCount: number;
  verifiedCount: number;
  submitActionCount: number;
  failureCode?: string;
  steps: AgentStep[];
  openQuestions: string[];
}

async function extensionPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/fill-plan.html`);
  return page;
}

async function message<T>(page: Page, payload: Record<string, unknown>): Promise<T> {
  return page.evaluate<T, Record<string, unknown>>(
    (value) => chrome.runtime.sendMessage(value),
    payload,
  );
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-verify-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  const setup = await extensionPage();
  await setup.evaluate(
    ({ serverUrl, authToken }) =>
      chrome.storage.local.set({
        settings: {
          serverUrl,
          authToken,
          selectedModel: 'mock-grounded:latest',
          selectedDocumentId: null,
          aiGenerationEnabled: false,
          settingsVersion: 1,
          settingsUpdatedAt: new Date().toISOString(),
          ai: {
            generationModel: 'mock-grounded:latest',
            temperature: 0.2,
            maximumGenerationTokens: 768,
            defaultAnswerLength: 'short',
            generationTimeoutMs: 30000,
            maximumRetries: 1,
            maximumConcurrentGenerations: 2,
            regenerateBehavior: 'keep_previous',
            preferredTone: 'natural and professional',
          },
        },
      }),
    { serverUrl: AGENT_URL, authToken: TOKEN },
  );

  const stored = await message<{
    result: { ok: true; bundleId: string } | { ok: false; reason: string };
  }>(setup, {
    type: 'SAVE_APPLICATION_BUNDLE',
    bundle: {
      bundleVersion: 2,
      websiteJobId: 'job-agent-verification',
      company: 'Northwind Industrial',
      jobTitle: 'Engineering Intern',
      jobDescription: 'Welding and automation systems engineering internship.',
      officialApplicationUrl: APPLICATION_URL,
      // The bundle schema requires one. This page has no upload control, so it
      // is never attached and never influences the run.
      documents: [
        {
          kind: 'resume',
          filename: 'Robin-Vale-Resume.pdf',
          mimeType: 'application/pdf',
          contentBase64: RESUME_BYTES.toString('base64'),
          byteLength: RESUME_BYTES.byteLength,
          generatedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      profile: PROFILE,
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-05T00:00:00.000Z',
    },
  });
  expect(
    stored.result.ok,
    `the bundle was rejected: ${stored.result.ok ? '' : stored.result.reason}`,
  ).toBe(true);

  await setup.evaluate(() => chrome.storage.local.remove('autoStartArmed'));
  await setup.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

interface Evidence {
  application: Page;
  trace: AgentTrace;
  values: Record<string, string>;
}

let evidence: Evidence;

async function read(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((node: HTMLInputElement) => node.value ?? '')
    .catch(() => '');
}

test.beforeAll(async () => {
  test.setTimeout(RUN_BUDGET_MS + 60_000);
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);
  expect(await read(application, '#city'), 'the fixture did not start blank').toBe('');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  // Closed before polling: an open popup refreshes status and documents against
  // the local server for the whole run, and the server's rate limit is a
  // deliberate hard-coded constant rather than configuration.
  await popup.close();

  const evidencePage = await extensionPage();
  const exported = await (async () => {
    const deadline = Date.now() + RUN_BUDGET_MS;
    for (;;) {
      const attempt = await message<{ trace?: AgentTrace; error?: { message: string } }>(
        evidencePage,
        { type: 'EXPORT_AGENT_TRACE' },
      );
      if (attempt.trace) return attempt;
      if (Date.now() >= deadline) return attempt;
      await evidencePage.waitForTimeout(1000);
    }
  })();
  await evidencePage.close();
  expect(
    exported.trace,
    `no agent trace was recorded: ${exported.error?.message ?? ''}`,
  ).toBeTruthy();

  const values: Record<string, string> = {};
  for (const id of ['addressLine1', 'city', 'postalCode', 'phone', 'employer0', 'title0']) {
    values[id] = await read(application, `#${id}`);
  }
  evidence = { application, trace: exported.trace!, values };
});

// ---------------------------------------------------------------------------
test.describe('the live signature cannot recur', () => {
  test('does not report actions with zero verified', () => {
    // The exact live shape, asserted as a shape so it fails loudly.
    const liveSignature = evidence.trace.actionCount > 0 && evidence.trace.verifiedCount === 0;
    expect(liveSignature, 'the run took actions and counted none of them').toBe(false);
  });

  test('every value it wrote is actually on the page', () => {
    // The premise of the whole repair: these writes really did land, so a run
    // that fails to count them is wrong about itself rather than unlucky.
    expect(evidence.values.addressLine1).toBe('48 Maple Avenue');
    expect(evidence.values.city).toBe('Clifton');
    expect(evidence.values.postalCode).toBe('07011');
    expect(evidence.values.employer0).toBe('Northwind Robotics');
    expect(evidence.values.title0).toBe('Engineering Intern');
    // Stored in the employer's own format, which is correct behaviour.
    expect(evidence.values.phone).toBe('(201) 555-0134');
  });
});

// ---------------------------------------------------------------------------
test.describe('BUILT TEST: six text actions, six verified', () => {
  test('counts at least six verified actions', () => {
    expect(evidence.trace.actionCount).toBeGreaterThanOrEqual(6);
    expect(evidence.trace.verifiedCount).toBeGreaterThanOrEqual(6);
  });

  test('the counter matches the steps it is counting', () => {
    // A counter that disagreed with its own steps would be the accounting bug
    // wearing different clothes.
    const verifiedSteps = evidence.trace.steps.filter(
      (step) => step.verification === 'VERIFIED',
    ).length;
    expect(evidence.trace.verifiedCount).toBe(verifiedSteps);
  });

  test('the reformatted phone verified rather than failing', () => {
    const step = evidence.trace.steps.find((entry) => entry.targetLabel.includes('Phone'));
    expect(step?.verification).toBe('VERIFIED');
    expect(step?.errorCode).toBeUndefined();
  });

  test('a field beside a permanent "required" hint verified', () => {
    // The primary root cause, through the production path.
    const step = evidence.trace.steps.find((entry) => entry.targetLabel.includes('Street Address'));
    expect(step?.verification).toBe('VERIFIED');
  });
});

// ---------------------------------------------------------------------------
test.describe('one TEXT_INPUT action, end to end', () => {
  test('records execution, a fresh observation, correlation, and the verdict', () => {
    const action = evidence.trace.steps.find(
      (step) => step.tool === 'type' && step.targetLabel.includes('City'),
    )?.action;
    expect(action, 'no action trace for the City write').toBeDefined();
    expect(action?.targetControlType).toBe('TEXT_INPUT');
    expect(action?.actionAccepted).toBe(true);
    expect(action?.executionSuccess).toBe(true);
    // The re-observation genuinely happened: two different readings of the page.
    expect(action?.freshObservation).toBe(true);
    expect(action?.observationBefore).not.toBe(action?.observationAfter);
    // The control was correlated across those two readings.
    expect(action?.logicalKey.length).toBeGreaterThan(0);
    expect(action?.verificationStrategy).toBe('TEXT_VALUE');
    expect(action?.verificationObservedState).toBe('HOLDS_EXPECTED');
    expect(action?.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
test.describe('one dropdown that displays a choice and commits nothing', () => {
  test('does not verify, and says exactly why', () => {
    const selections = evidence.trace.steps.filter((step) => step.tool === 'select_option');
    expect(selections.length, 'the run never tried to answer Education Type').toBeGreaterThan(0);

    // Not counted, whichever layer caught it.
    //
    // Two layers can notice a control that displays a choice and keeps nothing,
    // and on this fixture the *executor's* own commitment check gets there
    // first: it reports `executed: false, SELECTION_NOT_COMMITTED`, so the
    // verifier never has to form an opinion. That is a better outcome than the
    // verifier catching it — the run learns sooner — and the guarantee under
    // test is the same either way, so the assertion is written on the
    // guarantee rather than on which layer happened to fire.
    //
    // The verifier-layer path, where the executor reports success and the page
    // contradicts it, is asserted exactly in `agentVerification.test.ts`
    // against a control that reports a clean execution.
    for (const step of selections) {
      expect(step.verification, 'an uncommitted selection was counted').not.toBe('VERIFIED');
      expect(step.action?.verified).toBe(false);
      expect(
        ['SELECTION_NOT_COMMITTED', 'OPTION_SELECTION_NOT_COMMITTED'],
        'the refusal was not named',
      ).toContain(step.errorCode);
    }
    expect(evidence.trace.steps.some((step) => step.errorCode === undefined && step.executed)).toBe(
      true,
    );
  });

  test('a broken dropdown does not take the working fields down with it', () => {
    expect(evidence.trace.verifiedCount).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
test.describe('the run says what became of it', () => {
  test('never ends BLOCKED with no reason', () => {
    if (evidence.trace.status === 'BLOCKED' || evidence.trace.status === 'FAILED') {
      expect(evidence.trace.failureCode, 'the run stopped short and said nothing').toBeDefined();
    }
  });

  test('every executed action carries its own record', () => {
    // Item 17: the exported trace is per-action, not two aggregate counters.
    const executed = evidence.trace.steps.filter((step) => step.executed);
    expect(executed.length).toBeGreaterThan(0);
    for (const step of executed) {
      expect(step.action, `step ${step.step} carried no action record`).toBeDefined();
      expect(step.action?.decisionTool).toBe(step.tool);
    }
  });

  test('every action record states execution and verification separately', () => {
    for (const step of evidence.trace.steps) {
      if (!step.action) continue;
      expect(typeof step.action.executionSuccess).toBe('boolean');
      expect(typeof step.action.verified).toBe('boolean');
      // A verified action is never one that did not execute.
      if (step.action.verified) expect(step.action.executionSuccess).toBe(true);
    }
  });

  test('the trace carries no personal value', () => {
    // Asserted against the serialized form, so a field added later that could
    // hold one fails here.
    const serialized = JSON.stringify(evidence.trace);
    for (const value of ['48 Maple Avenue', 'Clifton', '07011', '201 555 0134', '(201) 555-0134']) {
      expect(serialized, `the trace leaked ${value}`).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('the guarantees that must survive', () => {
  test('the final Submit was never pressed', async () => {
    expect(evidence.trace.submitActionCount).toBe(0);
    const submitted = await evidence.application
      .locator('body')
      .getAttribute('data-submitted')
      .catch(() => null);
    expect(submitted).toBeNull();
  });

  test('the loop re-observed after each action', () => {
    expect(evidence.trace.observationCount).toBeGreaterThan(1);
    const observationIds = new Set(evidence.trace.steps.map((step) => step.observationId));
    expect(observationIds.size).toBeGreaterThan(1);
  });
});
