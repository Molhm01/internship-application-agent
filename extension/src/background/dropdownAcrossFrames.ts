import {
  dropdownDirectiveSchema,
  dropdownRunResultSchema,
  dropdownsDiscoveredSchema,
  dropdownDirectivesCompleteSchema,
  resolveIntendedAnswer,
  summarizeDropdownRun,
  type ApprovedAnswer,
  type CompanyRelationship,
  type DropdownDescriptor,
  type DropdownDirective,
  type DropdownRunResult,
  type DropdownRunSummary,
  type Profile,
} from '@internship-agent/shared';
import { sendToFrame, type FrameTarget } from './frames.js';
import { resolveDropdownQuestion } from '../dropdown/dropdownQuestionResolver.js';

/**
 * The Dropdown Autofill Engine, across every frame of an application.
 *
 * This is the pass the "Autofill Application" button runs after the
 * deterministic fill, and it is deliberately not part of it. The ordinary
 * pipeline drives a dropdown only when the planner produced an action for it,
 * which requires the scan to have classified the control, the classifier to have
 * recognised the question, and the matcher to have produced a value — and a
 * control that falls out at any of those steps does not fail, it *disappears*.
 * This pass starts from the page instead, so a planner gap can no longer hide a
 * menu from the run.
 *
 * ## Where the two halves live
 *
 * Frames own the DOM and nothing else: they say what controls exist and they
 * drive the ones they were asked to. The worker owns the applicant's facts and
 * nothing else: it decides what each question means and what the answer is. No
 * profile crosses into a page, and no selector crosses out of one.
 *
 * ## Dependencies
 *
 * A control whose choices another control produces is not driven twice by
 * accident and not rescanned by sweeping the page. Controls that reported
 * `BLOCKED` after a pass in which something else verified are re-discovered and
 * retried, once — because that is the only condition under which their choices
 * could have arrived.
 */

/** How many times a blocked control may be retried after a parent was answered. */
const MAX_DEPENDENCY_ROUNDS = 2;

export interface DropdownRunInput {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
  profile: Profile;
  approvedAnswers: readonly ApprovedAnswer[];
  companyName: string;
  companyRelationship?: CompanyRelationship | undefined;
}

export interface DropdownRunOutcome {
  results: readonly DropdownRunResult[];
  summary: DropdownRunSummary;
  /** Frames that could not be reached, named rather than silently dropped. */
  unreachableFrames: readonly number[];
}

/** A control and the frame it was found in, so it is always driven where it lives. */
interface Located {
  frameId: number;
  descriptor: DropdownDescriptor;
}

async function discoverInFrames(
  input: DropdownRunInput,
): Promise<{ found: Located[]; unreachable: number[] }> {
  const found: Located[] = [];
  const unreachable: number[] = [];
  for (const frame of input.frames) {
    try {
      const response = await sendToFrame(input.tabId, frame.frameId, {
        type: 'DISCOVER_DROPDOWNS',
        runId: input.runId,
      });
      const parsed = dropdownsDiscoveredSchema.safeParse(response);
      if (!parsed.success) {
        unreachable.push(frame.frameId);
        continue;
      }
      for (const descriptor of parsed.data.dropdowns) {
        // The frame cannot learn its own id, so the worker stamps it. Every
        // later message about this control is routed by exactly this number:
        // discovering in one frame and executing in another is how a selector
        // resolves to a different control with the same name.
        found.push({
          frameId: frame.frameId,
          descriptor: { ...descriptor, frameId: frame.frameId },
        });
      }
    } catch {
      // One frame that has gone away fails only its own controls.
      unreachable.push(frame.frameId);
    }
  }
  return { found, unreachable };
}

/**
 * Turns one discovered control into an instruction, or into a question for the
 * applicant.
 *
 * Both halves happen here, in the worker, and neither can reach the page: the
 * question's meaning comes from the label the frame reported, and the answer
 * comes from saved facts. A control nobody can answer still gets a directive —
 * one that says so — because it must still be opened and its choices recorded.
 */
function directiveFor(located: Located, input: DropdownRunInput): DropdownDirective {
  const { descriptor } = located;
  const question = resolveDropdownQuestion(descriptor);
  const intended = resolveIntendedAnswer({
    canonicalQuestion: question.canonicalQuestion,
    label: descriptor.label,
    sectionContext: descriptor.sectionContext,
    recordIndex: descriptor.recordIndex,
    profile: input.profile,
    approvedAnswers: input.approvedAnswers,
    companyName: input.companyName,
    companyRelationship: input.companyRelationship,
  });

  return dropdownDirectiveSchema.parse({
    dropdownId: descriptor.dropdownId,
    canonicalQuestion: question.canonicalQuestion,
    intendedAnswer: intended.intendedAnswer,
    intendedAnswerSource: intended.source,
    alternativeValues: [...intended.alternativeValues].slice(0, 12),
    ...(intended.searchText ? { searchText: intended.searchText } : {}),
    allowOtherFallback: intended.allowOtherFallback,
    requiresUserConfirmation: intended.requiresUserConfirmation,
    ...(intended.confirmationPrompt ? { confirmationPrompt: intended.confirmationPrompt } : {}),
    sensitive: intended.sensitive,
  });
}

