import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURE = 'http://127.0.0.1:4173/ai-custom-answers.html';
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
  if (!response.ok || !body.ok) throw new Error(`Agent API failed: ${JSON.stringify(body)}`);
  return body.data;
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
  await api('/profile', {
    method: 'PUT',
    body: JSON.stringify({
      personal: {
        legalFirstName: 'Jordan',
        legalLastName: 'Rivera',
        email: 'jordan@example.com',
      },
      education: [
        {
          id: 'edu-ai',
          institution: 'Example University',
          degree: 'BS',
          major: 'Computer Engineering',
          coursework: ['Software Testing'],
          activities: ['Robotics club team'],
        },
      ],
      experience: [
        {
          id: 'exp-ai',
          employer: 'Campus Robotics Lab',
          title: 'Student Developer',
          responsibilities: ['Collaborated with a team to build and test TypeScript tools.'],
          achievements: ['Improved automated workflow reliability.'],
        },
      ],
      projects: [
        {
          id: 'project-ai',
          name: 'Workflow Assistant',
          description: 'Built a local TypeScript application with validated data contracts.',
          technologies: ['TypeScript', 'React', 'Playwright'],
          accomplishments: ['Added automated tests for controlled browser inputs.'],
        },
      ],
      skills: {
        technical: ['Automated testing', 'Data validation'],
        programmingLanguages: ['TypeScript', 'Python'],
      },
      preferences: {
        targetRoles: ['Software Engineering Intern'],
        industries: ['Developer tools'],
      },
    }),
  });
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-ai-e2e-'));
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

