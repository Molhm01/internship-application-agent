import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Dropdowns with no ARIA at all, proved against the built extension.
 *
 * The existing master fixture is, in hindsight, friendly: `role="combobox"`,
 * `role="listbox"`, `role="option"`, `aria-controls`, explicit portal
 * attributes — every declared route this codebase knows how to follow. It
 * passed while a live employer form came back with eight menus reading "No
 * Selection", because that form ships none of those things: a `div` trigger, a
 * menu appended to `document.body` on click, and rows that are plain `li` and
 * `div` elements.
 *
 * Every control on `hostile-dropdowns.html` is built that way. Nothing here
 * imports `extension/src`: the evidence is the employer page's DOM after one
 * click on the popup's own "Autofill Application" button, plus the run's own
 * trace. A helper that works in jsdom while the shipped bundle does not cannot
 * make this pass.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/hostile-dropdowns.html`;
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'hostile-dropdown-evidence.json',
);
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RUN_BUDGET_MS = 60_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

function pdf(text: string): string {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF`).toString('base64');
}

/**
 * The saved profile every expected answer below is derived from.
 *
 * Written out here rather than imported: this file may not depend on the source
 * tree it exists to test independently. Each control's target is a restatement
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
      location: 'New Brunswick, New Jersey',
      country: 'United States of America',
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-hostile-'));
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
      websiteJobId: 'job-hostile-1',
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

/** The live record of one option control, as the shipped trace reports it. */
interface LiveDropdownTrace {
  dropdownId: string;
  scanFieldId?: string;
  question: string;
  frameId: number;
  mainScannerFound: boolean;
  dedicatedScannerFound: boolean;
  discoverySource: string;
  structure?: {
    triggerTag: string;
    triggerRole: string;
    ariaHasPopup: string;
    ariaExpandedAfter: string;
    hasAriaControls: boolean;
    classFingerprint: string;
  };
  engineCalled: boolean;
  executorInvoked: boolean;
  triggerResolved: boolean;
  openAttempted: boolean;
  openSucceeded: boolean;
  menuDetection: string;
  menuFound: boolean;
  optionCandidates: string;
  optionsFound: number;
  scrolled: boolean;
  scrollIterations: number;
  targetFound: boolean;
  matchedOption: boolean;
  clickAttempted: boolean;
  selected: boolean;
  verified: boolean;
  finalStatus: string;
  failureCode?: string;
  durationMs: number;
}

interface RunTrace {
  buildId: string;
  fields: Array<{ label: string; finalStatus: string; dropdownEngineCalled?: boolean }>;
  engineInvocations: Array<{ marker: string }>;
  dropdownEngineTraces: LiveDropdownTrace[];
  optionActionsDeferred: number;
  legacyOptionExecutions: number;
}

interface Evidence {
  application: Page;
  report: {
    status: string;
    submissionPrevented: boolean;
  };
  trace: RunTrace;
  displayed: Record<string, string>;
}

let evidence: Evidence;

/**
 * Every hostile control, and the answer each must reach.
 *
 * Each expected value is a restatement of a fact in `PROFILE` above. Nothing
 * here asks the engine to decide anything.
 */
const CONTROLS: ReadonlyArray<{
  id: string;
  question: RegExp;
  expected: string;
}> = [
  { id: 'state', question: /state\/province/i, expected: 'New Jersey' },
  { id: 'employmentType', question: /employment type/i, expected: 'Internship' },
  { id: 'educationType', question: /education type/i, expected: "Bachelor's Degree" },
  {
    id: 'educationCountry',
    question: /education country/i,
    expected: 'United States of America',
  },
  { id: 'educationState', question: /education state/i, expected: 'New Jersey' },
  { id: 'school', question: /^school/i, expected: 'Rutgers University' },
  { id: 'areaOfStudy', question: /area of study/i, expected: 'Electrical Engineering' },
];

