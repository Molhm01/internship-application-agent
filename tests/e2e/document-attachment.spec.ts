import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The document-only path, end to end, through the built extension.
 *
 * Deliberately exercises the real runtime — popup command → background worker →
 * content script → file-field scanner → document retrieval → file executor →
 * DOM verification — rather than any helper in isolation. A helper that works
 * while the shipped bundle does not is exactly the failure this repair began
 * from.
 */

const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', 'extension', 'dist');
const FIXTURES = 'http://127.0.0.1:4173';
const AGENT_URL = 'http://127.0.0.1:4318';
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';

const RESUME_FILENAME = 'Resume-Acme-Software-Engineering-Intern.pdf';
const COVER_FILENAME = 'Cover-Letter-Acme-Software-Engineering-Intern.pdf';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/** A small but genuinely valid PDF, so the server's signature check applies. */
function pdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN, ...init.headers },
  });
  const body = (await response.json()) as { ok: boolean; data?: unknown };
  if (!response.ok || !body.ok) {
    throw new Error(`Agent API ${path} failed: ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function seedDocument(
  documentType: 'resume' | 'cover_letter',
  filename: string,
  bytes: Buffer,
): Promise<void> {
  await api('/documents/latest', {
    method: 'POST',
    body: JSON.stringify({
      documentType,
      filename,
      mimeType: 'application/pdf',
      source: 'tailored',
      company: 'Acme',
      jobTitle: 'Software Engineering Intern',
      jobId: 'e2e-job',
      checksum: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    }),
  });
}

async function extensionPage(path = 'fill-plan.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
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
  await seedDocument('resume', RESUME_FILENAME, pdf('tailored-resume'));
  await seedDocument('cover_letter', COVER_FILENAME, pdf('tailored-cover-letter'));

  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-docs-e2e-'));
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
          aiGenerationEnabled: true,
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

interface AttachmentReport {
  resume: {
    fieldFound: boolean;
    attached: boolean;
    verified: boolean;
    filename: string | null;
    source: string | null;
  };
  coverLetter: {
    fieldFound: boolean;
    attached: boolean;
    verified: boolean;
    filename: string | null;
    message: string | null;
  };
  elapsedMs: number;
  fileFieldsSeen: number;
  submitted: false;
}

test('one document command attaches and verifies both documents on a real page', async () => {
  const application = await context.newPage();
  const requests: string[] = [];
  // Proof that no model was consulted for a clearly labelled field.
  application.on('request', (request) => requests.push(request.url()));
  await application.goto(`${FIXTURES}/document-upload.html`);

  const extension = await extensionPage();
  const started = Date.now();
  const result = await message<{ report?: AttachmentReport; error?: { message: string } }>(
    extension,
    { type: 'ATTACH_DOCUMENTS', targetUrl: application.url() },
  );
  const elapsed = Date.now() - started;

  expect(result.error).toBeUndefined();
  const report = result.report!;

  expect(report.resume).toMatchObject({
    fieldFound: true,
    attached: true,
    verified: true,
    filename: RESUME_FILENAME,
    source: 'tailored',
  });
  expect(report.coverLetter).toMatchObject({
    fieldFound: true,
    attached: true,
    verified: true,
    filename: COVER_FILENAME,
  });

  // The page itself, not the report, is the evidence.
  await expect(application.locator('#resume-upload-filename')).toHaveText(RESUME_FILENAME);
  await expect(application.locator('#cover-letter-upload-filename')).toHaveText(COVER_FILENAME);
  expect(
    await application.evaluate(
      () => (document.getElementById('resume-upload') as HTMLInputElement).files?.[0]?.name,
    ),
  ).toBe(RESUME_FILENAME);
  expect(
    await application.evaluate(
      () => (document.getElementById('cover-letter-upload') as HTMLInputElement).files?.[0]?.name,
    ),
  ).toBe(COVER_FILENAME);

  // Unrelated controls are untouched, and the cover letter never lands in a
  // résumé slot.
  for (const id of ['transcript-upload', 'generic-document']) {
    expect(
      await application.evaluate(
        (value) => (document.getElementById(value) as HTMLInputElement).files?.length ?? 0,
        id,
      ),
    ).toBe(0);
  }

  // Nothing was submitted, and the fixture records it if anything ever is.
  expect(report.submitted).toBe(false);
  expect(
    await application.evaluate(() => (window as { __submitClicked?: boolean }).__submitClicked),
  ).toBeUndefined();

  // No AI request for fields this clearly labelled.
  expect(
    requests.filter((url) => url.includes('/api/generate') || url.includes(':11435')),
  ).toHaveLength(0);

  expect(elapsed).toBeLessThan(10_000);

  await extension.close();
  await application.close();
});

test('a lone unlabelled upload receives the résumé and only the résumé', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/document-upload-generic.html`);
  const extension = await extensionPage();

  const result = await message<{ report?: AttachmentReport }>(extension, {
    type: 'ATTACH_DOCUMENTS',
    targetUrl: application.url(),
  });
  const report = result.report!;

  await expect(application.locator('#generic-document-filename')).toHaveText(RESUME_FILENAME);
  expect(report.coverLetter.fieldFound).toBe(false);
  expect(report.coverLetter.attached).toBe(false);
  expect(report.coverLetter.message).toContain('No separate cover-letter field');
  expect(
    await application.evaluate(
      () => (document.getElementById('photo-upload') as HTMLInputElement).files?.length ?? 0,
    ),
  ).toBe(0);

  await extension.close();
  await application.close();
});

test('the popup shows both filenames and the truthful result of a run', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/document-upload.html`);
  await application.bringToFront();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(popup.locator('.status-row[data-row="Latest tailored résumé"]')).toContainText(
    RESUME_FILENAME,
  );
  await expect(popup.locator('.status-row[data-row="Latest tailored cover letter"]')).toContainText(
    COVER_FILENAME,
  );

  await popup.getByRole('button', { name: 'Attach Resume and Cover Letter' }).click();

  await expect(popup.locator('.status-row[data-row="Résumé verified"]')).toContainText('Yes', {
    timeout: 20_000,
  });
  await expect(popup.locator('.status-row[data-row="Cover letter verified"]')).toContainText('Yes');
  await expect(popup.locator('.status-row[data-row="Résumé filename"]')).toContainText(
    RESUME_FILENAME,
  );
  await expect(popup.locator('.status-row[data-row="Cover letter filename"]')).toContainText(
    COVER_FILENAME,
  );
  await expect(application.locator('#resume-upload-filename')).toHaveText(RESUME_FILENAME);

  await popup.close();
  await application.close();
});

test('documents survive a popup close and a service-worker restart', async () => {
  // Reading through a freshly opened extension page is what a reopened popup
  // does; the stored copy must answer without the server being asked again.
  const extension = await extensionPage();
  const stored = await message<{
    documents: { resume: { filename: string } | null; coverLetter: { filename: string } | null };
  }>(extension, { type: 'GET_LATEST_DOCUMENTS' });

  expect(stored.documents.resume?.filename).toBe(RESUME_FILENAME);
  expect(stored.documents.coverLetter?.filename).toBe(COVER_FILENAME);
  await extension.close();
});
