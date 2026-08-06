import {
  DEFAULT_ERROR_GUIDANCE,
  scanApplicationMessageSchema,
  scanCancelMessageSchema,
  scanCompleteMessageSchema,
  scanFailedMessageSchema,
  scanProgressMessageSchema,
  type AgentError,
  executeFillPlanMessageSchema,
  fillCompleteMessageSchema,
  fillFailedMessageSchema,
  fillProgressMessageSchema,
  fillExecutionResultSchema,
  type DeterministicFillAction,
  type FillExecutionResult,
  activateNavigationMessageSchema,
  awaitDependentOptionsMessageSchema,
  dependentOptionsResultSchema,
  attachToControlMessageSchema,
  attachToControlResponseSchema,
  discoverUploadControlsMessageSchema,
  uploadControlsResponseSchema,
} from '@internship-agent/shared';
import { attachInFrame, discoverInFrame } from '../uploads/frameUploads.js';
import { BUILD_ID } from '../generated/buildInfo.js';
import { activateNavigation } from './navigate.js';
import type { ContentPingResult, ExtensionMessage } from '../messaging/messages.js';
import { scanApplication } from '../scanner/scanApplication.js';
import { ATS_ADAPTERS, selectAdapter } from '../scanner/adapters.js';
import { completeReport, createRunningReport } from '../reporter/fillReporter.js';
import { validatePageIdentity } from '../executor/pageProtection.js';
import { startBundleBridge } from './bundleBridge.js';
import { awaitDependentOptions } from './dependentOptions.js';
import { clearHighlights, focusField, highlightField, reviewOrder } from './highlighter.js';

/**
 * Loads exactly once per frame.
 *
 * The manifest injects this script at document_idle, and the worker also
 * injects it with `chrome.scripting.executeScript` — both to repair a frame
 * that lost its script after an extension reload, and because that injection is
 * how frames are enumerated in the first place. Without this guard a frame
 * would end up with two listeners, both of which would call `sendResponse` for
 * the same message, and Chrome keeps only the first while the second throws.
 *
 * The guard is a flag rather than an early `throw`, because a script that
 * throws makes `executeScript` report an error for that frame — and that error
 * would be indistinguishable from a frame that genuinely could not be reached.
 */
declare global {
  interface Window {
    __internshipAgentContentLoaded__?: true;
  }
}

const alreadyLoaded = window.__internshipAgentContentLoaded__ === true;
window.__internshipAgentContentLoaded__ = true;

const controllers = new Map<string, AbortController>();
const fillControllers = new Map<string, AbortController>();

