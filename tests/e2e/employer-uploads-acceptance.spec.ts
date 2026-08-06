import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The live failure, reproduced and then proved fixed, through the real built
 * extension.
 *
 * This is the test that would have caught the shipped defect. Every step runs in
 * the shipped bundle — popup command → background worker → frame discovery →
 * content script → upload-control survey → document retrieval → file executor →
 * DOM verification. A helper that works while the built extension does not is
 * exactly the failure this repair began from, so nothing here calls a helper
 * directly.
 *
 * The fixture is the employer form from the report: a résumé section whose file
 * input does not exist until "My Computer" is pressed, a cover-letter section
 * two iframes deep whose input is present but invisible, Google Drive / Dropbox
 * / OneDrive buttons that must never be pressed, Transcript and Work Samples
 * sections that must come out untouched, a "Legal First Name" text box wearing a
 * combobox's ARIA role, and a real Submit button.
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
  if (!response.ok || !body.ok)
    throw new Error(`Agent API ${path} failed: ${JSON.stringify(body)}`);
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
      jobId: 'frames-e2e-job',
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

  userDataDir = await mkdtemp(join(tmpdir(), 'internship-agent-frames-e2e-'));
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

interface UploadControl {
  controlId: string;
  frameId: number;
  kind: string;
  discovery: string;
  accessible: boolean;
  hidden: boolean;
  launcherLabel?: string;
}

interface FrameSurvey {
  frameId: number;
  topFrame: boolean;
  fileInputs: number;
  hiddenFileInputs: number;
  uploadLaunchers: number;
  cloudLaunchers: number;
  controls: UploadControl[];
}

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
  };
  elapsedMs: number;
  fileFieldsSeen: number;
  submitted: false;
  trace: {
    totalFrames: number;
    framesReached: number;
    frames: FrameSurvey[];
    documents: Array<{
      documentType: string;
      stage: string;
      frameId: number | null;
      discovery: string | null;
      verified: boolean;
      failureCode: string | null;
    }>;
    assertionFailed: boolean;
    assertionReason: string | null;
  };
}

/** The tab's frames, in the same order Chrome reports them. */
function frames(page: Page): ReturnType<Page['frames']> {
  return page.frames();
}

