import { z } from 'zod';
import { idSchema } from './common.js';
import { errorCodeSchema } from './error.js';
import {
  dateRequirementSchema,
  dateShapeSchema,
  dateValidationStateSchema,
  datePrecisionSchema,
  dayConventionSchema,
  normalizedDateSchema,
} from './dates.js';

/**
 * Agent Mode: the contract between the page, the model, and the executor.
 *
 * ## Why this replaces the plan
 *
 * The old pipeline scanned a whole page, planned every field at once, executed
 * the lot, and reconciled afterwards. Every stage of that is a bet that the page
 * will still be what the scan said it was — and on a real employer portal it is
 * not. A State list does not exist until Country is chosen. A second Work
 * Experience block does not exist until Add is pressed. A dropdown's options do
 * not exist until it is opened. A plan built before any of that happened is a
 * plan about a page that never existed, and reconciling it afterwards is an
 * attempt to make the page match a stale belief.
 *
 * So the plan is gone. The agent makes *one* decision, executes *one* action,
 * looks at the page again, and decides again. The page's current state is the
 * only input to the next decision, which means a dependency does not need a
 * graph to be respected: Country becomes United States, the next observation
 * shows State enabled with options, and the agent handles State because that is
 * what the page now offers.
 *
 * ## What the model may and may not say
 *
 * The model receives a sanitized observation and returns one object matching
 * `agentDecisionSchema`. It cannot express a selector, a script, an index, or
 * more than one action. `elementId` is a handle the *extension* minted for this
 * observation and can only be resolved against that observation — so a model
 * that invents one addresses nothing, and a model that repeats a handle from
 * two observations ago addresses nothing either.
 *
 * Nothing here can carry executable code, and nothing in the extension
 * evaluates model output.
 */

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * What kind of control this is, in the vocabulary the agent reasons about.
 *
 * Coarser than the scanner's field types on purpose: the agent's decision is
 * "type into it" or "open it and choose", and a vocabulary that distinguishes
 * `tel` from `email` invites the model to reason about things that do not
 * change which tool to call.
 */
export const observedControlKindSchema = z.enum([
  'text',
  'textarea',
  'dropdown',
  'radio_group',
  'checkbox',
  'date',
  'file_upload',
  'button',
  'unknown',
]);

export type ObservedControlKind = z.infer<typeof observedControlKindSchema>;

/**
 * How a control must be *operated*, decided by the extension from the live
 * element — never by the model, and never inherited from a field type.
 *
 * This exists because the agent typed an answer into a dropdown on a live
 * application. `kind` was too coarse to prevent it and, worse, it was derived
 * from the scanner's field type: a vendor control the scanner reads as a text
 * box is one the agent will try to type into, whatever it actually is.
 *
 * So interaction type is computed from what the element *does*: does it open a
 * list, does it carry its own options, can a person put characters into it. It
 * is the authority the tool validator enforces against, and a control that
 * answers from a list can never be typed into however it is marked up.
 */
export const interactionTypeSchema = z.enum([
  'TEXT_INPUT',
  'TEXTAREA',
  /** A real <select>. Its options are in the DOM already. */
  'NATIVE_SELECT',
  /** Opens a menu. Never typed into. */
  'CUSTOM_SELECT',
  /** Opens a menu that contains its own search box. See the rules below. */
  'SEARCHABLE_COMBOBOX',
  /** A question answered by exactly one of several radio choices. */
  'RADIO_GROUP',
  /** A question answered by one or more checkbox choices. */
  'CHECKBOX_GROUP',
  /** One independent boolean checkbox or switch. */
  'SINGLE_CHECKBOX',
  'DATE_INPUT',
  'FILE_UPLOAD',
  'BUTTON',
  'LINK',
  'UNKNOWN',
]);

export type InteractionType = z.infer<typeof interactionTypeSchema>;

/**
 * The control families that answer from a list of choices.
 *
 * `type` is refused for every one of them. A searchable combobox is included
 * deliberately: its *search box* accepts characters, and the control itself
 * still does not — typing a query is not choosing an answer, and a run that
 * treated it as one would leave the field unanswered while reporting success.
 */
export const OPTION_INTERACTION_TYPES: readonly InteractionType[] = [
  'NATIVE_SELECT',
  'CUSTOM_SELECT',
  'SEARCHABLE_COMBOBOX',
  'RADIO_GROUP',
  'CHECKBOX_GROUP',
];

/** Choice controls that reveal their options by opening a popup. */
export const DROPDOWN_INTERACTION_TYPES: readonly InteractionType[] = [
  'NATIVE_SELECT',
  'CUSTOM_SELECT',
  'SEARCHABLE_COMBOBOX',
];

/**
 * The control families a date goes into, and which `type` is refused for.
 *
 * A date control is not a text box that happens to hold digits. It states a
 * format — in its `type`, its `pattern`, or its placeholder — and it validates
 * against that format, which means the *stored* representation of a date is
 * almost never the one it will accept. On a live Lincoln Electric application
 * the agent typed the profile's `2021-07` into a box reading `MM/DD/YYYY` and
 * the employer answered "Invalid date."
 *
 * `type` cannot express a conversion, because the string it carries was chosen
 * before anything looked at the control. `set_date` carries the date as parts
 * and renders it at the moment of execution against the control in front of it,
 * so the same saved fact becomes `07/12/2021` on one form and `2021-07-12` on
 * another. That is why this is a separate list and a separate refusal rather
 * than better prompt wording.
 */
export const DATE_INTERACTION_TYPES: readonly InteractionType[] = ['DATE_INPUT'];

/** Where a dropdown currently is, so the tools available to it are decidable. */
export const dropdownStateSchema = z.enum(['CLOSED', 'OPEN', 'SEARCHING', 'SELECTED']);
export type DropdownState = z.infer<typeof dropdownStateSchema>;

/**
 * How this question may be answered, decided by the extension and not the model.
 *
 * The model is told the classification; it does not get to choose it. That is
 * the whole of the factual-answer policy: a `SENSITIVE` question cannot become
 * answerable because a model decided it was fine, and an `UNKNOWN_FACT` cannot
 * be filled from something that merely sounds similar.
 */
export const answerPolicySchema = z.enum([
  /** A saved fact answers this. The agent may fill it. */
  'KNOWN_FACT',
  /** Nothing saved answers it. The agent asks rather than guesses. */
  'UNKNOWN_FACT',
  /** A protected characteristic. Never inferred, ever. */
  'SENSITIVE',
  /** An attestation. Requires review unless an explicit saved preference permits. */
  'LEGAL_ACKNOWLEDGMENT',
  /** Free prose the model may draft from trusted context, never invent facts into. */
  'SUBJECTIVE',
]);

export type AnswerPolicy = z.infer<typeof answerPolicySchema>;

/** One option a control is currently offering. Never a stale scan snapshot. */
export const observedOptionSchema = z
  .object({
    /**
     * A runtime handle for one offered choice, minted by the observation that
     * read it, of the form `e12::option::3`. The model selects by this and
     * never by text, so it cannot name a choice the control is not offering.
     */
    optionId: z.string().max(80).default(''),
    /** Position in the exact option observation that minted optionId. */
    index: z.number().int().nonnegative().max(5000).optional(),
    label: z.string().max(300),
    /** The live DOM value, when the control exposes one. */
    value: z.string().max(1000).optional(),
    disabled: z.boolean().default(false),
    selected: z.boolean().default(false),
  })
  .strict();

