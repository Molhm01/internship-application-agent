import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Dropdown execution, proved against the built extension.
 *
 * Every control on the master fixture is a widget family that failed on a live
 * application, and the only input here is one click on the popup's own
 * "Autofill Application" button. Nothing imports `extension/src`: the evidence
 * is the employer page's DOM afterwards and the run's own trace, so a helper
 * that works in jsdom while the shipped bundle does not cannot make this pass.
 *
 * Each control is reported at five stages — opened, options found, target
 * found, selected, verified — because "Autofill failed" over a dropdown was one
 * word covering five different repairs.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/dropdown-master.html`;
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'dropdown-run-evidence.json',
);
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

/** The whole run, one click to a terminal state. */
const RUN_BUDGET_MS = 45_000;
/** No single dropdown may take longer than this, including its dependency wait. */
const PER_DROPDOWN_BUDGET_MS = 5_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

function pdf(text: string): string {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF`).toString('base64');
}

const RESUME_FILENAME = 'Robin-Vale-Quanta-Robotics-Resume.pdf';

/**
 * The saved profile every expected answer below is derived from.
 *
 * Written out here rather than imported: this file may not depend on the source
 * tree it exists to test independently. Each dropdown's target is a restatement
 * of one of these facts, never something the engine decided.
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-dropdowns-'));
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
      websiteJobId: 'job-dropdowns-1',
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

interface FieldTrace {
  fieldId: string;
  frameId: number;
  label: string;
  controlType: string;
  executorAttempted: boolean;
  verification: string;
  finalStatus: string;
  annotation: string;
  errorCode?: string;
  durationMs?: number;
  dropdown?: {
    kind: string;
    optionCount: number;
    matchMethod: string;
    failureCode?: string;
  };
}

interface RunTrace {
  buildId: string;
  fields: FieldTrace[];
  totalDurationMs: number;
}

/** The five stages one control passed, or stopped at. */
interface Stages {
  opened: boolean;
  optionsFound: boolean;
  targetFound: boolean;
  selected: boolean;
  verified: boolean;
  kind: string;
  optionCount: number;
  frameId: number;
  failureCode: string;
  observed: string;
  durationMs: number;
  /** The whole trace record, so a control that never reached the engine can say why. */
  record?: FieldTrace;
}

interface Evidence {
  application: Page;
  report: {
    status: string;
    fieldsVerified: number;
    failedFields: number;
    submissionPrevented: boolean;
    results: Array<{ fieldId: string; question: string; verification: string; reason: string }>;
  };
  trace: RunTrace;
  wallClockMs: number;
  stages: Record<string, Stages>;
}

let evidence: Evidence;

