import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The Phase 3 acceptance gates, proven against the *built* extension.
 *
 * Nothing here imports from `extension/src`. The inputs are a bundle and one
 * click on the popup's "Autofill Application" button, and every assertion reads
 * either the employer page's own DOM — control values, the
 * `data-internship-agent-review` mark, the badges in the review layer's shadow
 * root — or the report the worker produced for that run.
 *
 * Two pages, because a portal either splits the phone's dialling code into its
 * own control or builds it into the number widget, and no real page does both.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/phase3-candidate-profile.html`;
const COMBINED_URL = `${FIXTURES}/lab/phase3-combined-phone.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 40_000;
/**
 * Gate 23. The deterministic writes must be visible inside five seconds, and
 * the bounded Country → State wait is explicitly excluded from that: the
 * fixture's region list is fetched 600ms after Country changes, exactly as a
 * real portal's is.
 */
const DETERMINISTIC_BUDGET_MS = 5_000;

const BADGES = '#internship-agent-review-layer .badge';
const MARK = 'data-internship-agent-review';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/**
 * The canonical Phase 3 applicant: no middle name, no preferred name, no
 * second address line, a US number with a stored +1, a mobile phone and a home
 * address in New Jersey.
 */
const PROFILE = {
  version: 3,
  updatedAt: '2026-08-06T00:00:00.000Z',
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    phone: '+1 929 264 3117',
    phoneCountryCode: '+1',
    phoneType: 'mobile',
    address: {
      type: 'home',
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
      graduationDate: '2027-05',
      status: 'in_progress',
    },
  ],
  currentDegreeInProgress: "Bachelor's Degree",
  experience: [],
  projects: [],
  organizations: [],
  activities: [],
  skills: {},
  eligibility: { workAuthorization: 'U.S. Citizen' },
  preferences: {},
};