function scanError(
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

function notifyProgress(progress: Parameters<typeof scanProgressMessageSchema.parse>[0]): void {
  const parsed = scanProgressMessageSchema.parse(progress);
  void chrome.runtime.sendMessage(parsed).catch(() => {
    // The initiating request still completes even if the popup closes mid-scan.
  });
}

function notifyFillProgress(progress: Parameters<typeof fillProgressMessageSchema.parse>[0]): void {
  const parsed = fillProgressMessageSchema.parse(progress);
  void chrome.runtime.sendMessage(parsed).catch(() => {
    // The run response still completes if its UI closes.
  });
}

function passiveResult(
  action: DeterministicFillAction,
  status: FillExecutionResult['status'],
): FillExecutionResult {
  return fillExecutionResultSchema.parse({
    actionId: action.id,
    fieldId: action.fieldId,
    status,
    expectedValue: action.proposedValue,
    attempts: 0,
    durationMs: 0,
  });
}

function handleMessage(
  raw: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (raw?.type === 'CONTENT_PING') {
    const result: ContentPingResult = {
      present: true,
      url: window.location.href,
      // Announced on every ping, so the worker learns which build is actually
      // executing in the page *before* it asks that build to scan or fill.
      buildId: BUILD_ID,
      fieldsDetected: null,
      // Detected here, in the page, on every ping. This is the same detector
      // the scan uses; answering it separately is what lets the popup name the
      // vendor even when the scan itself fails.
      ...(() => {
        try {
          const selected = selectAdapter({
            url: window.location.href,
            hostname: window.location.hostname,
            title: document.title,
            bodyText: document.body?.textContent?.slice(0, 4000) ?? '',
            document,
          });
          return {
            ats: {
              id: selected.adapter.id,
              displayName: selected.adapter.displayName,
              confidence: selected.detection.confidence,
              reason: selected.detection.reason,
            },
          };
        } catch {
          // No adapter matched at all. The ping still succeeds — the content
          // script being reachable is the thing the caller asked about.
          return {};
        }
      })(),
    };
    sendResponse(result);
    return false;
  }

  if (raw?.type === 'ACTIVATE_NAVIGATION') {
    // Parsed here rather than trusted: this is the one handler that clicks
    // something, and the schema is what makes `final_submit` unrepresentable.
    const parsed = activateNavigationMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse({
        status: 'refused',
        reason: 'That navigation request failed validation and was not acted on.',
      });
      return false;
    }
    void activateNavigation(parsed.data, document, () => window.location.href).then(
      sendResponse,
      (cause: unknown) => {
        sendResponse({
          status: 'refused',
          reason: `The navigation control could not be activated: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      },
    );
    return true;
  }

  if (raw?.type === 'ACCOUNT_WRITE_FIELD') {
    // One selector, one value, one field. Deliberately the narrowest possible
    // message: this is the path an employer-site password travels, and it must
    // carry nothing else and be usable for nothing else.
    //
    // Nothing here logs `value`. The response is a boolean.
    const element = document.querySelector(raw.selector);
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      sendResponse({ ok: false });
      return false;
    }
    if (typeof raw.checked === 'boolean') {
      if (!(element instanceof HTMLInputElement)) {
        sendResponse({ ok: false });
        return false;
      }
      element.checked = raw.checked;
    } else {
      element.value = raw.value ?? '';
    }
    // The events a framework-backed form listens for. Without them a React or
    // Angular control keeps its own empty state and the typed value vanishes on
    // the next render.
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    sendResponse({ ok: true });
    return false;
  }

  if (raw?.type === 'HIGHLIGHT_REVIEW_FIELDS') {
    clearHighlights();
    let drawn = 0;
    for (const request of raw.requests) {
      if (highlightField(request)) drawn += 1;
    }
    if (raw.scrollToFirst) {
      const first = reviewOrder()[0];
      if (first) focusField(first.fieldId);
    }
    sendResponse({ ok: true, drawn });
    return false;
  }

  if (raw?.type === 'FOCUS_REVIEW_FIELD') {
    sendResponse({ ok: focusField(raw.fieldId) });
    return false;
  }

  if (raw?.type === 'CLEAR_REVIEW_HIGHLIGHTS') {
    clearHighlights();
    sendResponse({ ok: true });
    return false;
  }

  if (raw?.type === 'DISCOVER_UPLOAD_CONTROLS') {
    // Phase one of the document path: this frame describes what it can accept a
    // document into, and decides nothing. No bytes arrive with this message and
    // none leave with the answer.
    const parsed = discoverUploadControlsMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse(
        uploadControlsResponseSchema.parse({
          type: 'UPLOAD_CONTROLS_FAILED',
          runId: 'unknown',
          reason: 'The discovery request failed validation and was not acted on.',
        }),
      );
      return false;
    }
    const message = parsed.data;
    void discoverInFrame(document, message.runId, message.mayActivateLaunchers)
      .then((survey) => {
        sendResponse(
          uploadControlsResponseSchema.parse({
            type: 'UPLOAD_CONTROLS',
            runId: message.runId,
            // The worker replaces this with the real frame id; a frame cannot
            // learn its own.
            survey: { ...survey, frameId: 0 },
          }),
        );
      })
      .catch((cause: unknown) => {
        sendResponse(
          uploadControlsResponseSchema.parse({
            type: 'UPLOAD_CONTROLS_FAILED',
            runId: message.runId,
            reason: `Upload discovery failed in this frame: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
        );
      });
    return true;
  }

  if (raw?.type === 'ATTACH_DOCUMENT_TO_CONTROL') {
    // Phase two: one document, one control this frame itself offered. The
    // message carries a `controlId` minted here moments ago and no selector, so
    // it cannot be used to reach anything this frame did not volunteer.
    const parsed = attachToControlMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse(
        attachToControlResponseSchema.parse({
          type: 'ATTACH_CONTROL_FAILED',
          runId: 'unknown',
          failureCode: 'CONTROL_LEFT_PAGE',
          message: 'The attachment request failed validation and was not acted on.',
        }),
      );
      return false;
    }
    const message = parsed.data;
    void attachInFrame(message.runId, message.controlId, message.document)
      .then((result) => {
        sendResponse(
          attachToControlResponseSchema.parse({
            type: 'ATTACH_CONTROL_RESULT',
            runId: message.runId,
            attached: result.attached,
            verified: result.verified,
            failureCode: result.failureCode,
            message: result.message,
          }),
        );
      })
      .catch((cause: unknown) => {
        sendResponse(
          attachToControlResponseSchema.parse({
            type: 'ATTACH_CONTROL_FAILED',
            runId: message.runId,
            failureCode: 'FILE_TRANSFER_REFUSED',
            message: `The attachment failed in this frame: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
        );
      });
    return true;
  }

  // The Country → State handoff, observed rather than slept through. Reads
  // option sets and answers; it can neither open a control nor write to one.
  if (raw?.type === 'AWAIT_DEPENDENT_OPTIONS') {
    const message = awaitDependentOptionsMessageSchema.parse(raw);
    void awaitDependentOptions(document, message.selectors, message.timeoutMs).then((outcome) => {
      sendResponse(
        dependentOptionsResultSchema.parse({ type: 'DEPENDENT_OPTIONS_RESULT', ...outcome }),
      );
    });
    return true;
  }

  if (raw?.type === 'SCAN_CANCEL') {
    const message = scanCancelMessageSchema.parse(raw);
    if (message.scanId) controllers.get(message.scanId)?.abort();
    else for (const controller of controllers.values()) controller.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (raw?.type === 'FILL_CANCEL') {
    if (raw.runId) fillControllers.get(raw.runId)?.abort();
    else for (const controller of fillControllers.values()) controller.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (raw?.type === 'EXECUTE_FILL_PLAN') {
    const message = executeFillPlanMessageSchema.parse(raw);
    const controller = new AbortController();
    fillControllers.set(message.runId, controller);
    void (async () => {
      if (
        !validatePageIdentity(window.location.href, message.scan, message.plan, message.frameUrl)
          .valid
      ) {
        throw new DOMException(
          'The application page no longer matches the scan.',
          'InvalidStateError',
        );
      }
      const adapter = ATS_ADAPTERS.find((candidate) => candidate.id === message.plan.ats);
      if (!adapter) throw new Error(`No executor exists for adapter ${message.plan.ats}.`);
      const report = createRunningReport(message.plan, message.scan, message.runId);
      const results: FillExecutionResult[] = [];
      notifyFillProgress({
        type: 'FILL_PROGRESS',
        progress: {
          runId: message.runId,
          planId: message.plan.id,
          stage: 'preflight',
          completed: 0,
          total: message.plan.actions.length,
          message: 'Confirming the page and scanned fields…',
        },
      });
      for (const [index, action] of message.plan.actions.entries()) {
        if (controller.signal.aborted) {
          results.push(passiveResult(action, 'cancelled'));
          continue;
        }
        const field = message.scan.fields.find((candidate) => candidate.id === action.fieldId);
        let result: FillExecutionResult;
        if (!field) {
          const generated = action.action === 'fill_generated_text';
          result = fillExecutionResultSchema.parse({
            ...passiveResult(action, 'failed'),
            error: scanError(
              generated ? 'GENERATED_FIELD_NOT_FOUND' : 'FIELD_NOT_FOUND',
              'The action field is missing from the scan.',
              {
                actionId: action.id,
              },
            ),
          });
        } else if (action.action === 'unsupported') {
          result = passiveResult(action, 'unsupported');
        } else if (action.action === 'manual_review') {
          result = passiveResult(action, 'needs_review');
        } else if (action.action === 'skip' || !action.approved) {
          result = passiveResult(action, 'skipped');
        } else {
          result = await adapter.executeAction(
            {
              document,
              signal: controller.signal,
              documentContents: message.documentContents,
            },
            field,
            action,
          );
        }
        results.push(result);
        notifyFillProgress({
          type: 'FILL_PROGRESS',
          progress: {
            runId: message.runId,
            planId: message.plan.id,
            stage: result.status === 'verified' ? 'verifying' : 'filling',
            completed: index + 1,
            total: message.plan.actions.length,
            message: `Processed ${index + 1} of ${message.plan.actions.length} fields.`,
          },
        });
      }
      const completed = completeReport(report, results);
      notifyFillProgress({
        type: 'FILL_PROGRESS',
        progress: {
          runId: message.runId,
          planId: message.plan.id,
          stage: 'done',
          completed: message.plan.actions.length,
          total: message.plan.actions.length,
          message: 'Fill run finished. Review the application and continue manually.',
        },
      });
      return completed;
    })()
      .then((report) => {
        sendResponse(fillCompleteMessageSchema.parse({ type: 'FILL_COMPLETE', report }));
      })
      .catch((cause: unknown) => {
        const aborted =
          controller.signal.aborted ||
          (cause instanceof DOMException && cause.name === 'AbortError');
        const pageChanged = cause instanceof DOMException && cause.name === 'InvalidStateError';
        const error = scanError(
          aborted ? 'EXECUTION_CANCELLED' : pageChanged ? 'PAGE_CHANGED' : 'INVALID_FILL_PLAN',
          aborted
            ? 'The deterministic fill run was cancelled.'
            : pageChanged
              ? 'The application page changed after it was scanned.'
              : `The deterministic fill run failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { runId: message.runId, planId: message.plan.id },
        );
        sendResponse(
          fillFailedMessageSchema.parse({ type: 'FILL_FAILED', runId: message.runId, error }),
        );
      })
      .finally(() => fillControllers.delete(message.runId));
    return true;
  }

  if (raw?.type !== 'SCAN_APPLICATION') return false;
  const message = scanApplicationMessageSchema.parse(raw);
  const scanId = message.scanId ?? crypto.randomUUID();
  const controller = new AbortController();
  controllers.set(scanId, controller);

  void scanApplication({
    scanId,
    document,
    signal: controller.signal,
    onProgress: (progress) => notifyProgress({ type: 'SCAN_PROGRESS', progress }),
  })
    .then((result) => {
      sendResponse(scanCompleteMessageSchema.parse({ type: 'SCAN_COMPLETE', result }));
    })
    .catch((cause: unknown) => {
      const aborted =
        controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      const pageChanged = cause instanceof DOMException && cause.name === 'InvalidStateError';
      const error = scanError(
        aborted
          ? 'SCAN_CANCELLED'
          : pageChanged
            ? 'PAGE_CHANGED_DURING_SCAN'
            : 'ATS_DETECTION_FAILED',
        aborted
          ? 'The application scan was cancelled.'
          : pageChanged
            ? 'The application page changed while it was being scanned.'
            : `The read-only scanner failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { scanId },
      );
      sendResponse(scanFailedMessageSchema.parse({ type: 'SCAN_FAILED', scanId, error }));
    })
    .finally(() => controllers.delete(scanId));

  return true;
}

if (!alreadyLoaded) {
  chrome.runtime.onMessage.addListener(handleMessage);

  // Listening costs nothing on a page that never posts a bundle, and it means
  // the user never has to have the popup open for the handoff to land.
  startBundleBridge();

  /**
   * Tells the worker this page exists, so a run armed by "Apply with Agent" can
   * begin without the user opening the popup and clicking a second button.
   *
   * Sent from the main frame only. A subframe announcing itself would arm a run
   * against a document that is a fragment of the application, and the worker has
   * no way to tell the two apart from the message alone.
   */
  if (window.top === window) {
    void chrome.runtime.sendMessage({ type: 'PAGE_READY', url: window.location.href }).catch(() => {
      // No worker listening yet. The popup opening will reach the same code.
    });
  }
}
