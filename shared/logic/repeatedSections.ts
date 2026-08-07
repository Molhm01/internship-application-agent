/**
 * Deciding how many repeated blocks an application needs, and which saved
 * record belongs in each one.
 *
 * A form offers one Work Experience block and an "Add" button. An applicant
 * with three jobs needs three blocks. Nothing created them, so two jobs never
 * reached the application at all — and because every "Company Name" control
 * shares one canonical question, the one block that did exist was answered from
 * `experience[0]` no matter which block it was.
 *
 * This module is the arithmetic, kept pure and away from the DOM so it can be
 * read and tested on its own: how many blocks exist, how many records there
 * are, how many times Add must be pressed, and what happened to each record.
 * The browser-side controller performs the pressing; it does not decide it.
 *
 * Two rules are load-bearing and neither is negotiable:
 *
 *  - **Never create a block for a record that does not exist.** An empty block
 *    the page already offers is not an unanswered question; it is a block the
 *    applicant does not need.
 *  - **Never map one record into two blocks.** That is a fabricated history,
 *    and it is what the page showed before this existed.
 */

/** A repeating section this engine knows how to drive. */
export const REPEATED_SECTION_KINDS = ['experience', 'education', 'projects'] as const;

export type RepeatedSectionKind = (typeof REPEATED_SECTION_KINDS)[number];

/** What became of one saved record. */
export const RECORD_MAPPING_STATUSES = [
  /** A block already on the page was assigned to it. */
  'MATCHED_EXISTING_BLOCK',
  /** Add was pressed and the new block was assigned to it. */
  'CREATED_NEW_BLOCK',
  /** The page will not accept more blocks, so this record has nowhere to go. */
  'BLOCK_LIMIT_REACHED',
  /** The application has no section of this kind at all. */
  'SKIPPED_NO_PAGE_SECTION',
  /** Add was pressed and no new block appeared. */
  'FAILED_TO_CREATE_BLOCK',
] as const;

export type RecordMappingStatus = (typeof RECORD_MAPPING_STATUSES)[number];

/** One saved record and the block it ended up in. */
export interface RecordMapping {
  /** Position in the profile array. Never the record's contents. */
  recordIndex: number;
  /** The block it was assigned to, when it got one. */
  blockIndex?: number;
  status: RecordMappingStatus;
}

export interface RepeatPlanInput {
  kind: RepeatedSectionKind;
  /** How many saved records the profile holds for this section. */
  recordCount: number;
  /** How many blocks the page is offering right now. */
  blockCount: number;
  /** Whether the page has an Add control for this section. */
  hasAddControl: boolean;
  /**
   * The most blocks this section may hold, when the page states one. Absent
   * means unstated, which is not the same as unlimited — `MAX_BLOCKS` still
   * applies, because a page that answers every Add with a new block and never
   * stops would otherwise be pressed until the record list ran out.
   */
  maxBlocks?: number;
}

/** A ceiling that holds even when the page states none. */
export const MAX_BLOCKS = 20;

export interface RepeatPlan {
  kind: RepeatedSectionKind;
  /** How many times Add must be pressed. Never more than this. */
  addPresses: number;
  /** How many blocks the section should end up with. */
  targetBlockCount: number;
  /** One entry per saved record, in profile order. */
  mappings: RecordMapping[];
  /**
   * Blocks the page offers that no record needs. Left completely alone — an
   * optional empty block is finished work, not outstanding work.
   */
  surplusBlockIndexes: number[];
  /** One sentence for the diagnostic, carrying counts and never contents. */
  summary: string;
}

/**
 * Works out the presses and the record-to-block assignment.
 *
 * Deterministic and total: every record gets exactly one mapping entry, and
 * every entry names either a block or the reason there is none.
 */
export function planRepeatedSection(input: RepeatPlanInput): RepeatPlan {
  const ceiling = Math.min(input.maxBlocks ?? MAX_BLOCKS, MAX_BLOCKS);
  const mappings: RecordMapping[] = [];

  // A page with no section of this kind is not a failure. An application that
  // does not ask about projects is not an application missing the projects.
  if (input.blockCount === 0 && !input.hasAddControl) {
    for (let index = 0; index < input.recordCount; index += 1) {
      mappings.push({ recordIndex: index, status: 'SKIPPED_NO_PAGE_SECTION' });
    }
    return {
      kind: input.kind,
      addPresses: 0,
      targetBlockCount: 0,
      mappings,
      surplusBlockIndexes: [],
      summary: `${input.kind}: ${input.recordCount} record(s), no section on this page.`,
    };
  }

  const reachable = Math.min(input.recordCount, ceiling);
  // Add is pressed only for records that have no block yet, and only when the
  // page offers an Add control. A page already showing more blocks than there
  // are records is never pressed at all.
  const addPresses = input.hasAddControl ? Math.max(0, reachable - input.blockCount) : 0;
  const targetBlockCount = Math.max(input.blockCount, input.blockCount + addPresses);

  for (let index = 0; index < input.recordCount; index += 1) {
    if (index >= ceiling) {
      mappings.push({ recordIndex: index, status: 'BLOCK_LIMIT_REACHED' });
      continue;
    }
    if (index < input.blockCount) {
      mappings.push({ recordIndex: index, blockIndex: index, status: 'MATCHED_EXISTING_BLOCK' });
      continue;
    }
    if (!input.hasAddControl) {
      mappings.push({ recordIndex: index, status: 'BLOCK_LIMIT_REACHED' });
      continue;
    }
    mappings.push({ recordIndex: index, blockIndex: index, status: 'CREATED_NEW_BLOCK' });
  }

  const surplusBlockIndexes: number[] = [];
  for (let block = input.recordCount; block < input.blockCount; block += 1) {
    surplusBlockIndexes.push(block);
  }

  return {
    kind: input.kind,
    addPresses,
    targetBlockCount,
    mappings,
    surplusBlockIndexes,
    summary:
      `${input.kind}: ${input.recordCount} record(s), ${input.blockCount} block(s) on the page, ` +
      `${addPresses} Add press(es), ${surplusBlockIndexes.length} block(s) left empty.`,
  };
}

/**
 * Revises a plan after the page failed to produce a block that was pressed for.
 *
 * The record is not silently dropped and it is not retried forever: it is
 * recorded as `FAILED_TO_CREATE_BLOCK`, which is a different thing from "the
 * applicant has nothing to say here" and reads differently in the report.
 */
export function markBlockCreationFailed(plan: RepeatPlan, fromRecordIndex: number): RepeatPlan {
  return {
    ...plan,
    mappings: plan.mappings.map((mapping) =>
      mapping.recordIndex >= fromRecordIndex && mapping.status === 'CREATED_NEW_BLOCK'
        ? { recordIndex: mapping.recordIndex, status: 'FAILED_TO_CREATE_BLOCK' as const }
        : mapping,
    ),
  };
}

/** Counts by status, for the run trace. Counts only — never a record's contents. */
export function summariseMappings(
  mappings: readonly RecordMapping[],
): Record<RecordMappingStatus, number> {
  const counts = Object.fromEntries(RECORD_MAPPING_STATUSES.map((status) => [status, 0])) as Record<
    RecordMappingStatus,
    number
  >;
  for (const mapping of mappings) counts[mapping.status] += 1;
  return counts;
}