/**
 * Value-free structural evidence captured at the final Agent classifier.
 * Emitted only for the three temporary SuccessFactors diagnostic targets and
 * only when developer diagnostics are enabled.
 */
export const controlClassificationTraceSchema = z
  .object({
    event: z.literal('CONTROL_CLASSIFICATION_TRACE'),
    elementTagName: z.string().max(40),
    elementTypeAttribute: z.string().max(40),
    elementRole: z.string().max(80),
    elementAriaHasPopup: z.string().max(80),
    elementAriaExpanded: z.string().max(20),
    elementHasAriaControls: z.boolean(),
    elementAriaAutocomplete: z.string().max(80),
    elementReadonly: z.boolean(),
    elementDisabled: z.boolean(),
    parentTagName: z.string().max(40),
    parentRole: z.string().max(80),
    parentAriaHasPopup: z.string().max(80),
    parentAriaExpanded: z.string().max(20),
    closestRoleComboboxExists: z.boolean(),
    closestAriaHasPopupExists: z.boolean(),
    closestButtonExists: z.boolean(),
    nearbyButtonCount: z.number().int().nonnegative().max(100),
    nearbyDropdownArrowCount: z.number().int().nonnegative().max(100),
    associatedLabelRelationType: z.enum([
      'label_for',
      'aria_labelledby',
      'aria_label',
      'wrapped_label',
      'container_text',
      'none',
    ]),
    logicalFieldContainerTag: z.string().max(40),
    logicalFieldContainerClassTokens: z.array(z.string().max(60)).max(16),
    nativeSelectExistsInFieldContainer: z.boolean(),
    inputExistsInFieldContainer: z.boolean(),
    buttonExistsInFieldContainer: z.boolean(),
    roleComboboxExistsInFieldContainer: z.boolean(),
    ariaHasPopupExistsInFieldContainer: z.boolean(),
    scannerTypeBeforeNormalization: z.string().max(80),
    adapterType: z.string().max(80),
    normalizedType: z.string().max(80),
    finalAgentControlType: interactionTypeSchema,
  })
  .strict();

export type ControlClassificationTrace = z.infer<typeof controlClassificationTraceSchema>;

/**
 * One control, as it stands at this instant.
 *
 * `elementId` is minted per observation. It is the only way the model can name
 * anything, and it is meaningless outside the observation that issued it —
 * which is what stops a decision from addressing an element that has since been
 * replaced by a re-render.
 */
export const observedElementSchema = z
  .object({
    elementId: z.string().max(40),
    /** The section heading this control sits under, for disambiguation. */
    section: z.string().max(120).default(''),
    label: z.string().max(300),
    kind: observedControlKindSchema,
    /** How this control must be operated. The tool validator's authority. */
    interactionType: interactionTypeSchema.default('UNKNOWN'),
    /** Temporary developer-only structural trace for the live classifier miss. */
    controlClassificationTrace: controlClassificationTraceSchema.optional(),
    /** Where this dropdown is, when it is one. */
    dropdownState: dropdownStateSchema.default('CLOSED'),
    /** What the control displays now. Empty for a control holding nothing. */
    currentValue: z.string().max(300).default(''),
    required: z.boolean().default(false),
    disabled: z.boolean().default(false),
    visible: z.boolean().default(true),
    /**
     * The choices the control is offering *right now*, and only when it is
     * genuinely open or is a native select. A closed custom dropdown reports
     * none, because it has none until it is opened — pretending otherwise is
     * what made the old planner match against options that no longer existed.
     */
    options: z.array(observedOptionSchema).max(400).default([]),
    optionsKnown: z.boolean().default(false),
    /**
     * Whether the *form* holds this selection, as opposed to merely showing it.
     *
     * A dropdown has two states that look identical from outside and are not
     * the same thing at all: the text its trigger renders, and the value it
     * submits. On Lincoln Electric the Education Type trigger read "BS" and the
     * backing value was empty, so the form went on reporting the question as
     * required while the run counted it answered.
     *
     * Defaults to true, and is set false only on *positive evidence* — a
     * `<select>` sitting on an empty value, a backing input the widget left
     * blank, a listbox with nothing marked selected. A widget whose storage
     * cannot be found is not accused of losing anything.
     */
    selectionCommitted: z.boolean().default(true),
    /**
     * The employer form's own complaint about this control, when it has one.
     *
     * The most authoritative signal on the page: whatever the control displays,
     * a form still saying "Education Type is required" has not accepted an
     * answer. Read from `aria-invalid`, constraint validation, and the error
     * text the control points at.
     */
    validationError: z.string().max(300).default(''),
    /**
     * The search box inside this dropdown's *currently open* menu.
     *
     * Present only while the menu is open and actually carries one. It is also
     * emitted as an observed element in its own right, typed `TEXT_INPUT`, so
     * the one place a query may be typed is a real control the validator can
     * check — rather than an exception carved into the rule that a dropdown is
     * never typed into.
     */
    searchInputId: z.string().max(40).optional(),
    /** True when this control's open menu offers a search box. */
    searchable: z.boolean().default(false),
    /** The dropdown this element is the search box for, when it is one. */
    searchInputFor: z.string().max(40).optional(),
    /** Which repeated block this belongs to, when the section has more than one. */
    blockIndex: z.number().int().nonnegative().max(50).optional(),
    /**
     * What this date control said about the date it will accept.
     *
     * Present only on `DATE_INPUT`, and made of the page's own words — the
     * input type, the placeholder, the pattern, the bounds. It is what makes
     * the decision "which string does this control want" answerable *before*
     * anything is written, instead of discovered from an "Invalid date."
     * message afterwards.
     */
    dateRequirement: dateRequirementSchema.optional(),
    /** The canonical intent, when the scanner resolved one. */
    intent: z.string().max(80).optional(),
    policy: answerPolicySchema,
    /** The answer the extension trusts for this control, when there is one. */
    proposedValue: z.string().max(2000).optional(),
    /**
     * The control whose answer switches this one on, and whether it currently
     * does. Observed, never assumed — this is what keeps a relatives-detail box
     * blank while the question above it is unanswered.
     */
    dependsOnElementId: z.string().max(40).optional(),
    dependencyActive: z.boolean().optional(),
    dependencyStatus: z.enum(['WAITING_FOR_DEPENDENCY', 'NOT_APPLICABLE', 'ACTIVE']).optional(),
    frameId: z.number().int().nonnegative().default(0),
  })
  .strict();

export type ObservedElement = z.infer<typeof observedElementSchema>;

/** A control that adds another repeated block, and what it would add to. */
export const observedRepeaterSchema = z
  .object({
    elementId: z.string().max(40),
    section: z.string().max(120),
    label: z.string().max(200),
    /** Blocks currently on the page for this section. */
    blockCount: z.number().int().nonnegative().max(50),
    /** Saved records for it. `blockCount < recordCount` is why Add is pressed. */
    recordCount: z.number().int().nonnegative().max(50),
    frameId: z.number().int().nonnegative().default(0),
  })
  .strict();

