import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Agent Mode writes a date in the shape the employer asked for, or it asks.
 *
 * ## The live failure
 *
 * On a real Lincoln Electric application the Work Experience "From Date" box
 * displayed `MM/DD/YYYY`. The profile held that start date as `2021-07`. The
 * agent typed `2021-07` into the box and the employer's own script answered
 * "Invalid date."
 *
 * ## Why this test goes through the shipped bundle
 *
 * Nothing here imports `extension/src`. The only input is one click on the
 * popup's own "Autofill Application" button, and the evidence is the employer
 * page's DOM afterwards plus the Agent Trace the run exports.
 *
 * That matters more than usual for this repair, because the fix is spread over
 * four layers that each have their own unit tests — classification, the tool
 * validator, the formatter, the executor — and all four passing while the
 * production path still typed a raw stored date is *exactly* the failure mode
 * this project has shipped before. A date can only reach the box correctly if
 * every one of them is wired to the next.
 *
 * ## The three scenarios, on one page
 *
 * The fixture carries two saved jobs and controls that disagree about format on
 * purpose:
 *
 *  - job 1 has an exact date and its control wants `MM/DD/YYYY` → filled;
 *  - job 2 has a month and a year and its control wants `MM/YYYY` → filled;
 *  - job 1's End Date wants `MM/DD/YYYY` from a month-only record → asked.
 *
 * The last one is the guarantee. There is no day in the record, so there is no
 * day in the box.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/lincoln-dates.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RUN_BUDGET_MS = 90_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

const RESUME_BYTES = Buffer.from('%PDF-1.4\n% resume\n%%EOF');

