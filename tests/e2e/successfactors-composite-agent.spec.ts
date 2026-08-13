import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Shipped-bundle regression for the live SuccessFactors failure shape.
 *
 * Nothing imports extension/src. Chromium loads extension/dist, the popup's
 * production button starts Agent Mode, and assertions read the resulting page
 * plus the exported production Agent Run Trace.
 */
const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const APPLICATION_URL = 'http://127.0.0.1:4173/lab/successfactors-composite-controls.html';
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const RESUME_BYTES = Buffer.from('%PDF-1.4\n% fixture resume\n%%EOF');

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

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

interface TraceStep {
  tool?: string;
  targetLabel: string;
  verification: string;
  optionsSeen: number;
  action?: {
    targetControlType?: string;
    controlType?: string;
    toolRequested?: string;
    controlClassificationTrace?: { event?: string; finalAgentControlType?: string };
  };
  date?: { controlType?: string };
}

interface AgentTrace {
  status: string;
  buildId: string;
  steps: TraceStep[];
}

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-sf-composite-'));
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
          developerMode: true,
          settingsVersion: 1,
          settingsUpdatedAt: new Date().toISOString(),
        },
      }),
    { serverUrl: AGENT_URL, authToken: TOKEN },
  );

  const stored = await message<{
    result: { ok: true; bundleId: string } | { ok: false; reason: string };
  }>(setup, {
    type: 'SAVE_APPLICATION_BUNDLE',
    bundle: {
      bundleVersion: 3,
      websiteJobId: 'successfactors-composite-agent',
      company: 'Lincoln Electric',
      jobTitle: 'Engineering Intern',
      jobDescription: 'SuccessFactors composite-control acceptance fixture.',
      officialApplicationUrl: APPLICATION_URL,
      documents: [
        {
          kind: 'resume',
          filename: 'Robin-Vale-Resume.pdf',
          mimeType: 'application/pdf',
          contentBase64: RESUME_BYTES.toString('base64'),
          byteLength: RESUME_BYTES.byteLength,
          generatedAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      profile: {
        updatedAt: '2026-08-13T00:00:00.000Z',
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
            degree: 'BS',
            major: 'Electrical Engineering',
            graduationDate: '2027-05',
            status: 'in_progress',
          },
        ],
        currentDegreeInProgress: 'BS',
        experience: [
          {
            id: 'experience-1',
            employer: 'Northwind Robotics',
            title: 'Engineering Intern',
            startDate: '2026-06',
            current: true,
            responsibilities: [],
            achievements: [],
          },
        ],
      },
      approvedAnswers: [],
      accountPreferences: { wantsAccountCreationHelp: false },
      createdAt: '2026-08-13T00:00:00.000Z',
    },
  });
  expect(stored.result.ok, stored.result.ok ? '' : stored.result.reason).toBe(true);
  await setup.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

test('routes composite choices through open, observed options, select, and verify', async () => {
  const application = await context.newPage();
  await application.goto(APPLICATION_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Autofill Application' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();

  const evidencePage = await extensionPage();
  let trace: AgentTrace | undefined;
  const deadline = Date.now() + 60_000;
  while (!trace && Date.now() < deadline) {
    const exported = await message<{ trace?: AgentTrace }>(evidencePage, {
      type: 'EXPORT_AGENT_TRACE',
    });
    trace = exported.trace;
    if (!trace) await evidencePage.waitForTimeout(250);
  }
  expect(trace, 'the production Agent Run Trace was not exported').toBeTruthy();

  for (const label of ['State/Province', 'Education Type', 'Area of Study']) {
    const steps = trace!.steps.filter((step) => step.targetLabel.includes(label));
    expect(
      steps.some((step) => step.tool === 'type'),
      `${label} reached type()`,
    ).toBe(false);
    expect(steps.some((step) => step.tool === 'open_dropdown')).toBe(true);
    expect(steps.some((step) => step.optionsSeen > 0)).toBe(true);
    expect(
      steps.some((step) => step.tool === 'select_option' && step.verification === 'VERIFIED'),
    ).toBe(true);
    expect(
      steps.some(
        (step) =>
          step.action?.controlClassificationTrace?.event === 'CONTROL_CLASSIFICATION_TRACE' &&
          step.action.controlClassificationTrace.finalAgentControlType !== 'TEXT_INPUT',
      ),
    ).toBe(true);
    expect(
      steps.every(
        (step) =>
          step.action?.targetControlType !== 'TEXT_INPUT' &&
          step.action?.controlType !== 'TEXT_INPUT',
      ),
    ).toBe(true);
  }

  for (const [selector, expected] of [
    ['#state-display', 'New Jersey'],
    ['#education-type-display', 'BS'],
    ['#area-display', 'Electrical Engineering'],
  ] as const) {
    await expect(application.locator(selector)).toHaveValue(expected);
  }

  const fromDate = trace!.steps.find((step) => step.targetLabel === 'From Date');
  expect(fromDate?.date?.controlType).toBe('DATE_INPUT');
  const address = trace!.steps.find(
    (step) => step.targetLabel === 'Address' && step.tool === 'type',
  );
  expect(address?.action?.targetControlType).toBe('TEXT_INPUT');

  await evidencePage.close();
  await popup.close();
  await application.close();
});