/** A navigation control. Final-submit candidates are marked, never offered. */
export const observedNavigationSchema = z
  .object({
    elementId: z.string().max(40),
    label: z.string().max(200),
    /**
     * True when pressing this would submit the application.
     *
     * Decided by the extension from the button's own words and the page's
     * structure, and it is the reason the model is never in a position to
     * submit: a control marked this way is refused by the safety layer whatever
     * the model asks for, and when the extension is *unsure* it marks it true.
     */
    finalSubmit: z.boolean(),
    frameId: z.number().int().nonnegative().default(0),
  })
  .strict();

/** Everything the agent knows about the page at one instant. */
export const pageObservationSchema = z
  .object({
    observationId: z.string().max(60),
    /** Origin only — a path can carry a requisition or session id. */
    origin: z.string().max(300).default(''),
    title: z.string().max(300).default(''),
    /** Section headings in page order, so the agent can work top to bottom. */
    sections: z.array(z.string().max(120)).max(40).default([]),
    elements: z.array(observedElementSchema).max(400).default([]),
    repeaters: z.array(observedRepeaterSchema).max(20).default([]),
    navigation: z.array(observedNavigationSchema).max(20).default([]),
    /** How many required controls still hold nothing. */
    requiredOutstanding: z.number().int().nonnegative().default(0),
    takenAt: z.string().max(40).default(''),
  })
  .strict();

export type PageObservation = z.infer<typeof pageObservationSchema>;

// ---------------------------------------------------------------------------
// Multiple-choice model contract
// ---------------------------------------------------------------------------

/** Sanitized context from the last action the page rejected or did not keep. */
export const agentFailureFeedbackSchema = z
  .object({
    previousTool: z.lazy(() => agentToolSchema),
    /** Employer wording only; never the value that was attempted. */
    field: z.string().max(200),
    logicalField: z.string().max(300).default(''),
    result: errorCodeSchema,
    /** More specific verifier/executor code, when one exists. */
    detailErrorCode: errorCodeSchema.optional(),
    observedState: z.enum([
      'EMPTY',
      'HOLDS_EXPECTED',
      'HOLDS_OTHER',
      'REJECTED_BY_FORM',
      'NOT_FOUND',
      'PLACEHOLDER',
      'COMMITTED',
      'UNKNOWN',
    ]),
    pageChanged: z.boolean(),
    /** Authoritative type recorded on the failed action's observation. */
    previousControlType: interactionTypeSchema,
    /** Authoritative type on the fresh observation used for recovery. */
    controlType: interactionTypeSchema,
    identicalActionAlreadyFailed: z.boolean().default(false),
    /** Strategy correction only. It never contains an applicant value. */
    guidance: z.string().max(500),
  })
  .strict();

export type AgentFailureFeedback = z.infer<typeof agentFailureFeedbackSchema>;

export const agentChoiceRequestSchema = z
  .object({
    fieldType: interactionTypeSchema,
    question: z.string().min(1).max(500),
    candidateContext: z
      .record(z.union([z.string().max(2000), z.boolean(), z.number().finite()]))
      .default({}),
    choices: z
      .array(
        z
          .object({
            optionId: z.string().min(1).max(80),
            label: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(400),
    previousFailure: agentFailureFeedbackSchema.optional(),
  })
  .strict();

export type AgentChoiceRequest = z.infer<typeof agentChoiceRequestSchema>;

export const agentChoiceDecisionSchema = z
  .object({
    decision: z.enum(['SELECT', 'ASK_USER']),
    optionId: z.string().max(80).optional(),
    optionIds: z.array(z.string().min(1).max(80)).min(1).max(100).optional(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(600),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.decision === 'SELECT' && !decision.optionId && !decision.optionIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionId'],
        message: 'SELECT requires optionId or optionIds',
      });
    }
    if (decision.optionId && decision.optionIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionIds'],
        message: 'SELECT must use optionId or optionIds, not both',
      });
    }
    if (decision.decision === 'ASK_USER' && (decision.optionId || decision.optionIds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionId'],
        message: 'ASK_USER must not carry option IDs',
      });
    }
  });

export type AgentChoiceDecision = z.infer<typeof agentChoiceDecisionSchema>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The complete set of things the agent may do to a page.
 *
 * A closed list, enforced by `z.enum`, and the only vocabulary the model has.
 * There is no "run this script" member and there will not be one: the model
 * chooses *which* of these to call and on *which* observed element, and the
 * extension owns every line of what actually happens to the DOM.
 */
export const AGENT_TOOLS = [
  'observe_page',
  'click',
  'type',
  /**
   * Writes a date into a date control, in whatever shape that control wants.
   *
   * Distinct from `type` because the value does not exist yet when the decision
   * is made. `type` carries a finished string chosen against the profile;
   * `set_date` carries the date as parts and the *executor* renders it against
   * the control's stated format. That is the whole repair for the live failure
   * in which `2021-07` was typed into an `MM/DD/YYYY` box.
   */
  'set_date',
  'clear',
  'focus',
  'open_dropdown',
  'get_options',
  'select_option',
  'select_options',
  'set_checked',
  'scroll_page',
  'scroll_element',
  'wait_for_change',
  'click_add',
  'upload_document',
  'click_next',
  'ask_user',
  'finish_for_review',
] as const;

export const agentToolSchema = z.enum(AGENT_TOOLS);
export type AgentTool = z.infer<typeof agentToolSchema>;

/** Tools that write to the page. Everything else only looks. */
export const MUTATING_TOOLS: readonly AgentTool[] = [
  'click',
  'type',
  'set_date',
  'clear',
  'select_option',
  'select_options',
  'set_checked',
  'click_add',
  'upload_document',
  'click_next',
];

/**
 * One tool call: a tool, a target the observation issued, and a literal value.
 *
 * `.strict()` throughout, so a model that adds `selector`, `script`, `xpath` or
 * `js` loses the key at the schema boundary rather than having it read by
 * something downstream.
 */
export const agentToolCallSchema = z
  .object({
    tool: agentToolSchema,
    /** A handle from the current observation. Never a selector. */
    elementId: z.string().max(40).optional(),
    /**
     * What to type, or which offered option to choose.
     *
     * A literal, and the safety layer checks it against the trusted context: a
     * value the model invented for a factual question is refused, because the
     * agent may restate saved facts and may not make them up.
     */
    value: z.string().max(2000).optional(),
    /**
     * Which offered choice to select, by the handle the observation issued.
     *
     * The model may not invent one: a handle no current observation minted
     * resolves to nothing, which is what stops "select the option I imagine
     * exists" from being expressible.
     */
    optionId: z.string().max(80).optional(),
    /** The actual offered choices to select for a multi-answer control. */
    optionIds: z.array(z.string().max(80)).max(100).optional(),
    /** The state requested from one independent checkbox. */
    checked: z.boolean().optional(),
    /**
     * The date to write, for `set_date`. Parts, never a rendered string.
     *
     * There is deliberately nowhere in this object to put `"2021-07"` for a
     * date — the shape a control receives is decided by the executor, against
     * that control, at the moment of writing. And because `day` is separate
     * from `month`, "the applicant did not state a day" survives all the way to
     * the DOM instead of being lost inside a string that looks complete.
     */
    normalizedDate: normalizedDateSchema.optional(),
    /** Which stored document to attach, by kind. Never a path. */
    documentKind: z.enum(['resume', 'cover_letter']).optional(),
    /** The question to put to the applicant, for `ask_user`. */
    question: z.string().max(500).optional(),
  })
  .strict();

