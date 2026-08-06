import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The Phase 2 acceptance gates, proven against the *built* extension.
 *
 * Nothing here imports from `extension/src`. The only input is a message to the
 * loaded service worker, which reaches the content script, which runs the
 * scanner and the normalizer in every frame of the page — the same path the
 * "Autofill Application" button takes. A jsdom suite proves the source is
 * correct; only this can prove the bundle Chrome loaded behaves that way.
 *
 * The fixture is a realistic candidate-profile page carrying every false
 * control the live extension previously normalized: iCIMS-shaped accordion
 * headers that say "required", instructional prose, a validation summary,
 * navigation and submit buttons, and the agent's own review badges.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const APPLICATION_URL = `${FIXTURES}/phase2-candidate-profile.html`;

interface ScannedField {
  id: string;
  label: string;
  canonicalKey?: string;
  fieldType: string;
  required: boolean;
  requiredSource?: string;
  selector: string;
  section?: string;
  frameId?: number;
  options?: Array<{ label: string }>;
  metadata: Record<string, unknown>;
}

interface ScanReply {
  type: string;
  result?: {
    fields: ScannedField[];
    statistics: {
      total: number;
      rawControls: number;
      falseControlsRemoved: number;
      duplicateControlsRemoved: number;
      required: number;
      optional: number;
    };
  };
}

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;
let application: Page;

