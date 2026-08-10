import { z } from 'zod';
import { idSchema } from './common.js';
import { canonicalQuestionSchema } from './fields.js';
import { dropdownFailureCodeSchema, dropdownKindSchema } from './dropdownExecution.js';

/**
 * The contract of the Dropdown Autofill Engine — a pass that answers option
 * controls on its own terms, beside the deterministic fill rather than inside
 * it.
 *
 * ## Why this is a separate subsystem
 *
 * The ordinary pipeline reaches a dropdown only when the *planner* produced a
 * `SELECT_OPTION` action for it, and it produces one only when the scan already
 * knew the question, the answer, and — historically — the option text. Every
 * link in that chain is a place a live control silently drops out: a question
 * the classifier did not recognise, a control the scan typed as text, an option
 * list that does not exist until the widget is opened. A dropdown that falls out
 * that way is not *failed*, it is *absent*, and absent is what let a form come
 * back reporting success with six untouched menus on it.
 *
 * So this pass starts from the page. It finds option controls itself, works out
 * what each one is asking, resolves an intended answer from saved facts, and
 * only then opens the control to see what it is actually offering. The scan and
 * the plan are not consulted at any point, which is precisely what makes a
 * planner gap unable to hide a dropdown from it.
 *
 * ## What it may not do
 *
 * It resolves answers from stored facts; it does not invent them. A question
 * whose answer is not saved ends `USER_CONFIRMATION_REQUIRED` with the choices
 * it found recorded, so the applicant answers a question rather than hunting for
 * a control. That is the whole of the safety story here: `intendedAnswer` may
 * only ever be a restatement of something the user saved.
 *
 * Nothing in these types can express a selector, a script, or a DOM index. A
 * directive names an answer and a `dropdownId` the frame itself minted moments
 * earlier, so it cannot address a control that frame did not volunteer.
 */

/**
 * `dropdownKindSchema` below is the executor's own classification, imported
 * rather than restated: this pass and the widget driver must never disagree
 * about what shape a control is.
 */

/**
 * Whether a control's choices are produced by another control, and whether that
 * has happened yet.
 *
 * Recorded rather than inferred, because "this list is empty" means two
 * completely different things: a Country list that came up empty is broken, and
 * a State list that came up empty is simply waiting for Country. Reporting both
 * as `NO_OPTIONS_FOUND` is how a working dependency looked like a failure.
 */
export const dropdownDependencyStateSchema = z.enum([
  /** Nothing else on the form governs this control. */
  'independent',
  /** Governed by another control that has not been answered yet. */
  'awaiting_parent',
  /** Governed by another control that has been answered. */
  'parent_answered',
]);

export type DropdownDependencyState = z.infer<typeof dropdownDependencyStateSchema>;

/**
 * Which pass found a control.
 *
 * Recorded because the two passes disagree, and the disagreement is the
 * diagnosis. The application scan is the authoritative view of the form — it is
 * what the plan, the report, and the applicant's own review list are built from
 * — and the dropdown pass's own DOM walk knows only the widget shapes its
 * selector list was written for. A live employer control that the main scan
 * classified as a dropdown and `CANDIDATE_SELECTOR` does not recognise used to
 * reach the Dropdown Engine through neither route: the stage ignored the scan
 * it was handed, and the walk never saw the widget. `main_scan` on a finished
 * run names exactly those controls.
 */
export const dropdownDiscoverySourceSchema = z.enum([
  /** Only the application scan saw it. Reached the engine by being seeded. */
  'main_scan',
  /** Only this pass's own DOM walk saw it. */
  'dropdown_scan',
  /** Both, and deduplicated to one control. */
  'both',
]);

export type DropdownDiscoverySource = z.infer<typeof dropdownDiscoverySourceSchema>;

/**
 * One option control the application scan already found, handed to the frame so
 * the Dropdown Engine drives it whether or not its own walk recognises the
 * widget.
 *
 * A seed carries a selector and no instruction. The frame resolves it against
 * its own document, applies the same ownership and visibility rules it applies
 * to anything else, and mints its own `dropdownId` for it — so a seed can name
 * a control but never reach past the frame's own registry, and the worker still
 * learns nothing but the handle it is given back.
 */