export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** What the agent decided to do with this observation. */
export const agentDecisionKindSchema = z.enum([
  'ACTION',
  'ASK_USER',
  'READY_FOR_REVIEW',
  'BLOCKED',
]);

export type AgentDecisionKind = z.infer<typeof agentDecisionKindSchema>;

/**
 * Exactly one decision, per observation.
 *
 * Deliberately not an array. The old system's failure mode was a list of
 * twenty-six actions decided before any of them ran, and a schema that cannot
 * express a list is the cheapest possible guarantee that it cannot come back.
 */
export const agentDecisionSchema = z
  .object({
    kind: agentDecisionKindSchema,
    /** Why, in one sentence. Shown in the trace, never used to decide anything. */
    reason: z.string().max(600).default(''),
    /** Present when `kind` is ACTION. */
    action: agentToolCallSchema.optional(),
    /** Present when `kind` is ASK_USER. */
    question: z.string().max(500).optional(),
    /** The element the question is about, so the popup can name it. */
    elementId: z.string().max(40).optional(),
    /**
     * Why the agent could not settle this itself.
     *
     * Set on an ASK_USER that follows a dropdown the agent opened, read, and
     * found nothing matching in — `DROPDOWN_TARGET_NOT_FOUND`. It records that
     * the list was actually consulted, which is what distinguishes "the page
     * does not offer this answer" from "the agent never looked".
     */
    errorCode: errorCodeSchema.optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.kind === 'ACTION' && !decision.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'An ACTION decision must carry exactly one tool call',
      });
    }
    if (decision.kind !== 'ACTION' && decision.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'Only an ACTION decision may carry a tool call',
      });
    }
    if (decision.kind === 'ASK_USER' && !decision.question) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['question'],
        message: 'An ASK_USER decision must carry the question to ask',
      });
    }
  });

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

// ---------------------------------------------------------------------------
// Execution and verification
// ---------------------------------------------------------------------------

export const toolExecutionResultSchema = z
  .object({
    tool: agentToolSchema,
    executed: z.boolean(),
    /** What the control held afterwards, for the verifier. Never logged raw. */
    observedValue: z.string().max(600).default(''),
    /** Options a `get_options` / `open_dropdown` call actually read. */
    options: z.array(observedOptionSchema).max(400).default([]),
    /**
     * How many choices the tool read while working, as a count.
     *
     * Separate from `options` because a successful selection deliberately does
     * not carry its option list home — a verified control has no need of one,
     * and shipping several thousand strings per run would be waste. The count
     * survives, so a trace can still prove a selection was made from a list the
     * engine had actually read.
     */
    optionsSeen: z.number().int().nonnegative().max(5000).default(0),
    /** True when the page changed in a way the tool was waiting for. */
    pageChanged: z.boolean().default(false),
    /**
     * The shape `set_date` actually wrote, as a shape name.
     *
     * `us_full`, never `07/12/2021`. It is what lets a trace prove a date went
     * in as `MM/DD/YYYY` without recording which date it was.
     */
    dateShapeWritten: dateShapeSchema.optional(),
    /**
     * How the page judged the date control on either side of the write.
     *
     * Both, because one is not interpretable without the other: a control that
     * was already showing "Invalid date." before the agent touched it and one
     * the agent's own value was rejected by look identical from the "after"
     * reading alone, and only the second is this run's problem.
     */
    dateValidationBefore: dateValidationStateSchema.optional(),
    dateValidationAfter: dateValidationStateSchema.optional(),
    reason: z.string().max(600).default(''),
    errorCode: errorCodeSchema.optional(),
    durationMs: z.number().nonnegative().max(600_000).default(0),
  })
  .strict();

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;

/**
 * How an action's effect was checked against the page afterwards.
 *
 * Four states, not three, because "could not confirm" and "confirmed wrong"
 * are different facts and only one of them is recoverable by looking again.
 *
 * - `VERIFIED` — the control holds what the action intended.
 * - `NOT_VERIFIED` — nothing could be read back. The control was replaced, or
 *   the page moved on, and the outcome is genuinely unknown.
 * - `VERIFICATION_FAILED` — the page was read and contradicts the action. The
 *   live case: Education Type *displayed* "BS" while the value behind it was
 *   empty and the form still showed "Education Type is required". A control
 *   that changed its visible text and kept nothing has failed, and calling that
 *   merely unconfirmed is how a blank application came to report success.
 * - `NOT_APPLICABLE` — the action wrote nothing to verify.
 */
export const agentVerificationSchema = z.enum([
  'VERIFIED',
  'NOT_VERIFIED',
  'VERIFICATION_FAILED',
  'NOT_APPLICABLE',
]);

export type AgentVerification = z.infer<typeof agentVerificationSchema>;

// ---------------------------------------------------------------------------
// Run state and trace
// ---------------------------------------------------------------------------

/**
 * The nine-condition readiness verdict, recorded per cycle.
 *
 * In the trace because the live failure was invisible without it: a run that
 * says READY_FOR_REVIEW and a run that says READY_FOR_REVIEW look identical,
 * and only one of them had actually finished. These counts are the difference.
 */
/**
 * How one required field ended the run.
 *
 * Every required control on the page finishes in exactly one of these, and that
 * exhaustiveness is the point. The live failure was a run reporting
 * `unresolvedRequired: 9` beside `ready: true` — nine required fields that were
 * blank and were in *no* category at all, so they blocked nothing and were
 * reported to nobody. A field cannot disappear from the accounting any more,
 * because there is nowhere for it to disappear to.
 */
export const agentFieldOutcomeSchema = z.enum([
  /** Filled by the agent and confirmed against the page afterwards. */
  'FILLED_VERIFIED',
  /** Blank, and nothing saved answers it. The applicant must supply it. */
  'USER_INPUT_REQUIRED',
  /** Answered, and the applicant has to confirm it before submitting. */
  'USER_REVIEW_REQUIRED',
  /** A conditional control its parent does not currently switch on. */
  'NOT_APPLICABLE',
  /** A saved answer exists and the page would not accept it. */
  'BLOCKED_EXECUTION',
  /** The question is answerable in principle and the profile holds nothing. */
  'BLOCKED_DATA_MISSING',
  /** A control that would submit. Never pressed, by construction. */
  'FINAL_SUBMIT_PROTECTED',
]);

export type AgentFieldOutcome = z.infer<typeof agentFieldOutcomeSchema>;

/**
 * The readiness verdict, recorded per cycle.
 *
 * ## What went wrong with the previous version
 *
 * `unresolvedRequired` was computed, reported, and **never referenced by the
 * `ready` conjunction**. It was a display counter beside a boolean that did not
 * consult it, so a live run reported nine blank required fields and called
 * itself ready in the same object.
 *
 * Every count here now feeds the verdict, and the counts are exhaustive over
 * the required fields: an unresolved required control is *always* in one of
 * `blockedDataMissing`, `userInputRequired`, `userReviewRequired` or
 * `blockedExecution`, and every one of those blocks readiness. A test asserts
 * the arithmetic, so a field cannot fall out of the accounting without
 * something failing.
 */
