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
} from '@internship-agent/shared';
import type { ContentPingResult, ExtensionMessage } from '../messaging/messages.js';
import { scanApplication } from '../scanner/scanApplication.js';
import { ATS_ADAPTERS } from '../scanner/adapters.js';
import { completeReport, createRunningReport } from '../reporter/fillReporter.js';
import { validatePageIdentity } from '../executor/pageProtection.js';
import { startBundleBridge } from './bundleBridge.js';

const controllers = new Map<string, AbortController>();
const fillControllers = new Map<string, AbortController>();

// Listening costs nothing on a page that never posts a bundle, and it means the
// user never has to have the popup open for the handoff to land.
startBundleBridge();

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

chrome.runtime.onMessage.addListener((raw: ExtensionMessage, _sender, sendResponse) => {
  if (raw?.type === 'CONTENT_PING') {
    const result: ContentPingResult = {
      present: true,
      url: window.location.href,
      fieldsDetected: null,
    };
    sendResponse(result);
    return false;
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
      if (!validatePageIdentity(window.location.href, message.scan, message.plan).valid) {
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
});
