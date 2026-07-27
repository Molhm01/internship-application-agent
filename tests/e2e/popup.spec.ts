import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const TOKEN_PATH = resolve(import.meta.dirname, '..', '..', 'local-data', 'agent-token.txt');

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }

  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // MV3 service workers require a real (headed) Chromium profile.
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
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

test('popup reports the live agent server and Ollama connection state', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const serverRow = page.locator('.status-row[data-row="Agent Server"]');
  await expect(serverRow).toContainText('Connected');

  // Ollama may legitimately be absent on a dev machine. Either state is a pass;
  // an empty or generic value is not.
  const ollamaRow = page.locator('.status-row[data-row="Ollama"]');
  const ollamaText = await ollamaRow.innerText();
  expect(ollamaText).toMatch(/Connected|Disconnected/);

  if (ollamaText.includes('Disconnected')) {
    // A failure must always carry a cause and a remedy.
    await expect(ollamaRow.locator('.status-row__detail')).toContainText(/127\.0\.0\.1:11434/);
    await expect(ollamaRow.locator('.status-row__detail')).toContainText(/ollama serve/);
  }

  // Milestone 1 rows must report a definite state, never a blank.
  for (const row of ['Model', 'Profile', 'Selected Resume', 'Fields Detected']) {
    await expect(page.locator(`.status-row[data-row="${row}"]`)).not.toBeEmpty();
  }
  await expect(page.locator('.status-row[data-row="Fields Detected"]')).not.toBeEmpty();
  await expect(page.getByRole('button', { name: 'Analyze Application' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review Scan' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Fill Approved Fields' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open Settings' })).toBeEnabled();
  await page.close();
});

test('options page reaches the server and reports the token result', async () => {
  test.skip(!existsSync(TOKEN_PATH), 'agent-token.txt not present; start the server once first');

  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.getByRole('button', { name: 'Connection' }).click();
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Test connection' }).click();

  const result = page.locator('.result').last();
  await expect(result).toContainText('Server reachable');
  await expect(result).toContainText('Token accepted: yes');
  await page.close();
});

/**
 * This suite runs against the developer's real `local-data`, so it deliberately
 * only reads. Profile saving, document registration, and answer CRUD are covered
 * by the server and jsdom suites, which use throwaway databases and directories.
 */
test('settings page exposes every profile area and loads without error', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // The profile loader must always reach a terminal state. A permanent
  // "Loading profile…" was a real bug; this asserts it cannot come back
  // unnoticed, whatever the outcome of the load is.
  await expect(page.getByText('Loading profile…')).toHaveCount(0, { timeout: 20_000 });

  for (const tab of [
    'Name and contact',
    'Education',
    'Work experience',
    'Projects',
    'Skills and activities',
    'Eligibility',
    'Preferences',
    'Sensitive answers',
    'Documents',
    'Approved answers',
    'AI answers',
    'Connection',
    'Diagnostics',
  ]) {
    await expect(page.getByRole('button', { name: tab })).toBeVisible();
  }

  // The developer's real local profile may contain any valid saved policy. The
  // page must render that policy rather than getting stuck or inventing a value.
  await page.getByRole('button', { name: 'Sensitive answers' }).click();
  await expect(page.getByText('These questions are never guessed', { exact: false })).toBeVisible();
  expect(await page.getByLabel('Race').inputValue()).toMatch(
    /^(none|approved_auto_fill|review_required|decline_to_answer|leave_blank)$/,
  );

  await page.getByRole('button', { name: 'Diagnostics' }).click();
  const diagnostics = page.getByRole('region', { name: 'Diagnostics' });
  await expect(diagnostics.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(diagnostics.getByText('Extension version')).toBeVisible();
  await expect(diagnostics.getByText('Database path')).toBeVisible();
  await expect(
    diagnostics.getByText('No authentication token or answer text is shown here.'),
  ).toBeVisible();
  await expect(diagnostics.locator('input, textarea')).toHaveCount(0);

  // Nothing in this build may offer to fill or submit an application.
  await expect(page.getByRole('button', { name: /Fill|Analyze|Submit/i })).toHaveCount(0);
  await page.close();
});

test('connection settings survive a Chromium profile restart', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole('button', { name: 'Connection' }).click();
  await page.getByLabel('Server URL').fill('http://127.0.0.1:4318');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.close();

  await context.close();
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
  expect(new URL(worker.url()).host).toBe(extensionId);

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/options.html`);
  await reopened.getByRole('button', { name: 'Connection' }).click();
  await expect(reopened.getByLabel('Server URL')).toHaveValue('http://127.0.0.1:4318');
  await reopened.close();
});