export const dropdownSeedSchema = z
  .object({
    /** The scan's own field id, so a run's two records can be tied together. */
    fieldId: idSchema,
    /** How the scanner addresses the element. Resolved in-frame, never executed. */
    selector: z.string().max(2000),
    label: z.string().max(600),
    sectionContext: z.string().max(600).default(''),
    /** The intent the scan resolved, which is better than re-deriving it here. */
    canonicalQuestion: canonicalQuestionSchema.optional(),
    required: z.boolean().default(false),
    recordIndex: z.number().int().nonnegative().max(50).optional(),
    /**
     * The choices the scan recorded, carried for the report only.
     *
     * Never matched against: the engine's whole reason for existing is that it
     * reads the list the control is offering at the moment of the attempt. A
     * scan snapshot is a planning hint and nothing selects from it.
     */
    knownOptions: z.array(z.string().max(600)).max(200).default([]),
  })
  .strict();

export type DropdownSeed = z.infer<typeof dropdownSeedSchema>;

/**
 * How a control is built, in structure only.
 *
 * This exists because a live employer failure could not be diagnosed from the
 * outcome alone. "The list did not open" is the same sentence for a control
 * whose trigger was never found, one that has no `aria-haspopup` and ignores a
 * click, and one that opened a menu this code could not recognise — three
 * different repairs. These are the facts that tell them apart, and every one of
 * them is markup rather than content: tags, roles, ARIA wiring, and a class
 * *fingerprint* rather than the classes themselves.
 *
 * Nothing here can carry an answer. No option text, no displayed value, no
 * label content beyond the question wording the run already records elsewhere.
 */
export const dropdownControlStructureSchema = z
  .object({
    triggerTag: z.string().max(40),
    triggerRole: z.string().max(60).default(''),
    triggerType: z.string().max(40).default(''),
    ariaHasPopup: z.string().max(40).default(''),
    ariaExpandedBefore: z.string().max(20).default(''),
    ariaExpandedAfter: z.string().max(20).default(''),
    /** Whether the trigger names its own popup, not the id it names. */
    hasAriaControls: z.boolean().default(false),
    /**
     * A stable, non-identifying digest of the control's class list.
     *
     * The classes themselves are omitted on purpose: an emotion-hashed class
     * name is not personal data but it is not diagnostic either, and a vendor
     * class list occasionally embeds a requisition id. A digest still answers
     * the question a trace is for — "are these nine failing controls the same
     * widget or nine different ones".
     */
    classFingerprint: z.string().max(40).default(''),
  })
  .strict();

export type DropdownControlStructure = z.infer<typeof dropdownControlStructureSchema>;

/** How the open menu was located, when one was. */
export const menuDetectionStrategySchema = z.enum([
  /** The trigger's own `aria-controls` / `aria-owns`. */
  'aria_controls',
  /** A `[role=listbox]` / `[role=menu]` container beside or under the trigger. */
  'aria_role_container',
  /** A portal container carrying an explicit dropdown data attribute. */
  'portal_attribute',
  /** Newly mounted after the click, with no role to recognise it by. */
  'mutation_fallback',
  /** Nothing was found. */
  'none',
]);

export type MenuDetectionStrategy = z.infer<typeof menuDetectionStrategySchema>;

/** How the entries inside a located menu were recognised. */
export const optionCandidateStrategySchema = z.enum([
  /** `role=option` / `role=menuitem` and friends. */
  'aria_option_role',
  /** Plain `li` / `button` / `a` / `[data-value]` inside the associated menu. */
  'structural_candidates',
  'none',
]);

export type OptionCandidateStrategy = z.infer<typeof optionCandidateStrategySchema>;

/**
 * One option control, as the page presents it before anything is done to it.
 *
 * Minted in the frame that owns the control and returned to the worker. The
 * `dropdownId` is a frame-local handle with no meaning anywhere else — the same
 * shape the upload path uses — so a directive coming back cannot reach a control
 * this frame did not offer.
 */