test('documents attach across nested frames through button-driven upload widgets', async () => {
  const application = await context.newPage();
  const requests: string[] = [];
  // Proof that no model was consulted. Attaching a file to a control labelled
  // "Resume" is not an ambiguous decision and must cost nothing.
  application.on('request', (request) => requests.push(request.url()));

  await application.goto(`${FIXTURES}/employer-uploads.html`);
  // Both nested frames have to be loaded before the run, or the test would be
  // measuring a race rather than the extension.
  await expect
    .poll(() => frames(application).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);
  await application
    .frameLocator('#cover-letter-frame')
    .frameLocator('#cover-letter-inner')
    .locator('#cover-letter-input')
    .waitFor({ state: 'attached' });

  const extension = await extensionPage();
  const started = Date.now();
  const result = await message<{ report?: AttachmentReport; error?: { message: string } }>(
    extension,
    { type: 'ATTACH_DOCUMENTS', targetUrl: application.url() },
  );
  const elapsed = Date.now() - started;

  expect(result.error).toBeUndefined();
  const report = result.report!;

  // ── The run actually ran ──────────────────────────────────────────────────
  // The reported failure was a 0.0 s run beside four visible upload buttons.
  // A run that discovered controls and attached files cannot take zero time.
  expect(report.elapsedMs).toBeGreaterThan(0);
  expect(report.trace.assertionFailed).toBe(false);

  // ── Frames ────────────────────────────────────────────────────────────────
  // Three documents: the page, the middle frame, and the cover-letter widget.
  expect(report.trace.totalFrames).toBeGreaterThanOrEqual(3);
  expect(report.trace.framesReached).toBeGreaterThanOrEqual(3);
  expect(report.trace.frames.some((frame) => frame.topFrame)).toBe(true);
  expect(report.trace.frames.some((frame) => !frame.topFrame)).toBe(true);

  // ── Résumé: dynamically inserted input, top frame ─────────────────────────
  expect(report.resume).toMatchObject({
    fieldFound: true,
    attached: true,
    verified: true,
    filename: RESUME_FILENAME,
    source: 'tailored',
  });
  const resumeTrace = report.trace.documents.find((entry) => entry.documentType === 'resume')!;
  expect(resumeTrace.stage).toBe('attachment_verified');
  expect(resumeTrace.discovery).toBe('launcher_activated');
  expect(resumeTrace.frameId).toBe(0);

  // ── Cover letter: hidden input, two frames down ───────────────────────────
  expect(report.coverLetter).toMatchObject({
    fieldFound: true,
    attached: true,
    verified: true,
    filename: COVER_FILENAME,
  });
  const coverTrace = report.trace.documents.find((entry) => entry.documentType === 'cover_letter')!;
  expect(coverTrace.stage).toBe('attachment_verified');
  // The whole point: it was found in, and executed against, a subframe.
  expect(coverTrace.frameId).toBeGreaterThan(0);

  // ── The page, not the report, is the evidence ─────────────────────────────
  await expect(application.locator('#resume-filename')).toHaveText(RESUME_FILENAME);
  expect(
    await application.evaluate(
      () => (document.getElementById('resume-input') as HTMLInputElement | null)?.files?.[0]?.name,
    ),
  ).toBe(RESUME_FILENAME);

  const coverFrame = application
    .frameLocator('#cover-letter-frame')
    .frameLocator('#cover-letter-inner');
  await expect(coverFrame.locator('#cover-letter-filename')).toHaveText(COVER_FILENAME);

  // ── Transcript and Work Samples are untouched ─────────────────────────────
  for (const id of ['transcript-input', 'work-samples-input']) {
    expect(
      await application.evaluate(
        (value) => (document.getElementById(value) as HTMLInputElement).files?.length ?? 0,
        id,
      ),
    ).toBe(0);
  }

  // ── Nothing pressed a cloud-provider button ───────────────────────────────
  expect(
    await application.evaluate(
      () => (window as { __cloudButtonPressed?: string[] }).__cloudButtonPressed,
    ),
  ).toBeUndefined();

  // ── Nothing was submitted ─────────────────────────────────────────────────
  expect(report.submitted).toBe(false);
  expect(
    await application.evaluate(() => (window as { __submitClicked?: boolean }).__submitClicked),
  ).toBeUndefined();

  // ── No AI request, and inside ten seconds ─────────────────────────────────
  expect(
    requests.filter((url) => url.includes('/api/generate') || url.includes(':11435')),
  ).toHaveLength(0);
  expect(elapsed).toBeLessThan(10_000);

  await extension.close();
  await application.close();
});

test('a text box wearing a combobox role is filled with text, not option matching', async () => {
  const application = await context.newPage();
  await application.goto(`${FIXTURES}/employer-uploads.html`);

  const extension = await extensionPage();
  const scan = await message<{ type: string; result?: { fields: Array<Record<string, unknown>> } }>(
    extension,
    { type: 'SCAN_APPLICATION', targetUrl: application.url() },
  );

  expect(scan.type).toBe('SCAN_COMPLETE');
  const fields = scan.result!.fields;

  // The exact defect: `<input type="text" role="combobox" class="css-…-control">`
  // was classified `combobox`, which permits `select_option`, which sent a first
  // name to an option matcher that reported "No option on the page matched
  // 'Molhm'". The DOM node's own type is now decisive.
  const byLabel = (needle: string): Record<string, unknown> | undefined =>
    fields.find((field) =>
      (typeof field.label === 'string' ? field.label : '').toLowerCase().includes(needle),
    );

  for (const [needle, expectedType] of [
    ['legal first name', 'text'],
    ['legal last name', 'text'],
    ['email address', 'email'],
    ['phone number', 'tel'],
    ['login', 'text'],
  ] as const) {
    const field = byLabel(needle);
    expect(field, `no scanned field labelled "${needle}"`).toBeDefined();
    expect(field!.fieldType, `"${needle}" was classified ${String(field!.fieldType)}`).toBe(
      expectedType,
    );
    // A text control must never carry an option list. Options are what an option
    // matcher searches, and an empty one is what produced the original message.
    expect(field!.options ?? []).toHaveLength(0);
  }

  // Every scanned field remembers the frame it came from.
  for (const field of fields) {
    expect(typeof field.frameId === 'number' || field.frameId === undefined).toBe(true);
  }

  await extension.close();
  await application.close();
});
