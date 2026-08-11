import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The acceptance gates for the profile-sync recovery, run against the built
 * extension.
 *
 * The existing acceptance suite covers the iCIMS lab page, which the agent
 * already filled. This one covers the controls it did *not*: a searchable ARIA
 * country combobox, a phone country-code select labelled only "Code", a state
 * list that does not exist until a country is chosen, and two `display:none`
 * file inputs behind buttons.
 *
 * Nothing here imports from `extension/src`. The only inputs are a bundle handed
 * to the worker the way the website hands one over, and one click on the popup's
 * own button; the only evidence is the employer page's DOM.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/profile-sync-application.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 30_000;
const DETERMINISTIC_BUDGET_MS = 8_000;

const RESUME_FILENAME = 'Molhm-Ellis-Quanta-Robotics-Resume.pdf';
const COVER_FILENAME = 'Molhm-Ellis-Quanta-Robotics-Cover-Letter.pdf';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

function pdf(text: string): string {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF`).toString('base64');
}

/**
 * The canonical profile, v3, with every section the brief requires.
 *
 * Written out rather than imported: this file must not depend on the source
 * tree it exists to test. The country is deliberately the alias "USA" and the
 * phone deliberately carries its own "+1", because both are what the live
 * profile holds and both are what the page's controls have to cope with.
 */
const PROFILE = {
  version: 3,
  updatedAt: '2026-08-05T00:00:00.000Z',
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    phone: '+1 201 555 0134',
    phoneCountryCode: '+1',
    phoneType: 'mobile',
    address: {
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      country: 'USA',
      type: 'home',
    },
  },
  education: [
    {
      id: 'education-1',
      institution: 'Rutgers University',
      degree: "Bachelor's Degree",
      degreeLevel: "Bachelor's",
      major: 'Computer Science',
      graduationDate: '2027-05',
      status: 'in_progress',
    },
  ],
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
      responsibilities: ['Built test rigs for actuator assemblies.'],
      achievements: [],
    },
  ],
  projects: [
    {
      id: 'project-1',
      name: 'Rover telemetry',
      description: 'A C++ telemetry pipeline for an autonomous rover.',
      technologies: ['C++'],
      accomplishments: [],
    },
  ],
  organizations: ['IEEE Student Branch'],
  activities: ['Robotics Club'],
  skills: { technical: ['C++', 'SolidWorks'], programmingLanguages: ['C++'] },
  eligibility: { workAuthorization: 'U.S. Citizen', willingToRelocate: true },
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-profile-sync-'));
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
          // Off on purpose: every gate below must be met by the deterministic
          // path alone. A model that happened to guess the right country would
          // hide exactly the defect this suite exists to catch.
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
      websiteJobId: 'job-quanta-sync',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software.',
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

  // The arming is spent here, so the gates below measure the *click*.
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
  documentsAttached: number;
  results: Array<{ fieldId: string; question: string; verification: string; action: string }>;
};

test.beforeAll(async () => {
  application = await context.newPage();
  await application.goto(APPLICATION_URL);

  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();

  await expect(application.locator('#firstName')).toHaveValue('Molhm', {
    timeout: DETERMINISTIC_BUDGET_MS,
  });
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });

  const evidencePage = await extensionPage();
  ({ report } = await message<{ report: typeof report }>(evidencePage, {
    type: 'GET_AUTOFILL_REPORT',
  }));
  await evidencePage.close();
});

test.describe('the bundle handoff is visible before anything is filled', () => {
  test('names the job, both tailored documents, and the synchronized profile', async () => {
    await expect(
      popup.getByText('Ready for Quanta Robotics — Software Engineering Intern'),
    ).toBeVisible();
    await expect(popup.getByText(`✓ Tailored résumé (${RESUME_FILENAME})`)).toBeVisible();
    await expect(popup.getByText(`✓ Tailored cover letter (${COVER_FILENAME})`)).toBeVisible();
    // Counts, not contents: enough to prove the work history came across.
    await expect(popup.getByText(/✓ Profile synchronized \(.*experience.*\)/)).toBeVisible();
    await expect(popup.getByText('No application loaded from Internship Pilot')).toHaveCount(0);
  });
});

test.describe('the fields that already worked still work', () => {
  test('fills first name, last name, and email', async () => {
    await expect(application.locator('#firstName')).toHaveValue('Molhm');
    await expect(application.locator('#lastName')).toHaveValue('Ellis');
    await expect(application.locator('#email')).toHaveValue('molhm@example.com');
  });

  test('fills the phone number, without repeating the dialling code', async () => {
    const value = await application.locator('#phoneNumber').inputValue();
    expect(value).not.toBe('');
    expect(value).not.toContain('+1');
    expect(value.replace(/\D/g, '')).toBe('2015550134');
  });
});

test.describe('the phone country code', () => {
  test('selects the offered spelling of +1 and verifies it', async () => {
    // The page offers "Canada (+1)" first. Selecting it would be a wrong answer
    // that looks right, which is what the removed structural rule did.
    await expect(application.locator('#phoneCode')).toHaveValue('+1');
    const label = await application
      .locator('#phoneCode')
      .evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent ?? '');
    expect(label).toBe('United States (+1)');
  });
});

test.describe('country and the control that depends on it', () => {
  test('selects the country through the searchable combobox', async () => {
    await expect(application.locator('#country')).toHaveValue('United States of America');
    await expect(application.locator('#countryValue')).toHaveValue('US');
  });

  test('fills the state that did not exist until the country landed', async () => {
    await expect(application.locator('#state')).toHaveValue('New Jersey');
  });
});

test.describe('the tailored documents reach the hidden file inputs', () => {
  test('attaches the résumé and the cover letter to the right controls', async () => {
    const resume = await application
      .locator('#resumeInput')
      .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? '');
    const cover = await application
      .locator('#coverInput')
      .evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? '');

    expect(resume).toBe(RESUME_FILENAME);
    expect(cover).toBe(COVER_FILENAME);
    expect(report.documentsAttached).toBe(2);
  });

  test('the employer page displays both filenames', async () => {
    // The page's own rendering, driven by its own change handler — evidence
    // that the upload reached the site rather than only the input object.
    await expect(application.getByTestId('resume-filename')).toHaveText(RESUME_FILENAME);
    await expect(application.getByTestId('cover-filename')).toHaveText(COVER_FILENAME);
  });
});

test.describe('the imported profile answers what the settings page used to ask for', () => {
  test('fills education and work experience from the synchronized profile', async () => {
    await expect(application.locator('#school')).toHaveValue('Rutgers University');
    await expect(application.locator('#major')).toHaveValue('Computer Science');
    await expect(application.locator('#employer')).toHaveValue('Northwind Robotics');
    await expect(application.locator('#jobTitle')).toHaveValue('Engineering Intern');
  });

  test('never puts the applicant home address in a past job location', async () => {
    const location = await application.locator('#employerLocation').inputValue();
    expect(location).not.toContain('Clifton');
    expect(location === '' || location === 'Newark, New Jersey').toBe(true);
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