export const dropdownDescriptorSchema = z
  .object({
    dropdownId: idSchema,
    /** Filled in by the worker; a frame cannot learn its own id. */
    frameId: z.number().int().nonnegative(),
    /** The complete question, as read from the label the control is tied to. */
    label: z.string().max(600),
    /**
     * How the scan would address this same element.
     *
     * Carried for one purpose: tying this pass's outcome back to the scanned
     * question afterwards. Matching the two on label wording was ambiguous
     * exactly where a form repeats a heading, so both sides compute one selector
     * with the scanner's own function. Nothing drives a control by it — the
     * frame reaches its own elements through the `dropdownId` registry.
     */
    selector: z.string().max(2000),
    /** The heading and legend the control sits under, for disambiguation. */
    sectionContext: z.string().max(600),
    required: z.boolean(),
    controlStrategy: dropdownKindSchema,
    /** What the control displays now. Compared, never assumed to be empty. */
    currentValue: z.string().max(600),
    disabled: z.boolean(),
    dependencyState: dropdownDependencyStateSchema,
    /**
     * Which repeated block this control belongs to, when the section has more
     * than one. A second education block's "Area of Study" must be answered
     * from the second education record, and without this every block would be
     * answered from the first.
     */
    recordIndex: z.number().int().nonnegative().optional(),
    /** Which pass found this control. Defaults to the pass's own DOM walk. */
    discoverySource: dropdownDiscoverySourceSchema.default('dropdown_scan'),
    /** The application scan's field id, when a seed named this element. */
    scanFieldId: idSchema.optional(),
    /**
     * The intent the application scan resolved for this control.
     *
     * Preferred over re-reading the label here. The scan has the section
     * context, the repeat index and the adapter's own knowledge of the page, and
     * two independent readings of one question that can disagree is one reading
     * too many.
     */
    scanCanonicalQuestion: canonicalQuestionSchema.optional(),
    /** How the control is built, for the trace. No values, ever. */
    structure: dropdownControlStructureSchema.optional(),
  })
  .strict();

export type DropdownDescriptor = z.infer<typeof dropdownDescriptorSchema>;

/** Where an intended answer came from. Ordered as the resolver tries them. */
export const intendedAnswerSourceSchema = z.enum([
  /** A canonical fact on the saved profile. */
  'profile_fact',
  /** A saved application preference. */
  'saved_preference',
  /** A fact saved against this specific employer. */
  'employer_fact',
  /** Derived from explicit saved facts by a documented rule, never a guess. */
  'derived_from_profile',
  /** An answer the user approved for this wording previously. */
  'approved_answer',
  /** No source could answer it. Always paired with a confirmation request. */
  'none',
]);

export type IntendedAnswerSource = z.infer<typeof intendedAnswerSourceSchema>;
/**
 * The answer the deterministic plan already resolved for one option control.
 *
 * Carried because deferring an option action to this engine must not throw away
 * what the planner knew. The two resolvers do not know the same things: the
 * planner has the scan's intent, the adapter's knowledge of the page, and the
 * structural rules that answer "Phone Type", "Address Type" and "How did you
 * hear about us" — none of which `resolveIntendedAnswer` derives on its own. The
 * first version of the deferral dropped those three answers on a form that had
 * been filling them correctly for months.
 *
 * So the division of labour is explicit: the **planner** decides what the answer
 * is, and this engine decides how to get it into the control. The engine's own
 * resolver remains the fallback for every control the planner said nothing
 * about, which is the majority of them.
 *
 * Worker-side only. This never travels to a frame during discovery — it reaches
 * the page only inside a `DropdownDirective`, exactly as every other answer
 * does.
 */
export const plannedOptionAnswerSchema = z
  .object({
    /** The scan's field id, which is how this is matched to a control. */
    fieldId: idSchema,
    /** The answer the planner resolved. Always a restatement of a saved fact. */
    intendedAnswer: z.string().max(600),
    intendedAnswerSource: intendedAnswerSourceSchema.default('profile_fact'),
    alternativeValues: z.array(z.string().max(600)).max(12).default([]),
    searchText: z.string().max(600).optional(),
    sensitive: z.boolean().default(false),
  })
  .strict();

export type PlannedOptionAnswer = z.infer<typeof plannedOptionAnswerSchema>;

/**
 * What the worker tells a frame to do with one control it offered.
 *
 * The answer travels as *meaning*, not as an option index or an exact label:
 * the frame is the only thing that can see what the control is offering at the
 * moment of the attempt, and the whole failure this engine exists to end came
 * from deciding the option text in advance.
 */