export const agentReadyEvaluationSchema = z
  .object({
    /** Required, live, and holding nothing. The number that must reach zero. */
    unresolvedRequired: z.number().int().nonnegative(),
    /** Required fields the agent filled and the page confirmed. */
    verifiedRequired: z.number().int().nonnegative().default(0),
    /** Explicit terminal-outcome count: the applicant still owes an answer. */
    userInputRequired: z.number().int().nonnegative().default(0),
    /** Explicit terminal-outcome count: an answer exists but is not on the page yet. */
    userReviewRequired: z.number().int().nonnegative().default(0),
    /** Explicit terminal-outcome count: the page refused a known answer. */
    blockedExecution: z.number().int().nonnegative().default(0),
    /** Explicit terminal-outcome count: a known-answer action is still pending. */
    blockedDataMissing: z.number().int().nonnegative().default(0),
    /** Fields with a saved answer that has not been applied. Blocks readiness. */
    knownActionableRemaining: z.number().int().nonnegative(),
    /**
     * Required questions the applicant has not answered yet.
     *
     * *Not* "questions not yet asked". The previous definition subtracted every
     * question the agent had put to the applicant, so asking five questions
     * drove this to zero and readiness followed — the agent marked its own
     * questions resolved by asking them. Only an answer removes one now.
     */
    askUserRemaining: z.number().int().nonnegative(),
    /** Required fields with a saved answer the page refused. Blocks readiness. */
    blockedRequiredRemaining: z.number().int().nonnegative().default(0),
    /** Required, available documents not yet attached. Blocks readiness. */
    requiredDocumentsPending: z.number().int().nonnegative().default(0),
    /** Optional blanks. Reported, and deliberately not blocking. */
    optionalRemaining: z.number().int().nonnegative().default(0),
    documentsPending: z.boolean().default(false),
    finalSubmitReached: z.boolean().default(false),
    /** Fields the agent tried and could not settle. The applicant finishes these. */
    blockedRemaining: z.number().int().nonnegative().default(0),
    /**
     * The authoritative predicate: may this application be called finished?
     *
     * True only when every count above that represents outstanding work is
     * zero. It is deliberately the *strict* reading — "the agent has done all
     * it safely can" is a different question, answered by the run status.
     */
    ready: z.boolean(),
    /** Trace-facing name for the same authoritative predicate. */
    readyForReview: z.boolean(),
  })
  .strict();

export type AgentReadyEvaluation = z.infer<typeof agentReadyEvaluationSchema>;

/**
 * What the saved profile could offer this run, as booleans.
 *
 * Recorded because "the agent did nothing" and "the agent had nothing" are the
 * same observation from outside, and the live run could not distinguish them.
 * Booleans and counts only — never a value.
 */
export const agentProfileContextSchema = z
  .object({
    profileLoaded: z.boolean(),
    hasFirstName: z.boolean(),
    hasLastName: z.boolean(),
    hasEmail: z.boolean(),
    hasPhone: z.boolean(),
    hasAddress: z.boolean(),
    hasCity: z.boolean(),
    hasPostalCode: z.boolean(),
    hasCountry: z.boolean(),
    hasState: z.boolean(),
    workRecordCount: z.number().int().nonnegative().max(50),
    educationRecordCount: z.number().int().nonnegative().max(50),
    resumeAvailable: z.boolean(),
    coverLetterAvailable: z.boolean(),
  })
  .strict();

export type AgentProfileContext = z.infer<typeof agentProfileContextSchema>;

/**
 * The markers a run emits, so a real console tells us what happened.
 *
 * The live failure was diagnosable only by reading source, because the run
 * logged one summary line and nothing about the cycle that produced it. Each of
 * these carries counts and a duration and no values.
 */
export const AGENT_MARKERS = [
  'AGENT_RUN_STARTED',
  'AGENT_OBSERVATION_CREATED',
  'AGENT_DECISION_REQUEST_STARTED',
  'AGENT_DECISION_REQUEST_FINISHED',
  'AGENT_DECISION_REQUEST_FAILED',
  'AGENT_DECISION_PARSED',
  'AGENT_ACTION_SELECTED',
  'AGENT_ACTION_EXECUTION_STARTED',
  'AGENT_ACTION_EXECUTION_FINISHED',
  'AGENT_VERIFICATION_FINISHED',
  'AGENT_READY_EVALUATION',
  'AGENT_RUN_FINISHED',
] as const;

export const agentMarkerSchema = z.enum(AGENT_MARKERS);
export type AgentMarker = z.infer<typeof agentMarkerSchema>;

export const agentMarkerRecordSchema = z
  .object({
    marker: agentMarkerSchema,
    step: z.number().int().nonnegative(),
    fieldCount: z.number().int().nonnegative().default(0),
    actionableFieldCount: z.number().int().nonnegative().default(0),
    knownAnswerFieldCount: z.number().int().nonnegative().default(0),
    askUserFieldCount: z.number().int().nonnegative().default(0),
    decisionType: agentDecisionKindSchema.optional(),
    tool: agentToolSchema.optional(),
    /** Which side chose the action, so a trace says whether the model ran. */
    decisionProvider: z.enum(['deterministic', 'model', 'none']).default('none'),
    durationMs: z.number().nonnegative().max(600_000).default(0),
    errorCode: errorCodeSchema.optional(),
  })
  .strict();

export type AgentMarkerRecord = z.infer<typeof agentMarkerRecordSchema>;

/**
 * One question the applicant has to answer, and whether they have.
 *
 * ## Why questions became objects
 *
 * They were a `string[]` of question text, and "has this been asked" was
 * answered by searching that array. Two things followed. Asking a question put
 * it in the list, and being in the list made readiness stop counting it — so
 * the agent resolved its own questions by asking them, and a run with five
 * outstanding questions reported `askUserRemaining: 0`. And there was nowhere
 * to record an *answer*, because nothing in a list of strings can be answered.
 *
 * So a question carries the identity of the control it is about, survives
 * re-observation through `logicalKey` rather than through a handle, and has an
 * `answeredAt` that only the applicant can set.
 */
export const agentPendingQuestionSchema = z
  .object({
    /** Stable across observations. The handle is not. */
    logicalKey: z.string().max(300),
    /** The employer's own wording for the control. Never an answer. */
    label: z.string().max(200),
    section: z.string().max(120).default(''),
    blockIndex: z.number().int().nonnegative().max(50).optional(),
    /** The question as put to the applicant. */
    question: z.string().max(500),
    /** Why it had to be asked, so the popup can group them sensibly. */
    outcome: agentFieldOutcomeSchema.default('USER_INPUT_REQUIRED'),
    askedAt: z.string().max(40).default(''),
    /**
     * When the applicant answered. Empty means still outstanding.
     *
     * There is deliberately no way for the agent to set this. Asking is not
     * answering, and conflating the two is the whole defect this schema exists
     * to make unrepresentable.
     */
    answeredAt: z.string().max(40).default(''),
    errorCode: errorCodeSchema.optional(),
  })
  .strict();

export type AgentPendingQuestion = z.infer<typeof agentPendingQuestionSchema>;

/**
 * What the run actually accomplished, in the terms the popup speaks.
 *
 * Exists so the applicant is told "6 fields filled, 5 questions need you, 4
 * fields blocked, résumé still to attach" instead of "Application ready for
 * review" over a form with nine blank required boxes.
 */