/** The text inputs that must keep working while the dropdowns are repaired. */
const TEXT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['firstName', 'Robin'],
  ['lastName', 'Vale'],
  ['email', 'robin.vale@example.com'],
  ['address', '48 Maple Avenue'],
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
  await button.click();
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });

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

  const displayed: Record<string, string> = {};
  for (const control of [...CONTROLS, { id: 'graduated' }]) {
    displayed[control.id] = await application
      .locator(`#${control.id} .val`)
      .innerText()
      .catch(() => '');
  }

  evidence = { application, report, trace, displayed };

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        buildId: trace.buildId,
        optionActionsDeferred: trace.optionActionsDeferred,
        legacyOptionExecutions: trace.legacyOptionExecutions,
        displayed,
        dropdownEngineTraces: trace.dropdownEngineTraces,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

/** The last trace recorded for a control, which is its settled account. */
function traceFor(question: RegExp): LiveDropdownTrace | undefined {
  return [...evidence.trace.dropdownEngineTraces]
    .reverse()
    .find((entry) => question.test(entry.question));
}

/** The trace in which the control was actually driven, if any pass drove it. */
function drivingTraceFor(question: RegExp): LiveDropdownTrace | undefined {
  return evidence.trace.dropdownEngineTraces.find(
    (entry) => question.test(entry.question) && entry.clickAttempted,
  );
}

test.describe('a control with no ARIA at all is opened, read, selected and verified', () => {
  for (const control of CONTROLS) {
    test(`${control.id} passes every stage`, () => {
      const settled = traceFor(control.question);
      const driving = drivingTraceFor(control.question) ?? settled;
      const detail = settled
        ? `source=${settled.discoverySource} menu=${settled.menuDetection} options=${settled.optionsFound} failure=${settled.failureCode ?? 'none'} shown="${evidence.displayed[control.id]}"`
        : 'no trace was recorded for this control at all';

      expect(settled, `ENGINE_CALLED — ${detail}`).toBeTruthy();
      expect(settled!.engineCalled, `ENGINE_CALLED — ${detail}`).toBe(true);
      expect(driving!.executorInvoked, `EXECUTOR_CALLED — ${detail}`).toBe(true);
      expect(driving!.triggerResolved, `TRIGGER_RESOLVED — ${detail}`).toBe(true);
      expect(driving!.openAttempted, `OPEN_ATTEMPTED — ${detail}`).toBe(true);
      expect(driving!.openSucceeded, `OPENED — ${detail}`).toBe(true);
      expect(driving!.menuFound, `MENU_FOUND — ${detail}`).toBe(true);
      expect(driving!.optionsFound, `OPTIONS_FOUND — ${detail}`).toBeGreaterThan(0);
      expect(driving!.targetFound, `TARGET_FOUND — ${detail}`).toBe(true);
      expect(driving!.selected, `SELECTED — ${detail}`).toBe(true);
      // The page itself, which is the only evidence that finally matters.
      expect(evidence.displayed[control.id], `VERIFIED — ${detail}`).toBe(control.expected);
    });
  }

  test('every menu was found by the no-ARIA fallback, not a declared route', () => {
    // The point of the fixture. If any of these came back `aria_controls` or
    // `aria_role_container` the fixture has stopped being hostile and has
    // stopped proving anything.
    for (const control of CONTROLS) {
      const driving = drivingTraceFor(control.question);
      expect(driving?.menuDetection, `${control.id} menu detection`).toBe('mutation_fallback');
    }
  });

  test('the long menu was scrolled to reach an answer below the fold', () => {
    const area = drivingTraceFor(/area of study/i);
    // `scrollIterations`, not `scrolled`. The two answer different questions:
    // `scrolled` means "scrolling revealed entries that were not rendered
    // before", which is the *virtualized* case, and this menu keeps all 61 rows
    // in the DOM behind an overflow. The list was still scrolled — eleven reads
    // of it — and the answer still sat past the fold, which is what this fixture
    // is here to exercise.
    expect(
      area?.scrollIterations ?? 0,
      'the Area of Study menu was never scrolled',
    ).toBeGreaterThan(1);
    expect(area?.optionsFound ?? 0, 'the whole long list was not read').toBeGreaterThan(50);
  });
});