/** The controls under test, their question wording, and the answer each must reach. */
const CONTROLS: ReadonlyArray<{
  name: string;
  question: RegExp;
  expected: string;
  /** Reads what the control displays, from the live page. */
  read: (page: Page) => Promise<string>;
}> = [
  {
    name: 'Country',
    question: /^Country \*/,
    expected: 'United States of America',
    read: (page) =>
      page
        .locator('#country')
        .evaluate((node: HTMLSelectElement) => node.selectedOptions[0]?.textContent?.trim() ?? ''),
  },
  {
    name: 'State/Province',
    question: /state\/province \*/i,
    expected: 'New Jersey',
    read: (page) =>
      page
        .locator('#state')
        .evaluate((node: HTMLSelectElement) => node.selectedOptions[0]?.textContent?.trim() ?? ''),
  },
  {
    name: 'Employment Type',
    question: /employment type/i,
    expected: 'Internship',
    read: (page) => page.locator('#employmentType .value').innerText(),
  },
  {
    name: 'Reason for Leaving',
    question: /reason for leaving/i,
    expected: 'Returned to school',
    read: (page) =>
      page
        .frameLocator('#employmentFrame')
        .frameLocator('#employmentInnerFrame')
        .locator('#reasonForLeaving .value')
        .innerText(),
  },
  {
    name: 'Education Type',
    question: /education type/i,
    expected: 'College/University',
    read: (page) => page.locator('#educationType .singleValue').innerText(),
  },
  {
    name: 'Education Country',
    question: /education country/i,
    expected: 'United States of America',
    read: (page) => page.locator('#educationCountry [data-selected-label]').innerText(),
  },
  {
    name: 'Education State',
    question: /education state\/province/i,
    expected: 'New Jersey',
    read: (page) => page.locator('#educationState [data-selected-label]').innerText(),
  },
  {
    name: 'School',
    question: /school\/institution/i,
    expected: 'Rutgers University',
    read: (page) => page.locator('#school').inputValue(),
  },
  {
    name: 'Area of Study',
    question: /area of study/i,
    expected: 'Electrical Engineering',
    read: (page) => page.locator('#areaOfStudy .value').innerText(),
  },
  {
    name: 'Graduated',
    question: /graduated/i,
    expected: 'No',
    read: (page) =>
      page.locator('#graduatedHost').evaluate((host: HTMLElement) => {
        const select = host.shadowRoot?.getElementById('graduated');
        return select instanceof HTMLSelectElement
          ? (select.selectedOptions[0]?.textContent?.trim() ?? '')
          : '';
      }),
  },
  {
    name: 'Degree in shadow root',
    question: /degree in progress/i,
    expected: "Bachelor's Degree",
    read: (page) =>
      page
        .locator('#degreeHost')
        .evaluate(
          (host: HTMLElement) =>
            host.shadowRoot?.querySelector('#degree .value')?.textContent?.trim() ?? '',
        ),
  },
  {
    name: 'How did you hear',
    question: /how did you hear/i,
    expected: 'LinkedIn',
    read: (page) => page.locator('#source .value').innerText(),
  },
];

/** The text inputs that must keep working while the dropdowns are repaired. */
const TEXT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['firstName', 'Robin'],
  ['lastName', 'Vale'],
  ['email', 'robin.vale@example.com'],
  ['addressLine1', '48 Maple Avenue'],
  ['city', 'Clifton'],
  ['postalCode', '07011'],
];

