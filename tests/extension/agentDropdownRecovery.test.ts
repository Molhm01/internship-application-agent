import { describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  observedElementSchema,
  toolExecutionResultSchema,
  type AgentDecision,
  type AgentToolCall,
  type ObservedElement,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import {
  decideDeterministically,
  type DecisionInput,
} from '../../extension/src/agent/agentDecision.js';

/**
 * A refused action is a correction, not the end of the run.
 *
 * This is the sequence the whole dropdown contract is for, driven through the
 * real loop rather than through the validator on its own:
 *
 *     type("New Jersey")   → REJECTED, WRONG_TOOL_FOR_CONTROL_TYPE, DOM untouched
 *     open_dropdown        → OPENED, options read
 *     select_option(handle)→ SELECTED
 *     observe              → VERIFIED
 *
 * Two things are being proved at once. The refusal is real — nothing was
 * written, and the step is not counted as a browser action. And the refusal is
 * survivable — the run carries on and finishes the field correctly, rather than
 * ending over one bad decision or letting the bad decision through.
 */

const STATE = 'New Jersey';

function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  return observedElementSchema.parse({
    elementId: 'e1',
    label: 'State/Province',
    section: 'Contact Information',
    kind: 'dropdown',
    interactionType: 'CUSTOM_SELECT',
    required: true,
    policy: 'KNOWN_FACT',
    proposedValue: STATE,
    ...patch,
  });
}

function observation(elements: ObservedElement[], id: string): PageObservation {
  return {
    observationId: id,
    origin: 'https://employer.example',
    title: 'Application',
    sections: ['Contact Information'],
    elements,
    repeaters: [],
    navigation: [],
    requiredOutstanding: elements.filter((entry) => entry.required && !entry.currentValue).length,
    takenAt: '2026-08-11T00:00:00.000Z',
  };
}

const OPTIONS = [
  { optionId: 'e1::option::0', label: 'No Selection', disabled: false, selected: true },
  { optionId: 'e1::option::1', label: 'New York', disabled: false, selected: false },
  { optionId: 'e1::option::2', label: STATE, disabled: false, selected: false },
];

/**
 * A page that only changes when something is actually done to it.
 *
 * The point of the harness: a rejected action never reaches `execute`, so the
 * page cannot change, and a run that believed it had answered the field would
 * be contradicted by the next observation rather than agreeing with itself.
 */
class FakePage {
  open = false;
  value = '';
  executions: AgentToolCall[] = [];

  constructor(readonly proposedValue = STATE) {}

  observe(): PageObservation {
    const state = element({
      currentValue: this.value,
      dropdownState: this.open ? 'OPEN' : 'CLOSED',
      options: this.open ? OPTIONS : [],
      optionsKnown: this.open,
      proposedValue: this.proposedValue,
    });
    return observation([state], `obs-${this.executions.length}`);
  }

  execute(call: AgentToolCall): ToolExecutionResult {
    this.executions.push(call);
    if (call.tool === 'open_dropdown') {
      this.open = true;
      return toolExecutionResultSchema.parse({
        tool: call.tool,
        executed: true,
        options: OPTIONS,
        optionsSeen: OPTIONS.length,
        pageChanged: true,
        durationMs: 1,
      });
    }
    if (call.tool === 'select_option') {
      const chosen = OPTIONS.find((option) => option.optionId === call.optionId);
      // The page only accepts a choice it was actually offering.
      if (chosen) this.value = chosen.label;
      this.open = false;
      return toolExecutionResultSchema.parse({
        tool: call.tool,
        executed: chosen !== undefined,
        options: [],
        optionsSeen: OPTIONS.length,
        pageChanged: chosen !== undefined,
        durationMs: 1,
      });
    }
    // Any other tool — including the `type` this test is about — would write
    // free text. Recorded so the test can assert it never happened.
    return toolExecutionResultSchema.parse({
      tool: call.tool,
      executed: false,
      options: [],
      optionsSeen: 0,
      pageChanged: false,
      durationMs: 1,
    });
  }
}

