import type { RepeaterBindReason, RepeaterRecordHint } from '@internship-agent/shared';

/**
 * Deciding which saved record belongs in which block on the page.
 *
 * Pure: it is given what each block currently holds and what each record is
 * called, and it returns an assignment. No DOM, no pressing, no writing — so the
 * rule that decides whether somebody's typing gets overwritten can be read in
 * one file and tested without a browser.
 *
 * The rule, in order of precedence:
 *
 *  1. **A block already holding a record's name belongs to that record.** This is
 *     what makes a second Autofill run a no-op instead of a duplicate: the three
 *     blocks the first run filled are recognised as the three records they hold.
 *  2. **An empty block is free.** The next record with nowhere to go takes it.
 *  3. **A block holding something that matches no record is left alone.** The
 *     applicant typed it. It is reported as needing review and never written to,
 *     because the alternative is destroying their work to make room for ours.
 *
 * Order within (2) is page order against profile order, and both are stable, so
 * the same profile against the same page produces the same assignment every run.
 */

/** One block, reduced to what the assignment depends on. */
export interface BlockState {
  blockIndex: number;
  blockId: string;
  /** What the block's anchor control holds. Empty means unused. */
  anchorValue: string;
  /**
   * The record an earlier run in this session already bound this block to, read
   * back off the page.
   *
   * Stronger evidence than the anchor value and checked before it, because the
   * value is not always there to check. An Education block's anchor is the
   * School dropdown, which has no options at all until Country and then State
   * have been answered — so a first run that grew the section but could not
   * complete that chain leaves two blocks holding nothing, and a second run
   * matching on values alone sees two empty blocks, gives one to each record,
   * finds one record still unplaced, and presses Add. That is a duplicate
   * education entry produced by pressing Autofill twice, which is the exact
   * failure this engine exists to prevent.
   */
  boundRecordIndex?: number;
}

export interface Assignment {
  recordIndex: number;
  blockIndex?: number;
  blockId?: string;
  reason?: RepeaterBindReason;
}

export interface MatchOutcome {
  assignments: Assignment[];
  /** Records with no block yet. Each one is an Add press the section needs. */
  unplacedRecordIndexes: number[];
  /** Blocks holding the applicant's own text that matches no saved record. */
  conflictingBlockIndexes: number[];
  /** Blocks no record needs. Left completely alone. */
  surplusBlockIndexes: number[];
}

/**
 * Loose enough to survive the round trip through a form, strict enough not to
 * collide.
 *
 * A page routinely returns "Acme Corp." as "Acme Corp" or "ACME CORP", and a
 * comparison that called those different would press Add and duplicate the job.
 * Punctuation and case go; the words stay.
 */
export function normalizeAnchor(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'"()]/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|university|college|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a block's current contents are this record.
 *
 * Equality after normalizing, or one containing the other — a form that stores
 * "University of Michigan" against a saved "Michigan" is the same school, and
 * treating it as a different one adds a second education block for a degree the
 * applicant has once.
 */
function isSameRecord(blockValue: string, recordValue: string): boolean {
  const block = normalizeAnchor(blockValue);
  const record = normalizeAnchor(recordValue);
  if (!block || !record) return false;
  if (block === record) return true;
  // Guarded by length so two short strings do not match on a shared syllable.
  const shorter = block.length <= record.length ? block : record;
  const longer = shorter === block ? record : block;
  return shorter.length >= 4 && longer.includes(shorter);
}

/**
 * Assigns records to blocks.
 *
 * Total: every record gets exactly one entry, whether or not it found a block.
 * A record without a `blockIndex` is one the section still has to grow for, and
 * saying so is the difference between "you have one job" and "this page only had
 * room for one".
 */
export function matchRecordsToBlocks(
  records: readonly RepeaterRecordHint[],
  blocks: readonly BlockState[],
): MatchOutcome {
  const assignments: Assignment[] = [];
  const claimed = new Set<number>();
  const byRecord = new Map<number, Assignment>();

  // Pass zero: a block this session already bound to this record. Honoured
  // before values are looked at, because a block that was bound and then could
  // not be filled still belongs to its record.
  for (const record of records) {
    const marked = blocks.find(
      (block) => !claimed.has(block.blockIndex) && block.boundRecordIndex === record.recordIndex,
    );
    if (!marked) continue;
    claimed.add(marked.blockIndex);
    byRecord.set(record.recordIndex, {
      recordIndex: record.recordIndex,
      blockIndex: marked.blockIndex,
      blockId: marked.blockId,
      reason: 'MATCHED_BY_VALUE',
    });
  }

  // Pass one: a block that already holds this record. Done for every record
  // before any empty block is handed out, so a record whose block sits third
  // does not first get given the empty one in position one.
  for (const record of records) {
    if (byRecord.has(record.recordIndex)) continue;
    if (!record.anchorValue) continue;
    const held = blocks.find(
      (block) =>
        !claimed.has(block.blockIndex) && isSameRecord(block.anchorValue, record.anchorValue),
    );
    if (!held) continue;
    claimed.add(held.blockIndex);
    const assignment: Assignment = {
      recordIndex: record.recordIndex,
      blockIndex: held.blockIndex,
      blockId: held.blockId,
      reason: 'MATCHED_BY_VALUE',
    };
    byRecord.set(record.recordIndex, assignment);
  }

  // Pass two: empty blocks, in page order, to records still without one.
  const empties = blocks.filter(
    (block) => !claimed.has(block.blockIndex) && normalizeAnchor(block.anchorValue) === '',
  );
  let nextEmpty = 0;
  for (const record of records) {
    if (byRecord.has(record.recordIndex)) continue;
    const empty = empties[nextEmpty];
    if (!empty) continue;
    nextEmpty += 1;
    claimed.add(empty.blockIndex);
    byRecord.set(record.recordIndex, {
      recordIndex: record.recordIndex,
      blockIndex: empty.blockIndex,
      blockId: empty.blockId,
      reason: 'ASSIGNED_TO_EMPTY',
    });
  }

  for (const record of records) {
    assignments.push(byRecord.get(record.recordIndex) ?? { recordIndex: record.recordIndex });
  }

  const unplacedRecordIndexes = assignments
    .filter((assignment) => assignment.blockIndex === undefined)
    .map((assignment) => assignment.recordIndex);

  // A block nobody claimed that still holds text is the applicant's own work.
  const conflictingBlockIndexes = blocks
    .filter((block) => !claimed.has(block.blockIndex) && normalizeAnchor(block.anchorValue) !== '')
    .map((block) => block.blockIndex);

  const surplusBlockIndexes = blocks
    .filter((block) => !claimed.has(block.blockIndex) && normalizeAnchor(block.anchorValue) === '')
    .map((block) => block.blockIndex);

  return {
    assignments,
    unplacedRecordIndexes,
    conflictingBlockIndexes,
    surplusBlockIndexes,
  };
}
