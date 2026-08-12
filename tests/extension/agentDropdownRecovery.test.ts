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

  observe(): PageObservation {
    const state = element({
      currentValue: this.value,
      dropdownState: this.open ? 'OPEN' : 'CLOSED',
      options: this.open ? OPTIONS : [],
      optionsKnown: this.open,
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
    trustedValues: () => Promise.resolve(new Map([['e1', STATE]])),
    decide: (input) => Promise.resolve(decide(input)),
  };
  return runAgentLoop(host);
}

describe('a decider that types into a dropdown is corrected, and the run continues', () => {
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

    // Handles and counts only. The applicant's state is not in the export.
    expect(JSON.stringify(outcome.trace.steps.map((step) => step.dropdown))).not.toContain(STATE);
  });

  it('does not report ready while the dropdown is still on its placeholder', async () => {
    // A decider that refuses to do anything but type. Every attempt is refused,
    // the field is never answered, and the run must not call that finished.
    const page = new FakePage();
    const outcome = await run(page, () =>
      agentDecisionSchema.parse({
        kind: 'ACTION',
        action: { tool: 'type', elementId: 'e1', value: STATE },
      }),
    );

    expect(page.value).toBe('');
    expect(outcome.trace.status).not.toBe('READY_FOR_REVIEW');
    expect(outcome.trace.failureCode).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
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
