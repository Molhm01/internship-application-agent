import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end proof for the Greenhouse execution repair: a country combobox, a
 * split phone country code, a searchable location autocomplete offering the same
 * city in five regions, and four self-identification questions that each word
 * "decline" differently.
 *
 * Asserts what the page actually shows after execution — not that a function
 * returned — and that no protected characteristic is ever inferred and Submit is
 * never activated.
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

/** Exactly the test data named in the repair brief. */
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
        // Carries the dialling code, so the split-field handling is exercised.
        phone: '+19292643117',
        address: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
      },
      // The only sensitive instruction that exists is "decline". No value, no
      // trait, and nothing an answer could be inferred from.
      sensitivePolicies: [
        { category: 'gender', policy: 'decline_to_answer' },
        { category: 'race', policy: 'decline_to_answer' },
        { category: 'ethnicity', policy: 'decline_to_answer' },
        { category: 'veteran_status', policy: 'decline_to_answer' },
        { category: 'disability', policy: 'decline_to_answer' },
      ],
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-location-e2e-'));
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
  confidence: number;
}

interface PlanStatistics {
  total: number;
  ready: number;
  approved: number;
  review: number;
  missingInformation: number;
  skipped: number;
  unsupported: number;
  sensitive: number;
}

/** Every wording the fixture uses to let someone decline. */
const DECLINE_WORDINGS = [
  'I do not wish to self-identify',
  'Choose not to disclose',
  'I prefer not to disclose',
  'Prefer not to answer',
];

/** Answers that would disclose a protected characteristic. */
const PROTECTED_ANSWERS = [
  'Male',
  'Female',
  'Non-binary',
  'Yes',
  'No',
  'I am not a protected veteran',
  'I identify as one or more of the classifications of a protected veteran',
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability',
];

