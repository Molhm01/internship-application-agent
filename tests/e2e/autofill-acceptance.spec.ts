import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The acceptance gates, run against the built extension.
 *
 * Everything here goes through `extension/dist`: the popup bundle Chrome loads,
 * the service worker it registers, and the content script it injects into the
 * employer page. No module is imported from `extension/src`, and no planner is
 * called directly — the only input is a click on the popup's own button, and
 * the only evidence is the employer page's DOM and the run's own trace.
 *
 * That distinction is the reason this file exists. A jsdom suite that imports
 * the source proves the source is correct; it cannot prove the browser is
 * running it, and "the browser was running a build two commits behind a green
 * test suite" is the failure this recovery started from.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/icims-account-creation.html`;
/**
 * Where the run's own evidence is written, for `npm run autofill:diagnose` to
 * render. The diagnosis is then a record of a real run rather than a
 * description of one.
 */
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'autofill-run-evidence.json',
);
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

/** Deterministic fields must be visible on the page within this long. */
const DETERMINISTIC_BUDGET_MS = 5_000;
/** The whole run, one click to a terminal state. */
const RUN_BUDGET_MS = 30_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

function pdf(text: string): string {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF`).toString('base64');
}

const RESUME_FILENAME = 'Molhm-Ellis-Quanta-Robotics-Resume.pdf';
const COVER_FILENAME = 'Molhm-Ellis-Quanta-Robotics-Cover-Letter.pdf';

/**
 * The profile Internship Pilot synchronises with the bundle.
 *
 * Written out here rather than imported from the jsdom fixtures on purpose:
 * this file may not depend on the source tree it is meant to be independent of.
 */
const PROFILE = {
  updatedAt: '2026-08-05T00:00:00.000Z',
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    phone: '+1 201 555 0134',
    linkedin: 'https://www.linkedin.com/in/molhmellis',
    github: 'https://github.com/molhmellis',
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
      major: 'Computer Science',
      minor: 'Mathematics',
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
      // Deliberately not the applicant's own city: an employer location filled
      // with the home address was the single thing a whole live run managed.
      location: 'Newark, New Jersey',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      responsibilities: ['Built test rigs for actuator assemblies.'],
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-acceptance-'));
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
          // This suite is an acceptance test for the *whole-page* pipeline,
          // which Agent Mode replaced as the production path. That pipeline is
          // retained behind this flag rather than deleted, and these are the
          // tests that keep it honest — so they opt into it explicitly instead
          // of the suite quietly measuring whichever path happens to be wired
          // to the button.
          developerMode: true,
          autofill: { legacyWholePageAutofill: true },
          aiGenerationEnabled: true,
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

  // The Internship Pilot handoff, as the website performs it.
  const stored = await message<{
    result:
      { ok: true; bundleId: string; storedDocuments: string[] } | { ok: false; reason: string };
  }>(setup, {
    type: 'SAVE_APPLICATION_BUNDLE',
    bundle: {
      bundleVersion: 2,
      websiteJobId: 'job-quanta-4471',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software for autonomous handling systems.',
      officialApplicationUrl: APPLICATION_URL,
      documents: [
        {
          kind: 'resume',
          filename: RESUME_FILENAME,
          mimeType: 'application/pdf',
          contentBase64: pdf('tailored resume'),
          byteLength: 32,
          generatedAt: '2026-08-05T00:00:00.000Z',
        },
        {
          kind: 'cover_letter',
          filename: COVER_FILENAME,
          mimeType: 'application/pdf',
          contentBase64: pdf('tailored cover letter'),
          byteLength: 38,
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
  expect(stored.result.ok && stored.result.storedDocuments).toEqual(['resume', 'cover_letter']);

  // Accepting a bundle arms one automatic start, so that "Apply with Agent" is
  // a single action. This suite is about the *click*, so the arming is spent
  // here — the same state a user reaches by opening the employer page later.
  await setup.evaluate(() => chrome.storage.local.remove('autoStartArmed'));
  await setup.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

interface RunEvidence {
  application: Page;
  popup: Page;
  report: {
    status: string;
    fieldsFound: number;
    fieldsVerified: number;
    documentsAttached: number;
    optionalLeftBlank: number;
    failedFields: number;
    userInputRequired: number;
    iterations: number;
    totalDurationMs: number;
    submissionPrevented: boolean;
    requiredFields: Array<{ fieldId: string; label: string; outcome: string; reason: string }>;
    results: Array<{
      fieldId: string;
      question: string;
      verification: string;
      reason: string;
      reviewReason?: string;
      action: string;
    }>;
  };
  trace: {
    buildId: string;
    rawControls: number;
    falseControlsRemoved: number;
    duplicateControlsRemoved: number;
    normalizedQuestions: number;
    requiredQuestions: number;
    aiRequests: number;
    dependentFieldsRescanned: number;
    deterministicVerified: number;
    stages: Array<{ stage: string; pass: number; durationMs: number; count: number }>;
    fields: Array<{
      fieldId: string;
      controlType: string;
      plannerSource: string;
      plannedAction?: string;
      contractResult: string;
      executorAttempted: boolean;
      verification: string;
      required: boolean;
    }>;
    totalDurationMs: number;
  };
  /** Wall clock from the click to a terminal run state. */
  wallClockMs: number;
  /** Wall clock from the click to First Name holding its saved value. */
  firstFieldMs: number;
  buildIds: { popup: string; worker: string; content: string };
}

let evidence: RunEvidence;

/**
 * One click, and everything it produced.
 *
 * Run once in `beforeAll` rather than per test: the gates are assertions about
 * a single run, and re-running it for each would prove something weaker — that
 * the pipeline works when repeated — while making "one click was enough"
 * unfalsifiable.
 */
test.beforeAll(async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // The bundle is named before anything is filled, so the user can see which
  // job and which documents this run is about.
  await expect(
    popup.getByText('Ready for Quanta Robotics — Software Engineering Intern'),
  ).toBeVisible();
  await expect(popup.getByText(`✓ Tailored résumé (${RESUME_FILENAME})`)).toBeVisible();
  await expect(popup.getByText(`✓ Tailored cover letter (${COVER_FILENAME})`)).toBeVisible();
  await expect(popup.getByText('✓ Profile synchronized')).toBeVisible();

  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });

  const started = Date.now();
  await button.click();

  // The deterministic clock. Nothing here waits for the model: this is the
  // profile's own answer appearing on the employer's page.
  await expect(application.locator('#firstName')).toHaveValue('Molhm', {
    timeout: DETERMINISTIC_BUDGET_MS,
  });
  const firstFieldMs = Date.now() - started;

  // ...and the run to reach a terminal state, from the popup's own UI.
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });
  const wallClockMs = Date.now() - started;

  const evidencePage = await extensionPage();
  const { report } = await message<{ report: RunEvidence['report'] }>(evidencePage, {
    type: 'GET_AUTOFILL_REPORT',
  });
  const { traces } = await message<{ traces: RunEvidence['trace'][] }>(evidencePage, {
    type: 'GET_RUN_TRACES',
  });
  const worker = await message<{ buildId: string }>(evidencePage, { type: 'WORKER_PING' });
  const applicationTabId = await evidencePage.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, APPLICATION_URL);
  expect(applicationTabId).not.toBeNull();
  const content = await message<{ buildId?: string }>(evidencePage, {
    type: 'ENSURE_CONTENT_SCRIPT',
    tabId: applicationTabId,
    url: APPLICATION_URL,
  });
  await evidencePage.close();

  const popupBuild = (await popup.locator('.popup__build').first().innerText()).replace(
    /^Build\s+/,
    '',
  );

  expect(report, 'the run produced no report').toBeTruthy();
  expect(traces.length, 'the run produced no trace').toBeGreaterThan(0);

  const uploaded = {
    resume: await application
      .locator('#resume')
      .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? ''),
    coverLetter: await application
      .locator('#coverLetter')
      .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? ''),
  };

  evidence = {
    application,
    popup,
    report,
    // Newest first: the store prepends, and this run is the most recent.
    trace: traces[0]!,
    wallClockMs,
    firstFieldMs,
    buildIds: {
      popup: popupBuild.split(' ·')[0]!.trim(),
      worker: worker.buildId,
      content: content.buildId ?? 'unstamped',
    },
  };

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        bundle: {
          company: 'Quanta Robotics',
          jobTitle: 'Software Engineering Intern',
          resumeFilename: RESUME_FILENAME,
          coverLetterFilename: COVER_FILENAME,
        },
        uploaded,
        buildIds: evidence.buildIds,
        firstFieldMs: evidence.firstFieldMs,
        wallClockMs: evidence.wallClockMs,
        report: evidence.report,
        trace: evidence.trace,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

function fieldValue(id: string): Promise<string> {
  return evidence.application.locator(`#${id}`).inputValue();
}