export const agentRunSummarySchema = z
  .object({
    verifiedFields: z.number().int().nonnegative().default(0),
    pendingUserQuestions: z.number().int().nonnegative().default(0),
    blockedRequiredFields: z.number().int().nonnegative().default(0),
    optionalUnresolvedFields: z.number().int().nonnegative().default(0),
    requiredDocumentsPending: z.number().int().nonnegative().default(0),
    /** Available documents the form does not require. Reported, not blocking. */
    optionalDocumentsPending: z.number().int().nonnegative().default(0),
    /** One sentence for the popup. Counts and employer wording only. */
    headline: z.string().max(300).default(''),
  })
  .strict();

export type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;

/**
 * How a run ended, in priority order.
 *
 * The order matters and is enforced in `agentLoop`: `READY_FOR_REVIEW` is the
 * *lowest-risk* terminal state and the last one considered, not the default a
 * run falls into when the decider stops having ideas. A live run reached it
 * with nine blank required fields and five unanswered questions, because
 * "nothing left I can do" and "nothing left to do" were the same state.
 *
 * `READY_FOR_USER_REVIEW` is the one that separates them: the agent has done
 * everything it safely can, and there is outstanding work that belongs to the
 * applicant. It is a success for the agent and emphatically not a finished
 * application.
 */
export const agentRunStatusSchema = z.enum([
  'RUNNING',
  /** Everything is done. No blanks, no questions, no documents outstanding. */
  'READY_FOR_REVIEW',
  /** The agent finished its part; explicitly surfaced items remain for the user. */
  'READY_FOR_USER_REVIEW',
  /** Questions are outstanding and unanswered. */
  'WAITING_FOR_USER',
  'BLOCKED',
  'CANCELLED',
  'FAILED',
]);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

/**
 * One step, sanitized for export.
 *
 * A trace is a document people paste into bug reports. The question wording is
 * the employer's own text and survives; the *answer* never does. There is no
 * member here able to hold a typed value, a document byte, a password, or a
 * demographic selection.
 */
/**
 * How one dropdown interaction actually went, end to end.
 *
 * Handles, counts and booleans only. `optionIdChosen` is `e12::option::3` — it
 * names *which* choice was taken without recording what the choice said, so a
 * trace can be handed to somebody else while the applicant's state, school and
 * field of study stay out of it.
 */
export const agentDropdownTraceSchema = z
  .object({
    elementId: z.string().max(40),
    controlType: interactionTypeSchema,
    fieldIntent: z.string().max(80).default(''),
    question: z.string().max(300).default(''),
    required: z.boolean().default(false),
    knownAnswerAvailable: z.boolean().default(false),
    /** The state the control displayed, never the value it displayed. */
    currentDisplayState: z.enum(['PLACEHOLDER', 'HAS_SELECTION']).default('PLACEHOLDER'),
    /** What the decider asked for, before the validator had a view. */
    requestedTool: agentToolSchema.optional(),
    toolAllowed: z.boolean().default(true),
    rejectionCode: errorCodeSchema.optional(),
    triggerFound: z.boolean().default(false),
    openAttempted: z.boolean().default(false),
    /** Exact diagnostic name for whether the action requested opening the control. */
    openDropdownRequested: z.boolean().default(false),
    opened: z.boolean().default(false),
    menuFound: z.boolean().default(false),
    optionCount: z.number().int().nonnegative().default(0),
    /** Options the live control exposed, before any decision was made. */
    optionsFoundCount: z.number().int().nonnegative().default(0),
    /** Non-empty option handles generated by the current observation. */
    optionIdsGeneratedCount: z.number().int().nonnegative().default(0),
    /** Whether those current choices were included in the model request. */
    optionsPassedToDecisionProvider: z.boolean().default(false),
    /** Tool produced by the decision layer after the choice response was validated. */
    decisionReturnedTool: agentToolSchema.optional(),
    decisionReturnedOptionIdPresent: z.boolean().default(false),
    optionIdExistsInCurrentOptions: z.boolean().default(false),
    searchable: z.boolean().default(false),
    scrollable: z.boolean().default(false),
    /** The handle of the option taken. Never its text. */
    optionIdChosen: z.string().max(80).optional(),
    optionIdsChosen: z.array(z.string().max(80)).max(100).default([]),
    matchingStrategy: z.enum(['EXACT', 'ALIAS', 'SEMANTIC', 'LLM', 'UNKNOWN']).default('UNKNOWN'),
    llmCalled: z.boolean().default(false),
    semanticMatchType: z
      .enum(['EXACT', 'CASE_INSENSITIVE', 'ABBREVIATION', 'CONTAINS', 'SEMANTIC', 'NONE'])
      .default('NONE'),
    optionClicked: z.boolean().default(false),
    actualOptionNodeFound: z.boolean().default(false),
    clickExecuted: z.boolean().default(false),
    optionClickAttempted: z.boolean().default(false),
    optionClickCompleted: z.boolean().default(false),
    frameworkEventsDispatched: z.boolean().default(false),
    displayedSelectionChanged: z.boolean().default(false),
    /**
     * Whether the form kept the choice, as distinct from displaying it.
     *
     * Recorded beside `displayedSelectionChanged` precisely so the two can
     * disagree in an exported trace. `true, false` is the live failure written
     * down: the control changed what it showed and the form kept nothing.
     */
    selectionCommitted: z.boolean().default(false),
    committedValueDetected: z.boolean().default(false),
    /** A new observation, rather than the executor, reported a committed selection. */
    freshCommittedValueObserved: z.boolean().default(false),
    /** True when the form still shows a validation complaint afterwards. */
    validationErrorPresent: z.boolean().default(false),
    /** The control is required and its validation complaint survived the action. */
    requiredValidationErrorStillPresent: z.boolean().default(false),
    verified: z.boolean().default(false),
    reobservationPerformed: z.boolean().default(false),
    finalStatus: agentVerificationSchema.default('NOT_APPLICABLE'),
  })
  .strict();

export type AgentDropdownTrace = z.infer<typeof agentDropdownTraceSchema>;

/**
 * How one date interaction actually went, end to end.
 *
 * The counterpart of the dropdown trace, and written to the same rule: it says
 * everything about *what happened* and nothing about *what the date was*.
 *
 * `formattedValueShape` is the shape name — `us_full` — and never `07/12/2021`.
 * An employment start date is a fact about somebody's life, and a trace is a
 * document people paste into bug reports; there is no member here that can hold
 * one. What survives is the pair that makes the live failure legible:
 * `profilePrecision: 'month'` beside `requiredFormat: 'us_full'` is a record
 * demanding a day the profile never held, and `validationAfter` recording the
 * employer's own complaint is the difference between a date the form accepted
 * and a date merely sitting in a box.
 */
