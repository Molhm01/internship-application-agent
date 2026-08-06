import {
  DEFAULT_ERROR_GUIDANCE,
  documentAttachmentReportSchema,
  type AgentError,
  type AttachableDocumentPayload,
  type DocumentAttachmentReport,
  type PageControlTrace,
  type LatestDocumentRecord,
  type LatestDocumentType,
  type StoredLatestDocument,
  type StoredLatestDocuments,
} from '@internship-agent/shared';
import { getLatestDocumentContent, listLatestDocuments } from './agentClient.js';
import {
  DocumentIntegrityError,
  decodeBase64,
  encodeBase64,
  readStoredBytes,
  readStoredDocuments,
  writeStoredDocument,
} from '../storage/latestDocumentStore.js';
import type { LatestDocumentSyncResult } from '../messaging/messages.js';
import { attachAcrossFrames, surveyPageControls } from './attachAcrossFrames.js';
import type { FrameTarget } from './frames.js';

/**
 * The document-only path in the background worker.
 *
 * Two jobs, both deliberately independent of the application bundle, of a page
 * scan, and of the fill plan:
 *
 *  - keep this browser's copy of the newest tailored résumé and cover letter in
 *    step with the agent server,
 *  - hand those bytes to the content script when the user asks for them.
 *
 * Nothing here needs the employer page to have been opened through the correct
 * posting URL, which is the whole point: a redirect through a job board must not
 * be able to make the user's own documents unreachable.
 */

const SYNC_STATE_KEY = 'latestDocumentsSyncedAt';
const LAST_REPORT_KEY = 'latestDocumentAttachmentReport';

function documentError(
  code: AgentError['code'],
  message: string,
  debugContext: Record<string, unknown> = {},
): AgentError {
  return {
    code,
    message,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
    debugContext,
  };
}

async function lastSyncedAt(): Promise<string | null> {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  const value: unknown = stored[SYNC_STATE_KEY];
  return typeof value === 'string' ? value : null;
}

async function lastAttachmentReport(): Promise<DocumentAttachmentReport | null> {
  const stored = await chrome.storage.local.get(LAST_REPORT_KEY);
  const parsed = documentAttachmentReportSchema.safeParse(stored[LAST_REPORT_KEY]);
  return parsed.success ? parsed.data : null;
}

async function rememberAttachmentReport(report: DocumentAttachmentReport): Promise<void> {
  await chrome.storage.local.set({ [LAST_REPORT_KEY]: report });
}

/**
 * A fresh frame-by-frame survey of the page, without attaching anything.
 *
 * This is what "Export Page Control Trace" produces. It runs the same discovery
 * the attach run does, so a "My Computer" button that the attach run could not
 * see is equally impossible to hide from here — but it never activates a
 * launcher and never carries a document byte, so it is safe to run on any page
 * at any time.
 */
export async function exportPageControlTrace(
  dependencies: AttachDocumentsDependencies,
  targetUrl?: string,
): Promise<{ trace: PageControlTrace } | { error: AgentError }> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await dependencies.resolveTab(targetUrl);
  } catch {
    return {
      error: documentError('ACTIVE_TAB_UNAVAILABLE', 'The application tab could not be found.'),
    };
  }

  const connection = await dependencies.ensureContentScript(tab.id!, tab.url);
  if (!connection.reachable) {
    return {
      error: documentError(
        'CONTENT_SCRIPT_UNAVAILABLE',
        connection.reason ?? 'This page could not be reached. Refresh it and try again.',
      ),
    };
  }

  const frames = await dependencies.discoverFrames(tab.id!, tab.url);
  return {
    trace: await surveyPageControls({
      tabId: tab.id!,
      frames,
      runId: `trace-${crypto.randomUUID()}`,
    }),
  };
}

/** What this browser holds right now, without asking the server anything. */
export async function readLatestDocuments(): Promise<LatestDocumentSyncResult> {
  return {
    documents: await readStoredDocuments(),
    syncedAt: await lastSyncedAt(),
    lastReport: await lastAttachmentReport(),
  };
}

function storedFor(
  documents: StoredLatestDocuments,
  documentType: LatestDocumentType,
): StoredLatestDocument | null {
  return documentType === 'resume' ? documents.resume : documents.coverLetter;
}

/**
 * Whether the server's record is a different document from the one held here.
 *
 * Compared on id and checksum rather than on timestamps. A clock that moved
 * backwards, or two documents generated inside the same second, must not be able
 * to make a stale résumé look current — and re-downloading an identical file
 * every time the popup opens would create exactly the duplicate copies this
 * store exists to avoid.
 */
function needsDownload(stored: StoredLatestDocument | null, record: LatestDocumentRecord): boolean {
  if (!stored) return true;
  return stored.id !== record.id || stored.checksum !== record.checksum;
}

/**
 * Pulls anything newer from the agent server.
 *
 * A failure never clears what is already here. The user's résumé staying
 * attachable while the server is restarting is worth more than a document list
 * that is provably fresh.
 */
