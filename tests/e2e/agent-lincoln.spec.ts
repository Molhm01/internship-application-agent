import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Agent Mode, through the production button, on a Lincoln-style application.
 *
 * The claim being tested is architectural, so the test is written against the
 * *shape* of the run rather than against a list of filled fields: did the
 * extension observe, decide one action, execute it, observe again, and repeat —
 * or did it do what the old pipeline did and plan everything at once?
 *
 * Nothing here imports `extension/src`. The only input is one click on the
 * popup's own "Autofill Application" button, and the evidence is the employer
 * page's DOM afterwards plus the Agent Trace the run exports. A loop that works
 * when its helpers are called directly, and not through the shipped bundle,
 * cannot make this pass — which is the failure mode that let a complete,
 * tested, unreachable Dropdown Engine ship twice.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/lincoln-application.html`;
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'agent-run-evidence.json',
);
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RUN_BUDGET_MS = 90_000;

/** The loop has to be genuinely iterative, not one batched pass wearing a loop. */
const MINIMUM_ACTIONS = 15;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

const RESUME_BYTES = Buffer.from('%PDF-1.4\n% resume\n%%EOF');

/**
 * Two jobs and two education records, on purpose.
 *
 * The page ships one block of each, so the agent has to notice the shortfall,
 * press Add, observe the block that appeared, and fill it — which is four
 * distinct observe/act cycles that a single planned pass cannot produce.
 */
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
      gpa: 3.7,
      graduationDate: '2027-05',
      status: 'in_progress',
    },
    {
      id: 'education-2',
      institution: 'Clifton High School',
      degree: 'High School',
      status: 'completed',
    },
  ],
  highestCompletedDegree: 'High School',
  currentDegreeInProgress: "Bachelor's Degree",
  experience: [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      location: 'Newark, New Jersey',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      employmentType: 'Internship',
      responsibilities: ['Built test rigs for actuator assemblies.'],
      achievements: [],
    },
    {
      id: 'experience-2',
      employer: 'Clifton Hardware',
      title: 'Sales Associate',
      location: 'Clifton, New Jersey',
      startDate: '2025-06',
      endDate: '2025-09',
      current: false,
      employmentType: 'Part Time',
      responsibilities: ['Served customers on the trade counter.'],
      achievements: [],
    },
  ],
  eligibility: {
    workAuthorization: 'U.S. Citizen',
    willingToRelocate: true,
    hasDriversLicense: true,
    meetsMinimumAge: true,
    earliestStartDate: '2027-06-01',
  },
  preferences: { discoverySource: 'LinkedIn' },
};

/** Nothing about the applicant may appear in the relatives box. */
const IDENTITY_VALUES = ['Robin', 'Vale', 'robin.vale@example.com', '48 Maple Avenue'];

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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-agentmode-'));
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
      websiteJobId: 'job-agent-lincoln',
      company: 'Lincoln Electric',
      jobTitle: 'Engineering Intern',
      jobDescription: 'Welding and automation systems engineering internship.',
      officialApplicationUrl: APPLICATION_URL,
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

interface AgentStep {
  step: number;
  observationId: string;
  observedElements: number;
  requiredOutstanding: number;
  decisionType: string;
  reason: string;
  tool?: string;
  targetKind?: string;
  targetLabel: string;
  targetSection: string;
  executed: boolean;
  wroteValue: boolean;
  optionsSeen: number;
  pageChanged: boolean;
  verification: string;
  errorCode?: string;
  durationMs: number;
}

interface AgentTrace {
  runId: string;
  buildId: string;
  status: string;
  observationCount: number;
  actionCount: number;
  verifiedCount: number;
  questionsAsked: number;
  submitActionCount: number;
  decider: string;
  decisionProviderCalled: boolean;
  observedFieldsInitial: number;
  actionableFieldsInitial: number;
  knownAnswerFieldsInitial: number;
  askUserFieldsInitial: number;
  failureCode?: string;
  finalReadyEvaluation?: {
    unresolvedRequired: number;
    knownActionableRemaining: number;
    askUserRemaining: number;
    documentsPending: boolean;
    finalSubmitReached: boolean;
    ready: boolean;
  };
  profileContext?: {
    profileLoaded: boolean;
    hasAddress: boolean;
    hasCity: boolean;
    hasPostalCode: boolean;
    hasPhone: boolean;
  };
  markers: Array<{ marker: string }>;
  steps: AgentStep[];
  openQuestions: string[];
}

interface Evidence {
  application: Page;
  trace: AgentTrace;
  values: Record<string, string>;
}

let evidence: Evidence;

/** Reads a control's displayed value, whatever kind it is. */
async function read(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((node: HTMLElement) => {
      if (node instanceof HTMLSelectElement) {
        return node.selectedOptions[0]?.textContent?.trim() ?? '';
      }
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        return node.value;
      }
      return node.textContent?.trim() ?? '';
    })
    .catch(() => '');
}

test.beforeAll(async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  const relativesBefore = await read(application, '#relativeDetails');
  expect(relativesBefore, 'the fixture did not start with the relatives box empty').toBe('');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();

  // Waited on the *run*, not on the popup's summary panel.
  //
  // The popup still renders the legacy whole-page report, which Agent Mode does
  // not produce — so waiting for `.autofill__summary` would be waiting for a
  // component this path deliberately no longer feeds. The production command is
  // the button; the finished agent run is what it produces, and that is what
  // this polls for.
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
      await evidencePage.waitForTimeout(500);
    }
  })();
  await evidencePage.close();
  await popup.close();
  expect(
    exported.trace,
    `no agent trace was recorded: ${exported.error?.message ?? ''}`,
  ).toBeTruthy();

  const values: Record<string, string> = {};
  for (const id of [
    'firstName',
    'lastName',
    'email',
    'phone',
    'addressLine1',
    'city',
    'postalCode',
    'country',
    'state',
    'relativesEmployed',
    'relativeDetails',
    'educationType',
    'graduated',
  ]) {
    values[id] = await read(application, `#${id}`);
  }

  evidence = { application, trace: exported.trace!, values };

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        buildId: evidence.trace.buildId,
        status: evidence.trace.status,
        observationCount: evidence.trace.observationCount,
        actionCount: evidence.trace.actionCount,
        verifiedCount: evidence.trace.verifiedCount,
        questionsAsked: evidence.trace.questionsAsked,
        submitActionCount: evidence.trace.submitActionCount,
        openQuestions: evidence.trace.openQuestions,
        observedFieldsInitial: evidence.trace.observedFieldsInitial,
        actionableFieldsInitial: evidence.trace.actionableFieldsInitial,
        knownAnswerFieldsInitial: evidence.trace.knownAnswerFieldsInitial,
        askUserFieldsInitial: evidence.trace.askUserFieldsInitial,
        decisionProviderCalled: evidence.trace.decisionProviderCalled,
        finalReadyEvaluation: evidence.trace.finalReadyEvaluation,
        profileContext: evidence.trace.profileContext,
        failureCode: evidence.trace.failureCode,
        values,
        steps: evidence.trace.steps,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test.describe('the zero-action exit cannot come back', () => {
  test('does not finish after one observation with no actions', () => {
    // The exact live signature: observations 1, actions 0, verified 0,
    // READY_FOR_REVIEW, over a blank application. Asserted as a shape so it
    // fails loudly rather than being read off a summary line.
    const zeroAction =
      evidence.trace.observationCount <= 1 &&
      evidence.trace.actionCount === 0 &&
      evidence.trace.verifiedCount === 0;
    expect(zeroAction, 'the agent exited without doing anything').toBe(false);
  });

  test('saw the page despite its vendor chrome', () => {
    // The fixture carries thirty header buttons. Before the repair the
    // observation threw on a twenty-item cap, the frame answered nothing, and
    // every one of the form's controls was invisible to the agent.
    expect(evidence.trace.observedFieldsInitial).toBeGreaterThan(0);
  });

  test('had something it could act on from the very first observation', () => {
    expect(evidence.trace.actionableFieldsInitial).toBeGreaterThan(0);
  });

  test('called a decision provider', () => {
    expect(evidence.trace.decisionProviderCalled).toBe(true);
  });

  test('finished on a readiness evaluation with nothing left to apply', () => {
    const readiness = evidence.trace.finalReadyEvaluation;
    expect(readiness, 'no readiness evaluation was recorded').toBeTruthy();
    if (evidence.trace.status === 'READY_FOR_REVIEW') {
      expect(readiness!.knownActionableRemaining).toBe(0);
      expect(readiness!.askUserRemaining).toBe(0);
      expect(readiness!.documentsPending).toBe(false);
    }
  });

  test('emitted the markers a live console needs', () => {
    const emitted = new Set(evidence.trace.markers.map((entry) => entry.marker));
    for (const marker of [
      'AGENT_RUN_STARTED',
      'AGENT_OBSERVATION_CREATED',
      'AGENT_DECISION_REQUEST_STARTED',
      'AGENT_DECISION_REQUEST_FINISHED',
      'AGENT_ACTION_SELECTED',
      'AGENT_ACTION_EXECUTION_FINISHED',
      'AGENT_VERIFICATION_FINISHED',
      'AGENT_READY_EVALUATION',
    ]) {
      expect(emitted, `marker ${marker} was never emitted`).toContain(marker);
    }
  });

  test('reports what the profile could offer', () => {
    const context = evidence.trace.profileContext;
    expect(context, 'no profile context was recorded').toBeTruthy();
    expect(context!.profileLoaded).toBe(true);
    expect(context!.hasAddress).toBe(true);
    expect(context!.hasCity).toBe(true);
    expect(context!.hasPostalCode).toBe(true);
    expect(context!.hasPhone).toBe(true);
  });
});