export const agentDateTraceSchema = z
  .object({
    elementId: z.string().max(40),
    /** The employer's own wording for the control. Never the value. */
    field: z.string().max(200).default(''),
    controlType: interactionTypeSchema,
    /** How precisely the profile knew this date. Never the date. */
    profilePrecision: datePrecisionSchema,
    /** The shape the control asked for, and what said so. */
    requiredFormat: dateShapeSchema.optional(),
    requiredFormatEvidence: z.string().max(40).default(''),
    /** True when the profile held a day, as opposed to one being needed. */
    exactDateAvailable: z.boolean().default(false),
    /** Which approved convention supplied a day, when one did. `none` otherwise. */
    dateConventionUsed: dayConventionSchema.default('ask'),
    requestedTool: agentToolSchema.optional(),
    toolAllowed: z.boolean().default(true),
    rejectionCode: errorCodeSchema.optional(),
    /**
     * The shape that was actually written — the *name* of it.
     *
     * `us_full`, not `07/12/2021`. This is the member somebody reading a trace
     * uses to see that a date went in as `MM/DD/YYYY`, and it is deliberately
     * incapable of telling them which date.
     */
    formattedValueShape: dateShapeSchema.optional(),
    executionResult: z
      .enum(['WRITTEN', 'REFUSED', 'CONTROL_NOT_FOUND', 'NOT_ATTEMPTED'])
      .default('NOT_ATTEMPTED'),
    /** The control's validity before the write, and after it. */
    validationBefore: dateValidationStateSchema.optional(),
    validationAfter: dateValidationStateSchema.optional(),
    verified: z.boolean().default(false),
    finalStatus: agentVerificationSchema.default('NOT_APPLICABLE'),
    errorCode: errorCodeSchema.optional(),
  })
  .strict();

export type AgentDateTrace = z.infer<typeof agentDateTraceSchema>;

/**
 * What a control looked like when it was read back, as a name rather than a
 * value.
 *
 * The whole point of these being names is that a trace can be pasted into a bug
 * report. `HOLDS_EXPECTED` and `REJECTED_BY_FORM` are the two facts somebody
 * debugging a run needs, and neither of them says what the applicant's address
 * or phone number is.
 */
export const observedFieldStateSchema = z.enum([
  'EMPTY',
  'HOLDS_EXPECTED',
  'HOLDS_OTHER',
  'REJECTED_BY_FORM',
  'NOT_FOUND',
  'PLACEHOLDER',
  'COMMITTED',
  'UNKNOWN',
]);

export type ObservedFieldStateName = z.infer<typeof observedFieldStateSchema>;

/**
 * One action, end to end, as its own record.
 *
 * ## Why the aggregate was not enough
 *
 * A live run reported `actions: 6, verified: 0` and there was no way to learn
 * anything more from it. Six actions had run; the values were visibly in the
 * employer's form; and the run counted none of them. Whether that was the
 * execution failing, the re-observation not happening, the control not being
 * found again, or the verifier rejecting a correct value was simply not
 * recorded anywhere — the two numbers were the entire evidence.
 *
 * So every action now says what became of it at each stage. The three fields
 * that carry the diagnosis are `executionSuccess`, `verified`, and the pair of
 * observation ids: an action with `executionSuccess: true`, `verified: false`,
 * two *different* observation ids and `verificationObservedState:
 * HOLDS_EXPECTED` is a verifier bug, and it is that specific combination that
 * this repair was found by.
 *
 * Nothing here holds a value. `verificationExpectedState` is a state name, not
 * the expected string.
 */
export const agentActionTraceSchema = z
  .object({
    step: z.number().int().nonnegative(),
    observationId: z.string().max(60).default(''),
    decisionTool: agentToolSchema,
    toolRequested: agentToolSchema,
    targetControlType: interactionTypeSchema.default('UNKNOWN'),
    controlType: interactionTypeSchema.default('UNKNOWN'),
    /** Final-authority evidence, when the developer-only capture selected this field. */
    controlClassificationTrace: controlClassificationTraceSchema.optional(),
    /** Employer wording only; never the value supplied to the field. */
    fieldLabel: z.string().max(200).default(''),
    /** The canonical question, when the scanner resolved one. Never an answer. */
    targetIntent: z.string().max(80).default(''),
    fieldIntent: z.string().max(80).default(''),
    /** State category only. No displayed or expected value is retained. */
    currentStateCategory: observedFieldStateSchema.default('UNKNOWN'),
    /**
     * The stable identity the verifier correlated on, as a key.
     *
     * Recorded because "the control could not be found again" is otherwise
     * indistinguishable from "the control was found and held the wrong thing",
     * and only the first is a correlation bug.
     */
    logicalKey: z.string().max(300).default(''),
    /** False when the safety layer refused the action before it ran. */
    actionAccepted: z.boolean().default(false),
    toolValidatorResult: z.enum(['ALLOWED', 'REJECTED', 'REPLACED']).default('REJECTED'),
    executionStarted: z.boolean().default(false),
    executionFinished: z.boolean().default(false),
    /**
     * The executor's own report. Deliberately separate from `verified`.
     *
     * A page can accept typing events perfectly and then reset the box; that is
     * `executionSuccess: true, verified: false`, and it is a correct outcome
     * rather than a contradiction.
     */
    executionSuccess: z.boolean().default(false),
    toolExecuted: z.boolean().default(false),
    executionResult: z.enum(['SUCCEEDED', 'FAILED', 'NOT_EXECUTED']).default('NOT_EXECUTED'),
    domChanged: z.boolean().default(false),
    /** The observation the decision was made from, and the one it was checked against. */
    observationBefore: z.string().max(60).default(''),
    observationAfter: z.string().max(60).default(''),
    /** True only when those two are genuinely different readings of the page. */
    freshObservation: z.boolean().default(false),
    /** Which rule decided the verdict, so a wrong verdict names its own rule. */
    verificationStrategy: z
      .enum([
        'TEXT_VALUE',
        'OPTION_COMMITMENT',
        'DATE_VALUE',
        'PAGE_CHANGED',
        'OPTIONS_READ',
        'BLOCK_COUNT',
        'NONE',
      ])
      .default('NONE'),
    verificationExpectedState: observedFieldStateSchema.default('UNKNOWN'),
    verificationObservedState: observedFieldStateSchema.default('UNKNOWN'),
    verified: z.boolean().default(false),
    verification: agentVerificationSchema.default('NOT_APPLICABLE'),
    verificationResult: agentVerificationSchema.default('NOT_APPLICABLE'),
    errorCode: errorCodeSchema.optional(),
    /** One-based count for this exact existing loop-breaker key. */
    retryCount: z.number().int().positive().max(1000).default(1),
    /** Stable, non-value fingerprint of the existing tool + normalized-label key. */
    retryFingerprint: z.string().max(80).default(''),
    durationMs: z.number().nonnegative().max(600_000).default(0),
  })
  .strict();

export type AgentActionTrace = z.infer<typeof agentActionTraceSchema>;

/**
 * Why the existing repeated-action loop breaker grouped a set of retries.
 *
 * This record deliberately contains only employer field wording, type names,
 * counts, booleans and error codes. Option labels and applicant answers cannot
 * be represented by the schema.
 */
export const agentRepeatedActionFailureDetailSchema = z
  .object({
    event: z.literal('REPEATED_ACTION_FAILURE_DETAIL'),
    logicalField: z.string().max(300).default(''),
    controlType: interactionTypeSchema.default('UNKNOWN'),
    repeatedTool: agentToolSchema,
    retryCount: z.number().int().positive().max(1000),
    firstErrorCode: errorCodeSchema.optional(),
    latestErrorCode: errorCodeSchema.optional(),
    observationChangedBetweenRetries: z.boolean().default(false),
    availableOptionsChangedBetweenRetries: z.boolean().default(false),
    modelReceivedFailureFeedback: z.boolean().default(false),
    equivalentBecause: z.string().max(300),
    retryFingerprint: z.string().max(80),
  })
  .strict();