export async function syncLatestDocuments(): Promise<LatestDocumentSyncResult> {
  const listed = await listLatestDocuments();
  if (listed.error) {
    return {
      documents: await readStoredDocuments(),
      syncedAt: await lastSyncedAt(),
      lastReport: await lastAttachmentReport(),
      error: listed.error,
    };
  }

  let documents = await readStoredDocuments();
  const failures: string[] = [];

  for (const record of [listed.data.resume, listed.data.coverLetter]) {
    if (!record) continue;
    if (!needsDownload(storedFor(documents, record.documentType), record)) continue;

    const content = await getLatestDocumentContent(record.id);
    if (content.error) {
      failures.push(`${record.filename}: ${content.error.message}`);
      continue;
    }
    try {
      // Checksum and byte length are verified inside the store, before anything
      // is written. A document that fails either is not stored at all.
      await writeStoredDocument(content.data, decodeBase64(content.data.contentBase64));
    } catch (cause) {
      failures.push(
        `${record.filename}: ${
          cause instanceof DocumentIntegrityError || cause instanceof Error
            ? cause.message
            : String(cause)
        }`,
      );
    }
  }

  documents = await readStoredDocuments();
  const syncedAt = new Date().toISOString();
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: syncedAt });

  return {
    documents,
    syncedAt,
    lastReport: await lastAttachmentReport(),
    ...(failures.length
      ? {
          error: documentError(
            'DOCUMENT_SYNC_FAILED',
            `Some documents could not be copied from the agent: ${failures.join('; ')}`,
          ),
        }
      : {}),
  };
}

/** The stored documents, shaped for the one message that carries bytes. */
async function attachablePayloads(
  documents: StoredLatestDocuments,
): Promise<AttachableDocumentPayload[]> {
  const payloads: AttachableDocumentPayload[] = [];
  for (const stored of [documents.resume, documents.coverLetter]) {
    if (!stored) continue;
    const bytes = await readStoredBytes(stored.documentType);
    if (!bytes || bytes.byteLength !== stored.byteLength) continue;
    payloads.push({
      documentType: stored.documentType,
      filename: stored.filename,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      source: stored.source,
      contentBase64: encodeBase64(bytes),
    });
  }
  return payloads;
}

export interface AttachDocumentsDependencies {
  resolveTab: (targetUrl?: string) => Promise<chrome.tabs.Tab>;
  ensureContentScript: (
    tabId: number,
    url?: string,
  ) => Promise<{ reachable: boolean; reason?: string }>;
  /** Every frame of the tab that holds a live content script, in frame order. */
  discoverFrames: (tabId: number, url?: string) => Promise<FrameTarget[]>;
}

/**
 * "Attach Resume and Cover Letter", end to end.
 *
 * Refreshes from the agent first — a document generated a moment ago on
 * Internship Pilot should not need a separate button press — but a refresh
 * failure is not fatal when this browser already holds the files.
 */
export async function attachLatestDocuments(
  dependencies: AttachDocumentsDependencies,
  targetUrl?: string,
): Promise<{ report: DocumentAttachmentReport } | { error: AgentError }> {
  const synced = await syncLatestDocuments();
  const payloads = await attachablePayloads(synced.documents);
  if (payloads.length === 0) {
    return {
      error:
        synced.error ??
        documentError(
          'LATEST_DOCUMENT_MISSING',
          'No tailored résumé or cover letter is stored in this extension yet.',
        ),
    };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await dependencies.resolveTab(targetUrl);
  } catch (cause) {
    const unsupported = cause instanceof Error && cause.message === 'UNSUPPORTED_PAGE';
    return {
      error: documentError(
        unsupported ? 'UNSUPPORTED_PAGE' : 'ACTIVE_TAB_UNAVAILABLE',
        unsupported
          ? 'This page is not an employer application page.'
          : 'The application tab could not be found.',
      ),
    };
  }

  const connection = await dependencies.ensureContentScript(tab.id!, tab.url);
  if (!connection.reachable) {
    return {
      error: documentError(
        'CONTENT_SCRIPT_UNAVAILABLE',
        connection.reason ?? 'This page could not be reached. Refresh it and try again.',
      ),
    };
  }

  // Every frame, not the top one. The upload section of a live application is
  // routinely inside an iframe, and the previous build's whole-tab broadcast
  // could only ever reach the main document — which is why a page showing four
  // upload buttons reported "no file upload control" in 0.0 seconds.
  const frames = await dependencies.discoverFrames(tab.id!, tab.url);
  if (frames.length === 0) {
    return {
      error: documentError(
        'CONTENT_SCRIPT_UNAVAILABLE',
        'No frame of this page could be reached. Refresh it and try again.',
      ),
    };
  }

  let report: DocumentAttachmentReport;
  try {
    report = await attachAcrossFrames({
      tabId: tab.id!,
      url: tab.url ?? '',
      frames,
      documents: payloads,
      runId: `attach-${crypto.randomUUID()}`,
    });
  } catch (cause) {
    return {
      error: documentError(
        'DOCUMENT_ATTACHMENT_FAILED',
        `The document attachment run failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
    };
  }

  // A run that saw upload controls and matched none of them is a defect here,
  // not a page without uploads. It is logged as one rather than presented to the
  // user as an ordinary "nothing found".
  if (report.trace?.assertionFailed) {
    console.error('[agent] upload discovery assertion failed', {
      runId: report.runId,
      reason: report.trace.assertionReason,
      frames: report.trace.totalFrames,
    });
  }

  await rememberAttachmentReport(report);
  return { report };
}