async function scan(): Promise<NonNullable<ScanReply['result']>> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/review.html`);
  const reply = await page.evaluate<ScanReply, string>(
    (url) => chrome.runtime.sendMessage({ type: 'SCAN_APPLICATION', targetUrl: url }),
    APPLICATION_URL,
  );
  await page.close();
  expect(reply.result, `the scan failed: ${JSON.stringify(reply)}`).toBeTruthy();
  return reply.result as NonNullable<ScanReply['result']>;
}

let first: NonNullable<ScanReply['result']>;

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-phase2-'));
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

  application = await context.newPage();
  await application.goto(APPLICATION_URL);
  await application.waitForLoadState('networkidle');
  first = await scan();
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

function labelled(label: string): ScannedField[] {
  return first.fields.filter((field) => field.label === label);
}

function intent(key: string): ScannedField[] {
  return first.fields.filter((field) => field.canonicalKey === key);
}

test('GATES 1–4 — headings, instructions and validation text are not questions', () => {
  const text = first.fields.map((field) => field.label).join('\n');
  expect(text).not.toMatch(/Phones \(1\)/);
  expect(text).not.toMatch(/Addresses \(1\)/);
  expect(text).not.toMatch(/Complete every section marked required/);
  expect(text).not.toMatch(/Information needed\./);
  expect(text).not.toMatch(/City is required\./);
  for (const selector of ['#phones-header', '#addresses-header']) {
    expect(first.fields.some((field) => field.selector === selector)).toBe(false);
  }
});

test('GATE 5 — no extension-owned node became a question', () => {
  // The page really does contain marked controls; this is not a vacuous pass.
  expect(application.locator('[data-internship-agent-owned="true"] input, select')).toBeTruthy();
  const owned = first.fields.filter((field) =>
    /Autofill|Information needed|Manual response required|All fields/i.test(field.label),
  );
  expect(owned).toEqual([]);
  expect(first.fields.some((field) => field.selector === '#agent-autofill-toggle')).toBe(false);
  expect(first.fields.some((field) => field.selector === '#agent-annotation-filter')).toBe(false);
});

test('GATE 6 — Previous, Next and Submit are not questions, and Submit is untouched', async () => {
  for (const selector of ['#previous-step', '#next-step', '#final-submit']) {
    expect(first.fields.some((field) => field.selector === selector)).toBe(false);
  }
  // GATE 18 — scanning is read-only, so the form cannot have been submitted.
  expect(await application.evaluate(() => document.location.pathname)).toBe(
    '/phase2-candidate-profile.html',
  );
});

test('GATES 7–9 — required status is earned, and on stated evidence', () => {
  const middle = intent('middle_name');
  expect(middle).toHaveLength(1);
  expect(middle[0]?.required).toBe(false);
  expect(middle[0]?.requiredSource).toBe('none');

  const line2 = intent('address_line2');
  expect(line2).toHaveLength(1);
  expect(line2[0]?.required).toBe(false);
  expect(line2[0]?.requiredSource).toBe('none');

  const line1 = intent('address_line1').filter((field) => field.selector === '#addressLine1');
  expect(line1.length).toBeGreaterThan(0);
  for (const field of line1) {
    expect(field.required).toBe(true);
    expect(field.requiredSource).toBe('native_required');
  }

  const first_ = intent('first_name');
  expect(first_[0]?.required).toBe(true);
  const country = intent('country');
  expect(country[0]?.required).toBe(true);

  // Every field says which evidence decided it, and agrees with itself.
  for (const field of first.fields) {
    expect(field.requiredSource, `${field.label} has no required evidence`).toBeDefined();
    expect(field.required).toBe(field.requiredSource !== 'none');
  }
});

test('GATE 10 — Highest Level of Education is one field, not three', () => {
  expect(labelled('Highest Level of Education')).toHaveLength(1);
  expect(intent('highest_degree_awarded')).toHaveLength(1);
  expect(first.statistics.duplicateControlsRemoved).toBeGreaterThanOrEqual(0);
});

test('GATE 11 — a radio group is one question and a lone checkbox is another', () => {
  const radios = first.fields.filter((field) => field.fieldType === 'radio');
  expect(radios).toHaveLength(1);
  expect(radios[0]?.options?.map((option) => option.label)).toEqual(['Yes', 'No']);
  expect(radios[0]?.metadata.groupName).toBe('workAuthorized');

  const checkboxes = first.fields.filter((field) => field.fieldType === 'checkbox');
  expect(checkboxes).toHaveLength(1);
  expect(checkboxes[0]?.selector).toBe('#marketingConsent');
});

test('GATES 12–13 — repeated generic labels inherit the right section', () => {
  const types = labelled('Type');
  expect(types).toHaveLength(2);
  expect(new Set(types.map((field) => field.canonicalKey))).toEqual(
    new Set(['phone_type', 'address_type']),
  );

  const location = intent('experience_location');
  expect(location).toHaveLength(1);
  expect(location[0]?.selector).toBe('#experienceLocation');
  expect(intent('current_location')).toEqual([]);

  const headings = Object.fromEntries(
    first.fields.map((field) => [field.selector, field.metadata.sectionHeading]),
  );
  expect(headings['#phoneNumber']).toBe('Phones (1)* required.');
  expect(headings['#city']).toBe('Addresses (1)* required.');
  expect(headings['#school']).toBe('Education');
});

test('GATE 14 — the same control in a nested frame stays a separate field', () => {
  const addressLines = first.fields.filter((field) => field.selector === '#addressLine1');
  expect(addressLines).toHaveLength(2);
  expect(new Set(addressLines.map((field) => field.id)).size).toBe(2);
  // The worker stamps the frame each field was found in; the two must differ.
  expect(new Set(addressLines.map((field) => field.frameId)).size).toBe(2);
});

test('GATES 15–16 — a second scan of an unchanged page is identical and marks nothing', async () => {
  const before = await application.evaluate(
    () => document.querySelectorAll('[data-internship-agent-owned="true"]').length,
  );
  const second = await scan();
  expect(second.fields.map((field) => field.id)).toEqual(first.fields.map((field) => field.id));
  expect(second.statistics.total).toBe(first.statistics.total);
  expect(second.statistics.required).toBe(first.statistics.required);

  const after = await application.evaluate(
    () => document.querySelectorAll('[data-internship-agent-owned="true"]').length,
  );
  expect(after).toBe(before);
  // Discovery marks nothing. Marks belong to the planner's final statuses.
  expect(
    await application.evaluate(
      () => document.querySelectorAll('[data-internship-agent-review]').length,
    ),
  ).toBe(0);
});

test('the census reports more raw controls than questions, and says what it dropped', () => {
  expect(first.statistics.rawControls).toBeGreaterThan(first.statistics.total);
  expect(first.statistics.falseControlsRemoved).toBeGreaterThan(0);
  expect(first.statistics.required + first.statistics.optional).toBe(first.statistics.total);
});