/** Accepts a plain decider and hands the loop the promise it expects. */
async function run(
  page: FakePage,
  decide: (input: DecisionInput) => AgentDecision | Promise<AgentDecision>,
) {
  const host: AgentLoopHost = {
    runId: '11111111-1111-4111-8111-111111111111',
    buildId: 'test',
    observe: () => Promise.resolve(page.observe()),
    execute: (call) => Promise.resolve(page.execute(call)),
    trustedValues: () => Promise.resolve(new Map([['e1', page.proposedValue]])),
    decide: (input) => Promise.resolve(decide(input)),
  };
  return runAgentLoop(host);
}

describe('a decider that types into a dropdown is corrected, and the run continues', () => {
  it('sends a rejected text strategy to the actual next choice-model request', async () => {
    const requests: Parameters<NonNullable<AgentLoopHost['chooseChoice']>>[0][] = [];
    let reclassified = false;
    let selected = false;
    let observations = 0;
    const educationOptions = [
      { optionId: 'e1::option::0', label: 'No Selection', disabled: false, selected: false },
      { optionId: 'e1::option::1', label: 'BS', disabled: false, selected: false },
    ];
    const observe = (): PageObservation => {
      observations += 1;
      return observation(
        [
          element({
            label: 'Education Type',
            section: 'Education',
            kind: reclassified ? 'dropdown' : 'text',
            interactionType: reclassified ? 'CUSTOM_SELECT' : 'TEXT_INPUT',
            proposedValue: 'BS',
            currentValue: selected ? 'BS' : '',
            dropdownState: reclassified && !selected ? 'OPEN' : 'CLOSED',
            options: reclassified && !selected ? educationOptions : [],
            optionsKnown: reclassified && !selected,
            selectionCommitted: selected,
            validationError: reclassified && !selected ? 'Education Type is required' : '',
          }),
        ],
        `obs-${observations}`,
      );
    };

    const outcome = await runAgentLoop({
      runId: '11111111-1111-4111-8111-111111111111',
      buildId: 'test',
      observe: () => Promise.resolve(observe()),
      execute: (call) => {
        if (call.tool === 'type') {
          reclassified = true;
          return Promise.resolve(
            toolExecutionResultSchema.parse({
              tool: 'type',
              executed: true,
              options: [],
              optionsSeen: 0,
              pageChanged: false,
              durationMs: 1,
            }),
          );
        }
        if (call.tool === 'select_option' && call.optionId === 'e1::option::1') selected = true;
        return Promise.resolve(
          toolExecutionResultSchema.parse({
            tool: call.tool,
            executed: call.tool === 'select_option',
            options: [],
            optionsSeen: educationOptions.length,
            pageChanged: call.tool === 'select_option',
            durationMs: 1,
          }),
        );
      },
      trustedValues: () => Promise.resolve(new Map([['e1', 'BS']])),
      chooseChoice: (request) => {
        requests.push(request);
        return Promise.resolve({
          decision: 'SELECT',
          optionId: 'e1::option::1',
          confidence: 1,
          reason: 'The observed option matches the trusted answer.',
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.previousFailure).toMatchObject({
      previousTool: 'type',
      field: 'Education Type',
      result: 'ACTION_VERIFICATION_FAILED',
      observedState: 'REJECTED_BY_FORM',
      pageChanged: false,
      previousControlType: 'TEXT_INPUT',
      controlType: 'CUSTOM_SELECT',
    });
    expect(requests[0]?.previousFailure?.guidance).toContain(
      'Typing into the parent is not allowed',
    );
    expect(requests[0]?.choices.map((choice) => choice.optionId)).toContain('e1::option::1');
    expect(
      outcome.trace.steps.find((step) => step.tool === 'select_option')
        ?.modelReceivedFailureFeedback,
    ).toBe(true);
    expect(outcome.trace.decisionProviderCalled).toBe(true);
    expect(selected).toBe(true);
  });

  it('delivers sanitized failure feedback to the next model decision', async () => {
    const page = new FakePage();
    const feedback: DecisionInput['failureFeedback'][] = [];
    let first = true;
    const outcome = await run(page, (input) => {
      feedback.push(input.failureFeedback);
      if (first) {
        first = false;
        return agentDecisionSchema.parse({
          kind: 'ACTION',
          action: { tool: 'type', elementId: 'e1', value: STATE },
        });
      }
      return decideDeterministically(input);
    });

    expect(feedback[0]).toBeUndefined();
    expect(feedback[1]).toMatchObject({
      previousTool: 'type',
      field: 'State/Province',
      result: 'WRONG_TOOL_FOR_CONTROL_TYPE',
      observedState: 'PLACEHOLDER',
      pageChanged: false,
      controlType: 'CUSTOM_SELECT',
      identicalActionAlreadyFailed: true,
    });
    expect(feedback[1]?.guidance).toContain('Typing into the parent is not allowed');
    expect(outcome.trace.repeatedActionFailureDetails).toEqual([]);
    expect(page.executions.map((call) => call.tool)).toEqual(['open_dropdown', 'select_option']);
  });

  it('rejects the type, leaves the page untouched, then opens and selects', async () => {
    const page = new FakePage();
    let first = true;
    const outcome = await run(page, (input) => {
      if (first) {
        first = false;
        // The exact live failure: a plausible answer, typed into a list.
        return Promise.resolve(
          agentDecisionSchema.parse({
            kind: 'ACTION',
            reason: 'Filling the state.',
            action: { tool: 'type', elementId: 'e1', value: STATE },
          }),
        );
      }
      return Promise.resolve(decideDeterministically(input));
    });

    // The bad action never reached the page.
    expect(page.executions.some((call) => call.tool === 'type')).toBe(false);

    const tools = page.executions.map((call) => call.tool);
    expect(tools).toEqual(['open_dropdown', 'select_option']);

    // It was chosen by handle, from what the page offered.
    const chosen = page.executions.find((call) => call.tool === 'select_option');
    expect(chosen?.optionId).toBe('e1::option::2');
    expect(page.value).toBe(STATE);

    // And the run finished rather than ending on the refusal.
    expect(outcome.trace.status).toBe('READY_FOR_REVIEW');
    expect(outcome.trace.submitActionCount).toBe(0);
  });

  it('records the refusal without counting it as a browser action', async () => {
    const page = new FakePage();
    let first = true;
    const outcome = await run(page, (input) => {
      if (first) {
        first = false;
        return Promise.resolve(
          agentDecisionSchema.parse({
            kind: 'ACTION',
            action: { tool: 'type', elementId: 'e1', value: STATE },
          }),
        );
      }
      return Promise.resolve(decideDeterministically(input));
    });

    const refused = outcome.trace.steps.find(
      (step) => step.errorCode === 'WRONG_TOOL_FOR_CONTROL_TYPE',
    );
    expect(refused).toBeDefined();
    expect(refused?.executed).toBe(false);
    expect(refused?.wroteValue).toBe(false);

    // Every step that did reach the page is one that was allowed to.
    const executed = outcome.trace.steps.filter((step) => step.executed);
    expect(executed.every((step) => step.tool !== 'type')).toBe(true);
    expect(outcome.trace.actionCount).toBe(2);
    expect(outcome.trace.verifiedCount).toBe(2);
  });

  it('writes the refusal into the exported dropdown trace', async () => {
    const page = new FakePage();
    let first = true;
    const outcome = await run(page, (input) => {
      if (first) {
        first = false;
        return Promise.resolve(
          agentDecisionSchema.parse({
            kind: 'ACTION',
            action: { tool: 'type', elementId: 'e1', value: STATE },
          }),
        );
      }
      return Promise.resolve(decideDeterministically(input));
    });

    const refused = outcome.trace.steps.find((step) => step.dropdown?.toolAllowed === false);
    expect(refused?.dropdown?.requestedTool).toBe('type');
    expect(refused?.dropdown?.rejectionCode).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect(refused?.dropdown?.controlType).toBe('CUSTOM_SELECT');
    // A placeholder, not an answer — which is why the field was still open.
    expect(refused?.dropdown?.currentDisplayState).toBe('PLACEHOLDER');

    const selected = outcome.trace.steps.find((step) => step.tool === 'select_option');
    expect(selected?.dropdown?.optionClicked).toBe(true);
    expect(selected?.dropdown?.optionCount).toBe(3);
    expect(selected?.dropdown?.optionIdChosen).toBe('e1::option::2');
    expect(selected?.dropdown?.verified).toBe(true);
    expect(selected?.dropdown?.displayedSelectionChanged).toBe(true);
    expect(selected?.dropdown).toMatchObject({
      openDropdownRequested: false,
      triggerFound: true,
      menuFound: true,
      optionsFoundCount: 3,
      optionIdsGeneratedCount: 3,
      optionsPassedToDecisionProvider: true,
      decisionReturnedTool: 'select_option',
      decisionReturnedOptionIdPresent: true,
      optionIdExistsInCurrentOptions: true,
      actualOptionNodeFound: true,
      optionClickAttempted: true,
      optionClickCompleted: true,
      freshCommittedValueObserved: true,
      requiredValidationErrorStillPresent: false,
    });

    const opened = outcome.trace.steps.find((step) => step.tool === 'open_dropdown');
    expect(opened?.dropdown).toMatchObject({
      openDropdownRequested: true,
      triggerFound: true,
      menuFound: true,
      optionsFoundCount: 3,
      optionIdsGeneratedCount: 3,
      optionClickAttempted: false,
    });

    // Handles and counts only. The applicant's state is not in the export.
    expect(JSON.stringify(outcome.trace.steps.map((step) => step.dropdown))).not.toContain(STATE);
  });

  it('records when current option handles were actually passed to the choice provider', async () => {
    const page = new FakePage('A saved degree description with no deterministic alias');
    const outcome = await runAgentLoop({
      runId: '11111111-1111-4111-8111-111111111111',
      buildId: 'test',
      observe: () => Promise.resolve(page.observe()),
      execute: (call) => Promise.resolve(page.execute(call)),
      trustedValues: () => Promise.resolve(new Map([['e1', page.proposedValue]])),
      chooseChoice: () =>
        Promise.resolve({
          decision: 'SELECT',
          optionId: 'e1::option::2',
          confidence: 0.9,
          reason: 'The current choice is the intended one.',
        }),
    });

    const selected = outcome.trace.steps.find((step) => step.tool === 'select_option');
    expect(selected?.dropdown).toMatchObject({
      llmCalled: true,
      optionsPassedToDecisionProvider: true,
      optionIdsGeneratedCount: 3,
      decisionReturnedTool: 'select_option',
      decisionReturnedOptionIdPresent: true,
      optionIdExistsInCurrentOptions: true,
    });
  });

  it('does not repeat a model’s identical rejected type action blindly', async () => {
    // The first type is refused. On the next cycle the model receives that
    // failure, and the loop replaces its identical retry with the authoritative
    // open -> inspect -> select recovery.
    const page = new FakePage();
    const outcome = await run(page, () =>
      page.value
        ? agentDecisionSchema.parse({ kind: 'READY_FOR_REVIEW', reason: 'The field is committed.' })
        : agentDecisionSchema.parse({
            kind: 'ACTION',
            action: { tool: 'type', elementId: 'e1', value: STATE },
          }),
    );

    expect(page.value).toBe(STATE);
    expect(page.executions.map((call) => call.tool)).toEqual(['open_dropdown', 'select_option']);
    expect(outcome.trace.status).toBe('READY_FOR_REVIEW');
    expect(
      outcome.trace.steps.filter((step) => step.action?.toolRequested === 'type'),
    ).toHaveLength(1);
  });

  it('overrides a decider that calls a placeholder-bearing page ready', async () => {
    // "No Selection" is not an answer, and a decision that says otherwise is
    // measured against the observation rather than believed.
    const page = new FakePage();
    let calls = 0;
    const outcome = await run(page, (input): AgentDecision => {
      calls += 1;
      if (calls === 1) {
        return agentDecisionSchema.parse({
          kind: 'READY_FOR_REVIEW',
          reason: 'Looks done to me.',
        });
      }
      return decideDeterministically(input);
    });

    expect(page.value).toBe(STATE);
    expect(outcome.trace.status).toBe('READY_FOR_REVIEW');
    expect(outcome.trace.finalReadyEvaluation?.knownActionableRemaining).toBe(0);
  });
});
