import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Repeating sections, proved against the built extension.
 *
 * The only input is one click on the popup's own "Autofill Application" button.
 * Nothing here imports `extension/src`: the evidence is the employer page's DOM
 * afterwards and the run's own trace, so a helper that works in jsdom while the
 * shipped bundle does not cannot make this pass. That distinction is the whole
 * reason this file exists — the previous repeater engine was green in the unit
 * suite and dead in the browser, because the worker never called it.
 *
 * Two runs, in order, against the same page:
 *
 *  1. One Work Experience block becomes three, one Education block becomes two,
 *     and each block holds its own record.
 *  2. Autofill again. Zero Add clicks, zero new blocks, zero duplicates.
 *
 * The submit button is never clicked, and that is asserted rather than assumed.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/repeater-master.html`;
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'repeater-run-evidence.json',
);
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 45_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

function pdf(text: string): string {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF`).toString('base64');
}

/**
 * The saved profile every expectation below is derived from.
 *
 * Written out here rather than imported: this file may not depend on the source
 * tree it exists to test independently. Three jobs and two schools, which is the
 * count the fixture's single block of each cannot hold.
 */
const EMPLOYERS = ['Northwind Robotics', 'Acme Industrial', 'Lakeside Analytics'] as const;
/**
 * Both in New Jersey, and deliberately so.
 *
 * The profile records no country or state per school, so each Education block's
 * Country and State are answered from the applicant's own address — New Jersey.
 * The School list the page then produces holds New Jersey schools, and a saved
 * school in another state is correctly *not* selected, because no choice on the
 * list is defensibly equivalent to it and one is never guessed. Pairing a
 * Michigan school with a New Jersey address would be asking this test to prove
 * the engine guesses.
 */
const SCHOOLS = ['Rutgers University', 'Princeton University'] as const;

const PROFILE = {
  updatedAt: '2026-08-09T00:00:00.000Z',
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
      institution: SCHOOLS[0],
      degree: "Bachelor's Degree",
      degreeLevel: "Bachelor's Degree",
      major: 'Electrical Engineering',
      graduationDate: '2027-05',
      status: 'in_progress',
    },
    {
      id: 'education-2',
      institution: SCHOOLS[1],
      degree: 'High School',
      degreeLevel: 'High School',
      major: 'Mathematics',
      graduationDate: '2023-06',
      status: 'completed',
    },
  ],
  highestCompletedDegree: 'High School',
  currentDegreeInProgress: "Bachelor's Degree",
  experience: [
    {
      id: 'experience-1',
      employer: EMPLOYERS[0],
      title: 'Engineering Intern',
      location: 'Newark, New Jersey',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      employmentType: 'Internship',
      reasonForLeaving: 'Internship Completed',
      responsibilities: ['Built test rigs for actuator assemblies.'],
      achievements: [],
    },
    {
      id: 'experience-2',
      employer: EMPLOYERS[1],
      title: 'Manufacturing Assistant',
      location: 'Clifton, New Jersey',
      startDate: '2025-06',
      endDate: '2025-08',
      current: false,
      employmentType: 'Part Time',
      reasonForLeaving: 'Resigned',
      responsibilities: ['Logged line output.'],
      achievements: [],
    },
    {
      id: 'experience-3',
      employer: EMPLOYERS[2],
      title: 'Data Analyst Intern',
      location: 'Remote',
      startDate: '2024-06',
      endDate: '2024-08',
      current: false,
      employmentType: 'Internship',
      reasonForLeaving: 'End of Contract',
      responsibilities: ['Cleaned survey datasets.'],
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

interface RepeaterTrace {
  type: string;
  profileRecords: number;
  existingBlocksInitially: number;
  blocksNeeded: number;
  addControlFound: boolean;
  addClicksAttempted: number;
  blocksCreated: number;
  blocksVerified: number;
  duplicateBlocksCreated: number;
  recordBindings: Array<{ recordIndex: number; blockIndex?: number; reason?: string }>;
  errorCode?: string;
}

interface RunTrace {
  buildId: string;
  runId: string;
  repeaters: RepeaterTrace[];
  fields: Array<{ label: string; finalStatus: string; recordIndex?: number }>;
}

interface PageState {
  experienceBlocks: number;
  educationBlocks: number;
  countries: string[];
  states: string[];
  companies: string[];
  titles: string[];
  schools: string[];
  areas: string[];
  graduated: string[];
  otherSchool: string[];
  otherArea: string[];
  submitClicked: boolean;
}

/** What the employer's page actually holds. Read from the DOM, never inferred. */
async function readPage(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const values = (selector: string): string[] =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map((node) => {
        if (node instanceof HTMLSelectElement) {
          const selected = node.selectedOptions[0];
          return selected && selected.value !== '' ? (selected.textContent ?? '').trim() : '';
        }
        if (node instanceof HTMLInputElement) return node.value.trim();
        return (node.textContent ?? '').trim();
      });

    return {
      experienceBlocks: document.querySelectorAll('.experience-block').length,
      educationBlocks: document.querySelectorAll('.education-block').length,
      companies: values('[id^="exp-company-"]'),
      titles: values('[id^="exp-title-"]'),
      countries: values('[id^="edu-country-"]'),
      states: values('[id^="edu-state-"]'),
      schools: values('[id^="edu-school-"]'),
      areas: values('[id^="edu-area-"]'),
      graduated: values('[id^="edu-graduated-"]'),
      otherSchool: values('[id^="edu-other-school-"]'),
      otherArea: values('[id^="edu-other-area-"]'),
      submitClicked:
        (window as unknown as { __submitClicked__?: boolean }).__submitClicked__ === true,
    };
  });
}