test.describe('"No Selection" never satisfies "No"', () => {
  test('the Graduated? control was driven, not skipped over its placeholder', () => {
    const all = evidence.trace.dropdownEngineTraces.filter((entry) =>
      /graduated/i.test(entry.question),
    );
    expect(all.length, 'Graduated? never reached the dropdown engine').toBeGreaterThan(0);

    // The control starts displaying "No Selection" and the intended answer is
    // "No". `"No Selection".includes("No")` is true, so the *first* pass over
    // this control is exactly where the old comparison reported it already
    // answered — never opening it, never driving it, and leaving the page
    // showing "No Selection" under a green verdict.
    const first = all[0]!;
    expect(first.finalStatus, 'the placeholder was accepted as the answer').not.toBe(
      'SKIPPED_ALREADY_VALID',
    );
    expect(first.openSucceeded, 'the control was never opened').toBe(true);
    expect(first.clickAttempted, 'nothing was ever chosen in the control').toBe(true);

    // And the page itself: "No", not "No Selection".
    expect(evidence.displayed.graduated).toBe('No');

    // A *later* pass reporting SKIPPED_ALREADY_VALID is correct and required —
    // the control now genuinely holds "No", and re-selecting it would fire
    // `change` and could discard a dependent list rebuilt from it.
    expect(all.at(-1)!.finalStatus).toBe('SKIPPED_ALREADY_VALID');
  });
});

test.describe('the authoritative scan is what reaches the engine', () => {
  test('every hostile control was found by the main scanner', () => {
    for (const control of CONTROLS) {
      const settled = traceFor(control.question);
      expect(settled?.mainScannerFound, `${control.id} was not seeded from the scan`).toBe(true);
      expect(settled?.scanFieldId, `${control.id} carries no scan field id`).toBeTruthy();
    }
  });

  test('records the control structure, and no value anywhere in the trace', () => {
    const state = traceFor(/state\/province/i);
    expect(state?.structure?.triggerTag).toBe('div');
    expect(state?.structure?.ariaHasPopup).toBe('');
    expect(state?.structure?.hasAriaControls).toBe(false);
    // Not one answer in the whole trace. The schema is strict and has no member
    // able to hold one; this asserts the outcome rather than the mechanism.
    const serialized = JSON.stringify(evidence.trace.dropdownEngineTraces);
    for (const answer of ['New Jersey', 'Rutgers', 'Electrical Engineering', 'Robin', 'Vale']) {
      expect(serialized, `the trace leaked "${answer}"`).not.toContain(answer);
    }
  });
});

test.describe('one engine drives an option control', () => {
  test('defers every option action and runs the retired executor zero times', () => {
    expect(evidence.trace.legacyOptionExecutions).toBe(0);
  });

  test('reaches and waits for the Dropdown Engine', () => {
    const markers = evidence.trace.engineInvocations.map((entry) => entry.marker);
    expect(markers).toContain('DROPDOWN_ENGINE_STARTED');
    expect(markers).toContain('DROPDOWN_ENGINE_FINISHED');
  });
});

test.describe('ordinary autofill still works', () => {
  for (const [id, expected] of TEXT_FIELDS) {
    test(`${id} is filled with the saved value`, async () => {
      await expect(evidence.application.locator(`#${id}`)).toHaveValue(expected);
    });
  }
});

test.describe('the application is never submitted', () => {
  test('nothing clicked the submit control', async () => {
    expect(evidence.report.submissionPrevented).toBe(true);
    await expect(evidence.application.locator('body')).not.toHaveAttribute(
      'data-submitted',
      'true',
    );
  });
});