test('fills country, phone code, and the correct Clifton, and declines without inferring a trait', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/greenhouse-location-phone.html`);
  const extension = await extensionPage();

  // 1/2. Analyze the application.
  const scan = await message<{
    type: string;
    result: { id: string; ats: { id: string } };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scan.type).toBe('SCAN_COMPLETE');
  expect(scan.result.ats.id).toBe('greenhouse');

  // 3. Build the fill plan.
  const built = await message<{
    plan: { id: string; actions: PlanAction[]; statistics: PlanStatistics };
  }>(extension, { type: 'BUILD_DETERMINISTIC_PLAN', scanId: scan.result.id });

  const byQuestion = (needle: string): PlanAction | undefined =>
    built.plan.actions.find((action) => action.question.toLowerCase().includes(needle));
  /**
   * Exact question text. "Country" and "Phone Country Code" are different
   * controls, and a substring match silently conflates them.
   */
  const exactly = (question: string): PlanAction | undefined =>
    built.plan.actions.find(
      (action) => action.question.trim().toLowerCase() === question.toLowerCase(),
    );

  // 4. Country has a valid proposed value.
  const country = exactly('Country *');
  expect(country?.action).toBe('select_suggested_option');
  expect(country?.proposedValue).toBe('United States');

  // 5. The location carries the whole saved place, not the bare city, so the
  // executor can tell the five Cliftons apart.
  const location = exactly('Location (City) *');
  expect(location?.action).toBe('select_suggested_option');
  expect(location?.proposedValue).toBe('Clifton, New Jersey');

  // 6. The phone country code is derived from the saved country.
  const phoneCode = exactly('Phone Country Code');
  expect(phoneCode?.action).toBe('select_suggested_option');
  expect(phoneCode?.proposedValue).toBe('+1');

  // The local number drops the dialling code the separate control now carries.
  const phone = exactly('Phone Number');
  expect(phone?.proposedValue).toBe('9292643117');
  expect(String(phone?.proposedValue)).not.toContain('+1');

  // 7. Every disclosure field uses the saved decline policy and proposes a
  // decline — never a trait.
  for (const needle of ['gender', 'hispanic', 'veteran', 'disability']) {
    const action = byQuestion(needle);
    expect(action?.sensitive, `${needle} must be treated as sensitive`).toBe(true);
    expect(
      PROTECTED_ANSWERS,
      `${needle} must never propose a protected characteristic`,
    ).not.toContain(action?.proposedValue);
    expect(action?.proposedValue, `${needle} must propose a decline`).toBe('Decline to answer');
  }

  // 15. Plan counts reconcile: every action lands in exactly one bucket, and
  // nothing unsupported is counted as approved.
  const stats = built.plan.statistics;
  expect(
    stats.ready +
      stats.approved +
      stats.review +
      stats.missingInformation +
      stats.skipped +
      stats.unsupported,
  ).toBe(stats.total);
  expect(stats.total).toBe(built.plan.actions.length);
  expect(
    built.plan.actions.filter((action) => action.action === 'unsupported' && action.approved),
  ).toHaveLength(0);

  // 8. Approve the safe actions, then each control that needs a decision.
  await extension.reload();
  await expect(extension.getByRole('heading', { name: 'Fill Plan Review' })).toBeVisible();
  await extension.getByRole('button', { name: 'Approve All Safe' }).click();

  const afterBulk = await message<{ plan: { actions: PlanAction[] } }>(extension, {
    type: 'GET_FILL_PLAN',
  });
  expect(
    afterBulk.plan.actions.filter((action) => action.approved && action.sensitive),
    'no sensitive action may ever be bulk-approved',
  ).toHaveLength(0);

  const explicit = [
    country,
    location,
    phoneCode,
    ...['gender', 'hispanic', 'veteran', 'disability'].map(byQuestion),
  ];
  for (const action of explicit) {
    const result = await message<{ plan: { actions: PlanAction[] } }>(extension, {
      type: 'APPROVE_FILL_ACTION',
      actionId: action?.id,
      approved: true,
    });
    const updated = result.plan.actions.find((candidate) => candidate.id === action?.id);
    expect(updated?.approved, `${action?.question} should be approvable`).toBe(true);
  }

  await extension.reload();
  await extension.getByRole('button', { name: /Fill Approved Fields \(\d+\)/ }).click();
  // Seven custom comboboxes, each opened, read, matched, clicked, and verified
  // against the rerendered control, take well past the default assertion window.
  await expect(extension.getByRole('heading', { name: 'Fill Run Report' })).toBeVisible({
    timeout: 90_000,
  });

  // 9. Country is verified against the page's own wording.
  await expect(application.locator('#country-root .select-value')).toHaveText(
    'United States of America',
  );

  // 10. +1 is verified.
  await expect(application.locator('#phone-country-root .select-value')).toHaveText(
    'United States (+1)',
  );

  // 11. The phone number does not repeat the dialling code.
  await expect(application.locator('#phone')).toHaveValue('9292643117');

  // 12. Clifton, New Jersey — not Colorado, Arizona, Texas, Bristol, or Clifton Park.
  await expect(application.locator('#location')).toHaveValue('Clifton, New Jersey, United States');

  // 13. Each disclosure field shows this form's own way of declining.
  for (const id of ['#gender-root', '#hispanic-root', '#veteran-root', '#disability-root']) {
    const shown = await application.locator(`${id} .select-value`).innerText();
    expect(DECLINE_WORDINGS, `${id} must show a decline option`).toContain(shown.trim());
    // 14. No protected characteristic was inferred anywhere on the page.
    expect(PROTECTED_ANSWERS, `${id} must never disclose a trait`).not.toContain(shown.trim());
  }

  // 16. Neither Submit nor Next was ever activated.
  const activation = await application.evaluate(() => ({
    submitted: (globalThis as unknown as { __submitted: boolean }).__submitted,
    nextClicked: (globalThis as unknown as { __nextClicked: boolean }).__nextClicked,
  }));
  expect(activation.submitted).toBe(false);
  expect(activation.nextClicked).toBe(false);

  const stored = await message<{
    report: { submitted: false; verifiedActions: number; results: Array<{ status: string }> };
  }>(extension, { type: 'GET_FILL_PLAN' });
  expect(stored.report.submitted).toBe(false);
  expect(stored.report.verifiedActions).toBe(
    stored.report.results.filter((result) => result.status === 'verified').length,
  );
});
