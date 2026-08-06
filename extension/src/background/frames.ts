import { RECONNECT_MESSAGE } from '@internship-agent/shared';
import type { ContentPingResult } from '../messaging/messages.js';

/**
 * Reaching every frame of an application, and addressing exactly one.
 *
 * An application is routinely not one document. iCIMS, Workday and
 * SmartRecruiters render the upload section — and sometimes the entire form —
 * inside an iframe, and a `document.querySelectorAll` in the top frame does not
 * cross that boundary. The old build declared `all_frames: false` and reinjected
 * with `allFrames: false`, so a page showing four upload buttons genuinely
 * contained zero file inputs as far as the extension could see.
 *
 * The second half matters just as much. `chrome.tabs.sendMessage(tabId, msg)`
 * with no `frameId` broadcasts to every listening frame and resolves with
 * whichever answers first. Injecting into all frames without also routing by
 * `frameId` would therefore have traded "always the top frame" for "an
 * arbitrary frame", so both changes belong to one repair: discovery returns
 * frame ids, and every subsequent message names one.
 */

export interface FrameTarget {
  frameId: number;
  url: string;
  topFrame: boolean;
  /** The build actually executing in that frame, when it answered a ping. */
  buildId?: string;
}

/** Chrome's id for a tab's main frame. Fixed by the platform, not a guess. */
export const MAIN_FRAME_ID = 0;

/** A page the browser will never let a content script run on. */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

async function pingFrame(tabId: number, frameId: number): Promise<ContentPingResult | null> {
  try {
    const response: unknown = await chrome.tabs.sendMessage(
      tabId,
      { type: 'CONTENT_PING' },
      { frameId },
    );
    if (!response || typeof response !== 'object') return null;
    return response as ContentPingResult;
  } catch {
    // "No receiving end" for one frame is ordinary — a frame may be
    // `about:blank`, a cross-origin ad slot, or still loading. The other frames
    // are unaffected, which is the whole reason this is per-frame.
    return null;
  }
}

/**
 * Every frame of the tab that now holds a live content script.
 *
 * Injection is the enumeration: `executeScript` with `allFrames: true` reports
 * one `InjectionResult` per frame it reached, each carrying its `frameId`.
 * Frames the manifest does not cover simply do not appear, which is the honest
 * answer — they are not reachable and pretending otherwise would produce a plan
 * addressed to a frame that cannot act on it.
 *
 * Re-injection is safe: the content script guards against loading twice, so a
 * frame that already had it keeps its single listener.
 */
export async function discoverFrames(tabId: number, tabUrl?: string): Promise<FrameTarget[]> {
  if (!isInjectablePage(tabUrl)) return [];

  let injected: chrome.scripting.InjectionResult[] = [];
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (cause) {
    // The whole call failing means the top frame is off limits. Fall back to
    // the main frame alone so a page that was already injected by the manifest
    // still works, rather than reporting a tab with no frames at all.
    console.warn('[agent] all-frame injection refused', {
      tabId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    const main = await pingFrame(tabId, MAIN_FRAME_ID);
    return main
      ? [
          {
            frameId: MAIN_FRAME_ID,
            url: main.url,
            topFrame: true,
            ...(main.buildId ? { buildId: main.buildId } : {}),
          },
        ]
      : [];
  }

  const frames: FrameTarget[] = [];
  for (const result of injected) {
    const frameId = result.frameId ?? MAIN_FRAME_ID;
    const ping = await pingFrame(tabId, frameId);
    // A frame that took the script but does not answer is not a frame we can
    // send work to, so it is not reported as one.
    if (!ping) continue;
    frames.push({
      frameId,
      url: ping.url,
      topFrame: frameId === MAIN_FRAME_ID,
      ...(ping.buildId ? { buildId: ping.buildId } : {}),
    });
  }
  // Main frame first, so a merged scan reads in the order a person sees the page.
  frames.sort((left, right) => left.frameId - right.frameId);
  return frames;
}

/** Sends one message to one frame. Never a broadcast. */
export async function sendToFrame(
  tabId: number,
  frameId: number,
  message: unknown,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

export interface FrameReply<T> {
  frame: FrameTarget;
  response: T | null;
  /** Present when the frame did not answer. Sanitized. */
  reason?: string;
}

/**
 * Asks every frame the same question and keeps each answer beside its frame.
 *
 * Sequential rather than parallel. A frame that activates an upload launcher
 * can open the browser's file chooser, and doing that in six frames at once is
 * both useless and hostile; the work is small and bounded either way.
 */
export async function askEveryFrame<T>(
  tabId: number,
  frames: readonly FrameTarget[],
  message: unknown,
): Promise<Array<FrameReply<T>>> {
  const replies: Array<FrameReply<T>> = [];
  for (const frame of frames) {
    try {
      const response = (await sendToFrame(tabId, frame.frameId, message)) as T;
      replies.push({ frame, response });
    } catch (cause) {
      replies.push({
        frame,
        response: null,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return replies;
}

/**
 * Best-effort fire-and-forget to every frame, for messages with nothing to say
 * back — clearing highlights, cancelling a run.
 */
export async function tellEveryFrame(
  tabId: number,
  frames: readonly FrameTarget[],
  message: unknown,
): Promise<void> {
  await Promise.allSettled(
    frames.map((frame) => chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId })),
  );
}

export const FRAMES_UNREACHABLE_MESSAGE = RECONNECT_MESSAGE;
