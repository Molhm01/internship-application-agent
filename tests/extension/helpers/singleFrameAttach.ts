import { attachAcrossFrames } from '../../../extension/src/background/attachAcrossFrames.js';
import { attachInFrame, discoverInFrame } from '../../../extension/src/uploads/frameUploads.js';
import type { FrameTarget } from '../../../extension/src/background/frames.js';
import type { AttachableDocumentPayload, DocumentAttachmentReport } from '@internship-agent/shared';

/**
 * A whole document run against the ambient jsdom document, through the real
 * orchestrator.
 *
 * The worker and the frame are the same process here, so `chrome.tabs.sendMessage`
 * is stubbed to hand each message straight to the content script's own handlers.
 * Everything else is the shipped code: the same discovery, the same
 * classification, the same `DataTransfer` assignment, the same DOM verification,
 * and the same two-phase frame protocol.
 *
 * That matters more than it sounds. These tests previously exercised a separate
 * single-frame implementation that no command could reach any more — so they
 * could have gone on passing indefinitely while the path users actually take was
 * broken, which is precisely the failure this repair began from.
 */

const FRAME: FrameTarget = {
  frameId: 0,
  url: 'https://jobs.example.com/apply',
  topFrame: true,
};

export function installSingleFrameChrome(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      sendMessage: async (
        _tabId: number,
        message: Record<string, unknown>,
        options?: { frameId?: number },
      ): Promise<unknown> => {
        // The production worker never broadcasts, and neither may the stub — a
        // stub that tolerated a missing frame id would hide a regression in the
        // one property this whole repair turns on.
        if (options?.frameId === undefined) throw new Error('message sent without a frameId');

        if (message.type === 'DISCOVER_UPLOAD_CONTROLS') {
          const survey = await discoverInFrame(
            document,
            String(message.runId),
            message.mayActivateLaunchers === true,
          );
          return {
            type: 'UPLOAD_CONTROLS',
            runId: String(message.runId),
            survey: { ...survey, frameId: 0 },
          };
        }

        if (message.type === 'ATTACH_DOCUMENT_TO_CONTROL') {
          const result = await attachInFrame(
            String(message.runId),
            String(message.controlId),
            message.document as AttachableDocumentPayload,
          );
          return {
            type: 'ATTACH_CONTROL_RESULT',
            runId: String(message.runId),
            attached: result.attached,
            verified: result.verified,
            failureCode: result.failureCode,
            message: result.message,
          };
        }

        throw new Error(`unexpected message ${String(message.type)}`);
      },
    },
  };
}

/** One "Attach Resume and Cover Letter" run against the current document. */
export async function runSingleFrameAttachment(
  runId: string,
  url: string,
  documents: readonly AttachableDocumentPayload[],
): Promise<DocumentAttachmentReport> {
  installSingleFrameChrome();
  return attachAcrossFrames({
    tabId: 1,
    url,
    frames: [{ ...FRAME, url }],
    documents,
    runId,
  });
}