/** Runs Autofill once from the popup and returns the trace it produced. */
async function autofillOnce(): Promise<RunTrace> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Any of the labels the one primary action carries. It reads "Autofill
  // Application" on a fresh page and "Retry failed fields" or "Try again" after
  // a run that did not fully verify — so a test waiting for one exact string is
  // really waiting for a particular history rather than for the button, and the
  // second run here is by definition not a fresh page.
  const button = popup.getByRole('button', {
    name: /^(Autofill Application|Retry failed fields|Try again)$/,
  });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });
  await popup.close();

  const evidencePage = await extensionPage();
  const { traces } = await message<{ traces: RunTrace[] }>(evidencePage, {
    type: 'GET_RUN_TRACES',
  });
  await evidencePage.close();
  expect(traces.length, 'the run produced no trace').toBeGreaterThan(0);
  return traces[0]!;
}

function sectionOf(trace: RunTrace, kind: string): RepeaterTrace {
  const found = trace.repeaters.find((entry) => entry.type === kind);
  expect(found, `the run trace carries no ${kind} repeater section`).toBeTruthy();
  return found!;
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-repeaters-'));
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
      websiteJobId: 'job-repeaters-1',
      company: 'Quanta Robotics',
      jobTitle: 'Software Engineering Intern',
      jobDescription: 'Build and test control software for autonomous handling systems.',
      officialApplicationUrl: APPLICATION_URL,
      documents: [
        {
          kind: 'resume',
          filename: 'Robin-Vale-Quanta-Robotics-Resume.pdf',
          mimeType: 'application/pdf',
          contentBase64: pdf('tailored resume'),
          byteLength: 32,
          generatedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
      profile: PROFILE,
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-09T00:00:00.000Z',
    },
  });
  expect(
    stored.result.ok,
    `the bundle was rejected: ${stored.result.ok ? '' : stored.result.reason}`,
  ).toBe(true);

  /**
   * Disarm "Apply with Agent" auto-start, and prove it is disarmed.
   *
   * Storing a bundle arms exactly one origin, and the arming is written without
   * the store call waiting on it — so a single `remove` can land *before* the
   * arm does and leave the page filling itself the moment it loads. That run
   * then grows the sections before the click this test is about, and the first
   * run under test is really the second. Polled until the key is genuinely
   * gone, because this test's whole claim is "one click did this".
   */
  await expect
    .poll(
      async () => {
        await setup.evaluate(() => chrome.storage.local.remove('autoStartArmed'));
        return setup.evaluate(() =>
          chrome.storage.local.get('autoStartArmed').then((stored) => 'autoStartArmed' in stored),
        );
      },
      { timeout: 10_000 },
    )
    .toBe(false);
  await setup.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

let application: Page;
let firstRun: RunTrace;
let afterFirst: PageState;
let secondRun: RunTrace;
let afterSecond: PageState;