test.beforeAll(async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });

  const started = Date.now();
  await button.click();
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });
  const wallClockMs = Date.now() - started;

  const evidencePage = await extensionPage();
  const { report } = await message<{ report: Evidence['report'] }>(evidencePage, {
    type: 'GET_AUTOFILL_REPORT',
  });
  const { traces } = await message<{ traces: RunTrace[] }>(evidencePage, {
    type: 'GET_RUN_TRACES',
  });
  await evidencePage.close();
  await popup.close();

  expect(report, 'the run produced no report').toBeTruthy();
  expect(traces.length, 'the run produced no trace').toBeGreaterThan(0);
  const trace = traces[0]!;

  const stages: Record<string, Stages> = {};
  for (const control of CONTROLS) {
    const record = trace.fields.find((field) => control.question.test(field.label));
    const observed = await control.read(application).catch(() => '');
    const dropdown = record?.dropdown;
    const verified = observed.trim() === control.expected;
    stages[control.name] = {
      // A native select has its choices in the DOM already, so "opened" for it
      // is "its option list was read". For everything else the option count is
      // evidence the menu actually came up.
      opened: (dropdown?.optionCount ?? 0) > 0,
      optionsFound: (dropdown?.optionCount ?? 0) > 0,
      targetFound: dropdown !== undefined && dropdown.matchMethod !== 'none',
      selected: record?.executorAttempted === true && record.finalStatus === 'FILLED_VERIFIED',
      verified,
      kind: dropdown?.kind ?? 'not_reached',
      optionCount: dropdown?.optionCount ?? 0,
      frameId: record?.frameId ?? -1,
      failureCode: dropdown?.failureCode ?? record?.errorCode ?? 'none',
      observed,
      durationMs: record?.durationMs ?? 0,
      ...(record ? { record } : {}),
    };
  }

  evidence = { application, report, trace, wallClockMs, stages };

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        buildId: trace.buildId,
        wallClockMs,
        stages,
        report: {
          status: report.status,
          fieldsVerified: report.fieldsVerified,
          failedFields: report.failedFields,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test.describe('every dropdown shape reaches the page', () => {
  for (const control of CONTROLS) {
    test(`${control.name} opens, offers options, matches, selects and verifies`, () => {
      const stage = evidence.stages[control.name]!;
      const detail = `kind=${stage.kind} frame=${stage.frameId} options=${stage.optionCount} failure=${stage.failureCode} observed="${stage.observed}"`;
      expect(stage.opened, `OPENED — ${detail}`).toBe(true);
      expect(stage.optionsFound, `OPTIONS_FOUND — ${detail}`).toBe(true);
      expect(stage.targetFound, `TARGET_FOUND — ${detail}`).toBe(true);
      expect(stage.selected, `SELECTED — ${detail}`).toBe(true);
      expect(stage.verified, `VERIFIED — ${detail}`).toBe(true);
    });
  }
});

test.describe('the widget shapes each control actually was', () => {
  const expectedKinds: ReadonlyArray<readonly [string, string]> = [
    ['State/Province', 'native_select'],
    ['Employment Type', 'aria_combobox'],
    ['Education Type', 'aria_combobox'],
    ['Education Country', 'button_menu'],
    ['Education State', 'button_menu'],
    ['School', 'searchable_combobox'],
    ['Area of Study', 'aria_combobox'],
    ['Graduated', 'native_select'],
    ['Degree in shadow root', 'aria_combobox'],
  ];

  for (const [name, kind] of expectedKinds) {
    test(`${name} was driven as ${kind}`, () => {
      expect(evidence.stages[name]!.kind).toBe(kind);
    });
  }

  test('the long country menu was read past its visible rows', () => {
    // Six rows are on screen; anything close to the full list is proof the
    // menu itself was scrolled rather than the page.
    expect(evidence.stages['Education Country']!.optionCount).toBeGreaterThan(100);
  });

  test('the virtualized menu accumulated options it had to scroll to render', () => {
    expect(evidence.stages['Area of Study']!.optionCount).toBeGreaterThan(50);
  });

  test('the nested-frame control executed in its own frame', () => {
    expect(evidence.stages['Reason for Leaving']!.frameId).toBeGreaterThan(0);
  });
});

test.describe('the fill the dropdowns sit in', () => {
  for (const [id, value] of TEXT_FIELDS) {
    test(`${id} still holds ${value}`, async () => {
      expect(await evidence.application.locator(`#${id}`).inputValue()).toBe(value);
    });
  }

  test('no verified dropdown is still wearing a failure', () => {
    const wrong = evidence.trace.fields.filter(
      (field) =>
        field.dropdown !== undefined &&
        field.finalStatus === 'FILLED_VERIFIED' &&
        field.annotation !== 'verified',
    );
    expect(wrong.map((field) => `${field.label}: ${field.annotation}`)).toEqual([]);
  });

  test('no dropdown was left in a temporary state', () => {
    const pending = evidence.trace.fields.filter(
      (field) => field.dropdown !== undefined && field.finalStatus.startsWith('PENDING_'),
    );
    expect(pending.map((field) => field.label)).toEqual([]);
  });

  test('every dropdown finished inside its budget', () => {
    const slow = evidence.trace.fields.filter(
      (field) => field.dropdown !== undefined && (field.durationMs ?? 0) > PER_DROPDOWN_BUDGET_MS,
    );
    expect(slow.map((field) => `${field.label}: ${field.durationMs}ms`)).toEqual([]);
  });

  test('the whole run finished inside its budget', () => {
    expect(evidence.wallClockMs).toBeLessThan(RUN_BUDGET_MS);
  });

  test('the application was never submitted', async () => {
    expect(evidence.report.submissionPrevented).toBe(true);
    expect(
      await evidence.application.evaluate(
        () =>
          (window as unknown as { fixtureState: { submitted: boolean } }).fixtureState.submitted,
      ),
    ).toBe(false);
  });
});
