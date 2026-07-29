import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end coverage for the Greenhouse application that exposed the
 * unresolved-field bug: text fields filled, while country, city, and every
 * demographic question came back "unsupported".
 *
 * Asserts the whole chain — scan, plan, option discovery, exact matching,
 * execution, verification — and that sensitive questions without an explicit
 * saved answer stay untouched.
 */

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
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN, ...init.headers },
  });
  const body = (await response.json()) as { ok: boolean; data?: unknown };
  if (!response.ok || !body.ok)
    throw new Error(`Agent API ${path} failed: ${JSON.stringify(body)}`);
  return body.data;
}

/** Exactly the profile described in the repair brief. */
async function seedProfile(): Promise<void> {
  const listed = (await api('/answers')) as { answers: Array<{ id: string }> };
  for (const answer of listed.answers) {
    await api(`/answers/${encodeURIComponent(answer.id)}`, { method: 'DELETE', body: '{}' });
  }

  await api('/profile', {
    method: 'PUT',
    body: JSON.stringify({
      personal: {
        legalFirstName: 'Jordan',
        legalLastName: 'Rivera',
        email: 'jordan@example.com',
        phone: '+16175550142',
        address: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
        linkedin: 'https://www.linkedin.com/in/jordan',
        portfolio: 'https://portfolio.example.com',
      },
      // Veteran status has an explicit approved answer; gender, Hispanic/Latino,
      // and disability deliberately do not.
      sensitivePolicies: [{ category: 'veteran_status', policy: 'review_required' }],
    }),
  });

  await api('/answers', {
    method: 'POST',
    body: JSON.stringify({
      canonicalQuestion: 'Veteran Status',
      aliases: ['veteran_status', 'Veteran Status'],
      answerType: 'single_select',
      answer: 'I am not a protected veteran',
      category: 'demographics',
      approved: true,
      autoFillAllowed: true,
      sensitive: true,
      tailoringAllowed: false,
      requiresReview: true,
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
  await seedProfile();
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-combobox-e2e-'));
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
          aiGenerationEnabled: false,
          settingsVersion: 1,
          settingsUpdatedAt: new Date().toISOString(),
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

interface PlanAction {
  id: string;
  fieldId: string;
  question: string;
  action: string;
  approved: boolean;
  sensitive: boolean;
  proposedValue?: string;
  matchedOption?: { label: string; value: string };
  requiresReview: boolean;
}

test('resolves and fills custom comboboxes without touching unanswered sensitive questions', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/greenhouse-comboboxes.html`);
  const extension = await extensionPage();

  // 1. Analyze the Greenhouse fixture.
  const scan = await message<{
    type: string;
    result: {
      id: string;
      ats: { id: string };
      fields: Array<{ question: string; fieldType: string }>;
    };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scan.type).toBe('SCAN_COMPLETE');
  expect(scan.result.ats.id).toBe('greenhouse');

  // 2. Build the fill plan.
  const built = await message<{ plan: { id: string; actions: PlanAction[] } }>(extension, {
    type: 'BUILD_DETERMINISTIC_PLAN',
    scanId: scan.result.id,
  });
  const byQuestion = (needle: string): PlanAction | undefined =>
    built.plan.actions.find((action) => action.question.toLowerCase().includes(needle));

  // 3. Country and city resolve from the profile, through the real option lists.
  const country = byQuestion('country');
  const city = byQuestion('location');
  expect(country?.action).toBe('select_suggested_option');
  expect(city?.action).toBe('select_suggested_option');

  // 4/5. A custom combobox renders its list only once opened, so at plan time the
  // proposal is the saved profile value; the executor reads the real options and
  // confirms the exact match at fill time (verified against the DOM below).
  expect(country?.proposedValue).toBe('United States');
  // A combined "Location (City)" control takes the whole saved place, so the
  // executor can distinguish this Clifton from the ones in other states.
  expect(city?.proposedValue).toBe('Clifton, New Jersey');
  expect(country?.requiresReview).toBe(true);
  expect(city?.requiresReview).toBe(true);

  // The website field falls back to the saved portfolio.
  expect(byQuestion('website')?.proposedValue).toBe('https://portfolio.example.com');

  // The resume field is missing information, not unsupported.
  expect(byQuestion('resume')?.action).toBe('missing_information');

  // Sensitive questions: veteran has an explicit answer and needs review;
  // gender, Hispanic/Latino, and disability have none and are never proposed.
  const veteran = byQuestion('veteran');
  expect(veteran?.sensitive).toBe(true);
  expect(veteran?.requiresReview).toBe(true);

  for (const needle of ['gender', 'hispanic', 'disability']) {
    const action = byQuestion(needle);
    expect(action?.sensitive, `${needle} must be sensitive`).toBe(true);
    expect(action?.proposedValue, `${needle} must have no proposed value`).toBeUndefined();
    expect(['missing_information', 'manual_review']).toContain(action?.action);
  }

  // 6. Approve the safe actions, then execute.
  await extension.reload();
  await expect(extension.getByRole('heading', { name: 'Fill Plan Review' })).toBeVisible();
  await extension.getByRole('button', { name: 'Approve All Safe' }).click();

  const approvedCount = await message<{ plan: { actions: PlanAction[] } }>(extension, {
    type: 'GET_FILL_PLAN',
  });
  const approvedSensitive = approvedCount.plan.actions.filter(
    (action) => action.approved && action.sensitive,
  );
  expect(approvedSensitive, 'no sensitive action may be bulk-approved').toHaveLength(0);

  // Country and city are normalized into the page's own wording, so they always
  // require an explicit approval rather than being swept up by "Approve All Safe".
  for (const action of [country, city]) {
    const result = await message<{ plan: { actions: PlanAction[] } }>(extension, {
      type: 'APPROVE_FILL_ACTION',
      actionId: action?.id,
      approved: true,
    });
    const updated = result.plan.actions.find((candidate) => candidate.id === action?.id);
    expect(updated?.approved, `${action?.question} should be approvable`).toBe(true);
  }

  // A sensitive action with no value must stay unapprovable even when asked.
  const gender = byQuestion('gender');
  const genderResult = await message<{ plan: { actions: PlanAction[] } }>(extension, {
    type: 'APPROVE_FILL_ACTION',
    actionId: gender?.id,
    approved: true,
  });
  expect(
    genderResult.plan.actions.find((candidate) => candidate.id === gender?.id)?.approved,
    'a value-less sensitive action must never become approved',
  ).toBe(false);

  await extension.reload();

  // 7. Execute.
  await extension.getByRole('button', { name: /Fill Approved Fields \(\d+\)/ }).click();
  await expect(extension.getByRole('heading', { name: 'Fill Run Report' })).toBeVisible();

  // 8/9/10. Verify what the page actually shows.
  await expect(application.locator('#country-root .select-value')).toHaveText(
    'United States of America',
  );
  await expect(application.locator('#city-root .select-value')).toHaveText(
    'Clifton, New Jersey, United States',
  );
  await expect(application.locator('#website')).toHaveValue('https://portfolio.example.com');
  await expect(application.locator('#first_name')).toHaveValue('Jordan');

  // 13. Unanswered sensitive questions were never touched.
  for (const id of ['#gender-root', '#hispanic-root', '#disability-root']) {
    await expect(application.locator(`${id} .select-value`)).toHaveText('');
  }

  // 15. Neither Submit nor Next was ever activated. The fixture records this
  // itself, so an accidental activation cannot pass unnoticed.
  const activation = await application.evaluate(() => ({
    submitted: (globalThis as unknown as { __submitted: boolean }).__submitted,
    nextClicked: (globalThis as unknown as { __nextClicked: boolean }).__nextClicked,
  }));
  expect(activation.submitted).toBe(false);
  expect(activation.nextClicked).toBe(false);

  // 16. Report statistics reconcile with the recorded results.
  const stored = await message<{
    report: {
      submitted: false;
      approvedActions: number;
      verifiedActions: number;
      results: Array<{ fieldId: string; status: string }>;
    };
  }>(extension, { type: 'GET_FILL_PLAN' });
  expect(stored.report.submitted).toBe(false);
  expect(stored.report.verifiedActions).toBe(
    stored.report.results.filter((result) => result.status === 'verified').length,
  );
});
