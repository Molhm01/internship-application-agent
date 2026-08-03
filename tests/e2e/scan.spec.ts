import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run "npm run build" first.`);
  }
  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-scan-e2e-'));
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
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

async function scanFromExtension(targetUrl: string): Promise<Record<string, unknown>> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/review.html`);
  const result = await extensionPage.evaluate(
    (url) => chrome.runtime.sendMessage({ type: 'SCAN_APPLICATION', targetUrl: url }),
    targetUrl,
  );
  await extensionPage.close();
  return result as Record<string, unknown>;
}

async function applicationPage(name: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/${name}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test('the popup detects a generic fixture, preserves the form, and opens review', async () => {
  const popup = await context.newPage();
  const application = await applicationPage('basic-generic.html');
  await application.evaluate(() => {
    (window as unknown as { submitted: boolean }).submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      (window as unknown as { submitted: boolean }).submitted = true;
    });
  });
  const before = await application.locator('input, textarea, select').evaluateAll((controls) =>
    controls.map((control) => {
      const input = control as HTMLInputElement;
      return { value: input.value, checked: input.checked };
    }),
  );

  await application.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Opening the popup scans the page by itself; there is no separate Analyze
  // step any more, and Autofill is the only action.
  await expect(popup.locator('.status-row[data-row="ATS"]')).toContainText('Generic HTML form');
  await expect(popup.locator('.status-row[data-row="Fields Detected"]')).toContainText('3');
  await expect(popup.getByRole('button', { name: 'Autofill Application' })).toBeEnabled();

  // Scanning is read-only: nothing on the employer's form may change, and the
  // form must not have been submitted.
  const after = await application.locator('input, textarea, select').evaluateAll((controls) =>
    controls.map((control) => {
      const input = control as HTMLInputElement;
      return { value: input.value, checked: input.checked };
    }),
  );
  expect(after).toEqual(before);
  expect(
    await application.evaluate(() => (window as unknown as { submitted: boolean }).submitted),
  ).toBe(false);

  // The analysis page is a developer tool now and the popup no longer links to
  // it in normal mode, so this opens it directly. The page itself is unchanged
  // and still has to render the scan correctly.
  const review = await context.newPage();
  await review.goto(`chrome-extension://${extensionId}/review.html`);
  await review.waitForLoadState();
  await expect(review.getByRole('heading', { name: 'Software Intern' })).toBeVisible();
  await expect(review.getByText('3 of 3 fields shown.')).toBeVisible();

  await review.getByLabel('Search').fill('email');
  await expect(review.getByText('1 of 3 fields shown.')).toBeVisible();
  await review.getByLabel('Search').fill('');
  await review.getByLabel('Requirement').selectOption('required');
  await expect(review.getByText('1 of 3 fields shown.')).toBeVisible();

  const download = review.waitForEvent('download');
  await review.getByRole('button', { name: 'Export JSON' }).click();
  expect((await download).suggestedFilename()).toMatch(/^application-scan-.*\.json$/);
  await review.close();
  await application.close();
  await popup.close();
});

for (const [name, expected, count] of [
  ['greenhouse.html', 'greenhouse', 2],
  ['lever.html', 'lever', 3],
  ['workday.html', 'workday', 2],
] as const) {
  test(`${expected} fixture uses its dedicated adapter`, async () => {
    const page = await applicationPage(name);
    const result = await scanFromExtension(page.url());
    expect(result['type']).toBe('SCAN_COMPLETE');
    const scan = result['result'] as {
      ats: { id: string };
      statistics: { total: number };
      readOnly: boolean;
    };
    expect(scan.ats.id).toBe(expected);
    expect(scan.statistics.total).toBe(count);
    expect(scan.readOnly).toBe(true);
    await page.close();
  });
}

test('dynamic fixture includes the inserted field and error scans terminate', async () => {
  const page = await applicationPage('dynamic-fields.html');
  const result = await scanFromExtension(page.url());
  expect(result['type']).toBe('SCAN_COMPLETE');
  expect((result['result'] as { statistics: { total: number } }).statistics.total).toBe(2);
  await page.close();

  const failed = await scanFromExtension(`${FIXTURES}/not-open.html`);
  expect(failed['type']).toBe('SCAN_FAILED');
  expect((failed['error'] as { code: string }).code).toBe('ACTIVE_TAB_UNAVAILABLE');
});