test.describe('the run is genuinely a loop', () => {
  test('meets the iterative floor', () => {
    expect(evidence.trace.observationCount).toBeGreaterThanOrEqual(10);
    expect(evidence.trace.actionCount).toBeGreaterThanOrEqual(8);
    expect(evidence.trace.verifiedCount).toBeGreaterThanOrEqual(6);
  });

  test('observed, decided, acted and observed again — many times', () => {
    // The core claim. A batched pass produces one observation and one burst of
    // writes; a loop produces an observation per action.
    expect(evidence.trace.actionCount).toBeGreaterThanOrEqual(MINIMUM_ACTIONS);
    expect(evidence.trace.observationCount).toBeGreaterThan(evidence.trace.actionCount);
  });

  test('every action carries its own observation', () => {
    const actions = evidence.trace.steps.filter((step) => step.decisionType === 'ACTION');
    const distinct = new Set(actions.map((step) => step.observationId));
    // Not one observation reused across a plan: each action was decided against
    // a page state taken after the previous one finished.
    expect(distinct.size).toBeGreaterThanOrEqual(Math.min(actions.length, MINIMUM_ACTIONS));
  });

  test('each step names exactly one tool', () => {
    for (const step of evidence.trace.steps) {
      if (step.decisionType !== 'ACTION') continue;
      expect(step.tool, `step ${step.step} had no tool`).toBeTruthy();
    }
  });

  test('reaches READY_FOR_REVIEW', () => {
    expect(evidence.trace.status).toBe('READY_FOR_REVIEW');
  });
});