test.beforeAll(async () => {
  application = await context.newPage();
  await application.goto(APPLICATION_URL);
  // A tripwire on the submit control. Nothing in this run may click it, and an
  // assertion that it "was not submitted" is worth more when the page itself is
  // the witness.
  await application.evaluate(() => {
    const submit = document.getElementById('submit');
    submit?.addEventListener('click', () => {
      (window as unknown as { __submitClicked__?: boolean }).__submitClicked__ = true;
    });
  });

  const before = await readPage(application);
  expect(before.experienceBlocks, 'the fixture must start with one work block').toBe(1);
  expect(before.educationBlocks, 'the fixture must start with one education block').toBe(1);

  firstRun = await autofillOnce();
  afterFirst = await readPage(application);

  secondRun = await autofillOnce();
  afterSecond = await readPage(application);

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        buildId: firstRun.buildId,
        firstRun: { repeaters: firstRun.repeaters, page: afterFirst },
        secondRun: { repeaters: secondRun.repeaters, page: afterSecond },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test.describe('first run: the page grows to fit the saved records', () => {
  test('detects three saved jobs against one work block and presses Add exactly twice', () => {
    const experience = sectionOf(firstRun, 'experience');
    expect(experience.profileRecords).toBe(3);
    expect(experience.existingBlocksInitially).toBe(1);
    expect(experience.addControlFound).toBe(true);
    expect(experience.addClicksAttempted).toBe(2);
    expect(experience.blocksCreated).toBe(2);
    expect(experience.duplicateBlocksCreated).toBe(0);
  });

  test('leaves exactly three work blocks on the page', () => {
    expect(afterFirst.experienceBlocks).toBe(3);
  });

  test('binds experience[i] to work block i', () => {
    expect(sectionOf(firstRun, 'experience').recordBindings).toEqual([
      expect.objectContaining({ recordIndex: 0, blockIndex: 0 }),
      expect.objectContaining({ recordIndex: 1, blockIndex: 1 }),
      expect.objectContaining({ recordIndex: 2, blockIndex: 2 }),
    ]);
  });

  test('fills each Company Name from its own record, never another block’s', () => {
    expect(afterFirst.companies).toEqual([...EMPLOYERS]);
  });

  test('fills each Position Title from its own record', () => {
    expect(afterFirst.titles).toEqual([
      'Engineering Intern',
      'Manufacturing Assistant',
      'Data Analyst Intern',
    ]);
  });

  test('detects two saved schools against one education block and presses Add exactly once', () => {
    const education = sectionOf(firstRun, 'education');
    expect(education.profileRecords).toBe(2);
    expect(education.existingBlocksInitially).toBe(1);
    expect(education.addControlFound).toBe(true);
    expect(education.addClicksAttempted).toBe(1);
    expect(education.blocksCreated).toBe(1);
    expect(education.duplicateBlocksCreated).toBe(0);
  });

  test('leaves exactly two education blocks on the page', () => {
    expect(afterFirst.educationBlocks).toBe(2);
  });

  test('binds education[i] to education block i', () => {
    expect(sectionOf(firstRun, 'education').recordBindings).toEqual([
      expect.objectContaining({ recordIndex: 0, blockIndex: 0 }),
      expect.objectContaining({ recordIndex: 1, blockIndex: 1 }),
    ]);
  });

  /**
   * The School control is a dependent dropdown: it has no options until Country
   * and then State are answered, and it is driven by the Dropdown Engine rather
   * than by anything in the repeater subsystem. Reaching the right school in
   * block 1 is therefore evidence of both — the block exists, and the existing
   * dropdown engine drove it inside that block.
   */
  test('reaches each block’s own school through the dropdown engine', () => {
    expect(afterFirst.schools).toEqual([SCHOOLS[0], SCHOOLS[1]]);
  });

  /**
   * Each block ran its own Country → State → School chain. Both resolve to the
   * same country and state here because the applicant has one address, and the
   * point is that block 1's chain ran *at all* — it is inside a block that did
   * not exist until this run pressed Add.
   */
  test('runs the Country → State chain inside the block Add created', () => {
    expect(afterFirst.countries).toEqual(['United States', 'United States']);
    expect(afterFirst.states).toEqual(['New Jersey', 'New Jersey']);
  });

  test('keeps Area of Study record-specific', () => {
    expect(afterFirst.areas).toHaveLength(2);
    expect(afterFirst.areas[0]).toBe('Electrical Engineering');
  });

  test('leaves the If-other boxes blank because no parent selected Other', () => {
    expect(afterFirst.otherSchool.every((value) => value === '')).toBe(true);
    expect(afterFirst.otherArea.every((value) => value === '')).toBe(true);
  });

  test('never clicks the final submit control', () => {
    expect(afterFirst.submitClicked).toBe(false);
  });
});

test.describe('second run: zero duplicates', () => {
  test('presses Add zero times for work experience', () => {
    const experience = sectionOf(secondRun, 'experience');
    expect(experience.existingBlocksInitially).toBe(3);
    expect(experience.blocksNeeded).toBe(0);
    expect(experience.addClicksAttempted).toBe(0);
    expect(experience.blocksCreated).toBe(0);
    expect(experience.duplicateBlocksCreated).toBe(0);
  });

  test('presses Add zero times for education', () => {
    const education = sectionOf(secondRun, 'education');
    expect(education.existingBlocksInitially).toBe(2);
    expect(education.blocksNeeded).toBe(0);
    expect(education.addClicksAttempted).toBe(0);
    expect(education.blocksCreated).toBe(0);
    expect(education.duplicateBlocksCreated).toBe(0);
  });

  test('creates no new blocks of either kind', () => {
    expect(afterSecond.experienceBlocks).toBe(3);
    expect(afterSecond.educationBlocks).toBe(2);
  });

  test('leaves every value exactly where the first run put it', () => {
    expect(afterSecond.companies).toEqual(afterFirst.companies);
    expect(afterSecond.titles).toEqual(afterFirst.titles);
    expect(afterSecond.schools).toEqual(afterFirst.schools);
  });

  test('recognises every block as already holding its record', () => {
    expect(
      sectionOf(secondRun, 'experience').recordBindings.every(
        (binding) => binding.reason === 'MATCHED_BY_VALUE',
      ),
    ).toBe(true);
  });

  test('still never clicks the final submit control', () => {
    expect(afterSecond.submitClicked).toBe(false);
  });
});