test.describe('GATE 1 — one click drives the real extension runtime', () => {
  test('reaches a terminal state without a second click', () => {
    expect(['completed', 'completed_with_review']).toContain(evidence.report.status);
    expect(evidence.report.iterations).toBeLessThanOrEqual(3);
  });

  test('records the scan, plan, execute and verify stages it actually ran', () => {
    const stages = new Set(evidence.trace.stages.map((entry) => entry.stage));
    expect(stages.has('scan')).toBe(true);
    expect(stages.has('plan')).toBe(true);
    expect(stages.has('execute')).toBe(true);
    expect(evidence.trace.rawControls).toBeGreaterThan(25);
    expect(evidence.trace.normalizedQuestions).toBeGreaterThan(25);
  });
});

test.describe('GATE 2 — the employer page after the click', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['firstName', 'Molhm'],
    ['lastName', 'Ellis'],
    ['email', 'molhm@example.com'],
    ['phoneType', 'mobile'],
    ['phoneNumber', '+12015550134'],
    ['addressType', 'home'],
    ['addressLine1', '48 Maple Avenue'],
    ['city', 'Clifton'],
    ['postalCode', '07011'],
    ['country', 'US'],
    ['stateProvince', 'NJ'],
    ['source', 'internet'],
    ['educationLevel', 'hs'],
    ['school', 'Rutgers University'],
    ['degreeType', 'bachelor'],
    ['major', 'Computer Science'],
    ['gpa', '3.7'],
    ['expEmployer', 'Northwind Robotics'],
    ['expTitle', 'Engineering Intern'],
    ['expLocation', 'Newark, New Jersey'],
  ];

  for (const [id, value] of expected) {
    test(`${id} holds ${value}`, async () => {
      expect(await fieldValue(id)).toBe(value);
    });
  }

  test('verifies at least 90% of the fields a saved source grounded', () => {
    // The denominator is "fields something actually answered", not "fields on
    // the page": a credential the vault owns, a consent nobody may tick, and a
    // free-text question needing interpretation are not failures of the fill.
    const grounded = evidence.trace.fields.filter((field) => field.plannerSource !== 'none');
    const settled = grounded.filter(
      (field) => field.verification === 'verified' || field.verification === 'optional_left_blank',
    );
    expect(grounded.length).toBeGreaterThan(15);
    expect(settled.length / grounded.length).toBeGreaterThanOrEqual(0.9);
  });

  test('leaves the optional fields blank rather than inventing them', async () => {
    expect(await fieldValue('middleName')).toBe('');
    expect(await fieldValue('addressLine2')).toBe('');
  });

  test('never writes a credential or ticks a consent on its own', async () => {
    expect(await fieldValue('password')).toBe('');
    expect(await fieldValue('passwordReenter')).toBe('');
    expect(await evidence.application.locator('#policyAgreement').isChecked()).toBe(false);
  });
});

