import {
  repeaterSectionTraceSchema,
  type ErrorCode,
  type RepeaterDirective,
  type RepeaterSectionTrace,
} from '@internship-agent/shared';
import { bindSection } from './repeaterBinder.js';
import { createBlock } from './repeaterCreator.js';
import { countBlocks, findAddControl, findSection } from './repeaterScanner.js';
import { verifySection } from './repeaterVerifier.js';

/**
 * The Repeater Engine, inside one frame.
 *
 * One operation: given how many records the applicant has for each repeating
 * section, make the page hold that many blocks and say which record each block
 * is for. It does not fill anything. Filling belongs to the executor that
 * already does it and to the Dropdown Engine that already drives menus, and a
 * second implementation of either — inside here, for "new" blocks — is exactly
 * the sort of parallel path that lets the two disagree about what a block
 * contains.
 *
 * What this owns instead is the part nothing else could do: deciding a section
 * is short a block, pressing the page's own Add control, and proving a block
 * appeared. Once a block exists it is an ordinary part of the form, and the
 * ordinary pipeline scans it, numbers it, and answers it from the right record —
 * which it has always been able to do, and never got the chance to.
 *
 * ## Never a model call
 *
 * Nothing in this path asks anything of Ollama. Counting records, counting
 * blocks, finding a button under a heading, and pressing it are deterministic,
 * and a form's structure is not a question of interpretation.
 */

/** A ceiling on presses per section that holds whatever the arithmetic says. */
const MAX_PRESSES_PER_SECTION = 20;

export interface RepeaterEngineContext {
  /** The frame's own document. The engine never reaches outside it. */
  document: Document;
  directives: readonly RepeaterDirective[];
  /** Overridable so a test can drive the loop without real timers. */
  now?: () => number;
}

/**
 * Runs every directive against this frame.
 *
 * Always returns one trace per directive. A section this frame does not have is
 * reported as `REPEATER_SECTION_NOT_FOUND` rather than omitted — an application
 * split across frames has an Education section in exactly one of them, and a
 * frame that stayed silent about it would be indistinguishable from a frame that
 * failed.
 */
export async function runRepeaterAutofill(
  context: RepeaterEngineContext,
): Promise<RepeaterSectionTrace[]> {
  const clock = context.now ?? (() => Date.now());
  const traces: RepeaterSectionTrace[] = [];

  for (const directive of context.directives) {
    traces.push(await runOne(context.document, directive, clock));
  }
  return traces;
}

async function runOne(
  document: Document,
  directive: RepeaterDirective,
  clock: () => number,
): Promise<RepeaterSectionTrace> {
  const startedAt = clock();
  const section = findSection(document, directive.kind);

  if (!section) {
    return repeaterSectionTraceSchema.parse({
      type: directive.kind,
      profileRecords: directive.recordCount,
      existingBlocksInitially: 0,
      blocksNeeded: 0,
      addControlFound: false,
      addClicksAttempted: 0,
      blocksCreated: 0,
      blocksVerified: 0,
      recordBindings: [],
      durationMs: Math.max(0, clock() - startedAt),
      // Only an error when the applicant actually has records for it. A page
      // that does not ask about projects is not a page missing the projects.
      ...(directive.recordCount > 0 ? { errorCode: 'REPEATER_SECTION_NOT_FOUND' as const } : {}),
    });
  }

  const blocksBefore = countBlocks(section);
  // Bound first, so an Add press is only ever issued for a record that has
  // nowhere to go. This is the whole of the second-run guarantee: on a page the
  // last run filled, every record matches a block it already holds, nothing is
  // unplaced, and the loop below runs zero times.
  let binding = bindSection(section, directive.records);
  const blocksNeeded = binding.unplacedRecordIndexes.length;

  // Reported whether or not it is needed. "This section has an Add control and
  // did not need it" and "this section has no Add control" are the two readings
  // of zero presses, and only one of them is fine.
  let addControlFound = findAddControl(section) !== null;
  let clicks = 0;
  let created = 0;
  let duplicates = 0;
  let creationError: ErrorCode | undefined;

  for (let press = 0; press < Math.min(blocksNeeded, MAX_PRESSES_PER_SECTION); press += 1) {
    const outcome = await createBlock(section);
    clicks += outcome.clicksAttempted;
    if (outcome.clicksAttempted > 0) addControlFound = true;
    if (outcome.errorCode === 'REPEATER_ADD_NOT_FOUND') {
      creationError = 'REPEATER_ADD_NOT_FOUND';
      break;
    }
    if (outcome.created === 0) {
      // The press did nothing. Recorded and the loop stops: pressing again
      // would either do nothing again or add two blocks at once, and neither is
      // a repair. The records that had nowhere to go are reported as such.
      creationError = outcome.errorCode ?? 'REPEATER_BLOCK_NOT_CREATED';
      break;
    }
    created += outcome.created;
    duplicates += outcome.duplicates;
    if (outcome.errorCode) creationError = outcome.errorCode;

    // Re-bound after every press, against the page as it now is. The new block
    // is empty, so the matcher hands it to the next record with nowhere to go —
    // by the same rule that would have bound it had the page shipped with it.
    binding = bindSection(section, directive.records);
    if (binding.unplacedRecordIndexes.length === 0) break;
  }

  const verification = verifySection(section, binding, directive.recordCount);

  const bindings = binding.bindings.map((entry) =>
    entry.blockIndex === undefined
      ? {
          ...entry,
          errorCode:
            creationError ??
            (addControlFound ? 'REPEATER_BLOCK_NOT_CREATED' : 'REPEATER_ADD_NOT_FOUND'),
        }
      : entry,
  );

  return repeaterSectionTraceSchema.parse({
    type: directive.kind,
    profileRecords: directive.recordCount,
    existingBlocksInitially: blocksBefore,
    blocksNeeded,
    addControlFound,
    addClicksAttempted: clicks,
    blocksCreated: created,
    blocksVerified: verification.blocksVerified,
    recordBindings: bindings,
    duplicateBlocksCreated: duplicates,
    durationMs: Math.max(0, clock() - startedAt),
    // The creator's own code wins: "Add was pressed and nothing appeared" is
    // more specific than the verifier's "the counts do not agree", and it is the
    // one that names what to do about it.
    ...(creationError
      ? { errorCode: creationError }
      : verification.errorCode
        ? { errorCode: verification.errorCode }
        : {}),
  });
}
