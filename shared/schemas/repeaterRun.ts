import { z } from 'zod';
import { errorCodeSchema } from './error.js';

/**
 * The Repeater Engine's contract between the worker and a frame.
 *
 * A repeating section is one the applicant can have any number of: three jobs,
 * two schools. The page offers one block and an Add control, and the number of
 * blocks it ends up with is a fact about the *applicant*, not about the page —
 * which is why the worker, which holds the profile, decides how many are needed,
 * and the frame, which holds the DOM, is the only thing that presses anything.
 *
 * Nothing in here carries a record's contents except `anchorValue`, and that one
 * field exists for a single purpose: telling a block the applicant already
 * filled in by hand from an empty one, so their typing is never overwritten. It
 * is the employer or institution name — a value the executor would type into
 * that same page anyway — and never a date, a salary, or a reason for leaving.
 */

export const REPEATER_KINDS = ['experience', 'education', 'projects'] as const;
export const repeaterKindSchema = z.enum(REPEATER_KINDS);
export type RepeaterKind = z.infer<typeof repeaterKindSchema>;

/**
 * How a block came to be bound to a record.
 *
 * The distinction that matters is `MATCHED_BY_VALUE` versus `ASSIGNED_TO_EMPTY`:
 * the first means the page already held this record and nothing needs writing,
 * the second means the block is blank and free to use. `CONFLICTS_WITH_USER`
 * is neither, and is never written to.
 */
export const REPEATER_BIND_REASONS = [
  /** The block already holds this record's anchor value. */
  'MATCHED_BY_VALUE',
  /** The block is empty, so the next unplaced record may use it. */
  'ASSIGNED_TO_EMPTY',
  /** Add was pressed and this block is what the page produced. */
  'CREATED_BY_ADD',
  /**
   * The block holds something the applicant typed that matches no saved record.
   * Left exactly as it is — overwriting it is destroying their work.
   */
  'CONFLICTS_WITH_USER',
] as const;
export const repeaterBindReasonSchema = z.enum(REPEATER_BIND_REASONS);
export type RepeaterBindReason = z.infer<typeof repeaterBindReasonSchema>;

/**
 * One saved record, reduced to what a page is allowed to know about it.
 *
 * Sent into a frame so an existing block can be recognised as already holding
 * this record. Index and one identifying string; nothing else.
 */
export const repeaterRecordHintSchema = z.object({
  recordIndex: z.number().int().nonnegative().max(99),
  /** Employer, or institution. Empty when the record has neither. */
  anchorValue: z.string().max(200).default(''),
});
export type RepeaterRecordHint = z.infer<typeof repeaterRecordHintSchema>;

/** What the worker asks one frame to do for one section. */
export const repeaterDirectiveSchema = z.object({
  kind: repeaterKindSchema,
  /** How many blocks the applicant's records call for. Counts only. */
  recordCount: z.number().int().nonnegative().max(99),
  records: z.array(repeaterRecordHintSchema).max(99).default([]),
});
export type RepeaterDirective = z.infer<typeof repeaterDirectiveSchema>;

/** One record and the block it ended up in. Sanitized: indices and reasons. */
export const repeaterBindingSchema = z.object({
  recordIndex: z.number().int().nonnegative().max(99),
  blockIndex: z.number().int().nonnegative().max(99).optional(),
  /** Stable within a run: `experience:block:1`. Never a selector. */
  blockId: z.string().max(120).optional(),
  reason: repeaterBindReasonSchema.optional(),
  /** Set when this record could not be placed. */
  errorCode: errorCodeSchema.optional(),
});
export type RepeaterBinding = z.infer<typeof repeaterBindingSchema>;

/**
 * The Repeater Engine Trace, for one section.
 *
 * Every number here is observed rather than assumed. `blocksCreated` is counted
 * from the DOM after each press, not inferred from `addClicksAttempted` — a page
 * that answers one press with two blocks and a page that answers it with none
 * are both real, and both used to be reported as "added one".
 */
export const repeaterSectionTraceSchema = z.object({
  type: repeaterKindSchema,
  frameId: z.number().int().nonnegative().optional(),
  profileRecords: z.number().int().nonnegative(),
  existingBlocksInitially: z.number().int().nonnegative(),
  blocksNeeded: z.number().int().nonnegative(),
  addControlFound: z.boolean(),
  addClicksAttempted: z.number().int().nonnegative(),
  blocksCreated: z.number().int().nonnegative(),
  blocksVerified: z.number().int().nonnegative(),
  recordBindings: z.array(repeaterBindingSchema).max(99).default([]),
  fieldsAttempted: z.number().int().nonnegative().default(0),
  fieldsVerified: z.number().int().nonnegative().default(0),
  duplicateBlocksCreated: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  errorCode: errorCodeSchema.optional(),
});
export type RepeaterSectionTrace = z.infer<typeof repeaterSectionTraceSchema>;

export const repeaterRunSummarySchema = z.object({
  sections: z.array(repeaterSectionTraceSchema).max(12).default([]),
  totalAddClicks: z.number().int().nonnegative().default(0),
  totalBlocksCreated: z.number().int().nonnegative().default(0),
  totalDuplicateBlocks: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
});
export type RepeaterRunSummary = z.infer<typeof repeaterRunSummarySchema>;

/**
 * One human-readable line per section, for the run log and the diagnostics
 * panel. Counts, indices, and statuses — never a record's contents.
 */
export function describeRepeaterSection(trace: RepeaterSectionTrace): string {
  const bindings = trace.recordBindings
    .map((binding) =>
      binding.blockIndex === undefined
        ? `#${binding.recordIndex}→none(${binding.errorCode ?? 'unplaced'})`
        : `#${binding.recordIndex}→block ${binding.blockIndex}`,
    )
    .join(' ');
  return (
    `${trace.type}: ${trace.profileRecords} record(s), blocks ` +
    `${trace.existingBlocksInitially}→${trace.existingBlocksInitially + trace.blocksCreated}, ` +
    `${trace.addClicksAttempted} add click(s), ${trace.blocksVerified} verified` +
    (trace.duplicateBlocksCreated > 0 ? `, ${trace.duplicateBlocksCreated} duplicate(s)` : '') +
    (trace.errorCode ? `, ${trace.errorCode}` : '') +
    (bindings ? ` — ${bindings}` : '')
  );
}

export function summarizeRepeaterRun(
  sections: readonly RepeaterSectionTrace[],
  durationMs: number,
): RepeaterRunSummary {
  return repeaterRunSummarySchema.parse({
    sections,
    totalAddClicks: sections.reduce((total, entry) => total + entry.addClicksAttempted, 0),
    totalBlocksCreated: sections.reduce((total, entry) => total + entry.blocksCreated, 0),
    totalDuplicateBlocks: sections.reduce(
      (total, entry) => total + entry.duplicateBlocksCreated,
      0,
    ),
    durationMs,
  });
}
