import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-agent-token': TOKEN,
      ...init.headers,
    },
  });
  const body = (await response.json()) as { ok: boolean; data?: unknown; error?: unknown };
  if (!response.ok || !body.ok)
    throw new Error(`Agent API ${path} failed: ${JSON.stringify(body)}`);
  return body.data;
}

async function seedAgent(): Promise<void> {
  const listed = (await api('/answers')) as { answers: Array<{ id: string }> };
  for (const answer of listed.answers) {
    await api(`/answers/${encodeURIComponent(answer.id)}`, { method: 'DELETE', body: '{}' });
  }
  await api('/profile', {
    method: 'PUT',
    body: JSON.stringify({
      personal: {
        legalFirstName: 'Jordan',
        legalMiddleName: 'Avery',
        legalLastName: 'Rivera',
        preferredName: 'Jordy',
        email: 'jordan@example.com',
        phone: '+16175550142',
        address: { country: 'United States' },
        github: 'https://github.com/jordan',
        portfolio: 'https://portfolio.example.com',
      },
      education: [
        {
          id: 'edu-e2e',
          institution: 'Example University',
          degree: "Bachelor's",
          major: 'Computer Engineering',
          gpa: 3.8,
          graduationDate: '2028-05',
        },
      ],
      experience: [
        {
          id: 'exp-e2e',
          employer: 'Campus Robotics Lab',
          title: 'Student Developer',
          responsibilities: ['Built and tested TypeScript tools with a small engineering team.'],
          achievements: ['Improved the reliability of automated test workflows.'],
        },
      ],
      projects: [
        {
          id: 'project-e2e',
          name: 'Application Workflow Assistant',
          description: 'Built a local TypeScript application with validated data contracts.',
          technologies: ['TypeScript', 'React', 'Playwright'],
          accomplishments: ['Added automated tests for controlled browser form inputs.'],
        },
      ],
      skills: {
        technical: ['Automated testing', 'Data validation'],
        programmingLanguages: ['TypeScript', 'Python'],
      },
      eligibility: {
        willingToRelocate: true,
        hasDriversLicense: true,
        earliestStartDate: '2028-06-01',
      },
      sensitivePolicies: [{ category: 'gender', policy: 'review_required' }],
    }),
  });
  await api('/answers', {
    method: 'POST',
    body: JSON.stringify({
      canonicalQuestion: 'Are you legally authorized to work in the United States?',
      aliases: ['Are you legally authorized to work in the United States?'],
      answerType: 'boolean',
      answer: true,
      category: 'eligibility',
      approved: true,
      autoFillAllowed: true,
      sensitive: false,
      tailoringAllowed: false,
      requiresReview: false,
    }),
  });
  await api('/answers', {
    method: 'POST',
    body: JSON.stringify({
      canonicalQuestion: 'Programming languages',
      aliases: ['Programming languages'],
      answerType: 'multi_select',
      answer: ['TypeScript', 'Python'],
      category: 'skills',
      approved: true,
      autoFillAllowed: true,
      sensitive: false,
      tailoringAllowed: false,
      requiresReview: false,
    }),
  });
}

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
  await seedAgent();
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-fill-e2e-'));
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
  const page = await extensionPage();
  await page.evaluate(
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
  await page.close();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

test('scan builds, reviews, fills, verifies, and reports deterministic approved actions', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/autofill-controls.html`);
  const extension = await extensionPage();

  const scanResponse = await message<{
    type: string;
    result: { id: string; fields: Array<{ id: string; question: string }> };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scanResponse.type).toBe('SCAN_COMPLETE');

  const built = await message<{
    plan: {
      id: string;
      scanId: string;
      actions: Array<{
        id: string;
        question: string;
        action: string;
        approved: boolean;
        sensitive: boolean;
      }>;
    };
  }>(extension, { type: 'BUILD_DETERMINISTIC_PLAN', scanId: scanResponse.result.id });
  expect(built.plan.scanId).toBe(scanResponse.result.id);
  expect(built.plan.actions.every((action) => !action.approved)).toBe(true);
  expect(built.plan.actions.find((action) => action.question === 'Gender')?.sensitive).toBe(true);
  expect(built.plan.actions.find((action) => action.question.includes('I certify'))?.action).toBe(
    'manual_review',
  );
  expect(built.plan.actions.find((action) => action.question === 'Resume')?.action).toBe(
    'unsupported',
  );

  await extension.reload();
  await expect(extension.getByRole('heading', { name: 'Fill Plan Review' })).toBeVisible();
  await extension.getByRole('button', { name: 'Approve All Safe' }).click();
  const rejectedCard = extension
    .locator('article')
    .filter({ has: extension.getByRole('heading', { name: 'Last Name' }) });
  await expect(rejectedCard.getByLabel('Approved')).toBeChecked();
  await rejectedCard.getByLabel('Approved').uncheck();
  await extension.getByRole('button', { name: /Fill Approved Fields \(\d+\)/ }).click();
  await expect(extension.getByRole('heading', { name: 'Fill Run Report' })).toBeVisible();

  const stored = await message<{
    report: {
      status: string;
      approvedActions: number;
      verifiedActions: number;
      failedActions: number;
      reviewActions: number;
      skippedActions: number;
      unsupportedActions: number;
      results: Array<{ fieldId: string; status: string; error?: { code: string } }>;
      submitted: false;
    };
  }>(extension, { type: 'GET_FILL_PLAN' });
  const completed = { report: stored.report };
  expect(completed.report.status).toBe('completed_with_errors');
  expect(completed.report.approvedActions).toBeGreaterThan(5);
  expect(completed.report.verifiedActions).toBe(completed.report.approvedActions - 1);
  expect(completed.report.failedActions).toBe(1);
  expect(completed.report.reviewActions).toBe(
    completed.report.results.filter((result) => result.status === 'needs_review').length,
  );
  expect(completed.report.skippedActions).toBe(
    completed.report.results.filter((result) => result.status === 'skipped').length,
  );
  expect(completed.report.unsupportedActions).toBe(
    completed.report.results.filter((result) => result.status === 'unsupported').length,
  );
  expect(
    completed.report.results.some((result) => result.error?.code === 'VALUE_NOT_VERIFIED'),
  ).toBe(true);
  expect(completed.report.submitted).toBe(false);

  await expect(application.locator('#firstName')).toHaveValue('Jordan');
  await expect(application.locator('#lastName')).toHaveValue('');
  await expect(application.locator('#middleName')).toHaveValue('Avery');
  await expect(application.locator('#preferredName')).toHaveValue('Jordy');
  await expect(application.locator('#preferredName')).toHaveAttribute('data-rerendered', 'true');
  await expect(application.locator('#email')).toHaveValue('jordan@example.com');
  await expect(application.locator('#phone')).toHaveValue('(617) 555-0142');
  await expect(application.locator('#github')).toHaveValue('https://github.com/jordan');
  await expect(application.locator('#gpa')).toHaveValue('3.8');
  await expect(application.locator('#country')).toHaveValue('US');
  await expect(application.locator('#authorized')).toHaveValue('yes');
  await expect(application.locator('input[name="relocate"][value="yes"]')).toBeChecked();
  await expect(application.locator('#driversLicense')).toBeChecked();
  await expect(application.locator('#startDate')).toHaveValue('2028-06-01');
  await expect(application.locator('input[name="languages"][value="typescript"]')).toBeChecked();
  await expect(application.locator('input[name="languages"][value="python"]')).toBeChecked();
  await expect(application.locator('input[name="languages"][value="rust"]')).not.toBeChecked();

  await expect(application.locator('#gender')).toHaveValue('');
  await expect(application.locator('#attestation')).not.toBeChecked();
  await expect(application.locator('#resume')).toHaveValue('');
  await expect(application.locator('#custom')).toHaveText('');
  await expect(application.locator('#ambiguous')).toHaveValue('');
  await expect(application.locator('#hiddenField')).toHaveValue('');
  await expect(application.locator('#disabledField')).toHaveValue('');
  expect(
    await application.evaluate(
      () =>
        (window as unknown as { fixtureState: { submitted: boolean; nextClicked: boolean } })
          .fixtureState,
    ),
  ).toMatchObject({ submitted: false, nextClicked: false });

  await expect(extension.getByText(/VALUE_NOT_VERIFIED/)).toBeVisible();
  await expect(extension.getByText('Review the application and continue manually.')).toBeVisible();

  await application.goto(`${FIXTURES}/autofill-controls.html?changed=1`);
  await application.bringToFront();
  const changed = await message<{ type: string; error: { code: string } }>(extension, {
    type: 'EXECUTE_APPROVED_ACTIONS',
  });
  expect(changed.type).toBe('FILL_FAILED');
  expect(changed.error.code).toBe('PAGE_CHANGED');

  await extension.close();
  await application.close();
});

for (const fixture of [
  { name: 'greenhouse.html', selector: '#first_name', expected: 'Jordan' },
  { name: 'lever.html', selector: 'input[name="email"]', expected: 'jordan@example.com' },
  { name: 'workday.html', selector: '#legalName', expected: 'Jordan' },
] as const) {
  test(`${fixture.name} uses its adapter executor and never submits`, async () => {
    const application = await context.newPage();
    await application.goto(`${FIXTURES}/${fixture.name}`);
    await application.evaluate(() => {
      (window as unknown as { submitted: boolean }).submitted = false;
      document.querySelector('form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        (window as unknown as { submitted: boolean }).submitted = true;
      });
    });
    const extension = await extensionPage();
    const scan = await message<{ type: string; result: { id: string } }>(extension, {
      type: 'SCAN_APPLICATION',
      targetUrl: application.url(),
    });
    expect(scan.type).toBe('SCAN_COMPLETE');
    await message(extension, { type: 'BUILD_DETERMINISTIC_PLAN', scanId: scan.result.id });
    await message(extension, { type: 'APPROVE_SAFE_ACTIONS' });
    const response = await message<{ type: string }>(extension, {
      type: 'EXECUTE_APPROVED_ACTIONS',
      targetUrl: application.url(),
    });
    expect(response.type).toBe('FILL_COMPLETE');
    await expect(application.locator(fixture.selector)).toHaveValue(fixture.expected);
    expect(
      await application.evaluate(() => (window as unknown as { submitted: boolean }).submitted),
    ).toBe(false);
    await extension.close();
    await application.close();
  });
}