export const dropdownDirectiveSchema = z
  .object({
    dropdownId: idSchema,
    /** The canonical meaning of the question, for place-aware matching. */
    canonicalQuestion: canonicalQuestionSchema,
    /** The answer to reach. Empty only when confirmation is required. */
    intendedAnswer: z.string().max(600),
    intendedAnswerSource: intendedAnswerSourceSchema,
    /**
     * Other wordings of the *same saved fact*, tried in order after the first.
     * Not synonyms and not guesses: one employer's "Education Type" lists
     * institutions and the next lists degree programmes, and only the page can
     * say which taxonomy it is using.
     */
    alternativeValues: z.array(z.string().max(600)).max(12).default([]),
    /** What to type into a searchable control. Derived from saved values only. */
    searchText: z.string().max(600).optional(),
    /** Permits choosing the form's own "Other" entry. Off unless asked for. */
    allowOtherFallback: z.boolean().default(false),
    /**
     * True when this question is one the applicant alone may answer. The frame
     * still opens and enumerates it — the choices are worth recording — and
     * never selects anything.
     */
    requiresUserConfirmation: z.boolean().default(false),
    /** Why confirmation is needed, in words the popup can show verbatim. */
    confirmationPrompt: z.string().max(400).optional(),
    /** A protected characteristic or legal attestation. Never inferred. */
    sensitive: z.boolean().default(false),
  })
  .strict();

export type DropdownDirective = z.infer<typeof dropdownDirectiveSchema>;

/**
 * How one dropdown ended.
 *
 * Deliberately five words rather than "filled" and "failed". A control nobody
 * can answer but the applicant, a control the page would not let anything be
 * chosen in, and a control that was already correct are three different things
 * and need three different responses — and collapsing them is what made every
 * dropdown problem look like the same bug.
 */
export const dropdownFinalStatusSchema = z.enum([
  /** Selected, and the control's own state confirms it. */
  'FILLED_VERIFIED',
  /** Nothing saved answers this, or only the applicant may. Never guessed. */
  'USER_CONFIRMATION_REQUIRED',
  /** An answer was known and the control would not take it. */
  'FAILED_EXECUTION',
  /** The control could not be driven at all: disabled, or its parent is unset. */
  'BLOCKED',
  /** The control already displayed the intended answer. Left untouched. */
  'SKIPPED_ALREADY_VALID',
]);

export type DropdownFinalStatus = z.infer<typeof dropdownFinalStatusSchema>;

/** One option as the control offered it at the moment of the attempt. */
export const collectedOptionSchema = z
  .object({
    optionId: z.string().max(200),
    displayedText: z.string().max(600),
    value: z.string().max(600),
    disabled: z.boolean(),
    selected: z.boolean(),
    /** Case, punctuation and spacing flattened, for matching and for counting. */
    normalizedText: z.string().max(600),
  })
  .strict();

export type CollectedOption = z.infer<typeof collectedOptionSchema>;

/**
 * What became of one dropdown, at every stage it passed or stopped at.
 *
 * Each boolean is a separate observation rather than a summary, because
 * "Autofill failed" over a menu was one word covering five distinct repairs:
 * the list never opened, the list opened empty, the list had choices and none
 * matched, the option was clicked and did not take, the value reverted.
 */
