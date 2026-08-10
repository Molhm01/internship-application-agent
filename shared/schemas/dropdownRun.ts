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
