import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Dependent fields, proved against the built extension.
 *
 * One click on the popup's own "Autofill Application" button, and every
 * assertion below is either the employer page's DOM afterwards or the run's own
 * trace. Nothing imports `extension/src`, so a helper that works in jsdom while
 * the shipped bundle does not cannot make this pass — which matters here more
 * than usual, because the two engines this one builds on were both green in the
 * unit suite while being unreachable from the button.
 *
 * The fixture rebuilds every dependent list *asynchronously*. A run that reads
 * a list synchronously after answering its parent reads the list the page has
 * not replaced yet, matches nothing, and reports the profile as wrong.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/lab/dependency-master.html`;
const EVIDENCE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'local-data',
  'dependency-run-evidence.json',
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
 * tree it exists to test. Two schools in different states, so each education
 * block's chain has to reach a *different* answer — a run that leaks block 0's
 * country into block 1 produces the same state twice and fails visibly.
 *
 * There is deliberately no saved answer about relatives. That question must end
 * with the applicant, and the box below it must stay empty.
 */
const PROFILE = {
  updatedAt: '2026-08-10T00:00:00.000Z',
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
      degreeLevel: "Bachelor's Degree",
      major: 'Electrical Engineering',
      graduationDate: '2027-05',
      status: 'in_progress',
    },
    {
      id: 'education-2',
      institution: 'Princeton University',
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
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ],
  eligibility: {
    workAuthorization: 'U.S. Citizen',
    willingToRelocate: true,
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

interface DependencyEdge {
  parent: { nodeId: string; intent: string; label: string; recordIndex?: number };
  dependent: { nodeId: string; intent: string; label: string; recordIndex?: number };
  dependencyType: string;
  parentResolved: boolean;
  parentVerified: boolean;
  initialDependentFingerprint?: { optionCount: number; usableOptionCount: number };
  mutationObserved: boolean;
  dependentRescanned: boolean;
  newFingerprint?: { optionCount: number; usableOptionCount: number };
  dependentExecuted: boolean;
  dependentVerified: boolean;
  finalStatus: string;
  errorCode?: string;
  durationMs: number;
}

interface RunTrace {
  buildId: string;
  dependencies: DependencyEdge[];
  fields: Array<{ label: string; finalStatus: string; annotation: string }>;
}

interface PageState {
  country: string;
  state: string;
  eduCountries: string[];
  eduStates: string[];
  eduSchools: string[];
  eduAreas: string[];
  otherSchools: string[];
  otherAreas: string[];
  relativeDetails: string;
  hasRelatives: string;
  submitClicked: boolean;
}

/** What the employer's page actually holds. Read from the DOM, never inferred. */
async function readPage(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const read = (node: HTMLElement | null): string => {
      if (!node) return '';
      if (node instanceof HTMLSelectElement) {
        const selected = node.selectedOptions[0];
        return selected && selected.value !== '' ? (selected.textContent ?? '').trim() : '';
      }
      if (node instanceof HTMLInputElement) return node.value.trim();
      return (node.textContent ?? '').trim();
    };
    const all = (selector: string): string[] =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(read);

    return {
      country: read(document.getElementById('country')),
      state: read(document.getElementById('state')),
      eduCountries: all('[id^="edu-country-"]'),
      eduStates: all('[id^="edu-state-"]'),
      eduSchools: all('[id^="edu-school-"]'),
      eduAreas: all('[id^="edu-area-"]'),
      otherSchools: all('[id^="edu-other-school-"]'),
      otherAreas: all('[id^="edu-other-area-"]'),
      relativeDetails: read(document.getElementById('relativeDetails')),
      hasRelatives: read(document.getElementById('hasRelatives')),
      submitClicked:
        (window as unknown as { __submitClicked__?: boolean }).__submitClicked__ === true,
    };
  });
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-dependencies-'));
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
      websiteJobId: 'job-dependencies-1',
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
          generatedAt: '2026-08-10T00:00:00.000Z',
        },
      ],
      profile: PROFILE,
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-10T00:00:00.000Z',
    },
  });
  expect(
    stored.result.ok,
    `the bundle was rejected: ${stored.result.ok ? '' : stored.result.reason}`,
  ).toBe(true);

  // Disarm "Apply with Agent" auto-start, and prove it is disarmed. Storing a
  // bundle arms one origin without the store call waiting on it, so a single
  // remove can land before the arm does — and the page would then fill itself
  // before the click this test is about.
  await expect
    .poll(
      async () => {
        await setup.evaluate(() => chrome.storage.local.remove('autoStartArmed'));
        return setup.evaluate(() =>
          chrome.storage.local.get('autoStartArmed').then((held) => 'autoStartArmed' in held),
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
let trace: RunTrace;
let after: PageState;

function edgeTo(intent: string, recordIndex?: number): DependencyEdge | undefined {
  return trace.dependencies.find(
    (edge) =>
      edge.dependent.intent === intent &&
      (recordIndex === undefined || edge.dependent.recordIndex === recordIndex),
  );
}

test.beforeAll(async () => {
  application = await context.newPage();
  await application.goto(APPLICATION_URL);
  await application.evaluate(() => {
    document.getElementById('submit')?.addEventListener('click', () => {
      (window as unknown as { __submitClicked__?: boolean }).__submitClicked__ = true;
    });
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
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
  trace = traces[0]!;
  after = await readPage(application);

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        applicationUrl: APPLICATION_URL,
        buildId: trace.buildId,
        dependencies: trace.dependencies,
        page: after,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

test.describe('the applicant’s own Country → State', () => {
  test('answers Country', () => {
    expect(after.country).toBe('United States');
  });

  /**
   * The edge is driven parent-first and reaches a resolved state.
   *
   * `mutationObserved` is deliberately not asserted here, and the reason is the
   * same one the comment on the next test already gives, only stronger. The
   * Dropdown Engine now runs before this stage and starts from the page rather
   * than from the plan, so by the time this engine fingerprints State the
   * applicant's Country has been answered and the region list has already been
   * rebuilt — its "before" is honestly post-parent, and there is no mutation
   * left for it to watch. The ordering is still proved, in two places: State
   * ends holding a region that did not exist before Country landed, and the
   * School link below, where this engine itself is what settles the parent,
   * still observes the rebuild it caused.
   */
  test('waits for Country and resolves State', () => {
    const edge = edgeTo('state', undefined);
    expect(edge, 'no Country → State edge reached the trace').toBeTruthy();
    expect(edge!.parentVerified).toBe(true);
    expect(edge!.finalStatus).toBe('RESOLVED');
  });

  /**
   * Asserted on the School link rather than on State, and deliberately.
   *
   * By the time the dependency stage first runs, the deterministic pass in the
   * same iteration has already answered the applicant's own Country, so State's
   * list has been rebuilt before this engine ever fingerprints it — its "before"
   * is honestly post-parent. School is the link where the engine itself is what
   * settles the parent, so its before/after is the real evidence: a list holding
   * no choices at all, then the list the page built once State landed.
   */
  test('never matches against the pre-parent option set', () => {
    const edge = edgeTo('school', undefined);
    expect(edge, 'no State → School edge reached the trace').toBeTruthy();
    expect(edge!.initialDependentFingerprint?.usableOptionCount).toBe(0);
    expect(edge!.newFingerprint!.usableOptionCount).toBeGreaterThan(0);
    expect(edge!.mutationObserved).toBe(true);
    expect(edge!.dependentRescanned).toBe(true);
    expect(edge!.finalStatus).toBe('RESOLVED');
  });

  test('selects and verifies New Jersey', () => {
    expect(edgeTo('state', undefined)!.finalStatus).toBe('RESOLVED');
    expect(after.state).toBe('New Jersey');
  });
});

test.describe('the education chain, per block', () => {
  test('answers Education Country in every block', () => {
    expect(after.eduCountries.filter((value) => value === 'United States').length).toBeGreaterThan(
      0,
    );
  });

  test('answers Education State after its own Country, per block', () => {
    expect(after.eduStates.every((value) => value !== '')).toBe(true);
  });

  test('answers School after its own State, per block', () => {
    expect(after.eduSchools[0]).toBe('Rutgers University');
  });

  test('keeps each block’s chain inside that block', () => {
    for (const edge of trace.dependencies) {
      if (edge.parent.recordIndex === undefined && edge.dependent.recordIndex === undefined) {
        continue;
      }
      expect(
        edge.parent.recordIndex ?? 0,
        `${edge.parent.intent} → ${edge.dependent.intent} crossed a block`,
      ).toBe(edge.dependent.recordIndex ?? 0);
    }
  });

  test('leaves "If other" blank while School holds a real school', () => {
    expect(after.otherSchools.every((value) => value === '')).toBe(true);
  });

  test('leaves "If other, enter Area of Study" blank for a real subject', () => {
    expect(after.otherAreas.every((value) => value === '')).toBe(true);
  });
});

test.describe('conditional questions', () => {
  /**
   * The regression this whole engine exists to make impossible.
   *
   * The live run typed the applicant's own name into "If yes, provide their
   * full name, location, and relationship" because that label contains the word
   * "name", while the relatives question above it had never been answered — so
   * the form stated to the employer that the applicant had a relative there.
   */
  test('never puts the applicant’s name in the relatives box', () => {
    expect(after.relativeDetails).toBe('');
    expect(after.relativeDetails).not.toContain('Robin');
    expect(after.relativeDetails).not.toContain('Vale');
  });

  test('leaves the relatives box untouched while its own question is unanswered', () => {
    expect(after.hasRelatives).toBe('');
    const edge = trace.dependencies.find(
      (candidate) => candidate.dependencyType === 'CONDITIONAL_REQUIRED',
    );
    if (edge) {
      expect(['WAITING_FOR_DEPENDENCY', 'NOT_APPLICABLE']).toContain(edge.finalStatus);
      expect(edge.dependentExecuted).toBe(false);
    }
  });
});

test.describe('the run as a whole', () => {
  test('produced a dependency graph', () => {
    expect(trace.dependencies.length).toBeGreaterThan(0);
  });

  test('left no field holding a temporary dependency stage', () => {
    // `WAITING_FOR_DEPENDENCY` is a stage, never a verdict. A run that ended
    // holding one has claimed a field is still being worked on after stopping.
    expect(trace.fields.filter((field) => field.finalStatus === 'WAITING_FOR_DEPENDENCY')).toEqual(
      [],
    );
  });

  test('marks no verified dependent field as failed or needing information', () => {
    for (const edge of trace.dependencies) {
      if (edge.finalStatus !== 'RESOLVED') continue;
      const field = trace.fields.find((candidate) => candidate.label === edge.dependent.label);
      if (!field) continue;
      expect(
        field.annotation,
        `${edge.dependent.label} verified but is marked ${field.annotation}`,
      ).not.toBe('execution_failed');
    }
  });

  test('never clicks the final submit control', () => {
    expect(after.submitClicked).toBe(false);
  });
});