/**
 * Two jobs, with deliberately different date precisions.
 *
 * Job 1 records an exact start day — 12 July 2021 — and an end date known only
 * to the month. Job 2 records both to the month. That split is the whole point:
 * one page, one profile, and three different correct outcomes depending on what
 * each control asks for and what the record actually holds.
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
  education: [],
  experience: [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      startDate: '2021-07-12',
      endDate: '2022-03',
      current: false,
      responsibilities: [],
      achievements: [],
    },
    {
      id: 'experience-2',
      employer: 'Clifton Hardware',
      title: 'Sales Associate',
      startDate: '2020-06',
      endDate: '2020-09',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ],
  // Left at the schema default — `ask` — on purpose. The month-only End Date on
  // job 1 must produce a question rather than a fabricated day, and it can only
  // do that if nothing here quietly opts the applicant into a convention.
  preferences: {},
};

interface AgentDateTrace {
  elementId: string;
  field: string;
  controlType: string;
  profilePrecision: string;
  requiredFormat?: string;
  exactDateAvailable: boolean;
  dateConventionUsed: string;
  requestedTool?: string;
  toolAllowed: boolean;
  rejectionCode?: string;
  formattedValueShape?: string;
  executionResult: string;
  verified: boolean;
  finalStatus: string;
  errorCode?: string;
}

interface AgentStep {
  step: number;
  decisionType: string;
  tool?: string;
  targetKind?: string;
  targetLabel: string;
  targetSection: string;
  executed: boolean;
  verification: string;
  errorCode?: string;
  observationId: string;
  date?: AgentDateTrace;
}

interface AgentTrace {
  runId: string;
  buildId: string;
  status: string;
  observationCount: number;
  actionCount: number;
  verifiedCount: number;
  submitActionCount: number;
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-dates-'));
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
      websiteJobId: 'job-agent-dates',
      company: 'Northwind Industrial',
      jobTitle: 'Engineering Intern',
      jobDescription: 'Welding and automation systems engineering internship.',
      officialApplicationUrl: APPLICATION_URL,
      // The bundle schema requires one. This page has no upload control, so it
      // is never attached and never influences the run — it is here to satisfy
      // the handoff contract, not to be exercised.
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
  invalid: Record<string, boolean>;
}

let evidence: Evidence;

async function read(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((node: HTMLInputElement) => node.value ?? '')
    .catch(() => '');
}

async function flaggedInvalid(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .evaluate((node: HTMLElement) => node.getAttribute('aria-invalid') === 'true')
    .catch(() => false);
}

test.beforeAll(async () => {
  // The whole run happens in this hook — one button click and one agent loop
  // over a dozen controls — so it needs more than the file's per-test budget.
  test.setTimeout(RUN_BUDGET_MS + 60_000);
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);
  expect(await read(application, '#from0'), 'the fixture did not start with From Date empty').toBe(
    '',
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();

  // Closed before polling, not after.
  //
  // The run lives in the service worker and does not need the popup open. What
  // an open popup *does* need is periodic status and document refreshes against
  // the local server, and the server's rate limit is a deliberate hard-coded
  // constant rather than configuration. Leaving this page open for the whole
  // poll pushed the whole suite's sixty-second window over that limit and made
  // an unrelated spec fail — so this test pays for its own run rather than
  // charging it to whichever spec happens to follow.
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

  const ids = [
    'firstName',
    'lastName',
    'addressLine1',
    'city',
    'postalCode',
    'phone',
    'employer0',
    'title0',
    'from0',
    'to0',
    'employer1',
    'title1',
    'from1',
    'to1',
  ];
  const values: Record<string, string> = {};
  const invalid: Record<string, boolean> = {};
  for (const id of ids) {
    values[id] = await read(application, `#${id}`);
    invalid[id] = await flaggedInvalid(application, `#${id}`);
  }

  evidence = { application, trace: exported.trace!, values, invalid };
});

// ---------------------------------------------------------------------------
test.describe('the previous live failure cannot recur', () => {
  test('never puts the profile’s storage format into the DOM', () => {
    // The whole point, asserted against the employer's page rather than against
    // a helper. `2021-07` is what the profile holds and it is not a date any
    // control on this page accepts.
    const stored = ['2021-07', '2021-07-12', '2022-03', '2020-06', '2020-09'];
    for (const [id, value] of Object.entries(evidence.values)) {
      expect(stored, `${id} received the profile's raw storage format`).not.toContain(value);
    }
  });

  test('leaves no date control flagged invalid by the employer', () => {
    // The live symptom. A control the page has flagged is a control the
    // employer refused, whatever it displays.
    for (const id of ['from0', 'to0', 'from1', 'to1']) {
      expect(evidence.invalid[id], `${id} is still flagged invalid`).toBe(false);
    }
  });

  test('never asked to type into a date control, or was refused when it did', () => {
    // Both halves of the contract in one assertion. The decider should not
    // choose `type` for a DATE_INPUT at all; and if some future change makes it,
    // the validator has to have refused it. What must never appear is a step
    // where `type` targeted a date control and executed.
    const typedIntoADate = evidence.trace.steps.filter(
      (step) => step.tool === 'type' && step.targetKind === 'date' && step.executed,
    );
    expect(typedIntoADate, 'a date control was typed into').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
test.describe('an exact date is written in the shape the control asked for', () => {
  test('SCENARIO A: 12 July 2021 lands as 07/12/2021 in an MM/DD/YYYY box', () => {
    expect(evidence.values.from0).toBe('07/12/2021');
  });

  test('the employer accepted it', () => {
    expect(evidence.invalid.from0).toBe(false);
  });

  test('the run recorded it as verified, not merely written', () => {
    const step = evidence.trace.steps.find(
      (entry) => entry.tool === 'set_date' && entry.targetLabel.includes('From Date'),
    );
    expect(step, 'no set_date step for a From Date control').toBeTruthy();
    expect(step?.verification).toBe('VERIFIED');
    expect(step?.date?.executionResult).toBe('WRITTEN');
    expect(step?.date?.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
test.describe('each control’s own format is read, not one format for the page', () => {
  test('the MM/YYYY block gets a month and a year', () => {
    // Same page, same run, different shape — from a record that holds only a
    // month, which this control does not need a day from.
    expect(evidence.values.from1).toBe('06/2020');
    expect(evidence.values.to1).toBe('09/2020');
  });

  test('the trace names the format each control asked for', () => {
    const dateSteps = evidence.trace.steps.filter((step) => step.date !== undefined);
    expect(dateSteps.length).toBeGreaterThan(0);
    const formats = new Set(
      dateSteps.map((step) => step.date?.requiredFormat).filter((shape) => shape !== undefined),
    );
    // Two different shapes on one page. A build that applied one format
    // everywhere could not produce this set.
    expect(formats).toContain('us_full');
    expect(formats).toContain('us_month');
  });
});

// ---------------------------------------------------------------------------
test.describe('a day the applicant never recorded is never invented', () => {
  test('SCENARIO B: the month-only End Date stays empty', () => {
    // Job 1's end date is saved as `2022-03` and its control wants
    // `MM/DD/YYYY`. There is no day in the record, so there is no day in the
    // box — and specifically none of the three plausible fabrications.
    expect(['', '03/01/2022', '03/15/2022', '03/31/2022']).toContain(evidence.values.to0);
    expect(evidence.values.to0).toBe('');
  });

  test('it was asked about rather than skipped in silence', () => {
    const asked = evidence.trace.steps.filter(
      (step) => step.decisionType === 'ASK_USER' && step.targetLabel.includes('End Date'),
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.errorCode).toBe('DATE_PRECISION_INSUFFICIENT');
    expect(evidence.trace.openQuestions.length).toBeGreaterThan(0);
  });

  test('the trace explains why without recording the date', () => {
    const step = evidence.trace.steps.find(
      (entry) => entry.date !== undefined && entry.targetLabel.includes('End Date'),
    );
    // The explanation, in two fields: a record holding a month met a control
    // demanding a day. Neither field can hold a date.
    expect(step?.date?.profilePrecision).toBe('month');
    expect(step?.date?.requiredFormat).toBe('us_full');
    expect(step?.date?.exactDateAvailable).toBe(false);
    expect(step?.date?.dateConventionUsed).toBe('ask');
  });

  test('the exported trace carries no date value anywhere', () => {
    // A trace is a document people paste into bug reports. Asserted against the
    // serialized form, so a field added later that could carry one fails here.
    const serialized = JSON.stringify(evidence.trace);
    for (const value of ['07/12/2021', '2021-07-12', '06/2020', '2020-06', '2022-03']) {
      expect(serialized, `the trace leaked the date ${value}`).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('the loop re-observes, and the regressions hold', () => {
  test('observed again after every action', () => {
    // A date written against stale page state is the same class of bug as
    // everything else this loop exists to prevent, so the run has to have
    // looked again after each one.
    expect(evidence.trace.observationCount).toBeGreaterThan(evidence.trace.actionCount);
    const observationIds = new Set(evidence.trace.steps.map((step) => step.observationId));
    expect(observationIds.size).toBeGreaterThan(1);
  });

  test('text autofill still works', () => {
    // Address, City, Postal Code, Phone, Company Name and Position Title. The
    // regression that matters most, because the date repair touched the branch
    // that fills them.
    expect(evidence.values.firstName).toBe('Robin');
    expect(evidence.values.lastName).toBe('Vale');
    expect(evidence.values.addressLine1).toBe('48 Maple Avenue');
    expect(evidence.values.city).toBe('Clifton');
    expect(evidence.values.postalCode).toBe('07011');
    expect(evidence.values.employer0).toBe('Northwind Robotics');
    expect(evidence.values.title0).toBe('Engineering Intern');
  });

  test('the run recorded no submit press', () => {
    expect(evidence.trace.submitActionCount).toBe(0);
  });

  test('and the page agrees the application was not submitted', async () => {
    // Two independent readings, because a counter the run keeps about itself is
    // a claim, and the page's own marker is the fact.
    const submitted = await evidence.application
      .locator('body')
      .getAttribute('data-submitted')
      .catch(() => null);
    expect(submitted).toBeNull();
  });
});