test('grounded custom answers require review and only approved text is filled', async () => {
  const application = await context.newPage();
  await application.goto(FIXTURE);
  const extension = await extensionPage();
  const scan = await message<{
    type: string;
    result: {
      fields: Array<{
        id: string;
        question: string;
        maxLength?: number;
      }>;
    };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scan.type).toBe('SCAN_COMPLETE');
  expect(scan.result.fields.some((field) => field.question.includes('Why do you want'))).toBe(true);
  expect(
    scan.result.fields.find((field) => field.question.includes('Why do you want'))?.maxLength,
  ).toBe(500);

  await message(extension, { type: 'BUILD_DETERMINISTIC_PLAN' });
  await extension.reload();
  await expect(
    extension.getByText('Review all AI-generated answers before filling.'),
  ).toBeVisible();

  const whyRoleEligible = extension.locator('article.answer-card--eligible').filter({
    has: extension.getByRole('heading', {
      name: 'Why are you interested in this role? Answer in 100 words or fewer.',
      exact: true,
    }),
  });
  await expect(whyRoleEligible).toBeVisible();
  await whyRoleEligible.getByRole('button', { name: 'Generate Answer' }).click();

  const whyRole = extension.locator('article.answer-card').filter({
    has: extension.getByRole('heading', {
      name: 'Why are you interested in this role? Answer in 100 words or fewer.',
      exact: true,
    }),
  });
  await expect(whyRole.getByText('Review required')).toBeVisible();
  await expect(whyRole.getByText('ready_for_review')).toBeVisible();
  await expect(extension.getByText(/1 generated · 0 failed/)).toBeVisible();
  await expect(whyRole.getByText('mock-grounded:latest')).toBeVisible();
  await expect(whyRole.getByText(/\d+ ms/)).toBeVisible();
  await expect(whyRole.getByText(/Evidence used \([1-9]/)).toBeVisible();
  await expect(whyRole.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect(await application.locator('#whyRole').inputValue()).toBe('');

  const edited =
    'My TypeScript project and automated testing experience align directly with this role.';
  await whyRole.locator('textarea').first().fill(edited);
  await whyRole.getByRole('button', { name: 'Save manual edit' }).click();
  await expect(whyRole.getByText('user_override')).toBeVisible();
  await whyRole.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(whyRole.getByText('Approved', { exact: true })).toBeVisible();

  const controlledField = scan.result.fields.find((field) =>
    field.question.includes('strong candidate'),
  )!;
  const controlledResult = await message<{
    record: { id: string; state: string };
  }>(extension, {
    type: 'GENERATE_CUSTOM_ANSWER',
    fieldId: controlledField.id,
  });
  await message(extension, {
    type: 'UPDATE_GENERATED_ANSWER',
    generationId: controlledResult.record.id,
    operation: 'edit',
    answer:
      'My verified TypeScript project work and automated testing experience make me a strong candidate.',
  });
  await message(extension, {
    type: 'APPROVE_GENERATED_ANSWER',
    generationId: controlledResult.record.id,
  });

  const conflict = scan.result.fields.find((field) =>
    field.question.includes('resolved a conflict'),
  )!;
  const insufficient = await message<{
    record: {
      state: string;
      candidate: { missingInformation: string[] };
    };
  }>(extension, { type: 'GENERATE_CUSTOM_ANSWER', fieldId: conflict.id });
  expect(insufficient.record.state).toBe('needs_user_input');
  expect(insufficient.record.candidate.missingInformation.length).toBeGreaterThan(0);

  const injection = scan.result.fields.find((field) =>
    field.question.includes('Ignore previous instructions'),
  )!;
  const injectionResult = await message<{
    record: { warnings: string[]; approved: boolean };
  }>(extension, { type: 'GENERATE_CUSTOM_ANSWER', fieldId: injection.id });
  expect(injectionResult.record.warnings.join(' ')).toContain('Untrusted text');
  expect(injectionResult.record.approved).toBe(false);

  const demographic = scan.result.fields.find((field) =>
    field.question.includes('race and ethnicity'),
  )!;
  const prohibited = await message<{ error: { code: string } }>(extension, {
    type: 'GENERATE_CUSTOM_ANSWER',
    fieldId: demographic.id,
  });
  expect(prohibited.error.code).toBe('PROHIBITED_QUESTION');

  await extension.reload();
  const fillButton = extension.getByRole('button', { name: /Fill Approved Fields/ });
  await expect(fillButton).toContainText('(2)');
  await fillButton.click();
  await expect(extension.getByRole('heading', { name: 'Fill Run Report' })).toBeVisible();
  expect(await application.locator('#whyRole').inputValue()).toBe(edited);
  await expect(application.locator('#controlled')).toHaveValue(
    'My verified TypeScript project work and automated testing experience make me a strong candidate.',
  );
  expect(await application.locator('#controlled').getAttribute('data-rerendered')).toBe('true');
  expect(await application.locator('#injection').inputValue()).toBe('');
  expect(await application.locator('#demographic').inputValue()).toBe('');
  expect(await application.locator('#legal').inputValue()).toBe('');
  expect(
    await application.evaluate(() => ({
      submitted: (
        window as unknown as { fixtureState: { submitted: boolean; nextClicked: boolean } }
      ).fixtureState.submitted,
      nextClicked: (
        window as unknown as { fixtureState: { submitted: boolean; nextClicked: boolean } }
      ).fixtureState.nextClicked,
    })),
  ).toEqual({ submitted: false, nextClicked: false });
  await expect(
    extension.getByText(
      'AI-generated answers were inserted. Review every answer and continue manually.',
    ),
  ).toBeVisible();
});

test('approved achievement answer survives review reopen and executes from the active plan', async () => {
  const fixture = 'http://127.0.0.1:4173/ai-plan-integration.html';
  const question =
    'Tell me 2 or 3 personal engineering achievements that you are most proud of and why?';
  const application = await context.newPage();
  await application.goto(fixture);
  let extension = await extensionPage();

  const scan = await message<{
    type: string;
    result: {
      fields: Array<{
        id: string;
        pageId: string;
        question: string;
        fieldType: string;
        selector: string;
        required: boolean;
      }>;
    };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scan.type).toBe('SCAN_COMPLETE');
  const achievementField = scan.result.fields.find((field) => field.question === question);
  expect(achievementField).toMatchObject({ fieldType: 'textarea', required: true });
  expect(achievementField?.id).toBeTruthy();
  expect(achievementField?.pageId).toBeTruthy();
  expect(achievementField?.selector).toBeTruthy();

  const built = await message<{
    plan: { actions: Array<{ fieldId: string; action: string; approved: boolean }> };
  }>(extension, { type: 'BUILD_DETERMINISTIC_PLAN' });
  expect(
    built.plan.actions.filter((action) => action.action === 'fill_text').length,
  ).toBeGreaterThanOrEqual(3);

  const generated = await message<{
    record: {
      id: string;
      fieldId: string;
      state: string;
      approved: boolean;
      candidate: { answer: string };
      model: string;
      generationDurationMs: number;
      constraints: { requestedExamples: { minimum: number; maximum: number } };
    };
  }>(extension, {
    type: 'GENERATE_CUSTOM_ANSWER',
    fieldId: achievementField!.id,
  });
  expect(generated.record).toMatchObject({
    fieldId: achievementField!.id,
    state: 'ready_for_review',
    approved: false,
    model: 'mock-grounded:latest',
    constraints: { requestedExamples: { minimum: 2, maximum: 3 } },
  });
  expect(generated.record.candidate.answer.length).toBeGreaterThan(0);
  expect(generated.record.generationDurationMs).toBeGreaterThanOrEqual(0);

  const beforeApproval = await message<{
    plan: {
      actions: Array<{
        fieldId: string;
        action: string;
        approved: boolean;
        generationId?: string;
      }>;
    };
  }>(extension, { type: 'GET_FILL_PLAN' });
  expect(
    beforeApproval.plan.actions.find((action) => action.generationId === generated.record.id),
  ).toMatchObject({
    fieldId: achievementField!.id,
    action: 'fill_generated_text',
    approved: false,
  });

  await message(extension, { type: 'APPROVE_SAFE_ACTIONS' });
  await message(extension, {
    type: 'EXECUTE_APPROVED_ACTIONS',
    targetUrl: application.url(),
  });
  await expect(application.locator('#achievements')).toHaveValue('');
  await expect(application.locator('#heard')).toHaveValue('');
  await expect(application.locator('#availability')).toHaveValue('');

  await message(extension, {
    type: 'APPROVE_GENERATED_ANSWER',
    generationId: generated.record.id,
  });
  await extension.close();
  extension = await extensionPage();

  const reopened = await message<{
    plan: {
      actions: Array<{
        fieldId: string;
        action: string;
        approved: boolean;
        answerValidationPassed?: boolean;
        generationId?: string;
      }>;
    };
  }>(extension, { type: 'GET_FILL_PLAN' });
  expect(
    reopened.plan.actions.find((action) => action.generationId === generated.record.id),
  ).toMatchObject({
    fieldId: achievementField!.id,
    action: 'fill_generated_text',
    approved: true,
    answerValidationPassed: true,
  });

  const completed = await message<{
    type: string;
    report: {
      submitted: boolean;
      results: Array<{ actionId: string; fieldId: string; status: string }>;
    };
  }>(extension, {
    type: 'EXECUTE_APPROVED_ACTIONS',
    targetUrl: application.url(),
  });
  expect(completed.type).toBe('FILL_COMPLETE');
  await expect(application.locator('#firstName')).toHaveValue('Jordan');
  await expect(application.locator('#lastName')).toHaveValue('Rivera');
  await expect(application.locator('#email')).toHaveValue('jordan@example.com');
  await expect(application.locator('#achievements')).toHaveValue(generated.record.candidate.answer);
  expect(
    completed.report.results.find((result) => result.fieldId === achievementField!.id)?.status,
  ).toBe('verified');
  expect(completed.report.submitted).toBe(false);
  expect(
    await application.evaluate(
      () => (window as unknown as { fixtureState: { submitted: boolean } }).fixtureState.submitted,
    ),
  ).toBe(false);
});

test('enabling AI persists and an existing AI_DISABLED card retries with fresh settings', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURE}?settings-retry=1`);
  const extension = await extensionPage();
  await extension.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings')).settings as Record<string, unknown>;
    await chrome.storage.local.set({
      settings: {
        ...stored,
        aiGenerationEnabled: false,
        settingsVersion: Number(stored['settingsVersion'] ?? 1) + 1,
        settingsUpdatedAt: new Date().toISOString(),
      },
    });
  });

  const scan = await message<{
    result: { fields: Array<{ id: string; question: string }> };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  await message(extension, { type: 'BUILD_DETERMINISTIC_PLAN' });
  await extension.reload();

  const question = 'Why are you interested in this role? Answer in 100 words or fewer.';
  const field = scan.result.fields.find((candidate) => candidate.question === question);
  expect(field).toBeTruthy();
  const disabled = await message<{
    record?: { state: string; error?: { code: string } };
    error?: { code: string; message: string };
  }>(extension, {
    type: 'GENERATE_CUSTOM_ANSWER',
    fieldId: field!.id,
  });
  if (!disabled.record) {
    throw new Error(`Expected a failed generation record: ${JSON.stringify(disabled)}`);
  }
  expect(disabled.record).toMatchObject({
    state: 'failed',
    error: { code: 'AI_DISABLED' },
  });
  await extension.reload();

  const failed = extension.locator('article.answer-card').filter({
    has: extension.getByRole('heading', { name: question, exact: true }),
  });
  await expect(failed.getByText(/AI_DISABLED/)).toBeVisible();
  await expect(failed.getByText('Not generated')).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Retry Generation' })).toBeEnabled();

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('button', { name: 'AI answers' }).click();
  const checkbox = options.getByLabel('Enable grounded AI answer generation');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await options.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(options.getByText('AI generation settings saved.')).toBeVisible();
  await options.close();

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/options.html`);
  await reopened.getByRole('button', { name: 'AI answers' }).click();
  await expect(reopened.getByLabel('Enable grounded AI answer generation')).toBeChecked();
  await reopened.close();

  await failed.getByRole('button', { name: 'Retry Generation' }).click();
  await expect(failed.getByText(/AI_DISABLED/)).toHaveCount(0);
  await expect(failed.getByText('ready_for_review')).toBeVisible();
  await expect(failed.getByText('Passed')).toBeVisible();
  await expect(failed.getByText('mock-grounded:latest')).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect((await failed.locator('textarea').first().inputValue()).trim().length).toBeGreaterThan(0);
});

test('batch generation and cancellation always terminate', async () => {
  const application = await context.newPage();
  await application.goto(FIXTURE);
  const extension = await extensionPage();
  await message(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  await message(extension, { type: 'BUILD_DETERMINISTIC_PLAN' });
  await extension.reload();
  await extension.getByRole('button', { name: 'Generate all eligible answers' }).click();
  await expect(
    extension.getByText(/queued|ready for review|Generation ended/i).first(),
  ).toBeVisible();
  await expect(extension.getByRole('button', { name: 'Cancel generation' })).toHaveCount(0);
  await expect(extension.getByText(/\d+\/\d+ · /).first()).toBeVisible();
  const cancelled = await message<{ ok: boolean }>(extension, {
    type: 'CANCEL_ANSWER_GENERATION',
  });
  expect(cancelled.ok).toBe(true);
  await expect(extension.getByText(/Generating…/)).toHaveCount(0);
});
