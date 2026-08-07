import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The Phase 4 acceptance gates, proven against the *built* extension.
 *
 * Nothing here imports from `extension/src`. The inputs are a bundle and one
 * click on the popup's "Autofill Application" button, and every assertion reads
 * either the employer page's own DOM — control values, the
 * `data-internship-agent-review` mark — or the report the worker produced.
 *
 * The profile is the one the brief specifies: a completed high-school record, a
 * bachelor's in progress, a school, a major, a GPA, an expected graduation month
 * and year, no minor, and **no** saved internship start date.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/phase4-education.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 40_000;
const DETERMINISTIC_BUDGET_MS = 5_000;

const MARK = 'data-internship-agent-review';

/** Today, in every shape a control on this page could hold it. */
const TODAY_SHAPES = ['2026-08-06', '08/06/2026', 'August 2026', '2026-08', '06/08/2026'];

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

const PROFILE = {
  version: 3,
  updatedAt: '2026-08-06T00:00:00.000Z',
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    address: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
  },
  education: [
    {
      id: 'education-1',
      institution: 'Clifton High School',
      degree: 'High School',
      status: 'completed',
    },
    {
      id: 'education-2',
      institution: 'Rutgers University',
      degree: "Bachelor's Degree",
      major: 'Computer Science',
      gpa: 3.7,
      // A month and a year. This is all a graduation is ever known to, and it is
      // the value every date control on the fixture is judged against.
      graduationDate: '2027-05',
      status: 'in_progress',
    },
  ],
  highestCompletedDegree: 'High School',
  currentDegreeInProgress: "Bachelor's Degree",
  experience: [],
  projects: [],
  organizations: [],
  activities: [],
  skills: {},
  // Deliberately no `earliestStartDate`.
  eligibility: { workAuthorization: 'U.S. Citizen' },
  preferences: {},
};

interface Report {
  status: string;
  url: string;
  submissionPrevented: boolean;
  fieldOutcomes: Array<{ fieldId: string; label: string; status: string; annotation: string }>;
}

const TERMINAL = ['completed', 'completed_with_review', 'failed', 'cancelled'];

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

async function markOf(page: Page, id: string): Promise<string | null> {
  return page.locator(`#${id}`).getAttribute(MARK);
}

