import {
  describeRepeaterSection,
  repeaterDirectiveSchema,
  repeaterRunCompleteSchema,
  summarizeRepeaterRun,
  REPEATER_KINDS,
  type Profile,
  type RecordMapping,
  type RecordMappingStatus,
  type RepeaterDirective,
  type RepeaterKind,
  type RepeaterRunSummary,
  type RepeaterSectionTrace,
} from '@internship-agent/shared';
import { sendToFrame, type FrameTarget } from './frames.js';

/**
 * The Repeater Engine, across every frame of an application.
 *
 * The split is the same one the Dropdown Engine uses, for the same reason. The
 * worker holds the applicant's facts and decides *how many* blocks each section
 * needs; the frame holds the DOM and is the only thing that presses anything.
 * No profile crosses into a page beyond the employer and institution names that
 * identify a record — which the executor types into that page anyway — and no
 * selector crosses out of one.
 *
 * ## Why this runs at all
 *
 * `runApplicationAutofill` has accepted a `growRepeatedSections` dependency
 * since repeating sections were first supported, and calls it on the first pass.
 * The production worker never supplied it. The optional chaining read
 * `undefined`, the block was skipped without a warning, and every applicant with
 * more than one job submitted one — while the test that *did* supply it passed
 * the whole time. This module is what the worker supplies.
 */

/**
 * Restates one section's trace in the vocabulary the orchestrator's report
 * already uses.
 *
 * Kept as a translation rather than a second source of truth: the trace is what
 * was observed, and every status below is derived from it. `CREATED_NEW_BLOCK`
 * is decided by position — a block at or beyond the count the section started
 * with is one this run made — because the binder assigns a fresh block by
 * exactly the rule it assigns any other empty one, and the only thing that
 * distinguishes the two afterwards is where it sits.
 */
export function asRepeatedSectionOutcome(trace: RepeaterSectionTrace): {
  kind: RepeaterKind;
  recordCount: number;
  blocksBefore: number;
  blocksAfter: number;
  addPressesPerformed: number;
  mappings: RecordMapping[];
  trace: RepeaterSectionTrace;
} {
  const mappings: RecordMapping[] = trace.recordBindings.map((binding): RecordMapping => {
    if (binding.blockIndex === undefined) {
      const status: RecordMappingStatus =
        binding.errorCode === 'REPEATER_SECTION_NOT_FOUND'
          ? 'SKIPPED_NO_PAGE_SECTION'
          : binding.errorCode === 'REPEATER_ADD_NOT_FOUND'
            ? 'BLOCK_LIMIT_REACHED'
            : 'FAILED_TO_CREATE_BLOCK';
      return { recordIndex: binding.recordIndex, status };
    }
    return {
      recordIndex: binding.recordIndex,
      blockIndex: binding.blockIndex,
      status:
        binding.blockIndex >= trace.existingBlocksInitially
          ? 'CREATED_NEW_BLOCK'
          : 'MATCHED_EXISTING_BLOCK',
    };
  });

  return {
    kind: trace.type,
    recordCount: trace.profileRecords,
    blocksBefore: trace.existingBlocksInitially,
    blocksAfter: trace.existingBlocksInitially + trace.blocksCreated,
    addPressesPerformed: trace.addClicksAttempted,
    mappings,
    trace,
  };
}

/** How many blocks any one section may be grown to, whatever the profile says. */
const MAX_RECORDS_PER_SECTION = 20;

export interface RepeaterRunInput {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
  profile: Profile;
}

export interface RepeaterRunOutcome {
  sections: readonly RepeaterSectionTrace[];
  summary: RepeaterRunSummary;
  unreachableFrames: readonly number[];
}

/**
 * The record list for one section, reduced to counts and identifying names.
 *
 * Profile order is the binding order and it is never shuffled: `experience[0]`
 * is the first entry the applicant saved, this run and every run after it, so
 * pressing Autofill twice cannot rearrange a work history.
 */
