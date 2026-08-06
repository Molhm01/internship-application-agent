import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The diagnostic fixture, driven through the real popup → worker → content
 * script path.
 *
 * Nothing here imports from `extension/src`. The only input is a click on the
 * popup's own button in a Chrome that loaded `extension/dist`, and the only
 * evidence is the employer page's DOM, the marks the content script drew on it,
 * and the run's own report and trace. A jsdom suite proves the source is
 * correct; it cannot prove the browser is running it.
 *
 * The page is built so each final status is reached by one named control, so
 * these assertions are about *which* field ended where — not how many did.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/diagnostic-trace.html`;
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RUN_BUDGET_MS = 30_000;

/** Where the mark's meaning is written on the element itself. */
const MARK = 'data-internship-agent-review';

/** A bundle must carry a document; this page has nowhere to put one. */
const RESUME_BYTES = Buffer.from('%PDF-1.4\n% resume\n%%EOF');

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/**
 * The applicant Internship Pilot synchronises with the bundle.
 *
 * Written out here rather than imported from the jsdom fixtures on purpose:
 * this file may not depend on the source tree it is meant to be independent of.
 * The city matches the value the fixture's City box already holds, which is what
 * makes that field the already-valid case.
 */
const PROFILE = {
  updatedAt: '2026-08-06T00:00:00.000Z',
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-diagnostic-'));
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
          aiGenerationEnabled: true,
          settingsVersion: 1,
          settingsUpdatedAt: new Date().toISOString(),
        },
      }),
    { serverUrl: AGENT_URL, authToken: TOKEN },
  );
  const stored = await message<{ result: { ok: boolean; reason?: string } }>(setup, {
    type: 'SAVE_APPLICATION_BUNDLE',
    bundle: {
      bundleVersion: 2,
      websiteJobId: 'job-halden-1',
      company: 'Halden Instruments',
      jobTitle: 'Applications Engineering Intern',
      jobDescription: 'Support customers deploying measurement systems.',
      officialApplicationUrl: APPLICATION_URL,
      // A bundle must carry at least one document. This page has no upload
      // control, so it is never attached — it is here to make the handoff
      // valid, not to be used.
      documents: [
        {
          kind: 'resume',
          filename: 'Molhm-Ellis-Halden-Resume.pdf',
          mimeType: 'application/pdf',
          contentBase64: RESUME_BYTES.toString('base64'),
          byteLength: RESUME_BYTES.byteLength,
          generatedAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      profile: PROFILE,
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  });
  // Asserted rather than assumed: a bundle rejected here leaves the run with no
  // profile at all, and every field then reports "Information needed" for a
  // reason that has nothing to do with the pipeline under test.
  expect(stored.result.ok, `the bundle was rejected: ${stored.result.reason ?? ''}`).toBe(true);
  // Accepting a bundle arms one automatic start. This suite is about the click,
  // so the arming is spent here.
  await setup.evaluate(() => chrome.storage.local.remove('autoStartArmed'));
  await setup.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

interface Evidence {
  application: Page;
  report: {
    status: string;
    fieldsFound: number;
    fieldsVerified: number;
    failedFields: number;
    optionalLeftBlank: number;
    userInputRequired: number;
    blockedFields: number;
    submissionPrevented: boolean;
    finalStatusCounts: Record<string, number>;
    fieldOutcomes: Array<{
      fieldId: string;
      label: string;
      status: string;
      annotation: string;
      required: boolean;
      reason: string;
    }>;
  };
  trace: {
    buildId: string;
    pendingAtCompletion: number;
    finalStatusCounts: Record<string, number>;
    fields: Array<{
      fieldId: string;
      label: string;
      section?: string;
      intent?: string;
      controlType: string;
      required: boolean;
      profileValueAvailable: boolean;
      plannedAction?: string;
      executorAttempted: boolean;
      verification: string;
      finalStatus: string;
      annotation: string;
      errorCode?: string;
      durationMs?: number;
    }>;
  };
  exported: { summary: string[]; buildId: string; trace: { fields: unknown[] } };
}

let evidence: Evidence;

test.beforeAll(async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();

  // The employer's page changing is what proves the content script ran.
  await expect(application.locator('#firstName')).toHaveValue('Molhm', { timeout: 10_000 });
  await expect(popup.locator('.autofill__summary')).toBeVisible({ timeout: RUN_BUDGET_MS });

  const evidencePage = await extensionPage();
  const { report } = await message<{ report: Evidence['report'] }>(evidencePage, {
    type: 'GET_AUTOFILL_REPORT',
  });
  const { traces } = await message<{ traces: Evidence['trace'][] }>(evidencePage, {
    type: 'GET_RUN_TRACES',
  });
  const exportResult = await message<
    { export: Evidence['exported'] } | { error: { message: string } }
  >(evidencePage, { type: 'EXPORT_AUTOFILL_RUN_TRACE' });
  await evidencePage.close();

  expect(report, 'the run produced no report').toBeTruthy();
  expect(traces.length, 'the run produced no trace').toBeGreaterThan(0);
  expect('export' in exportResult, 'the run trace could not be exported').toBe(true);

  evidence = {
    application,
    report,
    trace: traces[0]!,
    exported: (exportResult as { export: Evidence['exported'] }).export,
  };
});

function outcome(label: string): Evidence['report']['fieldOutcomes'][number] {
  const found = evidence.report.fieldOutcomes.find((entry) => entry.label === label);
  expect(found, `no final status was recorded for "${label}"`).toBeTruthy();
  return found!;
}

/** The mark the content script actually left on the element. */
function markOn(id: string): Promise<string | null> {
  return evidence.application
    .locator(`#${id}`)
    .evaluate((element, attribute) => element.getAttribute(attribute), MARK);
}