export const dropdownRunResultSchema = z
  .object({
    dropdownId: idSchema,
    frameId: z.number().int().nonnegative(),
    /** The question as asked, for the popup to quote back. */
    question: z.string().max(600),
    /** How the scan addresses the same element, for tying the two passes. */
    selector: z.string().max(2000).default(''),
    canonicalQuestion: canonicalQuestionSchema,
    controlStrategy: dropdownKindSchema,
    intendedAnswerSource: intendedAnswerSourceSchema,
    intendedAnswerResolved: z.boolean(),
    /** How many real choices the control offered when it was read. */
    optionsFound: z.number().int().nonnegative(),
    /** The label chosen, absent when nothing was. Never an index. */
    matchedOption: z.string().max(600).optional(),
    opened: z.boolean(),
    /** True when the list itself had to be scrolled to read all of it. */
    scrolled: z.boolean(),
    selected: z.boolean(),
    verified: z.boolean(),
    finalStatus: dropdownFinalStatusSchema,
    errorCode: dropdownFailureCodeSchema.optional(),
    /** A sentence naming the actual cause. Never a bare failure. */
    reason: z.string().max(1000),
    durationMs: z.number().nonnegative().max(600_000),
    /**
     * The choices found, kept only for a control awaiting the applicant so the
     * popup can offer them rather than sending the user back to the page.
     * Empty for every other outcome — a verified control's option list is not
     * something worth carrying around.
     */
    availableOptions: z.array(collectedOptionSchema).max(600).default([]),
    /** Set when this control's own answer may have populated others. */
    mayHaveEnabledDependents: z.boolean().default(false),
    /**
     * Whether the in-page executor actually ran on this control.
     *
     * Written by the frame, and only by the frame. The worker fills in a record
     * for every directive it sent — including the ones whose frame never
     * answered — and without this flag those placeholders are indistinguishable
     * from controls the DOM executor genuinely reached and could not drive.
     * "The engine returned a result" is not "the page was driven", and this is
     * the field that separates them.
     */
    executorInvoked: z.boolean().default(false),
    /** Which pass found this control. See `dropdownDiscoverySourceSchema`. */
    discoverySource: dropdownDiscoverySourceSchema.default('dropdown_scan'),
    /** The application scan's field id, when a seed named this element. */
    scanFieldId: idSchema.optional(),
    /** How the control is built. Structure only — see the schema. */
    structure: dropdownControlStructureSchema.optional(),
    /** Whether a trigger element was resolved at all. */
    triggerResolved: z.boolean().default(false),
    /** Whether opening was attempted, as distinct from whether it worked. */
    openAttempted: z.boolean().default(false),
    menuDetection: menuDetectionStrategySchema.default('none'),
    optionCandidates: optionCandidateStrategySchema.default('none'),
    /** How many times the menu was scrolled while being read. */
    scrollIterations: z.number().int().nonnegative().max(200).default(0),
    /** Whether a matching option was found among the choices offered. */
    targetFound: z.boolean().default(false),
    /** Whether a click or keypress was dispatched at the matched option. */
    clickAttempted: z.boolean().default(false),
    /** What the control displayed after the attempt — as a yes/no, never text. */
    verificationObserved: z.boolean().default(false),
  })
  .strict();

export type DropdownRunResult = z.infer<typeof dropdownRunResultSchema>;

/**
 * The diagnostic view of one dropdown, with every answer stripped.
 *
 * A trace is a document people paste into bug reports, so no `matchedOption`,
 * no intended answer, and no option text survives. What is left — the control
 * shape, how many choices it offered, which stage it stopped at and how long it
 * took — is everything needed to tell the five failures apart, and nothing that
 * says anything about the applicant.
 */
export const dropdownEngineTraceSchema = z
  .object({
    question: z.string().max(300),
    controlStrategy: dropdownKindSchema,
    frameId: z.number().int().nonnegative(),
    canonicalQuestion: canonicalQuestionSchema,
    optionsFound: z.number().int().nonnegative(),
    intendedAnswerSource: intendedAnswerSourceSchema,
    intendedAnswerResolved: z.boolean(),
    opened: z.boolean(),
    scrolled: z.boolean(),
    selected: z.boolean(),
    verified: z.boolean(),
    finalStatus: dropdownFinalStatusSchema,
    failureCode: dropdownFailureCodeSchema.optional(),
    durationMs: z.number().nonnegative().max(600_000),
  })
  .strict();

export type DropdownEngineTrace = z.infer<typeof dropdownEngineTraceSchema>;

/**
 * The sanitized record of one attempt.
 *
 * The question wording survives — it is the page's text, not the applicant's,
 * and without it a trace of nine dropdowns is nine indistinguishable rows.
 * Everything that could carry an answer is dropped here rather than at the point
 * of export, so a new caller cannot forget to.
 */
export function toDropdownEngineTrace(result: DropdownRunResult): DropdownEngineTrace {
  return dropdownEngineTraceSchema.parse({
    question: result.question.slice(0, 300),
    controlStrategy: result.controlStrategy,
    frameId: result.frameId,
    canonicalQuestion: result.canonicalQuestion,
    optionsFound: result.optionsFound,
    intendedAnswerSource: result.intendedAnswerSource,
    intendedAnswerResolved: result.intendedAnswerResolved,
    opened: result.opened,
    scrolled: result.scrolled,
    selected: result.selected,
    verified: result.verified,
    finalStatus: result.finalStatus,
    ...(result.errorCode ? { failureCode: result.errorCode } : {}),
    durationMs: result.durationMs,
  });
}