test.describe('the page afterwards', () => {
  for (const [id, expected] of [
    ['firstName', 'Robin'],
    ['lastName', 'Vale'],
    ['email', 'robin.vale@example.com'],
    ['addressLine1', '48 Maple Avenue'],
    ['city', 'Clifton'],
    ['postalCode', '07011'],
  ] as const) {
    test(`${id} holds the saved value`, () => {
      expect(evidence.values[id]).toBe(expected);
    });
  }

  test('Country is answered', () => {
    expect(evidence.values.country).toMatch(/United States/i);
  });

  test('State is answered after Country, from the list the page then offered', () => {
    // The dependency, without a dependency graph: State is empty and disabled
    // on one observation and answerable on the next, and the only thing that
    // changed is that Country now holds an answer.
    expect(evidence.values.state).toMatch(/New Jersey/i);
  });
});

test.describe('safety, through the shipped bundle', () => {
  test('pressed nothing that would submit the application', () => {
    expect(evidence.trace.submitActionCount).toBe(0);
  });

  test('did not click the fixture’s submit control', async () => {
    await expect(evidence.application.locator('body')).not.toHaveAttribute(
      'data-submitted',
      'true',
    );
  });

  test('left the relatives question for the applicant', () => {
    // Reading a select gives its selected option's text, so an unanswered one
    // shows the page's own prompt rather than an empty string.
    expect(evidence.values.relativesEmployed).toMatch(/^(|No Selection)$/);
  });

  test('left the relatives detail box empty', () => {
    expect(evidence.values.relativeDetails).toBe('');
  });

  test('put no part of the applicant’s identity into the relatives box', () => {
    for (const value of IDENTITY_VALUES) {
      expect(evidence.values.relativeDetails).not.toContain(value);
    }
  });

  test('asked about what it could not answer instead of guessing', () => {
    // A required question nothing saved answers becomes a question, not a
    // fabricated value.
    expect(evidence.trace.questionsAsked).toBeGreaterThan(0);
  });
});