test.describe('GATE 1 — every field receives one final status', () => {
  test('one record per question, one status per record', () => {
    const allowed = [
      'FILLED_VERIFIED',
      'OPTIONAL_LEFT_BLANK',
      'USER_CONFIRMATION_REQUIRED',
      'FAILED_EXECUTION',
      'BLOCKED',
      'SKIPPED_ALREADY_VALID',
    ];
    expect(evidence.report.fieldOutcomes.length).toBeGreaterThan(0);
    for (const entry of evidence.report.fieldOutcomes) {
      expect(allowed, `${entry.label} had status ${entry.status}`).toContain(entry.status);
    }
    expect(new Set(evidence.report.fieldOutcomes.map((entry) => entry.fieldId)).size).toBe(
      evidence.report.fieldOutcomes.length,
    );
    expect(evidence.trace.fields.length).toBe(evidence.report.fieldOutcomes.length);
  });
});

test.describe('GATE 2 — no pending state remains after completion', () => {
  test('the trace records nothing still pending', () => {
    expect(evidence.trace.pendingAtCompletion).toBe(0);
    for (const entry of evidence.report.fieldOutcomes) {
      expect(entry.reason).not.toMatch(/waiting on/i);
    }
  });
});

test.describe('GATE 3 — a verified field loses its Information needed mark', () => {
  test('the three filled text fields hold their values and are marked verified', async () => {
    expect(await evidence.application.locator('#firstName').inputValue()).toBe('Molhm');
    expect(await evidence.application.locator('#lastName').inputValue()).toBe('Ellis');
    expect(await evidence.application.locator('#email').inputValue()).toBe('molhm@example.com');
    for (const [label, id] of [
      ['First name', 'firstName'],
      ['Last name', 'lastName'],
      ['Email address', 'email'],
    ] as const) {
      expect(outcome(label).status).toBe('FILLED_VERIFIED');
      expect(outcome(label).annotation).toBe('verified');
      // Read off the employer's own DOM: this is the mark a person sees.
      expect(await markOn(id), `${label} kept a stale mark`).toBe('verified');
    }
  });

  test('no verified field carries an Information needed badge on the page', async () => {
    const badges = await evidence.application.evaluate(() => {
      const host = document.getElementById('internship-agent-review-layer');
      return Array.from(host?.shadowRoot?.querySelectorAll('.badge') ?? []).map(
        (node) => node.textContent ?? '',
      );
    });
    const verified = evidence.report.fieldOutcomes.filter(
      (entry) => entry.annotation === 'verified',
    );
    expect(verified.length).toBeGreaterThan(0);
    // One badge per field that needs a person, and no more.
    const needing = evidence.report.fieldOutcomes.filter(
      (entry) => entry.annotation !== 'verified' && entry.annotation !== 'optional_blank',
    );
    expect(badges.filter((text) => /information needed/i.test(text)).length).toBeLessThanOrEqual(
      needing.length,
    );
  });
});