/**
 * The Live Dropdown Trace: one option control, end to end, with no answers.
 *
 * Wider than `dropdownEngineTraceSchema` on purpose. That one is a per-field
 * summary; this is the record a live employer failure is diagnosed from without
 * another architecture rewrite, so it says which pass found the control, how the
 * control is built, how its menu was located, and which stage the attempt
 * stopped at.
 *
 * What may never be in here: any option text, any displayed value, any answer,
 * any sensitive selection, any token. `matchedOption` is deliberately absent —
 * an option label is an answer once a control has been driven to it. The
 * question wording survives because it is the employer's text, and a trace of
 * nine dropdowns without it is nine indistinguishable rows.
 */
export const liveDropdownTraceSchema = z
  .object({
    // ---- Field ------------------------------------------------------------
    dropdownId: z.string().max(200),
    scanFieldId: z.string().max(200).optional(),
    canonicalQuestion: canonicalQuestionSchema,
    question: z.string().max(300),
    frameId: z.number().int().nonnegative(),
    mainScannerFound: z.boolean(),
    dedicatedScannerFound: z.boolean(),
    discoverySource: dropdownDiscoverySourceSchema,

    // ---- Control structure -------------------------------------------------
    structure: dropdownControlStructureSchema.optional(),
    controlStrategy: dropdownKindSchema,

    // ---- Execution ---------------------------------------------------------
    engineCalled: z.boolean(),
    executorInvoked: z.boolean(),
    triggerResolved: z.boolean(),
    openAttempted: z.boolean(),
    openSucceeded: z.boolean(),
    menuDetection: menuDetectionStrategySchema,
    menuFound: z.boolean(),
    optionCandidates: optionCandidateStrategySchema,
    optionsFound: z.number().int().nonnegative(),
    scrolled: z.boolean(),
    scrollIterations: z.number().int().nonnegative().max(200),
    intendedAnswerSource: intendedAnswerSourceSchema,
    intendedAnswerResolved: z.boolean(),
    targetFound: z.boolean(),
    /** That an option matched — never which one. */
    matchedOption: z.boolean(),
    clickAttempted: z.boolean(),
    selected: z.boolean(),
    verificationObserved: z.boolean(),
    verified: z.boolean(),
    finalStatus: dropdownFinalStatusSchema,
    failureCode: dropdownFailureCodeSchema.optional(),
    durationMs: z.number().nonnegative().max(600_000),
  })
  .strict();

export type LiveDropdownTrace = z.infer<typeof liveDropdownTraceSchema>;

/**
 * The sanitized live record of one control.
 *
 * Every answer-bearing field is dropped here rather than at the point of
 * export, so a future caller cannot forget to. `matchedOption` becomes a
 * boolean; `availableOptions` never leaves this function.
 */
export function toLiveDropdownTrace(result: DropdownRunResult): LiveDropdownTrace {
  return liveDropdownTraceSchema.parse({
    dropdownId: result.dropdownId,
    ...(result.scanFieldId ? { scanFieldId: result.scanFieldId } : {}),
    canonicalQuestion: result.canonicalQuestion,
    question: result.question.slice(0, 300),
    frameId: result.frameId,
    mainScannerFound: result.discoverySource !== 'dropdown_scan',
    dedicatedScannerFound: result.discoverySource !== 'main_scan',
    discoverySource: result.discoverySource,
    ...(result.structure ? { structure: result.structure } : {}),
    controlStrategy: result.controlStrategy,
    // A result exists at all only because a directive was built for it, which is
    // what "the engine was called on this control" means.
    engineCalled: true,
    executorInvoked: result.executorInvoked,
    triggerResolved: result.triggerResolved,
    openAttempted: result.openAttempted,
    openSucceeded: result.opened,
    menuDetection: result.menuDetection,
    menuFound: result.menuDetection !== 'none',
    optionCandidates: result.optionCandidates,
    optionsFound: result.optionsFound,
    scrolled: result.scrolled,
    scrollIterations: result.scrollIterations,
    intendedAnswerSource: result.intendedAnswerSource,
    intendedAnswerResolved: result.intendedAnswerResolved,
    targetFound: result.targetFound,
    matchedOption: result.matchedOption !== undefined,
    clickAttempted: result.clickAttempted,
    selected: result.selected,
    verificationObserved: result.verificationObserved,
    verified: result.verified,
    finalStatus: result.finalStatus,
    ...(result.errorCode ? { failureCode: result.errorCode } : {}),
    durationMs: result.durationMs,
  });
}

