import type { ErrorCode } from '@internship-agent/shared';
import { pressPointer } from '../scanner/optionDiscovery.js';
import {
  countBlocks,
  findAddControl,
  findBlocks,
  fingerprint,
  type RepeaterBlock,
  type RepeaterSection,
} from './repeaterScanner.js';

/**
 * Pressing Add, once, and finding out what the page did about it.
 *
 * Everything here is observation. It presses a control the page already has and
 * then *counts* — it never assumes a press worked, never presses twice to make
 * up for a press that seemed slow, and never reports a block it did not see.
 *
 * That is the whole difference between this and a loop that clicks Add three
 * times and hopes. A page that answers one press with two blocks, a page that
 * answers with none, and a page that answers after 1.8 seconds are three real
 * behaviours; a burst of clicks turns the first into a duplicated job history
 * and the third into a lost record.
 */

/** How long one press is given to produce a block. */
export const ADD_WAIT_MS = 2000;
/** One bounded retry, for a page that re-renders the control mid-press. */
export const ADD_RETRY_WAIT_MS = 1500;
const POLL_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateOutcome {
  /** Blocks the page actually produced. 0, 1, or — on a misbehaving page — more. */
  created: number;
  /** Blocks beyond the one that was asked for. Reported, never filled. */
  duplicates: number;
  /** The new block, when exactly one appeared. */
  block?: RepeaterBlock;
  clicksAttempted: number;
  errorCode?: ErrorCode;
}

/**
 * Waits for the section's block count to rise above `before`.
 *
 * Polls rather than using a MutationObserver, and deliberately: the question is
 * not "did the DOM change" — a framework changes the DOM constantly — but "does
 * this section now hold another employer question", which is a count, and a
 * count is what the wait has to be bounded on.
 */
async function waitForGrowth(
  section: RepeaterSection,
  before: number,
  budgetMs: number,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const now = countBlocks(section);
    if (now > before) return now;
    if (Date.now() >= deadline) return now;
    await sleep(POLL_MS);
  }
}

/**
 * Adds exactly one block to a section.
 *
 * Returns what happened rather than throwing, because "the page would not grow"
 * is a fact the report has to carry per section — a failure to add a third job
 * must not cost the applicant the two that did fit.
 */
export async function createBlock(section: RepeaterSection): Promise<CreateOutcome> {
  const before = countBlocks(section);
  const knownFingerprints = new Set(findBlocks(section).map(fingerprint));

  const control = findAddControl(section);
  if (!control) {
    return { created: 0, duplicates: 0, clicksAttempted: 0, errorCode: 'REPEATER_ADD_NOT_FOUND' };
  }

  // Scrolled into view before it is pressed. A control the page has virtualized
  // out of the viewport can receive a synthetic click and do nothing with it,
  // and that failure looks identical to a control that does not work at all.
  try {
    control.scrollIntoView({ block: 'center', behavior: 'auto' });
  } catch {
    // A jsdom or a page without smooth-scroll support. Not a reason to stop:
    // the press below is what matters and it does not depend on this.
  }

  let clicks = 0;
  let after = before;
  for (const budget of [ADD_WAIT_MS, ADD_RETRY_WAIT_MS]) {
    // Re-resolved each attempt. A framework that re-renders the section in
    // response to the first press leaves the old handle pointing at an element
    // no longer in the document, and pressing that is a press into nothing.
    const live = findAddControl(section) ?? control;
    if (!live.isConnected) {
      return {
        created: 0,
        duplicates: 0,
        clicksAttempted: clicks,
        errorCode: 'REPEATER_ADD_CLICK_FAILED',
      };
    }

    try {
      pressPointer(live);
    } catch {
      return {
        created: 0,
        duplicates: 0,
        clicksAttempted: clicks,
        errorCode: 'REPEATER_ADD_CLICK_FAILED',
      };
    }
    clicks += 1;

    after = await waitForGrowth(section, before, budget);
    if (after > before) break;
  }

  if (after <= before) {
    return {
      created: 0,
      duplicates: 0,
      clicksAttempted: clicks,
      // Two presses, both observed, neither produced a block. The count is what
      // was watched, so this is the count-specific code rather than the generic
      // "not created" one.
      errorCode: clicks > 1 ? 'REPEATER_BLOCK_COUNT_UNCHANGED' : 'REPEATER_BLOCK_NOT_CREATED',
    };
  }

  const created = after - before;
  const blocks = findBlocks(section);
  // The block whose fingerprint was not there before. Falls back to position
  // when a vendor clones a block without renaming its controls, which makes
  // every fingerprint identical and position the only thing left to go on.
  const fresh =
    blocks.find((block) => !knownFingerprints.has(fingerprint(block))) ?? blocks[before];

  return {
    created,
    duplicates: Math.max(0, created - 1),
    ...(fresh ? { block: fresh } : {}),
    clicksAttempted: clicks,
    // More than one block from one press is not a failure to add — it is a
    // failure to add *one*, and the extra is left empty rather than filled with
    // a record it does not correspond to.
    ...(created > 1 ? { errorCode: 'REPEATER_DUPLICATE_BLOCK' as const } : {}),
  };
}