interface Report {
  status: string;
  url: string;
  submissionPrevented: boolean;
  totalDurationMs: number;
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

/**
 * Model requests the most recent run actually made.
 *
 * Read from the run's own trace rather than inferred from the settings switch:
 * "the model is turned off" is a claim about configuration, and gate 22 is a
 * claim about what the run did.
 */
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-phase3-'));
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
          // Off, because every field in this phase is deterministic. A model
          // that happened to answer one would hide the failure this suite
          // exists to prove is fixed.
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
      websiteJobId: 'job-phase3',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software.',
      officialApplicationUrl: APPLICATION_URL,
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
/** How long the first deterministic write took to appear on the page. */
let firstWriteMs = 0;
let aiRequests = -1;

/**
 * One run over one page, from the popup's own button.
 *
 * The run is considered finished when the worker has stored a terminal report
 * *for the page under test* — not merely when the popup renders a summary. The
 * popup shows a summary only for the page its bundle names, and the combined
 * phone variant is deliberately a second page.
 */
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

/** Every question the run left marked as the user's, named rather than counted. */
function outstandingLabels(): string[] {
  return report.fieldOutcomes
    .filter((entry) => entry.annotation === 'information_needed')
    .map((entry) => `${entry.label} [${entry.status}]`);
}

function outcomeFor(label: string) {
  const outcome = report.fieldOutcomes.find((entry) => entry.label.startsWith(label));
  expect(outcome, `no outcome recorded for "${label}"`).toBeDefined();
  return outcome!;
}

test.beforeAll(async () => {
  application = await context.newPage();
  await application.goto(APPLICATION_URL);
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  report = await autofill(application, '#firstName', APPLICATION_URL);
  aiRequests = await aiRequestsInLastRun();
});

test.describe('the fields that already worked still work', () => {
  test('fills the legal first and last name', async () => {
    await expect(application.locator('#firstName')).toHaveValue('Molhm');
    await expect(application.locator('#lastName')).toHaveValue('Ellis');
    expect(outcomeFor('Legal First Name').status).toBe('FILLED_VERIFIED');
    expect(outcomeFor('Legal Last Name').status).toBe('FILLED_VERIFIED');
  });

  test('fills the email', async () => {
    await expect(application.locator('#email')).toHaveValue('molhm@example.com');
    expect(outcomeFor('Email Address').status).toBe('FILLED_VERIFIED');
  });

  test('chooses the phone type', async () => {
    await expect(application.locator('#phoneType')).toHaveValue('mobile');
    expect(outcomeFor('Phone Type').status).toBe('FILLED_VERIFIED');
  });

  test('leaves the optional middle name blank', async () => {
    await expect(application.locator('#middleName')).toHaveValue('');
    expect(outcomeFor('Middle Name').status).toBe('OPTIONAL_LEFT_BLANK');
  });

  test('leaves the optional preferred name blank', async () => {
    await expect(application.locator('#preferredName')).toHaveValue('');
    expect(outcomeFor('Preferred Name').status).toBe('OPTIONAL_LEFT_BLANK');
  });
});

test.describe('the phone block, split across two controls', () => {
  test('selects the +1 country code and verifies it', async () => {
    await expect(application.locator('#phoneCountryCode')).toHaveValue('1');
    expect(outcomeFor('Phone Country Code').status).toBe('FILLED_VERIFIED');
  });

  test('writes the national number and never duplicates the dialling code', async () => {
    const value = await application.locator('#phoneNumber').inputValue();
    expect(value.replace(/\D/g, '')).toBe('9292643117');
    expect(value).not.toContain('+1');
    expect(value.replace(/\D/g, '').startsWith('1')).toBe(false);
    expect(outcomeFor('Phone Number').status).toBe('FILLED_VERIFIED');
  });
});

test.describe('the full legal name', () => {
  test('constructs it from the saved parts and verifies it', async () => {
    await expect(application.locator('#fullLegalName')).toHaveValue('Molhm Ellis');
    expect(outcomeFor('Full Legal Name').status).toBe('FILLED_VERIFIED');
  });
});

test.describe('the account identifier the portal calls an email', () => {
  test('fills Login with the application email', async () => {
    await expect(application.locator('#login')).toHaveValue('molhm@example.com');
    expect(outcomeFor('Login').status).toBe('FILLED_VERIFIED');
  });
});

test.describe('the address block', () => {
  test('selects Home as the address type', async () => {
    await expect(application.locator('#addressType')).toHaveValue('home');
    expect(outcomeFor('Address Type').status).toBe('FILLED_VERIFIED');
  });

  test('fills address line 1, city and postal code', async () => {
    await expect(application.locator('#addressLine1')).toHaveValue('48 Maple Avenue');
    await expect(application.locator('#city')).toHaveValue('Clifton');
    await expect(application.locator('#postalCode')).toHaveValue('07011');
    expect(outcomeFor('Address Line 1').status).toBe('FILLED_VERIFIED');
    expect(outcomeFor('City').status).toBe('FILLED_VERIFIED');
    expect(outcomeFor('ZIP/Postal Code').status).toBe('FILLED_VERIFIED');
  });

  test('leaves the optional second line blank and never repeats line 1 into it', async () => {
    await expect(application.locator('#addressLine2')).toHaveValue('');
    expect(outcomeFor('Address Line 2').status).toBe('OPTIONAL_LEFT_BLANK');
  });
});

test.describe('Country, and the State it produces', () => {
  test('selects the United States on a control whose label says "Region"', async () => {
    await expect(application.locator('#country')).toHaveValue('US');
    expect(outcomeFor('Country/Region of Residence').status).toBe('FILLED_VERIFIED');
  });

  test('waits for the refreshed region list and selects New Jersey', async () => {
    await expect(application.locator('#state')).toHaveValue('NJ');
    expect(outcomeFor('State/Province').status).toBe('FILLED_VERIFIED');
  });

  test('read the list the page produced, not the prompt it replaced', async () => {
    const labels = await application.locator('#state option').allTextContents();
    expect(labels).toContain('New Jersey');
    expect(labels).not.toContain('Select a country first');
  });
});

test.describe('the stale marks are gone', () => {
  test('every field this run filled is marked verified', async () => {
    for (const id of [
      'firstName',
      'email',
      'country',
      'state',
      'phoneNumber',
      'fullLegalName',
      'addressLine1',
    ]) {
      expect(await markOf(application, id), `#${id} kept a stale mark`).toBe('verified');
    }
  });

  test('no filled control still wears an Information needed badge', async () => {
    expect(outstandingLabels()).toEqual([]);
    const badges = await application.locator(BADGES).allTextContents();
    expect(badges.filter((badge) => badge === 'Information needed')).toEqual([]);
  });

  test('the optional second line is marked as blank on purpose, not as outstanding', async () => {
    expect(await markOf(application, 'addressLine2')).not.toBe('information_needed');
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
  test('makes no AI request', () => {
    expect(aiRequests).toBe(0);
  });

  test('shows the first deterministic write within five seconds', () => {
    expect(firstWriteMs).toBeLessThan(DETERMINISTIC_BUDGET_MS);
  });

  test('finishes in a terminal status', () => {
    expect(['completed', 'completed_with_review']).toContain(report.status);
  });

  test('never clicks the final Submit', async () => {
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
    report = await autofill(application, '#firstName', APPLICATION_URL);
    await expect(application.locator('#country')).toHaveValue('US');
    await expect(application.locator('#state')).toHaveValue('NJ');
    await expect(application.locator('#fullLegalName')).toHaveValue('Molhm Ellis');
    expect(outstandingLabels()).toEqual([]);
    const badges = await application.locator(BADGES).allTextContents();
    expect(badges.filter((badge) => badge === 'Information needed')).toEqual([]);
  });
});

test.describe('the combined phone widget, on its own page', () => {
  test.beforeAll(async () => {
    await application.goto(COMBINED_URL);
    // The popup reads the page it is about to act on when it opens, so it is
    // reopened against the new one rather than reused.
    await popup.reload();
    report = await autofill(application, '#firstName', COMBINED_URL);
  });

  test('writes the number with its dialling code intact, exactly once', async () => {
    const value = await application.locator('#phoneNumber').inputValue();
    expect(value.replace(/\D/g, '')).toBe('19292643117');
    expect(value.startsWith('+1')).toBe(true);
    expect(value.match(/\+1/g)?.length).toBe(1);
    expect(outcomeFor('Phone Number').status).toBe('FILLED_VERIFIED');
  });

  test('lets the embedded +1 settle the country-code control', () => {
    const code = outcomeFor('Country Phone Code');
    // Settled, and which kind of settled depends on the page rather than on the
    // agent. This widget renders its code from the number beside it, so on a
    // page that already shows "US +1" the honest verdict is that it was already
    // valid — a control nobody had to touch, deliberately left unmarked because
    // a green tick would claim the agent's work over the user's own answer. What
    // must never happen is the *other* outcome this once produced: a red
    // "Autofill failed" over a control displaying exactly the right code,
    // because the engine opened a menu that does not exist behind it.
    expect(['FILLED_VERIFIED', 'SKIPPED_ALREADY_VALID']).toContain(code.status);
    expect(['verified', 'none']).toContain(code.annotation);
  });

  test('leaves no Information needed badge on the phone block', async () => {
    expect(await markOf(application, 'phoneNumber')).toBe('verified');
    // Unmarked or verified — never a failure and never an open question.
    expect([null, 'verified', 'none']).toContain(await markOf(application, 'countryPhoneCode'));
  });

  test('never clicks Submit here either', async () => {
    const attempts = await application.evaluate(
      () =>
        (window as unknown as { __fixture: { submitAttempts: number } }).__fixture.submitAttempts,
    );
    expect(attempts).toBe(0);
  });
});
