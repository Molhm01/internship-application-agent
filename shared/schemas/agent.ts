import { z } from 'zod';
import { idSchema } from './common.js';
import { errorCodeSchema } from './error.js';

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
    label: z.string().max(300),
    disabled: z.boolean().default(false),
    selected: z.boolean().default(false),
  })
  .strict();

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
    /** Which repeated block this belongs to, when the section has more than one. */
    blockIndex: z.number().int().nonnegative().max(50).optional(),
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
  'clear',
  'focus',
  'open_dropdown',
  'get_options',
  'select_option',
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
  'clear',
  'select_option',
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
    /** True when the page changed in a way the tool was waiting for. */
    pageChanged: z.boolean().default(false),
    reason: z.string().max(600).default(''),
    errorCode: errorCodeSchema.optional(),
    durationMs: z.number().nonnegative().max(600_000).default(0),
  })
  .strict();

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;

export const agentVerificationSchema = z.enum(['VERIFIED', 'NOT_VERIFIED', 'NOT_APPLICABLE']);

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
export const agentReadyEvaluationSchema = z
  .object({
    unresolvedRequired: z.number().int().nonnegative(),
    /** Fields with a saved answer that has not been applied. Blocks readiness. */
    knownActionableRemaining: z.number().int().nonnegative(),
    /** Required questions not yet put to the applicant. Blocks readiness. */
    askUserRemaining: z.number().int().nonnegative(),
    documentsPending: z.boolean().default(false),
    finalSubmitReached: z.boolean().default(false),
    /** Fields the agent tried and could not settle. The applicant finishes these. */
    blockedRemaining: z.number().int().nonnegative().default(0),
    ready: z.boolean(),
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

export const agentRunStatusSchema = z.enum([
  'RUNNING',
  'READY_FOR_REVIEW',
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
    /** The nine-condition verdict for the observation this step ended on. */
    readyEvaluation: agentReadyEvaluationSchema.optional(),
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
    steps: z.array(agentStepTraceSchema).max(400).default([]),
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
  })
  .strict();

export type AgentProgress = z.infer<typeof agentProgressSchema>;

/** The ceiling on one run. Generous, and finite. */
export const AGENT_ACTION_BUDGET = 150;

/** How many times one tool may fail on one element before strategy changes. */
export const AGENT_MAX_REPEATED_FAILURES = 3;
