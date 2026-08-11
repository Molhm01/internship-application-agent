import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Phase C end-to-end proof: every option-based control is opened, its real
 * choices are read, and exactly one is matched and verified.
 *
 * Asserts what the page shows after execution, not that a function returned.
 * No protected trait is ever inferred, and Submit is never activated.
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

/** The test profile named in the Phase C brief. */
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
        phone: '+1 (929) 264-3117',
        address: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
      },
      // The only sensitive instruction that exists is "decline". No value, no
      // trait, and nothing an answer could be inferred from.
      sensitivePolicies: [
        { category: 'gender', policy: 'decline_to_answer' },
        { category: 'sexual_orientation', policy: 'decline_to_answer' },
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
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-options-e2e-'));
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
  proposedValue?: string | string[];
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

/** Every decline wording this fixture uses, one per question. */
const DECLINE_WORDINGS = [
  "I don't wish to answer",
  'I do not wish to self-identify',
  'Choose not to disclose',
  'Decline to self-identify',
  'Prefer not to answer',
];

/** Answers that would disclose a protected characteristic. */
const PROTECTED_ANSWERS = [
  'Man',
  'Woman',
  'Non-binary',
  'I prefer to self-describe',
  'Asexual',
  'Bisexual and/or pansexual',
  'Gay',
  'Heterosexual',
  'Lesbian',
  'Queer',
  'Yes',
  'No',
  'I am not a protected veteran',
  'I identify as one or more of the classifications of a protected veteran',
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability',
];

test('opens every control, reads its real options, and resolves each from saved data', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/greenhouse-full.html`);
  const extension = await extensionPage();

  // 1/2. Scan the application.
  const scan = await message<{
    type: string;
    result: { id: string; ats: { id: string }; fields: Array<{ question: string }> };
  }>(extension, { type: 'SCAN_APPLICATION', targetUrl: application.url() });
  expect(scan.type).toBe('SCAN_COMPLETE');
  expect(scan.result.ats.id).toBe('greenhouse');

  // 3. Build the fill plan.
  const built = await message<{
    plan: { id: string; actions: PlanAction[]; statistics: PlanStatistics };
  }>(extension, { type: 'BUILD_DETERMINISTIC_PLAN', scanId: scan.result.id });

  const exactly = (question: string): PlanAction | undefined =>
    built.plan.actions.find(
      (action) => action.question.trim().toLowerCase() === question.toLowerCase(),
    );

  // 5. Country resolves from the saved "United States".
  const country = exactly('Country *');
  expect(country?.proposedValue).toBe('United States');

  // 6. Phone country code resolves to +1, derived from the saved country.
  const phoneCode = exactly('Phone Country Code');
  expect(phoneCode?.proposedValue).toBe('+1');

  // 7. The local number keeps its digits and drops the dialling code the
  // separate control now carries — never "+1 +1 929...".
  const phone = exactly('Phone Number');
  expect(phone?.proposedValue).toBe('9292643117');
  expect(String(phone?.proposedValue)).not.toContain('+1');

  // 8. The location carries the whole saved place, so the five Cliftons can be
  // told apart at fill time.
  const location = exactly('Location (City) *');
  expect(location?.proposedValue).toBe('Clifton, New Jersey');

  // 9-11. Every protected question proposes a decline, never a trait.
  const protectedQuestions = [
    'Gender identity — mark all that apply',
    'Do you identify as transgender?',
    'Sexual orientation — mark all that apply',
    'Are you Hispanic/Latino?',
    'Veteran Status',
    'Disability Status',
  ];
  for (const question of protectedQuestions) {
    const action = exactly(question);
    expect(action, question).toBeDefined();
    expect(action?.sensitive, `${question} must be treated as sensitive`).toBe(true);
    const proposed = Array.isArray(action?.proposedValue)
      ? action.proposedValue
      : [String(action?.proposedValue)];
    for (const value of proposed) {
      expect(PROTECTED_ANSWERS, `${question} must never propose a trait`).not.toContain(value);
    }
  }

  // 12. No unrecognized question was silently discarded. Phase C removed the
  // `skip` fallback that used to hide them.
  expect(
    built.plan.actions.filter((action) => action.action === 'skip'),
    'no field may be silently skipped',
  ).toHaveLength(0);

  // 15. Plan counts reconcile and nothing unsupported looks approved.
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

  // 13. Approve the safe actions, then each control that needs a decision.
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

  const explicit = [country, phoneCode, location, ...protectedQuestions.map(exactly)];
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
  await expect(extension.getByRole('heading', { name: 'Fill Run Report' })).toBeVisible({
    timeout: 90_000,
  });

  // Every approved action either verified or is named with the stage it failed
  // at. A silent non-result is what Phase C exists to eliminate.
  const runReport = await message<{
    report: {
      results: Array<{
        fieldId: string;
        status: string;
        error?: { code: string; message: string };
      }>;
    };
  }>(extension, { type: 'GET_FILL_PLAN' });
  const unresolved = runReport.report.results
    .filter((result) => result.status !== 'verified' && result.status !== 'skipped')
    .map((result) => ({
      question: built.plan.actions.find((action) => action.fieldId === result.fieldId)?.question,
      status: result.status,
      code: result.error?.code,
      // The stage's own sentence, not just its code: "the list never opened"
      // and "the list opened and had nothing on it" share a failure family and
      // need different repairs, and a bare code cannot tell them apart.
      reason: result.error?.message,
    }));
  expect(unresolved, 'every approved option control must resolve and verify').toEqual([]);

  // 14. Verify what the page actually shows.
  await expect(application.locator('#country-root .select-value')).toHaveText(
    'United States of America',
  );
  await expect(application.locator('#phone-country-root .select-value')).toHaveText(
    'United States (+1)',
  );
  await expect(application.locator('#phone')).toHaveValue('9292643117');
  // Clifton in New Jersey — not Colorado, Arizona, Texas, Bristol, or Clifton Park.
  await expect(application.locator('#location')).toHaveValue('Clifton, NJ, United States');

  for (const id of [
    '#gender-root',
    '#transgender-root',
    '#orientation-root',
    '#hispanic-root',
    '#veteran-root',
    '#disability-root',
  ]) {
    const shown = (await application.locator(`${id} .select-value`).innerText()).trim();
    expect(DECLINE_WORDINGS, `${id} must show a decline option`).toContain(shown);
    expect(PROTECTED_ANSWERS, `${id} must never disclose a trait`).not.toContain(shown);
  }

  // A multi-select decline marks the decline option only, never alongside a
  // category.
  const genderShown = await application.locator('#gender-root .select-value').innerText();
  expect(genderShown.split(',')).toHaveLength(1);

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
