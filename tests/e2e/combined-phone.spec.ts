import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The stale "Information needed" annotation, against the built extension.
 *
 * The reported failure was visual: a phone number filled with its +1 intact,
 * wearing the green verified border, with an orange "Information needed" badge
 * still sitting over it. The badge belonged to the country-code half of the same
 * combined widget — a combobox whose menu only exists once it is opened, so the
 * page offers it no choices and the planner rightly refuses to invent an answer
 * for it.
 *
 * Every assertion here reads the employer page's own DOM: the values in the
 * controls, the `data-internship-agent-review` attribute the content script
 * stamps on each marked control, and the badges inside the review layer's shadow
 * root. Nothing imports from `extension/src` — the only inputs are a bundle and
 * one click on the popup's button.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/combined-phone.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 30_000;
const FILL_BUDGET_MS = 10_000;

const BADGES = '#internship-agent-review-layer .badge';
const MARK = 'data-internship-agent-review';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/**
 * The applicant from the repair brief.
 *
 * Deliberately states no country and no separate dialling code: that is what
 * sends the whole number — "+1" included — into the one phone control, and what
 * leaves the page's Country question genuinely unanswerable. Both are the
 * conditions the reported failure occurred under.
 */
const PROFILE = {
  version: 3,
  updatedAt: '2026-08-06T00:00:00.000Z',
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    phone: '+1 929 264 3117',
    phoneType: 'mobile',
    address: {
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
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

/** The mark the content script left on one control, or null for none at all. */
async function markOf(page: Page, id: string): Promise<string | null> {
  return page.locator(`#${id}`).getAttribute(MARK);
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-combined-phone-'));
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
          // Off on purpose. Every mark asserted below must be earned by the
          // deterministic path: a model that happened to answer the country-code
          // control would hide the reconciliation this suite exists to prove.
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
      websiteJobId: 'job-combined-phone',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software.',
      officialApplicationUrl: APPLICATION_URL,
      // A bundle carries at least one document. This page has no upload
      // control, so it is never attached — it is here to make the bundle a
      // real one.
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
let report: {
  status: string;
  submissionPrevented: boolean;
  fieldOutcomes: Array<{ fieldId: string; label: string; status: string; annotation: string }>;
};

/** Runs the extension over the fixture once and collects its own report. */
async function autofill(): Promise<void> {
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await expect(application.locator('#phoneNumber')).not.toHaveValue('', {
    timeout: FILL_BUDGET_MS,
  });
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });

  const evidencePage = await extensionPage();
  ({ report } = await message<{ report: typeof report }>(evidencePage, {
    type: 'GET_AUTOFILL_REPORT',
  }));
  await evidencePage.close();
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
  await autofill();
});

test.describe('the phone block fills and verifies', () => {
  test('writes the number with its dialling code intact', async () => {
    const value = await application.locator('#phoneNumber').inputValue();
    expect(value.replace(/\D/g, '')).toBe('19292643117');
    expect(value.startsWith('+1')).toBe(true);
  });

  test('chooses the phone type', async () => {
    await expect(application.locator('#phoneType')).toHaveValue('mobile');
  });

  test('reports the number and the type as FILLED_VERIFIED', () => {
    expect(outcomeFor('Phone Number').status).toBe('FILLED_VERIFIED');
    expect(outcomeFor('Contact Phone Type').status).toBe('FILLED_VERIFIED');
  });

  test('lets the embedded +1 answer the country-code control', () => {
    const code = outcomeFor('Country Phone Code');
    expect(code.status).toBe('FILLED_VERIFIED');
    expect(code.annotation).toBe('verified');
  });
});

test.describe('the stale annotation is gone from the page', () => {
  test('marks the phone controls verified and none of them as needing you', async () => {
    expect(await markOf(application, 'phoneNumber')).toBe('verified');
    expect(await markOf(application, 'countryPhoneCode')).toBe('verified');
    expect(await markOf(application, 'phoneType')).toBe('verified');
  });

  test('leaves exactly one Information needed badge, and it is not on the phone block', async () => {
    // The visual claim, read off the page's own review layer.
    const badges = await application.locator(BADGES).allTextContents();
    expect(badges).toEqual(['Information needed']);
    expect(await markOf(application, 'country')).toBe('information_needed');
  });

  test('draws one mark per control, never two on one', async () => {
    const marked = await application.locator(`[${MARK}]`).count();
    const controls = await application
      .locator(`input[${MARK}], select[${MARK}], [role="combobox"][${MARK}]`)
      .count();
    expect(marked).toBe(controls);
  });
});

test.describe('a repeated run does not bring the orange back', () => {
  test('re-scans an already filled page and leaves the phone block unmarked as outstanding', async () => {
    await autofill();
    expect(await markOf(application, 'phoneNumber')).not.toBe('information_needed');
    expect(await markOf(application, 'countryPhoneCode')).not.toBe('information_needed');
    expect(outcomeFor('Country Phone Code').status).not.toBe('USER_CONFIRMATION_REQUIRED');
    const badges = await application.locator(BADGES).allTextContents();
    expect(badges).toEqual(['Information needed']);
    const value = await application.locator('#phoneNumber').inputValue();
    expect(value.replace(/\D/g, '')).toBe('19292643117');
  });
});

test.describe('the fields that already worked still work', () => {
  test('fills the legal name and the email', async () => {
    await expect(application.locator('#firstName')).toHaveValue('Molhm');
    await expect(application.locator('#lastName')).toHaveValue('Ellis');
    await expect(application.locator('#email')).toHaveValue('molhm@example.com');
  });

  test('still reports the unanswerable Country question as the user’s', async () => {
    expect(outcomeFor('Country *').status).toBe('USER_CONFIRMATION_REQUIRED');
    await expect(application.locator('#country')).toHaveValue('');
  });
});

test.describe('nothing was submitted', () => {
  test('the final Submit was never clicked', async () => {
    expect(report.submissionPrevented).toBe(true);
    const attempts = await application.evaluate(
      () =>
        (window as unknown as { __fixture: { submitAttempts: number } }).__fixture.submitAttempts,
    );
    expect(attempts).toBe(0);
  });
});
