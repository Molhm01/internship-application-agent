import type { RepeaterBinding, RepeaterKind, RepeaterRecordHint } from '@internship-agent/shared';
import { repeaterBindingSchema } from '@internship-agent/shared';
import { matchRecordsToBlocks, type BlockState } from './repeaterMatcher.js';
import { findBlocks, type RepeaterBlock, type RepeaterSection } from './repeaterScanner.js';

/**
 * Holding the record-to-block assignment for the life of one run, and marking
 * the page so the rest of the pipeline can see it.
 *
 * The binding has to outlive the moment it is made. Blocks are created on the
 * first pass and filled on the pass after, and between those two the page is
 * rescanned — so an assignment kept only in a local variable would be gone by
 * the time anything used it. It is written onto the block element itself, where
 * a rescan finds it.
 *
 * The attribute is read-only to everything else and carries an index, never a
 * value. A page that inspects its own DOM learns that this block is the second
 * of something; it does not learn what.
 */

/** Marks a block with the record it is bound to. Namespaced so it is ours. */
export const BLOCK_RECORD_ATTRIBUTE = 'data-agent-record-index';
export const BLOCK_ID_ATTRIBUTE = 'data-agent-block-id';

export interface SectionBinding {
  kind: RepeaterKind;
  bindings: RepeaterBinding[];
  /** Records with no block. Each is one Add press the section still needs. */
  unplacedRecordIndexes: number[];
  /** Blocks holding the applicant's own text. Never written to. */
  conflictingBlockIndexes: number[];
  blocks: RepeaterBlock[];
}

function stateOf(blocks: readonly RepeaterBlock[]): BlockState[] {
  return blocks.map((block) => {
    const marked = block.element.getAttribute(BLOCK_RECORD_ATTRIBUTE);
    const parsed = marked === null ? Number.NaN : Number.parseInt(marked, 10);
    return {
      blockIndex: block.index,
      blockId: block.blockId,
      anchorValue: block.anchorValue,
      ...(Number.isInteger(parsed) && parsed >= 0 ? { boundRecordIndex: parsed } : {}),
    };
  });
}

/**
 * Works out, and records on the page, which record each block holds.
 *
 * Called twice per section: once before any block is created, to find out how
 * many are missing, and once after, to bind the new ones. Both calls run the
 * same matcher over the same rules, so a block created on the second call is
 * bound by exactly the reasoning that would have bound it had the page shipped
 * with it.
 */
export function bindSection(
  section: RepeaterSection,
  records: readonly RepeaterRecordHint[],
): SectionBinding {
  const blocks = findBlocks(section);
  const outcome = matchRecordsToBlocks(records, stateOf(blocks));

  const bindings: RepeaterBinding[] = outcome.assignments.map((assignment) =>
    repeaterBindingSchema.parse({
      recordIndex: assignment.recordIndex,
      ...(assignment.blockIndex === undefined ? {} : { blockIndex: assignment.blockIndex }),
      ...(assignment.blockId === undefined ? {} : { blockId: assignment.blockId }),
      ...(assignment.reason === undefined ? {} : { reason: assignment.reason }),
    }),
  );

  // Stamped on the element so the pass that fills it can tell which record it
  // is for, and so a human reading the DOM in devtools can see the same thing.
  for (const assignment of outcome.assignments) {
    if (assignment.blockIndex === undefined) continue;
    const block = blocks.find((candidate) => candidate.index === assignment.blockIndex);
    if (!block) continue;
    block.element.setAttribute(BLOCK_RECORD_ATTRIBUTE, String(assignment.recordIndex));
    block.element.setAttribute(BLOCK_ID_ATTRIBUTE, block.blockId);
  }

  return {
    kind: section.kind,
    bindings,
    unplacedRecordIndexes: outcome.unplacedRecordIndexes,
    conflictingBlockIndexes: outcome.conflictingBlockIndexes,
    blocks,
  };
}

/**
 * The record a block was bound to, read back off the page.
 *
 * Used by the verifier and by anything that has to answer "whose block is this?"
 * after a rescan replaced every element handle the binder was holding.
 */
export function boundRecordIndex(element: HTMLElement): number | null {
  const raw = element.closest(`[${BLOCK_RECORD_ATTRIBUTE}]`)?.getAttribute(BLOCK_RECORD_ATTRIBUTE);
  if (raw === null || raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
