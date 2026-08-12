import {
  AGENT_ACTION_BUDGET,
  DATE_INTERACTION_TYPES,
  agentDateTraceSchema,
  agentDropdownTraceSchema,
  normalizeStoredDate,
  type AgentDateTrace,
  type DayConvention,
  agentMarkerRecordSchema,
  agentRunTraceSchema,
  agentStepTraceSchema,
  displaysSelection,
  OPTION_INTERACTION_TYPES,
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

function verify(
  call: AgentToolCall,
  before: ObservedElement | undefined,
  after: PageObservation,
  execution: ToolExecutionResult,
): AgentVerification {
  if (!execution.executed) return 'NOT_VERIFIED';
  switch (call.tool) {
    // ---- A date is verified against the employer, not against the box. -----
    //
    // The distinction that makes this worth its own case. A control displaying
    // `07/12/2021` beside a form still showing "Invalid date." has not been
    // answered, and every prior version of this code would have called that a
    // success because the text was there.
    //
    // So three things are asked, and the weakest of them comes last:
    //
    //  1. Does the employer's form still complain about this control? That
    //     outranks everything on the page, including the browser's own opinion:
    //     `2021-07` in a text box is *valid HTML* and was refused anyway.
    //  2. Does the control still hold anything at all? A masked box that
    //     silently discards what it did not understand keeps nothing.
    //  3. Only then, does what it holds correspond to what was written?
    case 'set_date': {
      if (!before) return 'NOT_VERIFIED';
      const now = after.elements.find(
        (element) =>
          element.label === before.label &&
          element.section === before.section &&
          element.blockIndex === before.blockIndex,
      );
      if (!now) return 'NOT_VERIFIED';
      if (now.validationError.trim().length > 0) return 'VERIFICATION_FAILED';
      if (execution.errorCode !== undefined) return 'VERIFICATION_FAILED';
      const written = execution.observedValue.trim();
      if (written.length === 0) return 'VERIFICATION_FAILED';
      return now.currentValue.trim() === written ? 'VERIFIED' : 'VERIFICATION_FAILED';
    }
    case 'type':
    case 'select_option': {
      if (!before) return 'NOT_VERIFIED';
      // Found by label rather than by handle: the handles were reminted by the
      // observation this is checking against, and a control the page replaced
      // has a new one.
      //
      // The block index is part of the identity, and leaving it out was a real
      // bug: a page with two Work Experience blocks has two controls labelled
      // "Company Name", so every write to the second block was checked against
      // the first one's value and reported NOT_VERIFIED over a field that had
      // been filled correctly.
      const now = after.elements.find(
        (element) =>
          element.label === before.label &&
          element.section === before.section &&
          element.blockIndex === before.blockIndex,
      );
      if (!now) return 'NOT_VERIFIED';
      const wanted = call.value ?? '';
      if (!wanted.trim()) return 'NOT_APPLICABLE';

      // ---- A list control is verified against the form, not the label. -----
      //
      // Three things are asked of a dropdown, and the previous version of this
      // asked only the weakest of them.
      //
      //  1. Does the form still say the question is unanswered? That outranks
      //     everything: Education Type displayed "BS" while the page went on
      //     showing "Education Type is required", and the page was right.
      //  2. Did the widget keep a value behind the text? A trigger whose label
      //     changed over an empty backing store has been *typed into*, not
      //     chosen from.
      //  3. Only then, does the displayed text correspond to the choice?
      //
      // And that last comparison is `displaysSelection` rather than
      // `includes`. Substring containment approved "No Selection" as an answer
      // of "No" — a placeholder verifying as a real choice, which is the exact
      // shape of failure this whole path exists to stop.
      if (isListControl(now)) {
        if (now.validationError.trim().length > 0) return 'VERIFICATION_FAILED';
        if (!now.selectionCommitted) return 'VERIFICATION_FAILED';
        if (now.currentValue.trim().length === 0) return 'VERIFICATION_FAILED';
        const aliases = call.optionId
          ? before.options
              .filter((option) => option.optionId === call.optionId)
              .map((option) => option.label)
          : [];
        return displaysSelection(now.currentValue, wanted, { aliases })
          ? 'VERIFIED'
          : 'VERIFICATION_FAILED';
      }

      // A text box holds what was written, or it does not. The form's own
      // complaint still counts against it — a rejected value is not a written
      // one — but containment stays, because a box may reformat what it keeps.
      if (now.validationError.trim().length > 0) return 'VERIFICATION_FAILED';
      const reduce = (value: string): string =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const held = reduce(now.currentValue);
      const target = reduce(wanted);
      return held === target || held.includes(target) ? 'VERIFIED' : 'VERIFICATION_FAILED';
    }
    case 'click_add': {
      // The page grew a block, or it did not. `pageChanged` here is the block
      // count rising, observed by the tool against the section it pressed.
      return execution.pageChanged ? 'VERIFIED' : 'NOT_VERIFIED';
    }
    case 'open_dropdown':
    case 'get_options': {
      return execution.options.length > 0 ? 'VERIFIED' : 'NOT_VERIFIED';
    }
    case 'click_next': {
      return execution.pageChanged ? 'VERIFIED' : 'NOT_VERIFIED';
    }
    default:
      return 'NOT_APPLICABLE';
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
    });
  };

  emit('Observing the page');

  for (let step = 0; status === 'RUNNING'; step += 1) {
    if (host.isCancelled?.()) {
      status = 'CANCELLED';
      break;
    }
    if (history.budgetExhausted()) {
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
      documentsPending: host.documentsPending?.() ?? false,
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
      status = decision.kind === 'READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'BLOCKED';
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
    observation = await host.observe();
    observationCount += 1;
    mark('AGENT_OBSERVATION_CREATED', step, observation);
    const verification = verify(call, target, observation, execution);
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
        // The tool's own code first, when it has one — it names the more
        // specific cause. Failing that, a verification the page contradicted is
        // recorded as exactly that, so a step where a control displayed the
        // answer and kept nothing is not filed as an unexplained silence.
        ...(execution.errorCode
          ? { errorCode: execution.errorCode }
          : verification === 'VERIFICATION_FAILED'
            ? { errorCode: 'SELECTION_NOT_COMMITTED' as const }
            : {}),
        durationMs: execution.durationMs,
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

    // A page that does not respond twice running is finished, whatever the
    // decider still wants to try. This is the third independent brake, and the
    // one that catches a decider looping over actions that "succeed" without
    // changing anything.
    unchangedStreak =
      execution.pageChanged || verification === 'VERIFIED' ? 0 : unchangedStreak + 1;
    if (unchangedStreak >= 6) {
      status = 'BLOCKED';
      break;
    }
  }

  // The loop's own condition guarantees `status` has left RUNNING by here; the
  // only ways out are the four terminal assignments above.
  emit(status === 'READY_FOR_REVIEW' ? 'Application ready for review' : 'Stopped');

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
      steps: [...history.all()],
      openQuestions: [...history.openQuestions()],
      totalDurationMs: Math.max(0, Date.now() - startedMs),
    }),
  };
}

export { AGENT_ACTION_BUDGET };