async function aiRequestsInLastRun(): Promise<number> {
  const page = await extensionPage();
  const { traces } = await message<{ traces: Array<{ runId: string; aiRequests: number }> }>(page, {
    type: 'GET_RUN_TRACES',
  });
  await page.close();
  const latest = traces.at(-1);
  expect(latest, 'the run recorded no trace').toBeDefined();
  return latest!.aiRequests;
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-phase4-'));
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
          // Off. Every question on this page is a matter of record, and a model
          // that happened to answer one would hide the failure this suite exists
          // to prove is fixed.
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
    result: { ok: true; storedDocuments: string[] } | { ok: false; reason: string };
  }>(setup, {
    type: 'SAVE_APPLICATION_BUNDLE',
    bundle: {
      bundleVersion: 3,
      websiteJobId: 'job-phase4',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software.',
      officialApplicationUrl: APPLICATION_URL,
      // A bundle carries at least one document. This page has no upload control,
      // so it is never attached — it is here because the contract requires it.
      documents: [
        {
          kind: 'resume',
          filename: 'Molhm-Ellis-Resume.pdf',
          mimeType: 'application/pdf',
          contentBase64: Buffer.from('%PDF-1.4\n% tailored resume\n%%EOF').toString('base64'),
          byteLength: 32,
          generatedAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      profile: PROFILE,
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-06T00:00:00.000Z',
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

let application: Page;
let popup: Page;
let report: Report;
let firstWriteMs = 0;
let aiRequests = -1;

async function autofill(page: Page, firstFilledSelector: string, url: string): Promise<Report> {
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  const started = Date.now();
  await button.click();
  await expect(page.locator(firstFilledSelector)).not.toHaveValue('', {
    timeout: DETERMINISTIC_BUDGET_MS,
  });
  firstWriteMs = Date.now() - started;

  const evidencePage = await extensionPage();
  let produced: Report | undefined;
  const deadline = Date.now() + RUN_BUDGET_MS;
  while (Date.now() < deadline) {
    const { report: current } = await message<{ report?: Report }>(evidencePage, {
      type: 'GET_AUTOFILL_REPORT',
    });
    if (current && current.url === url && TERMINAL.includes(current.status)) {
      produced = current;
      break;
    }
    await evidencePage.waitForTimeout(250);
  }
  await evidencePage.close();
  expect(produced, `no terminal autofill report was stored for ${url}`).toBeDefined();
  return produced!;
}

function outcomeFor(label: string) {
  const outcome = report.fieldOutcomes.find((entry) => entry.label.startsWith(label));
  expect(outcome, `no outcome recorded for "${label}"`).toBeDefined();
  return outcome!;
}

/** Every control on the page, and whatever it ended up holding. */
async function allValues(): Promise<Record<string, string>> {
  return application.evaluate(() => {
    const values: Record<string, string> = {};
    for (const control of Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'),
    )) {
      values[control.id] = control.value;
    }
    return values;
  });
}

test.beforeAll(async () => {
  application = await context.newPage();
  await application.goto(APPLICATION_URL);
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  report = await autofill(application, '#school', APPLICATION_URL);
  aiRequests = await aiRequestsInLastRun();
});

test.describe('the education facts', () => {
  test('gate 1 — School fills and verifies', async () => {
    await expect(application.locator('#school')).toHaveValue('Rutgers University');
    expect(outcomeFor('School').status).toBe('FILLED_VERIFIED');
  });

  test('gate 2 — the highest completed degree is High School', async () => {
    await expect(application.locator('#highestDegree')).toHaveValue('hs');
    expect(outcomeFor('Highest Degree Completed').status).toBe('FILLED_VERIFIED');
  });

  test("gate 3 — the current degree is the Bachelor's", async () => {
    await expect(application.locator('#currentDegree')).toHaveValue('bachelors');
    expect(outcomeFor('Current Degree Program').status).toBe('FILLED_VERIFIED');
  });

  test('gate 4 — the major fills and verifies', async () => {
    await expect(application.locator('#major')).toHaveValue('Computer Science');
    expect(outcomeFor('Field of Study').status).toBe('FILLED_VERIFIED');
  });

  test('gate 5 — the GPA fills and verifies', async () => {
    await expect(application.locator('#gpa')).toHaveValue('3.7');
    expect(outcomeFor('Cumulative GPA').status).toBe('FILLED_VERIFIED');
  });

  test('gate 6 — the optional minor stays blank, and is not outstanding work', async () => {
    await expect(application.locator('#minor')).toHaveValue('');
    expect(outcomeFor('Minor').status).toBe('OPTIONAL_LEFT_BLANK');
    expect(await markOf(application, 'minor')).not.toBe('information_needed');
  });
});

test.describe('the graduation date', () => {
  test('gate 7 — the split month and year come from the stored value', async () => {
    await expect(application.locator('#gradMonth')).toHaveValue('May');
    await expect(application.locator('#gradYear')).toHaveValue('2027');
    expect(outcomeFor('Graduation Month').status).toBe('FILLED_VERIFIED');
    expect(outcomeFor('Graduation Year').status).toBe('FILLED_VERIFIED');
  });

  test('gate 7 — the ATS date box takes the stored value in its own format', async () => {
    await expect(application.locator('#gradDateText')).toHaveValue('05/2027');
    expect(outcomeFor('Anticipated Degree Completion Date').status).toBe('FILLED_VERIFIED');
  });

  test('gate 12 — a control demanding a day it was never given stays empty', async () => {
    await expect(application.locator('#gradDateNative')).toHaveValue('');
    expect(outcomeFor('Degree Completion Date').status).toBe('USER_CONFIRMATION_REQUIRED');
    expect(outcomeFor('Degree Completion Date').annotation).toBe('information_needed');
  });
});

test.describe('current student, and the field it reveals', () => {
  test('gate 8 — Yes is chosen from the active enrolment record', async () => {
    await expect(application.locator('#currentStudent')).toHaveValue('yes');
    expect(outcomeFor('Are you currently a university student?').status).toBe('FILLED_VERIFIED');
  });

  test('gate 9 — the dependent graduation control is revealed, filled and verified', async () => {
    await expect(application.locator('#anticipatedGradRow')).toBeVisible();
    await expect(application.locator('#anticipatedGrad')).toHaveValue('May 2027');
    expect(outcomeFor('Anticipated Graduation Date').status).toBe('FILLED_VERIFIED');
  });
});

test.describe('availability', () => {
  test('gate 10 — an unsaved earliest start date stays the user’s', async () => {
    await expect(application.locator('#earliestStart')).toHaveValue('');
    const outcome = outcomeFor('Earliest Internship Start Date');
    expect(outcome.status).toBe('USER_CONFIRMATION_REQUIRED');
    expect(outcome.annotation).toBe('information_needed');
  });
});

test.describe('no date is invented', () => {
  test('gate 11 — no control on the page holds today’s date, in any shape', async () => {
    const values = Object.values(await allValues()).join(' | ');
    for (const shape of TODAY_SHAPES) {
      expect(values, `a control holds ${shape}`).not.toContain(shape);
    }
  });

  test('gate 12 — no control holds a value that is not a date but sits in a date box', async () => {
    const values = await allValues();
    expect(values.gradDateNative).toBe('');
    expect(values.earliestStart).toBe('');
    // And neither date box was given the name of a qualification.
    for (const id of ['gradDateNative', 'gradDateText', 'anticipatedGrad', 'earliestStart']) {
      expect(values[id] ?? '').not.toContain('Bachelor');
      expect(values[id] ?? '').not.toContain('High School');
    }
  });
});

test.describe('the marks on the page', () => {
  test('gate 13 — every field this run filled lost its Information needed mark', async () => {
    for (const id of [
      'school',
      'major',
      'gpa',
      'gradMonth',
      'gradYear',
      'currentDegree',
      'highestDegree',
    ]) {
      expect(await markOf(application, id), `#${id} kept a stale mark`).toBe('verified');
    }
  });

  test('the two genuinely open questions wear exactly one orange mark each', async () => {
    expect(await markOf(application, 'gradDateNative')).toBe('information_needed');
    expect(await markOf(application, 'earliestStart')).toBe('information_needed');
  });

  test('draws one mark per control, never two on one', async () => {
    const marked = await application.locator(`[${MARK}]`).count();
    const controls = await application
      .locator(`input[${MARK}], select[${MARK}], [role="combobox"][${MARK}]`)
      .count();
    expect(marked).toBe(controls);
  });
});

test.describe('the run itself', () => {
  test('gate 14 — makes no AI request', () => {
    expect(aiRequests).toBe(0);
  });

  test('shows the first deterministic write within five seconds', () => {
    expect(firstWriteMs).toBeLessThan(DETERMINISTIC_BUDGET_MS);
  });

  test('finishes in a terminal status, and never claims completed while work is open', () => {
    expect(report.status).toBe('completed_with_review');
  });

  test('gate 15 — never clicks the final Submit', async () => {
    expect(report.submissionPrevented).toBe(true);
    const attempts = await application.evaluate(
      () =>
        (window as unknown as { __fixture: { submitAttempts: number } }).__fixture.submitAttempts,
    );
    expect(attempts).toBe(0);
  });
});

test.describe('a repeated run stays stable', () => {
  test('re-runs over the filled page without undoing or re-marking anything', async () => {
    report = await autofill(application, '#school', APPLICATION_URL);
    await expect(application.locator('#highestDegree')).toHaveValue('hs');
    await expect(application.locator('#currentDegree')).toHaveValue('bachelors');
    await expect(application.locator('#gradMonth')).toHaveValue('May');
    await expect(application.locator('#anticipatedGrad')).toHaveValue('May 2027');
    const values = Object.values(await allValues()).join(' | ');
    for (const shape of TODAY_SHAPES) {
      expect(values, `a second run wrote ${shape}`).not.toContain(shape);
    }
  });
});