test.describe('GATE 4 — an optional blank field is not an error', () => {
  test('middle name is left empty, grey, and out of the outstanding count', async () => {
    expect(await evidence.application.locator('#middleName').inputValue()).toBe('');
    expect(outcome('Middle name').status).toBe('OPTIONAL_LEFT_BLANK');
    expect(outcome('Middle name').annotation).toBe('optional_blank');
    expect(await markOn('middleName')).toBe('optional_blank');
  });

  test('the already-correct field is left alone and reported as such', async () => {
    expect(await evidence.application.locator('#city').inputValue()).toBe('Clifton');
    expect(outcome('City').status).toBe('SKIPPED_ALREADY_VALID');
    expect(outcome('City').annotation).toBe('verified');
  });
});

test.describe('GATE 5 — the counters equal the field results exactly', () => {
  test('every counter is a tally of the same list', () => {
    const counted = (status: string): number =>
      evidence.report.fieldOutcomes.filter((entry) => entry.status === status).length;
    expect(evidence.report.fieldsFound).toBe(evidence.report.fieldOutcomes.length);
    expect(evidence.report.fieldsVerified).toBe(
      counted('FILLED_VERIFIED') + counted('SKIPPED_ALREADY_VALID'),
    );
    expect(evidence.report.failedFields).toBe(counted('FAILED_EXECUTION'));
    expect(evidence.report.optionalLeftBlank).toBe(counted('OPTIONAL_LEFT_BLANK'));
    expect(evidence.report.userInputRequired).toBe(counted('USER_CONFIRMATION_REQUIRED'));
    expect(evidence.report.blockedFields).toBe(counted('BLOCKED'));
    expect(
      Object.values(evidence.report.finalStatusCounts).reduce((sum, count) => sum + count, 0),
    ).toBe(evidence.report.fieldsFound);
    expect(evidence.trace.finalStatusCounts).toEqual(evidence.report.finalStatusCounts);
  });
});

test.describe('GATE 6 — the built extension carried the run', () => {
  test('the trace names the build the worker is running', () => {
    expect(evidence.trace.buildId).toMatch(/^[0-9a-f]{7,40}(\+dirty)?\.s\d+\.\d{14}$/);
    expect(evidence.exported.buildId).toBe(evidence.trace.buildId);
  });

  test('records a full diagnostic for every field, with no value anywhere', () => {
    for (const field of evidence.trace.fields) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.controlType.length).toBeGreaterThan(0);
      expect(typeof field.required).toBe('boolean');
      expect(typeof field.profileValueAvailable).toBe('boolean');
      expect(typeof field.executorAttempted).toBe('boolean');
      expect(field.finalStatus.length).toBeGreaterThan(0);
    }
    const serialized = JSON.stringify(evidence.trace);
    for (const secret of ['Molhm', 'Ellis', 'molhm@example.com', '48 Maple Avenue', 'Clifton']) {
      expect(serialized, `the trace leaked ${secret}`).not.toContain(secret);
    }
  });

  test('Export Autofill Run Trace produces a diagnosable document', () => {
    expect(evidence.exported.summary.length).toBeGreaterThan(0);
    expect(evidence.exported.trace.fields.length).toBe(evidence.report.fieldOutcomes.length);
  });
});

test.describe('GATE 7 — the final Submit is never clicked', () => {
  test('the page records no submission and the button is still there', async () => {
    expect(evidence.report.submissionPrevented).toBe(true);
    expect(
      await evidence.application.evaluate(
        () =>
          (window as unknown as { fixtureState: { submitted: boolean } }).fixtureState.submitted,
      ),
    ).toBe(false);
    await expect(evidence.application.locator('#submitApplication')).toBeVisible();
  });
});

test.describe('the failure cases the fixture exists for', () => {
  test('the refused dropdown is a failed execution, not a missing answer', async () => {
    expect(await evidence.application.locator('#country').inputValue()).toBe('');
    // The page really did refuse a write, rather than never receiving one.
    expect(
      await evidence.application.evaluate(
        () =>
          (window as unknown as { fixtureState: { countryWrites: number } }).fixtureState
            .countryWrites,
      ),
    ).toBeGreaterThan(0);
    expect(outcome('Country').status).toBe('FAILED_EXECUTION');
    expect(outcome('Country').annotation).toBe('execution_failed');
    expect(await markOn('country')).toBe('execution_failed');
  });

  test('the unanswerable required field is handed back in orange', async () => {
    expect(await evidence.application.locator('#referralName').inputValue()).toBe('');
    const referral = outcome('Name of the employee who referred you');
    expect(referral.status).toBe('USER_CONFIRMATION_REQUIRED');
    expect(referral.annotation).toBe('information_needed');
    expect(referral.required).toBe(true);
    expect(await markOn('referralName')).toBe('information_needed');
  });
});
