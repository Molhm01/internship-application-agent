import {
  fillExecutionResponseSchema,
  fillRunReportSchema,
  type ApplicationScanResult,
  type DeterministicFillPlan,
  type DocumentContentResponse,
  type FillExecutionResult,
  type FillRunReport,
} from '@internship-agent/shared';
import { sendToFrame, type FrameTarget } from './frames.js';
import { frameIdOf } from './mergeFrameScans.js';

/**
 * Running one fill plan across the frames its fields actually live in.
 *
 * A plan is not a plan for a page; it is a plan for a set of controls, and those
 * controls can be in different documents. Sending the whole plan to the top
 * frame means every action aimed at an embedded widget resolves to nothing and
 * is reported as "the scanned field was not found" — a message that blames the
 * page for an addressing mistake made here.
 *
 * So the plan is sliced by the frame each field was discovered in, each slice is
 * sent to that frame alone, and the results are reassembled in the plan's
 * original order. A frame that has gone away fails only its own actions.
 */

export interface FillAcrossFramesInput {
  tabId: number;
  frames: readonly FrameTarget[];
  scan: ApplicationScanResult;
  plan: DeterministicFillPlan;
  documentContents: readonly DocumentContentResponse[];
  runId: string;
}

/**
 * A result for an action whose frame could not be reached.
 *
 * Reported as a failure with the frame named, rather than omitted. An action
 * missing from a report is indistinguishable from an action that was never
 * planned, and that is how a half-filled form comes back looking complete.
 */
function unreachable(
  action: DeterministicFillPlan['actions'][number],
  frameId: number,
  reason: string,
): FillExecutionResult {
  return {
    actionId: action.id,
    fieldId: action.fieldId,
    status: 'failed',
    expectedValue: action.proposedValue,
    attempts: 0,
    durationMs: 0,
    error: {
      code: 'FIELD_NOT_FOUND',
      message: `The frame holding this field (frame ${frameId}) could not be reached: ${reason}`,
      fieldId: action.fieldId,
      recoverable: true,
      suggestedAction: 'Refresh the application page and run the fill again.',
      debugContext: { frameId },
    },
  };
}

/**
 * Executes the plan, frame by frame, and returns one report.
 *
 * The returned report keeps the plan's own action order, so the popup renders
 * the same sequence the user approved rather than a frame-grouped one.
 */
export async function fillAcrossFrames(
  input: FillAcrossFramesInput,
): Promise<{ report: FillRunReport } | { error: string }> {
  const frameOfField = new Map<string, number>(
    input.scan.fields.map((field) => [field.id, frameIdOf(field)]),
  );

  // Grouped in first-seen order so the main frame, which is normally frame 0 and
  // normally first, is filled first — the order a person would work in.
  const groups = new Map<number, DeterministicFillPlan['actions'][number][]>();
  for (const action of input.plan.actions) {
    const frameId = frameOfField.get(action.fieldId) ?? 0;
    const existing = groups.get(frameId);
    if (existing) existing.push(action);
    else groups.set(frameId, [action]);
  }

  const results = new Map<string, FillExecutionResult>();
  let anyFrameAnswered = false;
  let lastError: string | null = null;

  for (const [frameId, actions] of groups) {
    const frame = input.frames.find((candidate) => candidate.frameId === frameId);
    if (!frame) {
      for (const action of actions) {
        results.set(action.id, unreachable(action, frameId, 'the frame is no longer in the tab'));
      }
      continue;
    }

    const slice: DeterministicFillPlan = {
      ...input.plan,
      actions,
      // A frame is only ever given the fields it owns. It has no use for the
      // others and no way to act on them.
    };
    const scanSlice: ApplicationScanResult = {
      ...input.scan,
      fields: input.scan.fields.filter((field) => frameIdOf(field) === frameId),
    };

    let raw: unknown;
    try {
      raw = await sendToFrame(input.tabId, frameId, {
        type: 'EXECUTE_FILL_PLAN',
        runId: input.runId,
        scan: scanSlice,
        plan: slice,
        documentContents: input.documentContents,
        // Checked by the frame against its own location. Omitted for the main
        // frame so its identity check stays exactly as strict as before.
        ...(frameId === 0 ? {} : { frameUrl: frame.url }),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      lastError = reason;
      for (const action of actions) results.set(action.id, unreachable(action, frameId, reason));
      continue;
    }

    const parsed = fillExecutionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      lastError = 'the frame returned a fill result that failed validation';
      for (const action of actions) results.set(action.id, unreachable(action, frameId, lastError));
      continue;
    }
    if (parsed.data.type === 'FILL_FAILED') {
      lastError = parsed.data.error.message;
      for (const action of actions) results.set(action.id, unreachable(action, frameId, lastError));
      continue;
    }

    anyFrameAnswered = true;
    for (const result of parsed.data.report.results) results.set(result.actionId, result);
  }

  if (!anyFrameAnswered && results.size === 0) {
    return { error: lastError ?? 'No frame of this page accepted the fill plan.' };
  }

  const ordered = input.plan.actions
    .map((action) => results.get(action.id))
    .filter((result): result is FillExecutionResult => result !== undefined);

  const failed = ordered.filter(
    (result) => result.status === 'failed' || result.status === 'filled_unverified',
  ).length;
  const cancelled = ordered.some((result) => result.status === 'cancelled');

  return {
    report: fillRunReportSchema.parse({
      id: input.runId,
      planId: input.plan.id,
      scanId: input.scan.id,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      url: input.scan.url,
      ats: input.scan.ats.id,
      totalActions: input.plan.actions.length,
      approvedActions: input.plan.actions.filter((action) => action.approved).length,
      verifiedActions: ordered.filter((result) => result.status === 'verified').length,
      failedActions: failed,
      reviewActions: ordered.filter((result) => result.status === 'needs_review').length,
      skippedActions: ordered.filter((result) => result.status === 'skipped').length,
      unsupportedActions: ordered.filter((result) => result.status === 'unsupported').length,
      status: cancelled ? 'cancelled' : failed ? 'completed_with_errors' : 'completed',
      results: ordered,
      warnings: ['No application was submitted. Review the application and continue manually.'],
      submitted: false,
    }),
  };
}