export function directivesFor(profile: Profile): RepeaterDirective[] {
  const anchors: Record<RepeaterKind, (index: number) => string> = {
    experience: (index) => profile.experience[index]?.employer ?? '',
    education: (index) => profile.education[index]?.institution ?? '',
    projects: (index) => profile.projects[index]?.name ?? '',
  };
  const counts: Record<RepeaterKind, number> = {
    experience: profile.experience.length,
    education: profile.education.length,
    projects: profile.projects.length,
  };

  return REPEATER_KINDS.map((kind) => {
    const count = Math.min(counts[kind], MAX_RECORDS_PER_SECTION);
    return repeaterDirectiveSchema.parse({
      kind,
      recordCount: count,
      records: Array.from({ length: count }, (_unused, index) => ({
        recordIndex: index,
        anchorValue: anchors[kind](index),
      })),
    });
  });
}

/**
 * Grows every repeating section in every frame.
 *
 * Frames are asked one after another rather than all at once. Two frames
 * pressing Add at the same moment on a page that shares one section between them
 * is how a section gains two blocks for one record, and a repeater pass that
 * runs once per application is not the place to save two hundred milliseconds.
 *
 * A section is only ever grown in the frame that actually holds it, because a
 * frame that does not hold it reports `REPEATER_SECTION_NOT_FOUND` and presses
 * nothing.
 */
export async function runRepeaterAutofill(input: RepeaterRunInput): Promise<RepeaterRunOutcome> {
  const started = Date.now();
  const directives = directivesFor(input.profile);
  const sections: RepeaterSectionTrace[] = [];
  const unreachable: number[] = [];

  // A profile with no repeating records at all asks nothing of any frame.
  if (directives.every((directive) => directive.recordCount === 0)) {
    return { sections: [], summary: summarizeRepeaterRun([], 0), unreachableFrames: [] };
  }

  for (const frame of input.frames) {
    let response: unknown;
    try {
      response = await sendToFrame(input.tabId, frame.frameId, {
        type: 'RUN_REPEATER_AUTOFILL',
        runId: input.runId,
        directives,
      });
    } catch {
      // One frame that has gone away fails only its own sections.
      unreachable.push(frame.frameId);
      continue;
    }

    const parsed = repeaterRunCompleteSchema.safeParse(response);
    if (!parsed.success) {
      unreachable.push(frame.frameId);
      continue;
    }

    for (const section of parsed.data.sections) {
      // A frame that does not hold this section is not news. Only the frame
      // that found it has anything to report about it.
      if (section.errorCode === 'REPEATER_SECTION_NOT_FOUND' && section.blocksNeeded === 0) {
        continue;
      }
      sections.push({ ...section, frameId: frame.frameId });
    }
  }

  // Every section the applicant has records for, whether or not any frame found
  // it. A section that appears in no frame's report is a section this
  // application does not ask about, and that fact belongs in the trace rather
  // than in the gap where a trace would have been.
  for (const directive of directives) {
    if (directive.recordCount === 0) continue;
    if (sections.some((section) => section.type === directive.kind)) continue;
    sections.push({
      type: directive.kind,
      profileRecords: directive.recordCount,
      existingBlocksInitially: 0,
      blocksNeeded: 0,
      addControlFound: false,
      addClicksAttempted: 0,
      blocksCreated: 0,
      blocksVerified: 0,
      recordBindings: [],
      fieldsAttempted: 0,
      fieldsVerified: 0,
      duplicateBlocksCreated: 0,
      durationMs: 0,
      errorCode: 'REPEATER_SECTION_NOT_FOUND',
    });
  }

  const summary = summarizeRepeaterRun(sections, Date.now() - started);
  if (sections.length > 0) {
    // The one line that answers "did Add get pressed, and how many blocks came
    // back?". Counts, indices, and codes only — never a record's contents.
    console.info('[agent] repeater engine', sections.map(describeRepeaterSection));
  }
  return { sections, summary, unreachableFrames: unreachable };
}