test.describe('the exported trace', () => {
  test('carries no answer anywhere in it', () => {
    const serialized = JSON.stringify(evidence.trace);
    for (const answer of [
      'Robin',
      'Vale',
      'robin.vale@example.com',
      '48 Maple Avenue',
      '07011',
      'Northwind Robotics',
      'Rutgers University',
    ]) {
      expect(serialized, `the agent trace leaked "${answer}"`).not.toContain(answer);
    }
  });

  test('names the questions it stopped on, in the employer’s own words', () => {
    expect(evidence.trace.openQuestions.length).toBe(evidence.trace.questionsAsked);
  });

  test('says which decider produced it', () => {
    expect(['deterministic', 'model']).toContain(evidence.trace.decider);
  });
});

test.describe('a dropdown is opened and chosen from, never typed into', () => {
  /** Every step the run took against a control whose label matches. */
  const stepsFor = (question: RegExp): AgentStep[] =>
    evidence.trace.steps.filter((step) => question.test(step.targetLabel));

  test('no step ever typed into a control that answers from a list', () => {
    // The whole contract, stated as a fact about the finished run. A `type`
    // against a dropdown is the live failure; if one had happened, the step
    // would be here.
    const typedIntoDropdown = evidence.trace.steps.filter(
      (step) => step.tool === 'type' && step.targetKind === 'dropdown' && step.executed,
    );
    expect(
      typedIntoDropdown.map((step) => step.targetLabel),
      'the agent typed an answer into a dropdown',
    ).toEqual([]);
  });

  for (const [name, question] of [
    ['State/Province', /state\/province/i],
    ['Employment Type', /employment type/i],
    ['Education Type', /education type/i],
    ['Area of Study', /area of study/i],
    ['Graduated?', /graduated/i],
  ] as const) {
    test(`${name} was opened, read, and chosen from`, () => {
      const steps = stepsFor(question);
      if (steps.length === 0) {
        // The control was never reached — a different failure, and one the
        // other gates cover. Nothing to assert about the contract here.
        expect(steps.length, `${name} was never reached by the run`).toBeGreaterThan(0);
        return;
      }
      const tools = steps.filter((step) => step.executed).map((step) => step.tool);
      expect(tools, `${name} was typed into`).not.toContain('type');

      const selected = steps.find((step) => step.tool === 'select_option' && step.executed);
      if (selected) {
        // A selection only ever follows a read of the actual list.
        expect(
          selected.optionsSeen,
          `${name} was selected without reading its options`,
        ).toBeGreaterThan(0);
      }
    });
  }

  test('every executed selection saw the options it chose from', () => {
    for (const step of evidence.trace.steps) {
      if (step.tool !== 'select_option' || !step.executed) continue;
      expect(
        step.optionsSeen,
        `"${step.targetLabel}" was selected without any option list being read`,
      ).toBeGreaterThan(0);
    }
  });
});

test.describe('text controls still take text', () => {
  for (const [id, expected] of [
    ['addressLine1', '48 Maple Avenue'],
    ['city', 'Clifton'],
    ['postalCode', '07011'],
    ['phone', '+1 201 555 0134'],
  ] as const) {
    test(`${id} still fills`, () => {
      // The regression that matters most: these only started working recently,
      // and the new refusal must apply to list controls and nothing else.
      expect(evidence.values[id]).toBe(expected);
    });
  }
});
