import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The relatives box, proved shut against the built extension.
 *
 * Lincoln Electric asks, in these exact words:
 *
 *     Do you have any relatives, including those by marriage, employed by our
 *     Company?
 *
 * and beneath it:
 *
 *     If you have any relatives currently employed, provide their full name,
 *     location and your relationship to them.
 *
 * On the live run the parent was left on "No Selection" and the child was
 * filled with the applicant's own legal name. The submitted form then told an
 * employer that the applicant has a relative working there, and named them.
 *
 * The jsdom suite proves each of the four repairs in isolation. This proves the
 * one thing that actually matters, through the shipped bundle and one click on
 * the popup's own button: **the box is still empty afterwards**. Nothing here
 * imports `extension/src`, so a guard that works in a unit test while the built
 * extension does not cannot make this pass.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/lincoln-application.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RUN_BUDGET_MS = 60_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/** A minimal PDF, and the byte count the bundle has to declare for it. */
const RESUME_BYTES = Buffer.from('%PDF-1.4\n% resume\n%%EOF');

/**
 * The applicant. Their legal name is the value that must never appear in the
 * relatives box, so it is deliberately distinctive: a substring search for it
 * across the whole textarea cannot pass by accident.
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
      reasonForLeaving: 'Returned to school',
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

/** Every part of the applicant's identity that must not reach the box. */
const IDENTITY_VALUES = [
  'Robin',
  'Vale',
  'robin.vale@example.com',
  '48 Maple Avenue',
  'Clifton',
  '201 555 0134',
];

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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-relatives-'));
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
      websiteJobId: 'job-lincoln-relatives',
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

interface Evidence {
  application: Page;
  parentValue: string;
  childBefore: string;
  childAfter: string;
  firstName: string;
}

let evidence: Evidence;

test.beforeAll(async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  // The mandatory precondition: the parent is unanswered and the child is
  // empty. A run that starts with the box already blank and ends with it blank
  // proves nothing unless the parent really was left on "No Selection".
  const parentBefore = await application.locator('#relativesEmployed').inputValue();
  const childBefore = await application.locator('#relativeDetails').inputValue();
  expect(parentBefore, 'the fixture did not start with the parent unanswered').toBe('');
  expect(childBefore, 'the fixture did not start with the child empty').toBe('');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });
  await popup.close();

  evidence = {
    application,
    parentValue: await application.locator('#relativesEmployed').inputValue(),
    childBefore,
    childAfter: await application.locator('#relativeDetails').inputValue(),
    // Proof the run actually did something to this page, so an empty box is a
    // decision rather than an autofill that never happened.
    firstName: await application.locator('#firstName').inputValue(),
  };
});

test.describe('the relatives detail box', () => {
  test('the run actually filled this page', () => {
    expect(evidence.firstName).toBe('Robin');
  });

  test('left the parent question for the applicant', () => {
    // Nothing saved says whether the applicant has a relative working at
    // Lincoln Electric, so the honest outcome is that they are asked.
    expect(evidence.parentValue).toBe('');
  });

  test('is still empty after one Autofill Application click', () => {
    // The single assertion this file exists for.
    expect(evidence.childAfter).toBe('');
  });

  test('contains no part of the applicant’s identity', () => {
    for (const value of IDENTITY_VALUES) {
      expect(
        evidence.childAfter,
        `the relatives box was filled with the applicant's own "${value}"`,
      ).not.toContain(value);
    }
  });

  test('never clicked the submit control', async () => {
    await expect(evidence.application.locator('body')).not.toHaveAttribute(
      'data-submitted',
      'true',
    );
  });
});
