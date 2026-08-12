import {
  AGENT_ACTION_BUDGET,
  DATE_INTERACTION_TYPES,
  agentDateTraceSchema,
  agentDropdownTraceSchema,
  normalizeStoredDate,
  type AgentDateTrace,
  type DayConvention,
  agentActionTraceSchema,
  agentMarkerRecordSchema,
  agentRunSummarySchema,
  agentRunTraceSchema,
  type AgentRunSummary,
  agentStepTraceSchema,
  describeFieldState,
  displaysSelection,
  findLogicalField,
  logicalFieldKey,
  OPTION_INTERACTION_TYPES,
  type AgentActionTrace,
  type ObservedFieldStateName,
  type AgentDecision,
  type AgentDropdownTrace,
  type AgentTool,
  type ErrorCode,
  type AgentMarker,
  type AgentMarkerRecord,
  type AgentProgress,
  type AgentReadyEvaluation,
  type AgentRunStatus,
  type AgentRunTrace,
  type AgentToolCall,
  type AgentVerification,
  type ObservedElement,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { decideDeterministically, type DecisionInput } from './agentDecision.js';
import { evaluateReady, isActionable, isLive, needsUser, describeNotReady } from './agentReady.js';
import { checkDecision } from './agentSafety.js';
import { AgentHistory } from './agentHistory.js';

/**
 * Observe → decide → act → observe → verify → repeat.
 *
 * This is the whole architecture, and it is deliberately small. Everything that
 * used to be clever — the plan, the reconciliation, the per-engine passes over
 * the whole page — is gone, and what replaces it is a loop that never believes
 * anything about the page for longer than one action.
 *
 * ## Why the re-observation is not optional
 *
 * The old system's failures were all one failure wearing different clothes: it
 * acted on a belief formed before the page had reached the state the action
 * assumed. State was matched against a list that did not exist yet. A second
 * Work Experience block was filled before Add had created it. A dropdown's
 * options were decided at scan time and gone by execution time.
 *
 * Here, the only input to a decision is an observation taken *after* the
 * previous action finished. A dependency therefore needs no graph: Country is
 * answered, the page rebuilds State, the next observation shows State enabled
 * with options, and State becomes the next decision because that is what the
 * page now offers. Nothing had to know in advance that Country governs State.
 *
 * ## What stops it running forever
 *
 * Three things, and they are independent. The action budget bounds the run. The
 * history refuses a tool that has failed on the same control three times, which
 * is what breaks the "open the same broken dropdown forever" cycle that an
 * unchanged page would otherwise produce. And a decision that changes nothing
 * twice running ends the loop, because a page that does not respond is finished
 * as far as this agent is concerned.
 */

export interface AgentLoopHost {
  /** Looks at the page and returns the current observation. */
  observe(): Promise<PageObservation>;
  /** Runs exactly one tool call against the page. */
  execute(call: AgentToolCall): Promise<ToolExecutionResult>;
  /** Chooses one action. Deterministic policy unless a model is configured. */
  decide?(input: DecisionInput): Promise<AgentDecision>;
  /** Values the extension trusts for this observation, by element handle. */
  trustedValues(observation: PageObservation): Promise<ReadonlyMap<string, string>>;
  /**
   * What the applicant approved doing when a form demands a day their record
   * does not hold.
   *
   * Optional, and absent means `ask` — the value that stops and asks rather
   * than the one that writes the first of the month. A host that has not been
   * updated to supply this cannot accidentally opt its user into a convention
   * they never chose.
   */
  dayConvention?(): DayConvention;
  /** Called after each step so the popup can show what is happening. */
  onProgress?(progress: AgentProgress): void;
  /** True when a document is available and still unattached. Blocks readiness. */
  documentsPending?(): boolean;
  /**
   * How many *required* documents are available and not yet attached.
   *
   * Separate from `documentsPending` because requiredness decides whether it
   * blocks. A live run reported `resumeVerified: false` beside
   * `documentsPending: false`, and the reason was that the old check demanded
   * the upload control carry `required` — so an optional control with a
   * tailored résumé waiting for it counted as nothing at all. Optional
   * documents are now reported through `optionalDocumentsPending` instead of
   * being silently dropped.
   */
  requiredDocumentsPending?(): number;
  /** Available documents the form does not require. Reported, never blocking. */
  optionalDocumentsPending?(): number;
  /** True when the user has asked the run to stop. */
  isCancelled?(): boolean;
  now?(): string;
  buildId?: string;
  runId: string;
  /** What the profile could offer. Booleans and counts, for the trace. */
  profileContext?: AgentRunTrace['profileContext'];
}

/**
 * Did the action do what it claimed?
 *
 * Read from the observation taken *after* the action, never from the tool's own
 * report. A tool returning without throwing is not evidence a field was filled —
 * that mistake is the reason this project exists in its current form — so the
 * verifier compares the control's state now against what the action intended.
 */
/** Whether this control answers from a list, and so earns a dropdown trace. */
function isListControl(element: ObservedElement): boolean {
  return (OPTION_INTERACTION_TYPES as readonly string[]).includes(element.interactionType);
}

/**
 * How one dropdown interaction went, for the exported trace.
 *
 * Built only for steps whose target answers from a list, and built out of what
 * was actually observed rather than what was intended: `menuFound` is the
 * observer having read options, `displayedSelectionChanged` is the control
 * showing something different afterwards. Handles, counts and booleans only —
 * an exported trace names *which* option was taken and never what it said.
 */
function dropdownTraceFor(input: {
  before: ObservedElement;
  after?: PageObservation;
  call?: AgentToolCall;
  execution?: ToolExecutionResult;
  verification?: AgentVerification;
  requestedTool?: AgentTool;
  toolAllowed?: boolean;
  rejectionCode?: ErrorCode;
}): AgentDropdownTrace {
  const { before, after, call, execution } = input;
  const now = after?.elements.find(
    (element) =>
      element.label === before.label &&
      element.section === before.section &&
      element.blockIndex === before.blockIndex,
  );
  const optionCount = Math.max(
    before.options.length,
    execution?.optionsSeen ?? 0,
    execution?.options.length ?? 0,
  );
  const chosen = call?.optionId;
  return agentDropdownTraceSchema.parse({
    elementId: before.elementId,
    controlType: before.interactionType,
    currentDisplayState: before.currentValue.trim().length > 0 ? 'HAS_SELECTION' : 'PLACEHOLDER',
    ...(input.requestedTool ? { requestedTool: input.requestedTool } : {}),
    toolAllowed: input.toolAllowed ?? true,
    ...(input.rejectionCode ? { rejectionCode: input.rejectionCode } : {}),
    // The tool resolved something to press, which is the only sense in which a
    // trigger is "found" from out here.
    triggerFound: execution?.executed ?? false,
    opened: (execution?.optionsSeen ?? 0) > 0 || (execution?.options.length ?? 0) > 0,
    menuFound: optionCount > 0,
    optionCount,
    searchable: before.searchable,
    // More rows than a menu shows at once is the only scrollability this layer
    // can honestly assert without measuring the page.
    scrollable: optionCount > 10,
    ...(chosen ? { optionIdChosen: chosen } : {}),
    semanticMatchType: matchTypeOf(before, chosen),
    optionClicked: call?.tool === 'select_option' && (execution?.executed ?? false),
    frameworkEventsDispatched: execution?.executed ?? false,
    displayedSelectionChanged: now !== undefined && now.currentValue !== before.currentValue,
    // The pair that makes the live failure legible in an exported trace. A
    // control that changed what it shows and committed nothing writes
    // `displayedSelectionChanged: true, selectionCommitted: false`, which is
    // the whole defect in two booleans.
    selectionCommitted: now?.selectionCommitted ?? false,
    validationErrorPresent: (now?.validationError ?? '').trim().length > 0,
    verified: input.verification === 'VERIFIED',
    finalStatus: input.verification ?? 'NOT_APPLICABLE',
  });
}

/** Whether this control is one `set_date` writes to, and so earns a date trace. */
function isDateControl(element: ObservedElement): boolean {
  return (DATE_INTERACTION_TYPES as readonly string[]).includes(element.interactionType);
}

/**
 * How one date interaction went, for the exported trace.
 *
 * Written to exactly the rule the dropdown trace is written to: everything
 * about what happened, nothing about what the date was. `profilePrecision` is
 * `month`; `requiredFormat` is `us_full`; `formattedValueShape` is `us_full`.
 * Somebody reading this can see that a record holding a month and a year met a
 * control demanding a day, and they cannot see whose employment it was or when
 * it started.
 *
 * The pair that makes the live failure legible here is `validationBefore` and
 * `validationAfter`. A box that was clean before and complains after is a value
 * this run got refused; a box that complained both times was already broken and
 * is not this action's doing, and telling those apart from the "after" reading
 * alone is impossible.
 */
function dateTraceFor(input: {
  before: ObservedElement;
  after?: PageObservation;
  call?: AgentToolCall;
  execution?: ToolExecutionResult;
  verification?: AgentVerification;
  requestedTool?: AgentTool;
  toolAllowed?: boolean;
  rejectionCode?: ErrorCode;
  dayConvention?: DayConvention;
}): AgentDateTrace {
  const { before, call, execution } = input;
  const saved = normalizeStoredDate(before.proposedValue);
  const proposed = call?.normalizedDate;
  const executed = execution?.executed ?? false;
  return agentDateTraceSchema.parse({
    elementId: before.elementId,
    // The employer's own wording for the question, exactly as the dropdown
    // trace keeps it. It is their text, not the applicant's.
    field: before.label.slice(0, 200),
    controlType: before.interactionType,
    profilePrecision: saved.precision,
    ...(before.dateRequirement ? { requiredFormat: before.dateRequirement.shape } : {}),
    requiredFormatEvidence: before.dateRequirement?.evidence ?? '',
    exactDateAvailable: saved.precision === 'day',
    // Says which convention supplied a day, and `ask` when none did — so a
    // trace states, per field, whether a day was taken from the record or from
    // a preference the applicant set.
    dateConventionUsed: proposed?.dayFromConvention ?? input.dayConvention ?? 'ask',
    ...(input.requestedTool ? { requestedTool: input.requestedTool } : {}),
    toolAllowed: input.toolAllowed ?? true,
    ...(input.rejectionCode ? { rejectionCode: input.rejectionCode } : {}),
    ...(execution?.dateShapeWritten ? { formattedValueShape: execution.dateShapeWritten } : {}),
    executionResult:
      execution === undefined
        ? 'NOT_ATTEMPTED'
        : execution.errorCode === 'DATE_CONTROL_NOT_FOUND' ||
            execution.errorCode === 'CONTROL_NOT_FOUND'
          ? 'CONTROL_NOT_FOUND'
          : executed
            ? 'WRITTEN'
            : 'REFUSED',
    ...(execution?.dateValidationBefore
      ? { validationBefore: execution.dateValidationBefore }
      : {}),
    ...(execution?.dateValidationAfter ? { validationAfter: execution.dateValidationAfter } : {}),
    verified: input.verification === 'VERIFIED',
    finalStatus: input.verification ?? 'NOT_APPLICABLE',
    ...(execution?.errorCode ? { errorCode: execution.errorCode } : {}),
  });
}

/** How the chosen option's text relates to the saved answer. Never the text. */
function matchTypeOf(element: ObservedElement, optionId: string | undefined): string {
  const wanted = (element.proposedValue ?? '').trim();
  const option = element.options.find((candidate) => candidate.optionId === optionId);
  if (!option || !wanted) return 'NONE';
  if (option.label === wanted) return 'EXACT';
  if (option.label.toLowerCase() === wanted.toLowerCase()) return 'CASE_INSENSITIVE';
  const reduce = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const a = reduce(option.label);
  const b = reduce(wanted);
  if (a.includes(b) || b.includes(a)) return 'CONTAINS';
  // Matched by the alias tables rather than by its text, which is what makes
  // "NJ" an acceptable rendering of "New Jersey".
  return option.label.length <= 4 ? 'ABBREVIATION' : 'SEMANTIC';
}
/**
 * One action's whole life, for the exported trace.
 *
 * Built for *every* proposed action, refused ones included, because a refusal
 * is a thing that happened to a control and the previous trace recorded it
 * nowhere a reader would look.
 *
 * The three fields that make a run diagnosable are `executionSuccess`,
 * `verified` and the two observation ids. `executionSuccess: true` with
 * `verified: false` over two *different* observations and
 * `verificationObservedState: HOLDS_EXPECTED` is a verifier bug — which is
 * exactly the combination the live "six actions, zero verified" run would have
 * shown, and could not, because none of those five facts were recorded.
 *
 * Nothing here holds a value: `targetIntent` is the canonical question, and the
 * two states are names.
 */
function actionTraceFor(input: {
  step: number;
  call: AgentToolCall;
  target: ObservedElement | undefined;
  execution?: ToolExecutionResult;
  outcome?: VerificationVerdict;
  observationBefore: string;
  observationAfter: string;
  accepted: boolean;
  rejectionCode?: ErrorCode;
}): AgentActionTrace {
  const { call, target, execution, outcome } = input;
  const errorCode = input.rejectionCode ?? outcome?.errorCode ?? execution?.errorCode;
  return agentActionTraceSchema.parse({
    step: input.step,
    decisionTool: call.tool,
    targetControlType: target?.interactionType ?? 'UNKNOWN',
    targetIntent: (target?.intent ?? '').slice(0, 80),
    logicalKey: target ? logicalFieldKey(target).slice(0, 300) : '',
    actionAccepted: input.accepted,
    executionStarted: input.accepted,
    executionFinished: input.accepted && execution !== undefined,
    // The executor's own report, kept strictly separate from the verdict. A
    // page can accept every typing event and then reset the box.
    executionSuccess: execution?.executed ?? false,
    domChanged: execution?.pageChanged ?? false,
    observationBefore: input.observationBefore.slice(0, 60),
    observationAfter: input.observationAfter.slice(0, 60),
    // Two different ids means the loop genuinely looked again. Recorded rather
    // than assumed, because a verifier checking against a stale observation and
    // one checking against a fresh one are indistinguishable without it.
    freshObservation:
      input.observationAfter.length > 0 && input.observationAfter !== input.observationBefore,
    verificationStrategy: outcome?.strategy ?? 'NONE',
    verificationExpectedState: outcome?.expected ?? ('UNKNOWN' satisfies ObservedFieldStateName),
    verificationObservedState: outcome?.observed ?? ('UNKNOWN' satisfies ObservedFieldStateName),
    verified: outcome?.verification === 'VERIFIED',
    verification: outcome?.verification ?? 'NOT_APPLICABLE',
    ...(errorCode ? { errorCode } : {}),
    durationMs: execution?.durationMs ?? 0,
  });
}

/**
 * The verdict on one action, with the reasoning that produced it.
 *
 * A verdict rather than a bare enum, because the enum alone is what made the
 * live failure undiagnosable: six actions came back `VERIFICATION_FAILED` and
 * there was no record of *which* of the four possible reasons had fired. The
 * strategy, the two states and the code are the diagnosis, and they cost
 * nothing to carry.
 */
interface VerificationVerdict {
  verification: AgentVerification;
  strategy: AgentActionTrace['verificationStrategy'];
  expected: ObservedFieldStateName;
  observed: ObservedFieldStateName;
  /** Set only when the verdict is a failure. Never left to the caller to guess. */
  errorCode?: ErrorCode;
}

function verdict(
  verification: AgentVerification,
  strategy: AgentActionTrace['verificationStrategy'],
  expected: ObservedFieldStateName,
  observed: ObservedFieldStateName,
  errorCode?: ErrorCode,
): VerificationVerdict {
  return { verification, strategy, expected, observed, ...(errorCode ? { errorCode } : {}) };
}

/**
 * Did the action do what it claimed?
 *
 * ## The failure this was rewritten for
 *
 * A live Lincoln Electric run reported `actions: 6, verified: 0` while the
 * employer's form visibly held the values that had been written. Reproduced
 * against a fixture, three separate rules in the previous version of this
 * function each rejected a *correct* write:
 *
 *  1. **A static "required" hint counted as a rejection.** The observer read
 *     `aria-describedby` as an error source, so a required field pointing at a
 *     permanent "This field is required" marker reported `validationError` for
 *     ever, and the first line of the text check failed it. Fixed in the
 *     observer; the rule here is unchanged and now fires only on real evidence.
 *  2. **A reformatted value counted as a different value.** `+1 201 555 0134`
 *     stored as `(201) 555-0134` failed a containment test over the country
 *     code. Now `holdsWrittenValue`, which understands that for a value that is
 *     essentially digits, the digits are the value.
 *  3. **The control could not always be found again.** Correlation was exact
 *     equality of label, section and block index, so a re-render that changed a
 *     required marker or moved a control lost it entirely. Now
 *     `findLogicalField`, which correlates on canonical intent first.
 *
 * ## What has not changed
 *
 * The page after the action is still the only admissible evidence, and the
 * executor's own report is still not evidence. `executionSuccess` and
 * `verified` remain separate answers to separate questions: a form can accept
 * every typing event and then reset the box, and that is a failure however
 * cleanly the events were dispatched.
 */
function verify(
  call: AgentToolCall,
  before: ObservedElement | undefined,
  after: PageObservation,
  execution: ToolExecutionResult,
): VerificationVerdict {
  if (!execution.executed) {
    return verdict(
      'NOT_VERIFIED',
      'NONE',
      'UNKNOWN',
      'UNKNOWN',
      execution.errorCode ?? 'ACTION_EXECUTION_FAILED',
    );
  }
  switch (call.tool) {
    // ---- A date is verified against the employer, not against the box. -----
    //
    // A control displaying `07/12/2021` beside a form still showing "Invalid
    // date." has not been answered. So three things are asked, weakest last:
    // does the form still complain, does the control hold anything at all, and
    // only then does what it holds match what was written.
    case 'set_date': {
      if (!before)
        return verdict('NOT_VERIFIED', 'DATE_VALUE', 'UNKNOWN', 'UNKNOWN', 'STALE_ELEMENT');
      const now = findLogicalField(after.elements, before);
      if (!now) {
        return verdict(
          'NOT_VERIFIED',
          'DATE_VALUE',
          'HOLDS_EXPECTED',
          'NOT_FOUND',
          'STALE_ELEMENT',
        );
      }
      const written = execution.observedValue.trim();
      if (now.validationError.trim().length > 0) {
        return verdict(
          'VERIFICATION_FAILED',
          'DATE_VALUE',
          'HOLDS_EXPECTED',
          'REJECTED_BY_FORM',
          'DATE_VALIDATION_FAILED',
        );
      }
      if (execution.errorCode !== undefined) {
        return verdict(
          'VERIFICATION_FAILED',
          'DATE_VALUE',
          'HOLDS_EXPECTED',
          'HOLDS_OTHER',
          execution.errorCode,
        );
      }
      if (written.length === 0) {
        return verdict(
          'VERIFICATION_FAILED',
          'DATE_VALUE',
          'HOLDS_EXPECTED',
          'EMPTY',
          'DATE_EXECUTION_FAILED',
        );
      }
      return now.currentValue.trim() === written
        ? verdict('VERIFIED', 'DATE_VALUE', 'HOLDS_EXPECTED', 'HOLDS_EXPECTED')
        : verdict(
            'VERIFICATION_FAILED',
            'DATE_VALUE',
            'HOLDS_EXPECTED',
            now.currentValue.trim().length === 0 ? 'EMPTY' : 'HOLDS_OTHER',
            'DATE_VALIDATION_FAILED',
          );
    }
    case 'type':
    case 'select_option': {
      const listStrategy = call.tool === 'select_option' ? 'OPTION_COMMITMENT' : 'TEXT_VALUE';
      if (!before) {
        return verdict('NOT_VERIFIED', listStrategy, 'UNKNOWN', 'UNKNOWN', 'STALE_ELEMENT');
      }
      // ---- Found again by *logical* identity, not by handle equality. ------
      //
      // The handles were reminted by the observation this is checking against,
      // so the control just written to necessarily has a new one. Correlation
      // is on canonical intent within the same frame, section and repeated
      // block — which is what survives a re-render that rewords the label, and
      // what keeps block 2's "Company Name" from being confirmed against
      // block 1's.
      const now = findLogicalField(after.elements, before);
      if (!now) {
        return verdict(
          'NOT_VERIFIED',
          listStrategy,
          'HOLDS_EXPECTED',
          'NOT_FOUND',
          'STALE_ELEMENT',
        );
      }
      const wanted = call.value ?? '';
      if (!wanted.trim()) return verdict('NOT_APPLICABLE', 'NONE', 'UNKNOWN', 'UNKNOWN');

      // ---- A list control is verified against the form, not the label. -----
      //
      //  1. Does the form still say the question is unanswered? That outranks
      //     everything: Education Type displayed "BS" while the page went on
      //     showing "Education Type is required", and the page was right.
      //  2. Did the widget keep a value behind the text? A trigger whose label
      //     changed over an empty backing store has been *typed into*, not
      //     chosen from.
      //  3. Only then, does the displayed text correspond to the choice?
      //
      // That last comparison is `displaysSelection` rather than `includes`:
      // substring containment once approved "No Selection" as an answer of
      // "No", a placeholder verifying as a real choice.
      if (isListControl(now)) {
        if (now.validationError.trim().length > 0) {
          return verdict(
            'VERIFICATION_FAILED',
            'OPTION_COMMITMENT',
            'COMMITTED',
            'REJECTED_BY_FORM',
            'OPTION_SELECTION_NOT_COMMITTED',
          );
        }
        if (!now.selectionCommitted) {
          return verdict(
            'VERIFICATION_FAILED',
            'OPTION_COMMITMENT',
            'COMMITTED',
            'PLACEHOLDER',
            'OPTION_SELECTION_NOT_COMMITTED',
          );
        }
        if (now.currentValue.trim().length === 0) {
          return verdict(
            'VERIFICATION_FAILED',
            'OPTION_COMMITMENT',
            'COMMITTED',
            'EMPTY',
            'OPTION_SELECTION_NOT_COMMITTED',
          );
        }
        const aliases = call.optionId
          ? before.options
              .filter((option) => option.optionId === call.optionId)
              .map((option) => option.label)
          : [];
        return displaysSelection(now.currentValue, wanted, { aliases })
          ? verdict('VERIFIED', 'OPTION_COMMITMENT', 'COMMITTED', 'COMMITTED')
          : verdict(
              'VERIFICATION_FAILED',
              'OPTION_COMMITMENT',
              'COMMITTED',
              'HOLDS_OTHER',
              'OPTION_SELECTION_NOT_COMMITTED',
            );
      }

      // ---- A text box holds what was written, or it does not. --------------
      //
      // The form's own complaint still counts against it — a rejected value is
      // not a written one — but that complaint is now read only on real
      // evidence rather than from a static "required" hint, which is what made
      // every filled field on the live run report a failure.
      //
      // And the comparison is `holdsWrittenValue`, which accepts a control that
      // *reformatted* what it kept. A phone box storing `(201) 555-0134` for
      // `+1 201 555 0134` has the applicant's number in it, and reporting that
      // as a failure was the second half of the same bug.
      const observedState = describeFieldState({
        found: true,
        currentValue: now.currentValue,
        expected: wanted,
        validationError: now.validationError,
      });
      if (observedState === 'HOLDS_EXPECTED') {
        return verdict('VERIFIED', 'TEXT_VALUE', 'HOLDS_EXPECTED', 'HOLDS_EXPECTED');
      }
      return verdict(
        'VERIFICATION_FAILED',
        'TEXT_VALUE',
        'HOLDS_EXPECTED',
        observedState,
        observedState === 'REJECTED_BY_FORM'
          ? 'ACTION_VERIFICATION_FAILED'
          : 'TEXT_VALUE_NOT_COMMITTED',
      );
    }
    case 'click_add': {
      // The page grew a block, or it did not. `pageChanged` here is the block
      // count rising, observed by the tool against the section it pressed.
      return execution.pageChanged
        ? verdict('VERIFIED', 'BLOCK_COUNT', 'COMMITTED', 'COMMITTED')
        : verdict('NOT_VERIFIED', 'BLOCK_COUNT', 'COMMITTED', 'UNKNOWN', 'ACTION_NO_DOM_CHANGE');
    }
    case 'open_dropdown':
    case 'get_options': {
      // Reading a list is a real step forward even though it writes nothing:
      // the next decision cannot choose an option until this has happened.
      return execution.options.length > 0
        ? verdict('VERIFIED', 'OPTIONS_READ', 'COMMITTED', 'COMMITTED')
        : verdict(
            'NOT_VERIFIED',
            'OPTIONS_READ',
            'COMMITTED',
            'EMPTY',
            execution.errorCode ?? 'DROPDOWN_OPEN_FAILED',
          );
    }
    case 'click_next': {
      return execution.pageChanged
        ? verdict('VERIFIED', 'PAGE_CHANGED', 'COMMITTED', 'COMMITTED')
        : verdict('NOT_VERIFIED', 'PAGE_CHANGED', 'COMMITTED', 'UNKNOWN', 'ACTION_NO_DOM_CHANGE');
    }
    default:
      return verdict('NOT_APPLICABLE', 'NONE', 'UNKNOWN', 'UNKNOWN');
  }
}

export interface AgentRunOutcome {
  status: AgentRunStatus;
  trace: AgentRunTrace;
}

/**
 * The code for a decision that did not arrive, named by what went wrong.
 *
 * Four codes rather than one, and none of them is "ready": every previous shape
 * of "the agent could not decide" was converted into READY_FOR_REVIEW, which
 * told the applicant their form was complete when nothing had been attempted.
 */
/** How many refused actions a run tolerates before it stops and says why. */
const MAX_REJECTED_ACTIONS = 12;

/**
 * How a run that reached the end of its work should describe itself.
 *
 * ## Why this is a priority ladder and not a boolean
 *
 * A live run reported `READY_FOR_REVIEW` over an application with nine blank
 * required fields and five unanswered questions, because the only two outcomes
 * available were "ready" and "blocked", and the decider running out of safe
 * actions was indistinguishable from the application being finished.
 *
 * So the terminal states are ordered by how much is still owed, and
 * `READY_FOR_REVIEW` is the *last* one considered rather than the default. It
 * is reachable only when the readiness predicate — which now includes
 * `unresolvedRequired === 0` — is satisfied outright.
 *
 * The ordering is by what the applicant has to do first: answer questions,
 * then finish fields the page refused, then attach documents.
 */
function terminalStateFor(readiness: AgentReadyEvaluation): {
  status: AgentRunStatus;
  reason?: ErrorCode;
} {
  if (readiness.ready) return { status: 'READY_FOR_REVIEW' };
  if (readiness.askUserRemaining > 0) {
    return { status: 'WAITING_FOR_USER', reason: 'WAITING_FOR_USER_INPUT' };
  }
  if (readiness.blockedRequiredRemaining > 0) {
    return { status: 'READY_FOR_USER_REVIEW', reason: 'REQUIRED_FIELDS_BLOCKED' };
  }
  if (readiness.requiredDocumentsPending > 0) {
    return { status: 'READY_FOR_USER_REVIEW', reason: 'REQUIRED_DOCUMENT_PENDING' };
  }
  if (readiness.unresolvedRequired > 0) {
    // Required blanks the buckets above did not claim. Reported rather than
    // ignored: this is the exact condition the live run swallowed, and it must
    // reach the applicant even if the classification did not anticipate it.
    return { status: 'READY_FOR_USER_REVIEW', reason: 'PARTIAL_COMPLETION' };
  }
  if (readiness.knownActionableRemaining > 0) {
    return { status: 'READY_FOR_USER_REVIEW', reason: 'PARTIAL_COMPLETION' };
  }
  return { status: 'READY_FOR_USER_REVIEW', reason: 'NO_MORE_SAFE_ACTIONS' };
}

/**
 * What the run accomplished and what it left, in the terms the popup speaks.
 *
 * The headline exists so the applicant reads "Agent completed 6 fields. 5
 * questions need your input. 4 required fields could not be completed."
 * instead of "Application ready for review" over a form with nine blank boxes.
 * Counts and the employer's own wording only — never an answer.
 */
function summaryFor(
  readiness: AgentReadyEvaluation,
  history: AgentHistory,
  optionalDocumentsPending: number,
): AgentRunSummary {
  const pendingUserQuestions = history.unansweredQuestions().length;
  const parts: string[] = [];
  parts.push(`Agent completed ${history.verifiedCount()} field(s).`);
  if (pendingUserQuestions > 0) parts.push(`${pendingUserQuestions} question(s) need your input.`);
  if (readiness.blockedRequiredRemaining > 0) {
    parts.push(`${readiness.blockedRequiredRemaining} required field(s) could not be completed.`);
  }
  if (readiness.requiredDocumentsPending > 0) {
    parts.push(`${readiness.requiredDocumentsPending} required document(s) still need attaching.`);
  }
  if (parts.length === 1 && readiness.ready) parts.push('Nothing else is outstanding.');
  return agentRunSummarySchema.parse({
    verifiedFields: history.verifiedCount(),
    pendingUserQuestions,
    blockedRequiredFields: readiness.blockedRequiredRemaining,
    optionalUnresolvedFields: readiness.optionalRemaining,
    requiredDocumentsPending: readiness.requiredDocumentsPending,
    optionalDocumentsPending,
    headline: parts.join(' ').slice(0, 300),
  });
}

/**
 * Why a run that stopped short stopped, derived from what it actually did.
 *
 * Exists because `status: BLOCKED, failureCode: undefined` is what a live run
 * reported, and it is the least useful thing a run can say about itself. There
 * is always an answer available — the steps are right there — and this picks
 * the most specific one the run's own record supports.
 *
 * Ordered by how much it narrows the search: a control tried repeatedly and
 * refused every time is a page problem with a named control; actions that ran
 * and were not kept is a commitment problem; and only when neither applies is
 * "it stopped getting anywhere" the honest answer.
 */
function blockedReasonFrom(history: AgentHistory): ErrorCode {
  if (history.exhaustedLabels().length > 0) return 'AGENT_REPEATED_ACTION_FAILURE';
  const steps = history.all();
  if (steps.some((entry) => entry.verification === 'VERIFICATION_FAILED')) {
    return 'ACTION_VERIFICATION_FAILED';
  }
  return 'AGENT_NO_PROGRESS';
}

function decisionErrorFor(cause: unknown): AgentRunTrace['steps'][number]['errorCode'] {
  const detail = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (/timeout|timed out|abort/.test(detail)) return 'AGENT_DECISION_TIMEOUT';
  if (/unavailable|econnrefused|fetch failed|not reachable/.test(detail)) {
    return 'AGENT_MODEL_UNAVAILABLE';
  }
  if (/invalid|schema|parse/.test(detail)) return 'AGENT_INVALID_DECISION';
  return 'AGENT_DECISION_FAILED';
}

/**
 * What to do instead, when a decider claims READY over a page with work left.
 *
 * Falls back to the deterministic policy, which chooses from what the page
 * currently offers. If *that* also says READY the loop's counter ends the run
 * honestly rather than letting the two disagree forever.
 */
function fallbackDecision(input: DecisionInput, readiness: AgentReadyEvaluation): AgentDecision {
  const decided = decideDeterministically(input);
  if (decided.kind !== 'READY_FOR_REVIEW') return decided;
  return {
    kind: 'BLOCKED',
    reason: describeNotReady(readiness),
  };
}

/**
 * Runs the agent until the page is ready for the applicant to review it.
 *
 * Always returns a trace, whatever happened. A run that ends in `BLOCKED` with
 * fifty steps recorded is a diagnosis; a run that throws is a mystery, and this
 * project has had enough of those.
 */
export async function runAgentLoop(host: AgentLoopHost): Promise<AgentRunOutcome> {
  const history = new AgentHistory();
  // Read once per run, and defaulting to `ask`. Both the decider and the safety
  // layer receive the same value, so the layer that *checks* a day cannot be
  // working from a different preference than the layer that *chose* it.
  const dayConvention: DayConvention = host.dayConvention?.() ?? 'ask';
  const now: () => string = host.now ? () => host.now!() : () => new Date().toISOString();
  const startedAt = now();
  const startedMs = Date.now();
  const completed: string[] = [];
  let status: AgentRunStatus = 'RUNNING';
  const markers: AgentMarkerRecord[] = [];
  let decisionProviderCalled = false;
  let invalidReadyStates = 0;
  // Refused actions, bounded. A decider that keeps asking for a tool the
  // control does not accept is not making progress, and the run says so
  // rather than spending its budget being corrected.
  let rejectedActions = 0;
  let failure: AgentRunTrace['steps'][number]['errorCode'] | undefined;
  /**
   * Why the run ended where it did, on every ending that is not "finished".
   *
   * Separate from `failure` because they are separate facts: a run that stops
   * with five questions outstanding has *succeeded* at its part, and reporting
   * that as a failure would be as misleading as the READY_FOR_REVIEW it
   * replaces.
   */
  let statusReason: ErrorCode | undefined;
  let lastReadiness: AgentReadyEvaluation | undefined;

  /**
   * One marker, with the counts that make a real console conclusive.
   *
   * Counts only — how many controls were seen, how many the agent could act on,
   * how many needed the applicant. No labels and no values, so this is safe to
   * leave on in production, which is the only way it can help with the next
   * live run.
   */
  const mark = (
    marker: AgentMarker,
    step: number,
    page: PageObservation | null,
    patch: Partial<AgentMarkerRecord> = {},
  ): void => {
    const live = page?.elements.filter(isLive) ?? [];
    markers.push(
      agentMarkerRecordSchema.parse({
        marker,
        step,
        fieldCount: page?.elements.length ?? 0,
        actionableFieldCount: live.filter(isActionable).length,
        knownAnswerFieldCount: live.filter((element) => element.policy === 'KNOWN_FACT').length,
        askUserFieldCount: live.filter(needsUser).length,
        ...patch,
      }),
    );
  };

  mark('AGENT_RUN_STARTED', 0, null);
  let observation = await host.observe();
  let observationCount = 1;
  let unchangedStreak = 0;
  mark('AGENT_OBSERVATION_CREATED', 0, observation);

  // Counted from the *first* observation, so a run that does nothing says
  // whether it had nothing to do or could not see anything to do. That
  // distinction is the entire diagnosis of the live zero-action failure.
  const firstLive = observation.elements.filter(isLive);
  const initial = {
    observedFieldsInitial: observation.elements.length,
    actionableFieldsInitial: firstLive.filter(isActionable).length,
    knownAnswerFieldsInitial: firstLive.filter((element) => element.policy === 'KNOWN_FACT').length,
    askUserFieldsInitial: firstLive.filter(needsUser).length,
  };

  const emit = (activity: string): void => {
    host.onProgress?.({
      runId: host.runId,
      status,
      step: history.all().length,
      activity,
      completed: [...completed],
      questions: [...history.openQuestions()],
      blocked: [],
      // The queue as objects, so the popup can show which questions are still
      // outstanding rather than a list of sentences it cannot tick off.
      pendingQuestions: [...history.unansweredQuestions()],
      ...(lastReadiness
        ? { summary: summaryFor(lastReadiness, history, host.optionalDocumentsPending?.() ?? 0) }
        : {}),
    });
  };

  emit('Observing the page');

  for (let step = 0; status === 'RUNNING'; step += 1) {
    if (host.isCancelled?.()) {
      status = 'CANCELLED';
      break;
    }
    if (history.budgetExhausted()) {
      failure = 'AGENT_ACTION_BUDGET_EXHAUSTED';
      status = 'BLOCKED';
      break;
    }

    const trustedValues = await host.trustedValues(observation);
    const input: DecisionInput = { observation, history, trustedValues, dayConvention };

    // ---- Ask, and record that we asked. ------------------------------------
    //
    // The provider is marked before and after, so a real console says whether
    // a decision was ever requested. The live failure could not be diagnosed
    // because the run logged one summary line and nothing about the cycle that
    // produced it.
    const provider: 'deterministic' | 'model' = host.decide ? 'model' : 'deterministic';
    const decisionStarted = Date.now();
    mark('AGENT_DECISION_REQUEST_STARTED', step, observation, { decisionProvider: provider });
    let decided: AgentDecision;
    try {
      decided = host.decide ? await host.decide(input) : decideDeterministically(input);
      decisionProviderCalled = true;
      mark('AGENT_DECISION_REQUEST_FINISHED', step, observation, {
        decisionProvider: provider,
        decisionType: decided.kind,
        durationMs: Date.now() - decisionStarted,
      });
    } catch (cause) {
      // ---- A failed decision is never a finished application. --------------
      //
      // This is the rule the whole repair rests on. Every previous shape of
      // "the agent could not decide" ended as READY_FOR_REVIEW, which told the
      // applicant their form was complete when nothing had been attempted.
      // The run stops, and it says why.
      mark('AGENT_DECISION_REQUEST_FAILED', step, observation, {
        decisionProvider: provider,
        durationMs: Date.now() - decisionStarted,
        errorCode: decisionErrorFor(cause),
      });
      failure = decisionErrorFor(cause);
      status = 'FAILED';
      break;
    }
    mark('AGENT_DECISION_PARSED', step, observation, {
      decisionProvider: provider,
      decisionType: decided.kind,
    });

    // ---- READY is a predicate, not a claim. --------------------------------
    //
    // A decider that has run out of ideas and a finished application are
    // indistinguishable from inside the decider — and on the live run they were
    // the same thing: one observation, no actions, and an application declared
    // ready with a dozen blank required fields on it. So readiness is evaluated
    // independently, and a decision that disagrees is refused.
    const readiness = evaluateReady({
      observation,
      askedQuestions: history.openQuestions(),
      // Only an *answer* removes a question from the accounting. Passing the
      // asked list here is what made the agent resolve its own questions.
      answeredQuestions: history.answeredKeys(),
      documentsPending: host.documentsPending?.() ?? false,
      requiredDocumentsPending: host.requiredDocumentsPending?.() ?? 0,
      finalSubmitReached: history.submitActionCount() > 0,
      // Controls the run tried and could not settle. They are the applicant's
      // now, not pending work — without this the predicate would deadlock
      // forever on any control the page refuses.
      unresolvedByAgent: history.exhaustedLabels(),
    });
    mark('AGENT_READY_EVALUATION', step, observation, {
      decisionType: decided.kind,
      decisionProvider: provider,
    });
    lastReadiness = readiness;

    if (decided.kind === 'READY_FOR_REVIEW' && !readiness.ready) {
      // Overridden. The run continues rather than stopping, because the whole
      // point is that there is still work the agent can do — and if the decider
      // keeps insisting, the history's own brakes end the run honestly.
      invalidReadyStates += 1;
      mark('AGENT_READY_EVALUATION', step, observation, {
        decisionType: 'BLOCKED',
        decisionProvider: provider,
        errorCode: 'AGENT_DECISION_INVALID_READY_STATE',
      });
      if (invalidReadyStates >= 3) {
        failure = 'AGENT_DECISION_INVALID_READY_STATE';
        status = 'BLOCKED';
        break;
      }
      decided = fallbackDecision(input, readiness);
    }

    // Safety runs against the observation the decision was made from, never a
    // later one. A decision is a claim about a specific page state, and it is
    // checked against that state or refused.
    const verdict = checkDecision(decided, observation, trustedValues, dayConvention);

    // ---- A refused action is a correction, not the end of the run. ----------
    //
    // The case this exists for: the decider asks to type an answer into a
    // dropdown. Ending the run there would leave the rest of the application
    // unfilled over one bad decision, and letting it through would leave the
    // control on its placeholder while the run believed it answered. So the
    // action is rejected, the rejection is recorded against that control, and
    // the loop re-observes and decides again — now knowing this tool does not
    // work here. The history's own ceiling bounds how often that can repeat.
    if (!verdict.allowed && !verdict.replacement && decided.kind === 'ACTION') {
      const refusedTarget = decided.action?.elementId
        ? observation.elements.find((entry) => entry.elementId === decided.action?.elementId)
        : undefined;
      rejectedActions += 1;
      history.record(
        agentStepTraceSchema.parse({
          step,
          observationId: observation.observationId,
          observedElements: observation.elements.length,
          requiredOutstanding: observation.requiredOutstanding,
          decisionType: 'BLOCKED',
          reason: verdict.reason.slice(0, 300),
          tool: decided.action?.tool,
          ...(refusedTarget ? { targetKind: refusedTarget.kind } : {}),
          targetLabel: (refusedTarget?.label ?? '').slice(0, 200),
          targetSection: refusedTarget?.section ?? '',
          ...(refusedTarget?.blockIndex === undefined
            ? {}
            : { targetBlockIndex: refusedTarget.blockIndex }),
          // Never executed, so never counted as a browser action.
          executed: false,
          verification: 'NOT_VERIFIED',
          ...(verdict.code ? { errorCode: verdict.code } : {}),
          decisionProvider: provider,
          readyEvaluation: readiness,
          // The refusal itself, on the record. A reader of the trace can see
          // that a decider asked to type into a list control and was stopped —
          // which is the evidence that the contract is doing anything at all.
          ...(refusedTarget && isListControl(refusedTarget)
            ? {
                dropdown: dropdownTraceFor({
                  before: refusedTarget,
                  ...(decided.action?.tool ? { requestedTool: decided.action.tool } : {}),
                  toolAllowed: false,
                  ...(verdict.code ? { rejectionCode: verdict.code } : {}),
                }),
              }
            : {}),
          // The date refusal, on the record — and this is the step the whole
          // repair is measured by. A trace showing `requestedTool: 'type'`,
          // `toolAllowed: false`, `rejectionCode: 'WRONG_TOOL_FOR_CONTROL_TYPE'`
          // against a DATE_INPUT is the live Lincoln failure being stopped,
          // written down in a form a test can read.
          ...(refusedTarget && isDateControl(refusedTarget)
            ? {
                date: dateTraceFor({
                  before: refusedTarget,
                  ...(decided.action?.tool ? { requestedTool: decided.action.tool } : {}),
                  toolAllowed: false,
                  ...(verdict.code ? { rejectionCode: verdict.code } : {}),
                  dayConvention,
                }),
              }
            : {}),
          // A refused action is still an action that was proposed, and it gets
          // the same record as one that ran. `actionAccepted: false` beside
          // `verified: false` is the honest reading: nothing reached the page,
          // so nothing could be verified — as distinct from an action that ran
          // and was not kept, which looks completely different here.
          ...(decided.action
            ? {
                action: actionTraceFor({
                  step,
                  call: decided.action,
                  target: refusedTarget,
                  observationBefore: observation.observationId,
                  observationAfter: '',
                  accepted: false,
                  ...(verdict.code ? { rejectionCode: verdict.code } : {}),
                }),
              }
            : {}),
        }),
        // Recorded as an *action* decision so the history counts the failure
        // against this tool and this control, which is what makes the next
        // cycle choose differently rather than repeating itself.
        decided,
      );
      mark('AGENT_ACTION_SELECTED', step, observation, {
        decisionType: 'BLOCKED',
        ...(decided.action?.tool ? { tool: decided.action.tool } : {}),
        decisionProvider: provider,
        ...(verdict.code ? { errorCode: verdict.code } : {}),
      });
      if (rejectedActions >= MAX_REJECTED_ACTIONS) {
        failure = verdict.code ?? 'AGENT_DECISION_FAILED';
        status = 'BLOCKED';
        break;
      }
      observation = await host.observe();
      observationCount += 1;
      mark('AGENT_OBSERVATION_CREATED', step, observation);
      continue;
    }

    const decision: AgentDecision = verdict.allowed
      ? decided
      : (verdict.replacement ?? {
          kind: 'BLOCKED' as const,
          reason: verdict.reason,
        });

    const target =
      decision.kind === 'ACTION' && decision.action?.elementId
        ? observation.elements.find((element) => element.elementId === decision.action?.elementId)
        : decision.elementId
          ? observation.elements.find((element) => element.elementId === decision.elementId)
          : undefined;
    const navigationTarget =
      decision.kind === 'ACTION' && decision.action?.elementId
        ? observation.navigation.find((entry) => entry.elementId === decision.action?.elementId)
        : undefined;
    const repeaterTarget =
      decision.kind === 'ACTION' && decision.action?.elementId
        ? observation.repeaters.find((entry) => entry.elementId === decision.action?.elementId)
        : undefined;
    const targetLabel = target?.label ?? navigationTarget?.label ?? repeaterTarget?.label ?? '';

    // ---- Terminal decisions. ------------------------------------------------
    if (decision.kind === 'READY_FOR_REVIEW' || decision.kind === 'BLOCKED') {
      history.record(
        agentStepTraceSchema.parse({
          step,
          observationId: observation.observationId,
          observedElements: observation.elements.length,
          requiredOutstanding: observation.requiredOutstanding,
          decisionType: decision.kind,
          reason: decision.reason.slice(0, 300),
        }),
        decision,
      );
      if (decision.kind === 'READY_FOR_REVIEW') {
        // ---- READY is granted by the predicate, never by the decider. ------
        //
        // The decider saying READY means "I have run out of things I can
        // safely do", and on a live run that was accepted verbatim over an
        // application with nine blank required fields and five unanswered
        // questions. It is now converted through the terminal ladder, so a
        // decider that has finished its part yields READY_FOR_USER_REVIEW or
        // WAITING_FOR_USER unless the predicate is genuinely satisfied.
        const terminal = terminalStateFor(readiness);
        status = terminal.status;
        statusReason = terminal.reason;
      } else {
        // ---- A BLOCKED run always says why. --------------------------------
        //
        // This is the path the live run stopped on, and it reported
        // `failureCode: undefined` — a run that gave up with no stated reason,
        // which is the one thing a diagnosis cannot survive. The decider ran
        // out of ideas, readiness disagreed, and the fallback produced BLOCKED
        // carrying nothing.
        //
        // The reason is derived from what the run actually did, most specific
        // first: controls it tried and could not settle, then actions the page
        // refused to keep, and only failing both the generic "it stopped
        // getting anywhere".
        status = 'BLOCKED';
        failure = failure ?? blockedReasonFrom(history);
      }
      break;
    }

    if (decision.kind === 'ASK_USER') {
      // ---- A question that was already asked is not progress. --------------
      //
      // The fourth independent brake, and it exists because the other three
      // could not see this case. A decider that keeps proposing a write the
      // safety layer keeps converting into the *same* question spends no
      // budget — the action never executes — takes no page action, and asks
      // nothing new, so the action budget, the per-control failure ceiling and
      // the unchanged-page streak all sit still while the loop runs forever.
      //
      // Found by an integration test over two saved dates that contradicted
      // each other: the decider saw two perfectly fillable dates, the safety
      // layer saw the contradiction between them, and neither could see what
      // the other was doing.
      const questionsBefore = history.openQuestions().length;
      history.record(
        agentStepTraceSchema.parse({
          step,
          observationId: observation.observationId,
          observedElements: observation.elements.length,
          requiredOutstanding: observation.requiredOutstanding,
          decisionType: 'ASK_USER',
          decisionProvider: provider,
          readyEvaluation: readiness,
          reason: decision.reason.slice(0, 300),
          targetLabel: targetLabel.slice(0, 200),
          targetSection: target?.section ?? '',
          ...(target?.blockIndex === undefined ? {} : { targetBlockIndex: target.blockIndex }),
          ...(target ? { targetKind: target.kind } : {}),
          // The list was opened and read, and offered nothing matching. Carried
          // so a trace distinguishes that from a control nobody ever looked at.
          ...(decision.errorCode ? { errorCode: decision.errorCode } : {}),
          ...(target && isListControl(target)
            ? { dropdown: dropdownTraceFor({ before: target, after: observation }) }
            : {}),
          // A date the applicant has to supply. The trace records *why*: a
          // `profilePrecision` of `month` beside a `requiredFormat` of
          // `us_full` is the whole explanation, and it contains no dates.
          ...(target && isDateControl(target)
            ? { date: dateTraceFor({ before: target, after: observation, dayConvention }) }
            : {}),
        }),
        decision,
      );
      // The question is recorded and the loop continues rather than stopping.
      // A single unanswerable question must not end a run that could still fill
      // the twenty fields below it — the applicant answers the questions at the
      // end, together, rather than being interrupted per field.
      emit(`Need your input: ${targetLabel || decision.question || ''}`);
      unchangedStreak = history.openQuestions().length > questionsBefore ? 0 : unchangedStreak + 1;
      if (unchangedStreak >= 6) {
        failure = 'AGENT_NO_PROGRESS';
        status = 'BLOCKED';
        break;
      }
      observation = await host.observe();
      observationCount += 1;
      continue;
    }

    // ---- One action. --------------------------------------------------------
    const call = decision.action as AgentToolCall;
    emit(`Working on ${targetLabel || call.tool}`);
    mark('AGENT_ACTION_SELECTED', step, observation, {
      decisionType: 'ACTION',
      tool: call.tool,
      decisionProvider: provider,
    });
    mark('AGENT_ACTION_EXECUTION_STARTED', step, observation, { tool: call.tool });
    const execution = await host.execute(call);
    mark('AGENT_ACTION_EXECUTION_FINISHED', step, observation, {
      tool: call.tool,
      durationMs: execution.durationMs,
      ...(execution.errorCode ? { errorCode: execution.errorCode } : {}),
    });

    // Re-observe *before* verifying. The page's state after the action is the
    // only admissible evidence about whether the action worked.
    //
    // `observationBefore` is captured first, because "did the loop actually
    // look again" turned out to be a question nobody could answer about the
    // live run: a verifier checking against the same observation it decided
    // from and one checking against a fresh one produce identical traces unless
    // both ids are written down.
    const observationBefore = observation.observationId;
    const readinessBefore = readiness;
    observation = await host.observe();
    observationCount += 1;
    mark('AGENT_OBSERVATION_CREATED', step, observation);
    const outcome = verify(call, target, observation, execution);
    const verification = outcome.verification;
    mark('AGENT_VERIFICATION_FINISHED', step, observation, { tool: call.tool });

    if (navigationTarget?.finalSubmit && execution.executed) {
      // Should be unreachable: the safety layer refuses these. Counted anyway,
      // because a guarantee nobody measures is a guarantee nobody notices
      // losing.
      history.recordSubmitPress();
    }

    history.record(
      agentStepTraceSchema.parse({
        step,
        observationId: observation.observationId,
        observedElements: observation.elements.length,
        requiredOutstanding: observation.requiredOutstanding,
        decisionType: 'ACTION',
        reason: decision.reason.slice(0, 300),
        decisionProvider: provider,
        readyEvaluation: readiness,
        tool: call.tool,
        ...(target ? { targetKind: target.kind } : {}),
        targetLabel: targetLabel.slice(0, 200),
        targetSection: target?.section ?? '',
        ...(target?.blockIndex === undefined ? {} : { targetBlockIndex: target.blockIndex }),
        executed: execution.executed,
        wroteValue: (call.value ?? '').length > 0,
        optionsSeen: Math.max(execution.optionsSeen, execution.options.length),
        pageChanged: execution.pageChanged,
        verification,
        // ---- The verifier's own code, not the executor's. -----------------
        //
        // The order used to be the other way round, and it hid the failure. The
        // executor's `type` reports `VALUE_NOT_VERIFIED` whenever the box does
        // not hold its literal argument, which a control that *reformats* what
        // it keeps always triggers; and when the executor had no code at all, a
        // failed text verification was filed under `SELECTION_NOT_COMMITTED` —
        // a dropdown code, on a text field, which made the live failure
        // unsearchable in its own trace.
        //
        // So the verdict from the page comes first. It is the reading taken
        // last, against fresh evidence, and it is the one that decides whether
        // the field counts.
        //
        // And a step that verified carries *no* code at all, whatever the
        // executor thought. The executor's `type` reports `VALUE_NOT_VERIFIED`
        // for any box that does not hold its literal argument, so a control
        // that reformatted a phone number arrived at a verified step wearing an
        // error — which is precisely the kind of contradiction that makes a
        // trace unreadable.
        ...(verification === 'VERIFIED'
          ? {}
          : outcome.errorCode
            ? { errorCode: outcome.errorCode }
            : execution.errorCode
              ? { errorCode: execution.errorCode }
              : {}),
        durationMs: execution.durationMs,
        action: actionTraceFor({
          step,
          call,
          target,
          execution,
          outcome,
          observationBefore,
          observationAfter: observation.observationId,
          accepted: true,
        }),
        ...(target && isListControl(target)
          ? {
              dropdown: dropdownTraceFor({
                before: target,
                after: observation,
                call,
                execution,
                verification,
                requestedTool: call.tool,
                toolAllowed: true,
              }),
            }
          : {}),
        ...(target && isDateControl(target)
          ? {
              date: dateTraceFor({
                before: target,
                after: observation,
                call,
                execution,
                verification,
                requestedTool: call.tool,
                toolAllowed: true,
                dayConvention,
              }),
            }
          : {}),
      }),
      decision,
      execution,
    );

    if (verification === 'VERIFIED' && targetLabel) {
      if (!completed.includes(targetLabel)) completed.push(targetLabel);
    }

    // ---- Progress is measured from the page, not from the executor. --------
    //
    // A page that does not respond several times running is finished, whatever
    // the decider still wants to try. But "did not respond" has to be read from
    // the observations either side of the action, and it previously was not: it
    // was `execution.pageChanged`, which for `type` is the *executor* asking
    // whether the box holds its literal argument. A control that reformatted
    // what it kept reported `pageChanged: false` while genuinely having been
    // filled, so filling a form correctly counted as six steps of no progress.
    //
    // So three independent signs of progress are accepted, any one of which
    // means the run is getting somewhere:
    //
    //  1. the action verified against fresh page state;
    //  2. the page has fewer required blanks than it did before;
    //  3. the page has fewer fields the agent could still fill.
    //
    // Reading (2) and (3) from the readiness evaluation is deliberate — it is
    // the same predicate that decides whether the run may finish, so "made
    // progress" and "is finished" can never disagree about what counts.
    const readinessAfter = evaluateReady({
      observation,
      askedQuestions: history.openQuestions(),
      // Only an *answer* removes a question from the accounting. Passing the
      // asked list here is what made the agent resolve its own questions.
      answeredQuestions: history.answeredKeys(),
      documentsPending: host.documentsPending?.() ?? false,
      requiredDocumentsPending: host.requiredDocumentsPending?.() ?? 0,
      finalSubmitReached: history.submitActionCount() > 0,
      unresolvedByAgent: history.exhaustedLabels(),
    });
    const madeProgress =
      verification === 'VERIFIED' ||
      readinessAfter.unresolvedRequired < readinessBefore.unresolvedRequired ||
      readinessAfter.knownActionableRemaining < readinessBefore.knownActionableRemaining;
    unchangedStreak = madeProgress ? 0 : unchangedStreak + 1;
    if (unchangedStreak >= 6) {
      failure = 'AGENT_NO_PROGRESS';
      status = 'BLOCKED';
      break;
    }
  }

  // ---- A run that did not finish always names a reason. --------------------
  //
  // Every path above now sets one, and this is the backstop that makes that a
  // guarantee rather than a convention somebody has to maintain. The live run
  // reported `status: BLOCKED, failureCode: undefined`, and a future exit added
  // to this loop would silently do the same again — so the invariant is
  // enforced here, once, where every path converges.
  //
  // `CANCELLED` is exempt on purpose: the applicant pressing stop is not a
  // failure and has no cause to report.
  if ((status === 'BLOCKED' || status === 'FAILED') && failure === undefined) {
    failure = blockedReasonFrom(history);
  }

  // ---- READY_FOR_REVIEW is checked one last time against the predicate. ----
  //
  // The invariant this whole task exists for, enforced where every path
  // converges rather than at each of them. A live run reported
  // `READY_FOR_REVIEW` beside `unresolvedRequired: 9`, and no amount of
  // care at the individual exits would have caught it — the two facts were
  // produced in different places and never compared.
  //
  // So the claim is re-checked against the last readiness evaluation. A run
  // that cannot substantiate "finished" is downgraded to the honest terminal
  // state and says why. This can only ever *demote* a status.
  const finalReadiness = lastReadiness;
  if (status === 'READY_FOR_REVIEW' && finalReadiness && !finalReadiness.ready) {
    const terminal = terminalStateFor(finalReadiness);
    status = terminal.status;
    statusReason = statusReason ?? terminal.reason;
  }
  // ---- Outstanding questions outrank "the loop stopped moving". -----------
  //
  // A run that ran out of progress *and* has unanswered questions is, to the
  // applicant, a run waiting on them — that is the thing they can act on, and
  // `BLOCKED` sends them looking for a fault instead. So the status follows the
  // priority ladder while `failureCode` keeps the diagnosis, and the two facts
  // stay separately readable rather than one overwriting the other.
  //
  // Restricted to the stall codes on purpose: a run that FAILED, or that
  // stopped because no decision could be obtained, is not waiting on the
  // applicant and must not be dressed up as though it were.
  const STALLED: readonly (ErrorCode | undefined)[] = [
    'AGENT_NO_PROGRESS',
    'AGENT_REPEATED_ACTION_FAILURE',
    'ACTION_VERIFICATION_FAILED',
    'AGENT_ACTION_BUDGET_EXHAUSTED',
  ];
  if (
    status === 'BLOCKED' &&
    (finalReadiness?.askUserRemaining ?? 0) > 0 &&
    STALLED.includes(failure)
  ) {
    status = 'WAITING_FOR_USER';
    statusReason = statusReason ?? 'WAITING_FOR_USER_INPUT';
  }

  if (status !== 'READY_FOR_REVIEW' && status !== 'RUNNING' && statusReason === undefined) {
    statusReason =
      failure ?? (finalReadiness ? terminalStateFor(finalReadiness).reason : undefined);
  }

  const summary = finalReadiness
    ? summaryFor(finalReadiness, history, host.optionalDocumentsPending?.() ?? 0)
    : undefined;

  // The loop's own condition guarantees `status` has left RUNNING by here; the
  // only ways out are the terminal assignments above.
  emit(
    status === 'READY_FOR_REVIEW'
      ? 'Application ready for review'
      : (summary?.headline ?? 'Stopped'),
  );

  return {
    status,
    trace: agentRunTraceSchema.parse({
      runId: host.runId,
      buildId: host.buildId ?? 'unstamped',
      origin: observation.origin,
      startedAt,
      completedAt: now(),
      status,
      observationCount,
      actionCount: history.actionCount(),
      verifiedCount: history.verifiedCount(),
      questionsAsked: history.openQuestions().length,
      submitActionCount: history.submitActionCount(),
      decider: host.decide ? 'model' : 'deterministic',
      decisionProviderCalled,
      ...initial,
      ...(lastReadiness ? { finalReadyEvaluation: lastReadiness } : {}),
      ...(host.profileContext ? { profileContext: host.profileContext } : {}),
      markers,
      ...(failure ? { failureCode: failure } : {}),
      ...(statusReason ? { statusReason } : {}),
      ...(summary ? { summary } : {}),
      pendingQuestions: [...history.allQuestions()],
      steps: [...history.all()],
      openQuestions: [...history.openQuestions()],
      totalDurationMs: Math.max(0, Date.now() - startedMs),
    }),
  };
}

export { AGENT_ACTION_BUDGET };
