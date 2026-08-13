import {
  pageObservationSchema,
  toolExecutionResultSchema,
  type AgentToolCall,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { sendToFrame, type FrameTarget } from './frames.js';

/**
 * The agent's two conversations with a page, routed to the frame that owns it.
 *
 * Deliberately thin. Everything interesting happens in the loop (which frame
 * to talk to is not an interesting decision) and in the frame (which is the
 * only place that can see the DOM). This is the wire between them.
 *
 * ## Why the top frame leads
 *
 * An application split across frames is still one application, and the agent
 * reasons about one observation at a time. So the frames are observed in order
 * and their elements concatenated with the frame id stamped on each — the
 * handle a decision names carries its own frame, and the action goes back to
 * exactly that frame. Discovering in one frame and executing in another is how
 * a selector resolves to a different control with the same name.
 */

export interface AgentFrameInput {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
}

/** Which frame issued a handle, so the action goes back to the same document. */
const frameByHandle = new Map<string, number>();

/**
 * One observation of the whole application, frames included.
 *
 * Handles are namespaced per frame (`f2:e17`) so two frames cannot mint the
 * same one — the failure that would let a decision about frame 2's Country be
 * executed against frame 0's.
 */
export async function observeAcrossFrames(
  input: AgentFrameInput,
  context: {
    proposedValues: Record<string, string>;
    recordCounts: { experience: number; education: number };
    dependencyActive: Record<string, boolean>;
    classificationDiagnostics?: boolean;
  },
): Promise<PageObservation> {
  frameByHandle.clear();
  const elements: PageObservation['elements'] = [];
  const repeaters: PageObservation['repeaters'] = [];
  const navigation: PageObservation['navigation'] = [];
  const sections: string[] = [];
  let origin = '';
  let title = '';
  let observationId = '';

  for (const frame of input.frames) {
    let reply: unknown;
    try {
      reply = await sendToFrame(input.tabId, frame.frameId, {
        type: 'AGENT_OBSERVE',
        runId: input.runId,
        proposedValues: context.proposedValues,
        recordCounts: context.recordCounts,
        dependencyActive: context.dependencyActive,
        classificationDiagnostics: context.classificationDiagnostics ?? false,
      });
    } catch {
      // A frame that cannot be reached contributes nothing rather than failing
      // the observation. The agent works with what it can see.
      continue;
    }
    const parsed = pageObservationSchema.safeParse(reply);
    if (!parsed.success) continue;

    const namespace = (handle: string): string => {
      const scoped = `f${frame.frameId}:${handle}`;
      frameByHandle.set(scoped, frame.frameId);
      return scoped;
    };

    if (!observationId) {
      observationId = parsed.data.observationId;
      origin = parsed.data.origin;
      title = parsed.data.title;
    }
    for (const section of parsed.data.sections) {
      if (!sections.includes(section)) sections.push(section);
    }
    for (const element of parsed.data.elements) {
      elements.push({
        ...element,
        elementId: namespace(element.elementId),
        ...(element.dependsOnElementId
          ? { dependsOnElementId: `f${frame.frameId}:${element.dependsOnElementId}` }
          : {}),
        ...(element.searchInputId
          ? { searchInputId: namespace(element.searchInputId) }
          : {}),
        ...(element.searchInputFor
          ? { searchInputFor: `f${frame.frameId}:${element.searchInputFor}` }
          : {}),
        frameId: frame.frameId,
      });
    }
    for (const repeater of parsed.data.repeaters) {
      repeaters.push({
        ...repeater,
        elementId: namespace(repeater.elementId),
        frameId: frame.frameId,
      });
    }
    for (const entry of parsed.data.navigation) {
      navigation.push({ ...entry, elementId: namespace(entry.elementId), frameId: frame.frameId });
    }
  }

  return pageObservationSchema.parse({
    observationId: observationId || `obs-${Date.now()}`,
    origin,
    title,
    sections,
    elements,
    repeaters,
    navigation,
    requiredOutstanding: elements.filter(
      (element) => element.required && element.currentValue.trim().length === 0 && element.visible,
    ).length,
    takenAt: new Date().toISOString(),
  });
}

/**
 * Runs one tool in the frame that issued its handle.
 *
 * A call naming a handle no frame issued reaches no frame at all, which is the
 * routing half of the same guarantee the handles give: a decision can only
 * touch a control some frame volunteered during the current observation.
 */
export async function executeAcrossFrames(
  input: AgentFrameInput,
  call: AgentToolCall,
): Promise<ToolExecutionResult> {
  const frameId = call.elementId ? frameByHandle.get(call.elementId) : 0;
  if (frameId === undefined) {
    return toolExecutionResultSchema.parse({
      tool: call.tool,
      executed: false,
      errorCode: 'CONTROL_NOT_FOUND',
      reason: 'That element was not offered by any frame in the current observation.',
    });
  }
  // The frame receives the handle without its namespace, because the namespace
  // is a fact about routing rather than about the page.
  const local = call.elementId?.replace(/^f\d+:/, '');
  try {
    const reply = await sendToFrame(input.tabId, frameId, {
      type: 'AGENT_EXECUTE_TOOL',
      runId: input.runId,
      call: { ...call, ...(local ? { elementId: local } : {}) },
    });
    const parsed = toolExecutionResultSchema.safeParse(reply);
    if (!parsed.success) {
      return toolExecutionResultSchema.parse({
        tool: call.tool,
        executed: false,
        errorCode: 'CONTENT_SCRIPT_UNAVAILABLE',
        reason: 'The frame did not answer with a usable result.',
      });
    }
    return parsed.data;
  } catch {
    return toolExecutionResultSchema.parse({
      tool: call.tool,
      executed: false,
      errorCode: 'CONTENT_SCRIPT_UNAVAILABLE',
      reason: `Frame ${frameId} could not be reached.`,
    });
  }
}