/**
 * One live trace as a sentence, for a bug report to carry verbatim.
 *
 * The stages are named in the order they happen and the *first* one that failed
 * is the diagnosis, because everything after it is a consequence. A reader who
 * knows nothing about this codebase should be able to say what to fix from this
 * line alone — that is the entire reason the trace exists.
 *
 * No answers. The question wording is the employer's own text; every other part
 * of this string is a stage name, a count, or a code.
 */
export function describeLiveDropdown(trace: LiveDropdownTrace): string {
  const where =
    trace.discoverySource === 'main_scan'
      ? 'found only by the application scan'
      : trace.discoverySource === 'dropdown_scan'
        ? 'found only by the dropdown scan'
        : 'found by both scans';
  const shape = trace.structure
    ? `${trace.structure.triggerTag}${trace.structure.triggerRole ? `[role=${trace.structure.triggerRole}]` : ''}`
    : trace.controlStrategy;
  const stage = !trace.triggerResolved
    ? 'no trigger could be resolved'
    : !trace.openAttempted
      ? 'it was never opened'
      : !trace.openSucceeded
        ? 'nothing opened for a click, a keypress, or typing'
        : !trace.menuFound
          ? 'a menu opened and could not be recognised'
          : trace.optionsFound === 0
            ? 'the menu opened holding nothing'
            : !trace.intendedAnswerResolved
              ? `${trace.optionsFound} choices were read and nothing saved answers this`
              : !trace.targetFound
                ? `${trace.optionsFound} choices were read and none of them is the saved answer`
                : !trace.clickAttempted
                  ? 'a match was found and never clicked'
                  : !trace.verificationObserved
                    ? 'it was clicked and the control reported nothing back'
                    : trace.verified
                      ? `answered from ${trace.optionsFound} choices`
                      : 'it was clicked and the control still shows something else';
  const menu =
    trace.menuDetection === 'mutation_fallback'
      ? ' via the no-ARIA fallback'
      : trace.menuDetection === 'none'
        ? ''
        : ` via ${trace.menuDetection}`;
  const scrolls = trace.scrollIterations > 1 ? `, ${trace.scrollIterations} reads` : '';
  return `${trace.question || '(unlabelled)'} — frame ${trace.frameId}, ${shape}, ${where}: ${stage}${menu}${scrolls}${
    trace.failureCode ? ` [${trace.failureCode}]` : ''
  } (${trace.durationMs}ms)`;
}

/**
 * What a frame answers when asked which option controls it holds.
 *
 * Validated on the way *in* to the worker, like every other cross-boundary
 * message: a frame reports descriptors and nothing else, and `.strict()` means a
 * page that managed to influence the reply cannot smuggle an extra key through
 * it. The worker stamps `frameId` itself afterwards, because a frame cannot
 * learn its own id and a control discovered in one frame must never be driven in
 * another.
 */
export const dropdownsDiscoveredSchema = z
  .object({
    dropdowns: z.array(dropdownDescriptorSchema).max(400),
  })
  .strict();

export type DropdownsDiscovered = z.infer<typeof dropdownsDiscoveredSchema>;

/**
 * What a frame answers once it has driven the directives it was given.
 *
 * One result per directive is the contract the caller re-imposes anyway: a
 * control missing from this list is indistinguishable from one that was never on
 * the form, which is exactly how a half-filled page comes back looking complete.
 */
export const dropdownDirectivesCompleteSchema = z
  .object({
    results: z.array(dropdownRunResultSchema).max(400),
  })
  .strict();

export type DropdownDirectivesComplete = z.infer<typeof dropdownDirectivesCompleteSchema>;

/** The whole pass, as one record. */
export const dropdownRunSummarySchema = z
  .object({
    discovered: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    awaitingUser: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    alreadyValid: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().max(600_000),
  })
  .strict();

export type DropdownRunSummary = z.infer<typeof dropdownRunSummarySchema>;

export function summarizeDropdownRun(
  results: readonly DropdownRunResult[],
  durationMs: number,
): DropdownRunSummary {
  const count = (status: DropdownFinalStatus): number =>
    results.filter((result) => result.finalStatus === status).length;
  return dropdownRunSummarySchema.parse({
    discovered: results.length,
    selected: results.filter((result) => result.selected).length,
    verified: results.filter((result) => result.verified).length,
    awaitingUser: count('USER_CONFIRMATION_REQUIRED'),
    failed: count('FAILED_EXECUTION'),
    blocked: count('BLOCKED'),
    alreadyValid: count('SKIPPED_ALREADY_VALID'),
    durationMs,
  });
}
