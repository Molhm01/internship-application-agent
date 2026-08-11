import {
  AGENT_ACTION_BUDGET,
  agentRunTraceSchema,
  agentStepTraceSchema,
  type AgentDecision,
  type AgentProgress,
  type AgentRunStatus,
  type AgentRunTrace,
  type AgentToolCall,
  type AgentVerification,
  type ObservedElement,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { decideDeterministically, type DecisionInput } from './agentDecision.js';
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
  /** Called after each step so the popup can show what is happening. */
  onProgress?(progress: AgentProgress): void;
  /** True when the user has asked the run to stop. */
  isCancelled?(): boolean;
  now?(): string;
  buildId?: string;
  runId: string;
}

/**
 * Did the action do what it claimed?
 *
 * Read from the observation taken *after* the action, never from the tool's own
 * report. A tool returning without throwing is not evidence a field was filled —
 * that mistake is the reason this project exists in its current form — so the
 * verifier compares the control's state now against what the action intended.
 */
function verify(
  call: AgentToolCall,
  before: ObservedElement | undefined,
  after: PageObservation,
  execution: ToolExecutionResult,
): AgentVerification {
  if (!execution.executed) return 'NOT_VERIFIED';
  switch (call.tool) {
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
      const wanted = (call.value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const held = now.currentValue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!wanted) return 'NOT_APPLICABLE';
      return held === wanted || held.includes(wanted) ? 'VERIFIED' : 'NOT_VERIFIED';
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
 * Runs the agent until the page is ready for the applicant to review it.
 *
 * Always returns a trace, whatever happened. A run that ends in `BLOCKED` with
 * fifty steps recorded is a diagnosis; a run that throws is a mystery, and this
 * project has had enough of those.
 */
export async function runAgentLoop(host: AgentLoopHost): Promise<AgentRunOutcome> {
  const history = new AgentHistory();
  const now: () => string = host.now ? () => host.now!() : () => new Date().toISOString();
  const startedAt = now();
  const startedMs = Date.now();
  const completed: string[] = [];
  let status: AgentRunStatus = 'RUNNING';
  let observation = await host.observe();
  let observationCount = 1;
  let unchangedStreak = 0;

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
    const input: DecisionInput = { observation, history, trustedValues };
    const decided = host.decide ? await host.decide(input) : decideDeterministically(input);

    // Safety runs against the observation the decision was made from, never a
    // later one. A decision is a claim about a specific page state, and it is
    // checked against that state or refused.
    const verdict = checkDecision(decided, observation, trustedValues);
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
      history.record(
        agentStepTraceSchema.parse({
          step,
          observationId: observation.observationId,
          observedElements: observation.elements.length,
          requiredOutstanding: observation.requiredOutstanding,
          decisionType: 'ASK_USER',
          reason: decision.reason.slice(0, 300),
          targetLabel: targetLabel.slice(0, 200),
          targetSection: target?.section ?? '',
          ...(target ? { targetKind: target.kind } : {}),
        }),
        decision,
      );
      // The question is recorded and the loop continues rather than stopping.
      // A single unanswerable question must not end a run that could still fill
      // the twenty fields below it — the applicant answers the questions at the
      // end, together, rather than being interrupted per field.
      emit(`Need your input: ${targetLabel || decision.question || ''}`);
      observation = await host.observe();
      observationCount += 1;
      continue;
    }

    // ---- One action. --------------------------------------------------------
    const call = decision.action as AgentToolCall;
    emit(`Working on ${targetLabel || call.tool}`);
    const execution = await host.execute(call);

    // Re-observe *before* verifying. The page's state after the action is the
    // only admissible evidence about whether the action worked.
    observation = await host.observe();
    observationCount += 1;
    const verification = verify(call, target, observation, execution);

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
        tool: call.tool,
        ...(target ? { targetKind: target.kind } : {}),
        targetLabel: targetLabel.slice(0, 200),
        targetSection: target?.section ?? '',
        executed: execution.executed,
        wroteValue: (call.value ?? '').length > 0,
        optionsSeen: execution.options.length,
        pageChanged: execution.pageChanged,
        verification,
        ...(execution.errorCode ? { errorCode: execution.errorCode } : {}),
        durationMs: execution.durationMs,
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
      steps: [...history.all()],
      openQuestions: [...history.openQuestions()],
      totalDurationMs: Math.max(0, Date.now() - startedMs),
    }),
  };
}

export { AGENT_ACTION_BUDGET };
