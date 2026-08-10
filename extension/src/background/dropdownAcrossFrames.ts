import {
  dropdownDirectiveSchema,
  dropdownRunResultSchema,
  dropdownSeedSchema,
  dropdownsDiscoveredSchema,
  dropdownDirectivesCompleteSchema,
  isOptionFieldType,
  resolveIntendedAnswer,
  summarizeDropdownRun,
  type ApplicationScanResult,
  type ApprovedAnswer,
  type CompanyRelationship,
  type DropdownDescriptor,
  type DropdownDirective,
  type DropdownRunResult,
  type DropdownRunSummary,
  type DropdownSeed,
  type PlannedOptionAnswer,
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
  /**
   * The option controls the application scan found, grouped by the frame each
   * one lives in.
   *
   * This is the authoritative view of the form, and the pass consumes it rather
   * than rediscovering the page from scratch. Empty is a valid input and
   * reproduces the old behaviour exactly — every frame still runs its own walk.
   */
  seedsByFrame?: ReadonlyMap<number, readonly DropdownSeed[]>;
  /**
   * What the deterministic plan already resolved, by the scan's field id.
   *
   * Consulted before this pass's own resolver, and it is not an optimisation.
   * Deferring option actions to this engine means the planner's answers stop
   * being executed anywhere else, and the two resolvers do not know the same
   * things: "Phone Type", "Address Type" and "How did you hear about us" are
   * answered by the planner's structural rules and by nothing in
   * `resolveIntendedAnswer`. Without this, deferring them silently unanswered
   * three questions a working form had been filling for months.
   */
  plannedAnswers?: ReadonlyMap<string, PlannedOptionAnswer>;
}

export interface DropdownRunOutcome {
  results: readonly DropdownRunResult[];
  summary: DropdownRunSummary;
  /** Frames that could not be reached, named rather than silently dropped. */
  unreachableFrames: readonly number[];
}

/**
 * The option controls of an application scan, grouped by the frame each lives in.
 *
 * Which field types count is `isOptionFieldType` minus radios and checkboxes:
 * those are answered from a list too, and they are not menus — driving a radio
 * group through a dropdown engine would open nothing and report a failure about
 * a control that works. Everything else the scan called an option control is
 * seeded, whatever this pass's own walk would have made of it.
 *
 * Nothing is filtered on the scan's own option list. A control the scan saw with
 * no options is exactly the one that has to be opened to find out.
 */
export function dropdownSeedsByFrame(
  scan: ApplicationScanResult,
): Map<number, readonly DropdownSeed[]> {
  const byFrame = new Map<number, DropdownSeed[]>();
  for (const field of scan.fields) {
    if (!isOptionFieldType(field.fieldType)) continue;
    if (field.fieldType === 'radio' || field.fieldType === 'checkbox') continue;
    if (!field.selector.trim()) continue;
    const frameId = field.frameId ?? 0;
    const seed = dropdownSeedSchema.parse({
      fieldId: field.id,
      selector: field.selector,
      label: (field.label || field.question).slice(0, 600),
      // The section *name* the scan assigned — a vocabulary member such as
      // `education`, not page text. It is what tells one "Country" from the
      // other on a form that asks both.
      sectionContext: field.section ?? '',
      ...(field.canonicalKey ? { canonicalQuestion: field.canonicalKey } : {}),
      required: field.required,
      ...(field.recordIndex === undefined ? {} : { recordIndex: field.recordIndex }),
      knownOptions: (field.options ?? []).slice(0, 200).map((option) => option.label.slice(0, 600)),
    });
    byFrame.set(frameId, [...(byFrame.get(frameId) ?? []), seed]);
  }
  return byFrame;
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
        // Only this frame's own controls. A seed carries a selector, and a
        // selector resolved in the wrong document is how a question gets
        // answered from another frame's identically-named control.
        seeds: input.seedsByFrame?.get(frame.frameId) ?? [],
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
  // The application scan's own intent wins where it has one. It was resolved
  // with the section context, the repeat index and the adapter's knowledge of
  // the page behind it, and re-deriving the meaning of a question this pass
  // already has an answer for is how the two records come to disagree.
  const question = descriptor.scanCanonicalQuestion
    ? { canonicalQuestion: descriptor.scanCanonicalQuestion }
    : resolveDropdownQuestion(descriptor);
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

  // What the planner already settled for this exact control, if anything.
  //
  // It wins over this pass's own resolver, and only where the resolver came up
  // empty-handed or the planner's answer is simply better evidence: the planner
  // saw the scan's intent, the section, and the adapter's knowledge of the page.
  // It is *not* consulted when this control's question is one only the applicant
  // may answer — a planned answer cannot promote a sensitive question past the
  // confirmation rule, because the orchestrator only offers answers its approval
  // policy already accepted, and this keeps that true even if it stops being.
  const planned =
    descriptor.scanFieldId && !intended.sensitive
      ? input.plannedAnswers?.get(descriptor.scanFieldId)
      : undefined;
  const usePlanned =
    planned !== undefined && planned.intendedAnswer.trim().length > 0 && !planned.sensitive;

  // Neither answer is thrown away. The planner's is tried first — it has already
  // mapped the saved fact onto *this form's* own vocabulary, which is how "How
  // did you hear about us" reaches the form's `internet` entry from a saved
  // "LinkedIn" — and this pass's own reading follows it as an alternative, so a
  // plan built from a stale scan still cannot cost an answer the resolver knows.
  const alternatives = usePlanned
    ? [...planned.alternativeValues, intended.intendedAnswer, ...intended.alternativeValues]
    : [...intended.alternativeValues];

  return dropdownDirectiveSchema.parse({
    dropdownId: descriptor.dropdownId,
    canonicalQuestion: question.canonicalQuestion,
    intendedAnswer: usePlanned ? planned.intendedAnswer : intended.intendedAnswer,
    intendedAnswerSource: usePlanned ? planned.intendedAnswerSource : intended.source,
    alternativeValues: [...new Set(alternatives.filter((value) => value.trim().length > 0))].slice(
      0,
      12,
    ),
    ...(usePlanned
      ? planned.searchText
        ? { searchText: planned.searchText }
        : {}
      : intended.searchText
        ? { searchText: intended.searchText }
        : {}),
    allowOtherFallback: intended.allowOtherFallback,
    requiresUserConfirmation: usePlanned ? false : intended.requiresUserConfirmation,
    ...(!usePlanned && intended.confirmationPrompt
      ? { confirmationPrompt: intended.confirmationPrompt }
      : {}),
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
          // Discovery is a property of how the control was *found*, so it comes
          // from the descriptor rather than from the attempt — a frame that
          // never answered still has to report which pass found the control.
          discoverySource: descriptor?.discoverySource ?? result.discoverySource,
          ...(descriptor?.scanFieldId ? { scanFieldId: descriptor.scanFieldId } : {}),
          ...((result.structure ?? descriptor?.structure)
            ? { structure: result.structure ?? descriptor?.structure }
            : {}),
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