export type AgentRepeatedActionFailureDetail = z.infer<
  typeof agentRepeatedActionFailureDetailSchema
>;

export const agentStepTraceSchema = z
  .object({
    step: z.number().int().nonnegative(),
    observationId: z.string().max(60),
    /** Counts only: how much the agent was looking at. */
    observedElements: z.number().int().nonnegative(),
    requiredOutstanding: z.number().int().nonnegative(),
    decisionType: agentDecisionKindSchema,
    /** Why the agent chose this, in its own words. Never an answer. */
    reason: z.string().max(300).default(''),
    tool: agentToolSchema.optional(),
    targetKind: observedControlKindSchema.optional(),
    /** The question as the employer worded it. Never what was written into it. */
    targetLabel: z.string().max(200).default(''),
    targetSection: z.string().max(120).default(''),
    /**
     * Which repeated block the target sat in, when the section has more than one.
     *
     * Part of the control's identity rather than decoration: a page with three
     * Work Experience blocks has three controls labelled "End Date", and a run
     * that recorded only the label could neither tell them apart in a trace nor
     * remember which of them it had already asked about.
     */
    targetBlockIndex: z.number().int().nonnegative().max(50).optional(),
    executed: z.boolean().default(false),
    /** That a value was written — never which value. */
    wroteValue: z.boolean().default(false),
    optionsSeen: z.number().int().nonnegative().default(0),
    pageChanged: z.boolean().default(false),
    verification: agentVerificationSchema.default('NOT_APPLICABLE'),
    errorCode: errorCodeSchema.optional(),
    durationMs: z.number().nonnegative().max(600_000).default(0),
    /** Which side chose this action. 'none' for a terminal decision. */
    decisionProvider: z.enum(['deterministic', 'model', 'none']).default('none'),
    /** True only when the invoked model request carried previousFailure. */
    modelReceivedFailureFeedback: z.boolean().optional(),
    /** The nine-condition verdict for the observation this step ended on. */
    readyEvaluation: agentReadyEvaluationSchema.optional(),
    /** Present on every step whose target was a list control. */
    dropdown: agentDropdownTraceSchema.optional(),
    /** Present on every step whose target was a date control. */
    date: agentDateTraceSchema.optional(),
    /**
     * Present on every step that proposed a tool call, refused ones included.
     *
     * The record that makes a run diagnosable one action at a time rather than
     * as two aggregate counters.
     */
    action: agentActionTraceSchema.optional(),
  })
  .strict();

export type AgentStepTrace = z.infer<typeof agentStepTraceSchema>;

export const agentRunTraceSchema = z
  .object({
    runId: idSchema,
    buildId: z.string().max(120),
    origin: z.string().max(300).default(''),
    startedAt: z.string().max(40),
    completedAt: z.string().max(40).default(''),
    status: agentRunStatusSchema,
    observationCount: z.number().int().nonnegative(),
    actionCount: z.number().int().nonnegative(),
    verifiedCount: z.number().int().nonnegative(),
    questionsAsked: z.number().int().nonnegative(),
    /**
     * How many times the agent pressed something that would submit.
     *
     * Must be zero. Recorded rather than asserted in a comment, so a finished
     * run states it about itself and a test can read it.
     */
    submitActionCount: z.number().int().nonnegative().default(0),
    /** Which decider produced the decisions, so a trace is interpretable. */
    decider: z.enum(['deterministic', 'model']).default('deterministic'),
    /** True when a decision provider was actually invoked at least once. */
    decisionProviderCalled: z.boolean().default(false),
    /** What the profile could offer. Booleans and counts, never values. */
    profileContext: agentProfileContextSchema.optional(),
    /** Counted from the first observation, so a no-op run says why. */
    actionableFieldsInitial: z.number().int().nonnegative().default(0),
    knownAnswerFieldsInitial: z.number().int().nonnegative().default(0),
    askUserFieldsInitial: z.number().int().nonnegative().default(0),
    observedFieldsInitial: z.number().int().nonnegative().default(0),
    /** The readiness verdict the run finished on. */
    finalReadyEvaluation: agentReadyEvaluationSchema.optional(),
    /** Every marker the run emitted, in order. */
    markers: z.array(agentMarkerRecordSchema).max(1200).default([]),
    /**
     * Why the run stopped, when it stopped badly.
     *
     * Never absent on a FAILED or BLOCKED run: the failure this whole repair
     * exists for was one that reported success, so a run that did not finish
     * has to say so in a field a test can read.
     */
    failureCode: errorCodeSchema.optional(),
    /**
     * Why the run ended where it did, on *every* non-finished ending.
     *
     * Distinct from `failureCode`, which is for a run that went wrong. A run
     * that stops because five questions need the applicant has not gone wrong —
     * it has finished its part — and saying so with a code rather than leaving
     * the status to speak for itself is what stops "READY_FOR_REVIEW" from
     * meaning two incompatible things.
     */
    statusReason: errorCodeSchema.optional(),
    /** What was accomplished and what remains, for the popup. */
    summary: agentRunSummarySchema.optional(),
    /** Every question put to the applicant, with whether they have answered. */
    pendingQuestions: z.array(agentPendingQuestionSchema).max(60).default([]),
    steps: z.array(agentStepTraceSchema).max(400).default([]),
    /** Populated only when AGENT_REPEATED_ACTION_FAILURE is the run failure. */
    repeatedActionFailureDetails: z
      .array(agentRepeatedActionFailureDetailSchema)
      .max(100)
      .default([]),
    /** Questions still waiting on the applicant, as the employer worded them. */
    openQuestions: z.array(z.string().max(300)).max(60).default([]),
    totalDurationMs: z.number().nonnegative().max(3_600_000).default(0),
  })
  .strict();

export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;

/** What the popup shows while the agent works. One line per finished thing. */
export const agentProgressSchema = z
  .object({
    runId: idSchema,
    status: agentRunStatusSchema,
    step: z.number().int().nonnegative(),
    /** "Working on State/Province" — the employer's wording, never an answer. */
    activity: z.string().max(200).default(''),
    completed: z.array(z.string().max(200)).max(200).default([]),
    /** Questions the agent has stopped to ask. */
    questions: z.array(z.string().max(300)).max(60).default([]),
    blocked: z.array(z.string().max(300)).max(60).default([]),
    /**
     * The questions as objects, so the popup can render a queue rather than a
     * list of sentences — and can tell an answered one from an outstanding one.
     */
    pendingQuestions: z.array(agentPendingQuestionSchema).max(60).default([]),
    /** What the run has accomplished so far. */
    summary: agentRunSummarySchema.optional(),
  })
  .strict();

export type AgentProgress = z.infer<typeof agentProgressSchema>;

/** The ceiling on one run. Generous, and finite. */
export const AGENT_ACTION_BUDGET = 150;

/** How many times one tool may fail on one element before strategy changes. */
export const AGENT_MAX_REPEATED_FAILURES = 3;