/**
 * Parents before the controls that depend on them.
 *
 * A State list rebuilt by Country cannot be answered before Country is, and
 * driving them in discovery order means half the dependent controls are read
 * while they still hold a prompt. Independent controls first is the whole rule;
 * within each group the page's own order is kept, because that is the order the
 * applicant would work through and the order a form's own scripts expect.
 */
function inDependencyOrder(located: readonly Located[]): Located[] {
  const rank = (entry: Located): number =>
    entry.descriptor.dependencyState === 'awaiting_parent' ? 1 : 0;
  return [...located].sort((left, right) => rank(left) - rank(right));
}

async function driveFrame(
  input: DropdownRunInput,
  frameId: number,
  directives: readonly DropdownDirective[],
): Promise<DropdownRunResult[]> {
  if (directives.length === 0) return [];
  try {
    const response = await sendToFrame(input.tabId, frameId, {
      type: 'RUN_DROPDOWN_DIRECTIVES',
      runId: input.runId,
      directives,
    });
    const parsed = dropdownDirectivesCompleteSchema.safeParse(response);
    if (!parsed.success) return directives.map((directive) => unreached(directive, frameId));
    const returned = new Map(parsed.data.results.map((result) => [result.dropdownId, result]));
    // Every directive gets a result, whether or not the frame produced one. A
    // control missing from the report is indistinguishable from a control that
    // was never on the form, and that is how a half-filled page comes back
    // looking complete.
    return directives.map((directive) => {
      const result = returned.get(directive.dropdownId);
      return result ? { ...result, frameId } : unreached(directive, frameId);
    });
  } catch {
    return directives.map((directive) => unreached(directive, frameId));
  }
}

/** A control whose frame could not answer, reported rather than omitted. */
function unreached(directive: DropdownDirective, frameId: number): DropdownRunResult {
  return dropdownRunResultSchema.parse({
    dropdownId: directive.dropdownId,
    frameId,
    question: '',
    selector: '',
    canonicalQuestion: directive.canonicalQuestion,
    controlStrategy: 'unknown',
    intendedAnswerSource: directive.intendedAnswerSource,
    intendedAnswerResolved: directive.intendedAnswer.trim().length > 0,
    optionsFound: 0,
    opened: false,
    scrolled: false,
    selected: false,
    verified: false,
    finalStatus: 'BLOCKED',
    errorCode: 'CONTROL_NOT_FOUND',
    reason: `The frame holding this control (frame ${frameId}) did not answer, so it was left untouched.`,
    durationMs: 0,
  });
}

/**
 * The whole pass: discover, resolve, drive, then retry what a parent unblocked.
 *
 * Always returns a result per control. A dropdown that could not be reached, a
 * frame that went away, and a question nobody can answer are three different
 * recorded outcomes — never an absence.
 */
export async function runDropdownAutofill(input: DropdownRunInput): Promise<DropdownRunOutcome> {
  const started = Date.now();
  const { found, unreachable } = await discoverInFrames(input);

  const results = new Map<string, DropdownRunResult>();
  let pending = inDependencyOrder(found);

  for (let round = 0; round < MAX_DEPENDENCY_ROUNDS && pending.length > 0; round += 1) {
    const byFrame = new Map<number, Located[]>();
    for (const entry of pending) {
      byFrame.set(entry.frameId, [...(byFrame.get(entry.frameId) ?? []), entry]);
    }

    let anythingVerified = false;
    for (const [frameId, entries] of byFrame) {
      const directives = entries.map((entry) => directiveFor(entry, input));
      const produced = await driveFrame(input, frameId, directives);
      for (const [index, result] of produced.entries()) {
        const descriptor = entries[index]?.descriptor;
        results.set(result.dropdownId, {
          ...result,
          // The frame reports the question it read; a frame that could not
          // answer reports nothing, and the descriptor is what fills that gap.
          question: result.question || (descriptor?.label ?? ''),
          selector: result.selector || (descriptor?.selector ?? ''),
          controlStrategy:
            result.controlStrategy === 'unknown' && descriptor
              ? descriptor.controlStrategy
              : result.controlStrategy,
        });
        if (result.verified) anythingVerified = true;
      }
    }

    // Only worth another round when something was answered that could have
    // populated something else. Retrying a blocked control after a pass that
    // changed nothing would just produce the same `BLOCKED` more slowly.
    if (!anythingVerified) break;

    const blockedIds = new Set(
      [...results.values()]
        .filter((result) => result.finalStatus === 'BLOCKED')
        .map((result) => result.dropdownId),
    );
    if (blockedIds.size === 0) break;

    // Re-discovered rather than reused: a page that populates a dependent list
    // routinely replaces the control while doing it, and the old handle then
    // points at an element no longer in the document.
    const rediscovered = await discoverInFrames(input);
    const blockedLabels = new Set(
      [...results.values()]
        .filter((result) => blockedIds.has(result.dropdownId))
        .map((result) => result.question),
    );
    const retry = rediscovered.found.filter((entry) => blockedLabels.has(entry.descriptor.label));
    // The stale records are dropped so the retry's own outcome is what is
    // reported, rather than two records for one control.
    for (const id of blockedIds) results.delete(id);
    pending = inDependencyOrder(retry);
  }

  const all = [...results.values()];
  return {
    results: all,
    summary: summarizeDropdownRun(all, Date.now() - started),
    unreachableFrames: unreachable,
  };
}