test.describe('GATE 3 — the deterministic budget', () => {
  test('writes the saved profile onto the page within five seconds', () => {
    expect(evidence.firstFieldMs).toBeLessThan(DETERMINISTIC_BUDGET_MS);
  });

  test('finishes the whole run inside thirty seconds', () => {
    expect(evidence.wallClockMs).toBeLessThan(RUN_BUDGET_MS);
    expect(evidence.report.totalDurationMs).toBeLessThan(RUN_BUDGET_MS);
  });

  test('makes at most one analysis request for the page', () => {
    expect(evidence.trace.aiRequests).toBeLessThanOrEqual(1);
  });
});

test.describe('GATE 4 — the control-type contract', () => {
  test('never searched a text control for an option', () => {
    const reasons = evidence.report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/no option on the page matched ['"]?molhm/i);
    for (const field of evidence.trace.fields) {
      if (field.controlType !== 'text' || !field.plannedAction) continue;
      expect(field.plannedAction).not.toMatch(/option|radio/i);
    }
  });

  test('rejected no action and lost no field to a missing mapping', () => {
    expect(evidence.trace.fields.filter((field) => field.contractResult === 'rejected')).toEqual(
      [],
    );
  });

  test('chose the country first and then the state it produced', async () => {
    expect(await fieldValue('country')).toBe('US');
    expect(await fieldValue('stateProvince')).toBe('NJ');
    const reasons = evidence.report.results.map((result) => result.reason).join(' ');
    expect(reasons).not.toMatch(/no option on the page matched ['"]?new jersey/i);
  });
});

test.describe('GATE 5 — what became a question', () => {
  test('turned no section heading or validation summary into a question', () => {
    const questions = evidence.report.results.map((result) => result.question);
    for (const heading of [
      'Addresses (1)* required.',
      'Phones (1)',
      'Enable AI Autofill',
      'Autofill Application',
    ]) {
      expect(questions).not.toContain(heading);
    }
    expect(questions.join(' ')).not.toMatch(/some required information is missing/i);
  });

  test('asked each question once', () => {
    const questions = evidence.report.results.map((result) => result.question);
    const education = questions.filter((question) => question === 'Highest Level of Education');
    expect(education.length).toBeLessThanOrEqual(1);
    expect(new Set(evidence.report.results.map((result) => result.fieldId)).size).toBe(
      evidence.report.results.length,
    );
  });

  test('left nothing in a temporary state', () => {
    for (const result of evidence.report.results) {
      expect(result.verification).not.toBe('pending');
      expect(result.reason).not.toMatch(/waiting on/i);
    }
    for (const verdict of evidence.report.requiredFields) {
      expect([
        'FILLED_VERIFIED',
        'USER_CONFIRMATION_REQUIRED',
        'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
      ]).toContain(verdict.outcome);
    }
  });

  test('one unfillable field did not stop the ones after it', () => {
    // The credentials and the consent are refused by policy and sit early in
    // the form; everything after them still verified.
    expect(evidence.report.fieldsVerified).toBeGreaterThanOrEqual(20);
  });
});

test.describe('GATE 6 — the tailored documents', () => {
  test('attached the tailored résumé and cover letter to the right slots', async () => {
    expect(
      await evidence.application
        .locator('#resume')
        .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? ''),
    ).toBe(RESUME_FILENAME);
    expect(
      await evidence.application
        .locator('#coverLetter')
        .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? ''),
    ).toBe(COVER_FILENAME);
    expect(evidence.report.documentsAttached).toBeGreaterThanOrEqual(2);
  });
});

test.describe('GATE 7 — submission, and the build identity', () => {
  test('never clicked the final Submit', async () => {
    expect(evidence.report.submissionPrevented).toBe(true);
    expect(
      await evidence.application.evaluate(
        () =>
          (window as unknown as { fixtureState: { submitted: boolean } }).fixtureState.submitted,
      ),
    ).toBe(false);
    await expect(evidence.application.locator('#submitApplication')).toBeVisible();
  });

  test('popup, worker, and content script are one build', () => {
    expect(evidence.buildIds.worker).toBe(evidence.buildIds.popup);
    expect(evidence.buildIds.content).toBe(evidence.buildIds.popup);
    expect(evidence.trace.buildId).toBe(evidence.buildIds.popup);
    expect(evidence.buildIds.popup).toMatch(/^[0-9a-f]{7,40}(\+dirty)?\.s\d+\.\d{14}$/);
  });
});
