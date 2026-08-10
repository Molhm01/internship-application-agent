import type { ErrorCode } from '@internship-agent/shared';
import { countBlocks, findBlocks, type RepeaterSection } from './repeaterScanner.js';
import type { SectionBinding } from './repeaterBinder.js';

/**
 * Checking that the section really ended up the way the plan said it would.
 *
 * A function returning successfully is not evidence a block exists. This reads
 * the page back and says what is actually there — which is the only reason the
 * report can distinguish "three jobs are on this application" from "three Add
 * presses were issued".
 */

export interface SectionVerification {
  /** Blocks present now, counted from the page. */
  blocksNow: number;
  /** Bindings whose block still exists and is still bound to that record. */
  blocksVerified: number;
  errorCode?: ErrorCode;
}

/**
 * Verifies one section after growth.
 *
 * `REPEATER_RECORD_COUNT_MISMATCH` is reported only when the page ended up with
 * fewer blocks than there are placeable records — a section with *more* blocks
 * than records is not a mismatch, it is a form offering an optional extra, and
 * an empty optional block is finished work rather than outstanding work.
 */
export function verifySection(
  section: RepeaterSection,
  binding: SectionBinding,
  recordCount: number,
): SectionVerification {
  const blocksNow = countBlocks(section);
  const blocks = findBlocks(section);

  let verified = 0;
  for (const entry of binding.bindings) {
    if (entry.blockIndex === undefined) continue;
    // Present, and still this record's. A page that re-rendered the section and
    // dropped our marks has not verified, whatever its block count says.
    if (blocks.some((block) => block.index === entry.blockIndex)) verified += 1;
  }

  if (binding.conflictingBlockIndexes.length > 0) {
    return { blocksNow, blocksVerified: verified, errorCode: 'REPEATER_BINDING_REQUIRES_REVIEW' };
  }
  const placeable = Math.min(recordCount, Math.max(recordCount, blocksNow));
  if (blocksNow < placeable && binding.unplacedRecordIndexes.length > 0) {
    return { blocksNow, blocksVerified: verified, errorCode: 'REPEATER_RECORD_COUNT_MISMATCH' };
  }
  return { blocksNow, blocksVerified: verified };
}
