import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentChoiceRequest, AgentToolCall, PageObservation } from '@internship-agent/shared';
import { runAgentLoop } from '../../extension/src/agent/agentLoop.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * The handoff the live SuccessFactors run never made.
 *
 * The committed composite fixture proves classification and opening, but every
 * one of its menus is inline and declares `aria-controls`, so it never
 * reproduced the shape the employer actually ships: menus portalled into a
 * container with no ancestor relationship to their trigger, a search box
 * *inside* the opened menu, and a list far longer than one screen.
 *
 * On that page the live trace recorded `optionCount: 58` beside
 * `optionsPassedToDecisionProvider: false` — the options were read and then
 * dropped, because the escalation to a chooser was keyed on one error code that
 * a searchable dropdown never produces. What it produced instead was an action
 * typing the query into the menu's own search box, over and over, and the run
 * ended having answered nothing from a list.
 *
 * These tests drive the production observer, executor and loop over that shape.
 */

const FIXTURE = resolve(
  process.cwd(),
  'tests',
  'fixtures',
  'lab',
  'successfactors-live-dropdowns.html',
);

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 220,
    height: 32,
    top: 0,
    left: 0,
    right: 220,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(/<!doctype html>/i, '');
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

const ANSWERS: ReadonlyArray<[RegExp, string]> = [
  [/^Address/i, '100 Main Street'],
  [/^City/i, 'Newark'],
  [/^Postal Code/i, '07102'],
  [/^Phone/i, '2015550134'],
  [/^Company Name/i, 'Example Company'],
  [/^Position Title/i, 'Engineer'],
  [/^State\/Province/i, 'New Jersey'],
  [/^Education Type/i, 'BS'],
  [/^Area of Study/i, 'Electrical Engineering'],
  [/^School/i, 'Rutgers University'],
];

function observeWith(answers: ReadonlyArray<[RegExp, string]>) {
  return async function observeWithAnswers(): Promise<PageObservation> {
    const observation = await observePage({ classificationDiagnostics: true });
    return {
      ...observation,
      elements: observation.elements.map((element) => {
        // Never the dropdown's own search box: a query is a way of finding an
        // answer, not an answer, and giving it a trusted value would let the run
        // "verify" a field by having typed into a filter.
        if (element.searchInputFor) return element;
        const answer = answers.find(([pattern]) => pattern.test(element.label))?.[1];
        return answer
          ? { ...element, policy: 'KNOWN_FACT' as const, proposedValue: answer }
          : element;
      }),
    };
  };
}

interface RunResult {
  outcome: Awaited<ReturnType<typeof runAgentLoop>>;
  executions: AgentToolCall[];
  choiceRequests: AgentChoiceRequest[];
}

async function runProductionLoop(
  chooseChoice?: (request: AgentChoiceRequest) => Promise<unknown>,
  answers: ReadonlyArray<[RegExp, string]> = ANSWERS,
): Promise<RunResult> {
  const executions: AgentToolCall[] = [];
  const choiceRequests: AgentChoiceRequest[] = [];
  const outcome = await runAgentLoop({
    runId: '22222222-2222-4222-8222-222222222222',
    buildId: 'fixture',
    observe: observeWith(answers),
    execute: async (call) => {
      executions.push(call);
      return executeAgentTool(call);
    },
    trustedValues: (observation) =>
      Promise.resolve(
        new Map(
          observation.elements.flatMap((element) =>
            element.proposedValue ? [[element.elementId, element.proposedValue] as const] : [],
          ),
        ),
      ),
    ...(chooseChoice
      ? {
          chooseChoice: async (request: AgentChoiceRequest) => {
            choiceRequests.push(request);
            return chooseChoice(request);
          },
        }
      : {}),
  });
  return { outcome, executions, choiceRequests };
}

function dropdownTraces(outcome: RunResult['outcome'], label: string) {
  return outcome.trace.steps
    .filter((step) => step.targetLabel.includes(label) && step.dropdown)
    .map((step) => step.dropdown!);
}

beforeEach(loadFixture);

describe('portalled SuccessFactors dropdowns complete the option handoff', () => {
  it('carries State from open through a real option click to a committed value', async () => {
    const { outcome, executions } = await runProductionLoop();
    const steps = outcome.trace.steps.filter((step) => step.targetLabel.includes('State/Province'));
    const tools = steps.map((step) => step.tool);
    expect(tools).toContain('open_dropdown');
    expect(tools).toContain('select_option');
    expect(tools).not.toContain('type');

    const opened = dropdownTraces(outcome, 'State/Province').find((entry) => entry.openAttempted);
    expect(opened?.controlType).toBe('CUSTOM_SELECT');
    expect(opened?.opened).toBe(true);
    expect(opened?.menuFound).toBe(true);
    expect(opened?.optionCount).toBeGreaterThan(50);
    expect(opened?.optionIdsGeneratedCount).toBeGreaterThan(50);

    // The selection step: a real option id, belonging to this control's own
    // current options, clicked on the page and then seen committed by a fresh
    // observation. Every one of these was false on the live run.
    const chose = dropdownTraces(outcome, 'State/Province').find(
      (entry) => entry.decisionReturnedTool === 'select_option',
    );
    expect(chose?.decisionReturnedOptionIdPresent).toBe(true);
    expect(chose?.optionIdExistsInCurrentOptions).toBe(true);
    expect(chose?.matchingStrategy).not.toBe('UNKNOWN');
    expect(chose?.actualOptionNodeFound).toBe(true);
    expect(chose?.optionClickAttempted).toBe(true);
    expect(chose?.optionClickCompleted).toBe(true);
    expect(chose?.freshCommittedValueObserved).toBe(true);
    expect(chose?.selectionCommitted).toBe(true);
    expect(chose?.verified).toBe(true);

    // The employer's own DOM, not the trace's opinion of it.
    expect(document.querySelector<HTMLInputElement>('input[name="state"]')?.value).toBe(
      'New Jersey',
    );

    const selected = executions.find(
      (call) => call.tool === 'select_option' && call.elementId === chose?.elementId,
    );
    expect(selected?.optionId).toBeDefined();
  });

  it('answers Education Type and Area of Study from their own menus', async () => {
    const { outcome } = await runProductionLoop();
    for (const label of ['Education Type', 'Area of Study'] as const) {
      const traces = dropdownTraces(outcome, label);
      const opened = traces.find((entry) => entry.openAttempted);
      expect(opened, `${label} never opened its own trigger`).toBeDefined();
      expect(opened?.opened).toBe(true);
      expect(opened?.optionCount).toBeGreaterThan(0);

      const chose = traces.find((entry) => entry.decisionReturnedTool === 'select_option');
      expect(chose?.optionIdExistsInCurrentOptions).toBe(true);
      expect(chose?.optionClickCompleted).toBe(true);
      expect(chose?.verified).toBe(true);
    }
    expect(document.querySelector<HTMLInputElement>('input[name="educationType"]')?.value).toBe(
      'Bachelor of Science',
    );
    expect(document.querySelector<HTMLInputElement>('input[name="areaOfStudy"]')?.value).toBe(
      'Electrical Engineering',
    );
  });

  it('reaches a searchable School through its own search box and a real result click', async () => {
    const { outcome, executions } = await runProductionLoop();
    // The saved school is past the control's first rendered page, so it can only
    // be reached by narrowing — and narrowing alone must not end the field.
    const typedIntoSearch = executions.filter(
      (call) => call.tool === 'type' && call.elementId?.includes('::search'),
    );
    expect(typedIntoSearch.length).toBeGreaterThan(0);

    const chose = dropdownTraces(outcome, 'School').find(
      (entry) => entry.decisionReturnedTool === 'select_option',
    );
    expect(chose?.optionIdExistsInCurrentOptions).toBe(true);
    expect(chose?.actualOptionNodeFound).toBe(true);
    expect(chose?.optionClickCompleted).toBe(true);
    expect(chose?.verified).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[name="school"]')?.value).toBe(
      'Rutgers University',
    );
  });

  it('never treats a dropdown search box as an application question', async () => {
    const observation = await observePage({});
    const state = observation.elements.find((element) =>
      element.label.includes('State/Province'),
    )!;
    await executeAgentTool({ tool: 'open_dropdown', elementId: state.elementId });
    const opened = await observePage({});
    const search = opened.elements.find((element) => element.searchInputFor !== undefined);
    expect(search, 'the menu search box was not observed').toBeDefined();
    // Owned by the dropdown, never required, and never carrying a saved answer:
    // a run cannot be called finished, or a field called answered, on the
    // strength of a query having been typed.
    expect(search?.searchInputFor).toBe(state.elementId);
    expect(search?.required).toBe(false);
    expect(search?.policy).toBe('UNKNOWN_FACT');
    expect(opened.requiredOutstanding).toBeGreaterThan(0);
  });

  it('typing the query alone leaves the parent dropdown uncommitted', async () => {
    const first = await observePage({});
    const state = first.elements.find((element) => element.label.includes('State/Province'))!;
    await executeAgentTool({ tool: 'open_dropdown', elementId: state.elementId });
    const opened = await observePage({});
    const search = opened.elements.find((element) => element.searchInputFor !== undefined)!;
    await executeAgentTool({ tool: 'type', elementId: search.elementId, value: 'New Jersey' });

    const after = await observePage({});
    const parent = after.elements.find((element) => element.label.includes('State/Province'))!;
    expect(parent.selectionCommitted).toBe(false);
    expect(parent.currentValue.trim()).toBe('');
    expect(document.querySelector<HTMLInputElement>('input[name="state"]')?.value).toBe('');
  });
});

describe('menu ownership is scoped to the control that opened it', () => {
  it('does not lend an open menu to a dropdown that was never opened', async () => {
    const first = await observePage({});
    const state = first.elements.find((element) => element.label.includes('State/Province'))!;
    await executeAgentTool({ tool: 'open_dropdown', elementId: state.elementId });

    const opened = await observePage({});
    const stateNow = opened.elements.find((element) => element.label.includes('State/Province'))!;
    expect(stateNow.options.length).toBeGreaterThan(50);

    // The live trace recorded Education Type and Area of Study reporting
    // `menuFound: true, optionCount: 118` with `openAttempted: false` — a menu
    // belonging to another control, read as though it were their own.
    for (const label of ['Education Type', 'Area of Study', 'School']) {
      const other = opened.elements.find((element) => element.label.includes(label))!;
      expect(other.options, `${label} was lent State's open menu`).toHaveLength(0);
      expect(other.optionsKnown).toBe(false);
      expect(other.dropdownState).toBe('CLOSED');
    }
  });

  it('gives each control its own vocabulary when opened in turn', async () => {
    const first = await observePage({});
    const area = first.elements.find((element) => element.label.includes('Area of Study'))!;
    await executeAgentTool({ tool: 'open_dropdown', elementId: area.elementId });
    const opened = await observePage({});
    const areaNow = opened.elements.find((element) => element.label.includes('Area of Study'))!;
    const labels = areaNow.options.map((option) => option.label);
    expect(labels).toContain('Electrical Engineering');
    expect(labels).not.toContain('New Jersey');
  });
});

/**
 * A saved school no option spells the same way.
 *
 * `Rutgers Univ.` narrows the list to the real entry — so the options are
 * genuinely in hand — while matching none of them exactly or by any trusted
 * alias. That is the case the live run reached and then dropped: real options
 * present, no deterministic answer, and nothing consulted.
 */
const UNMATCHABLE_SCHOOL: ReadonlyArray<[RegExp, string]> = [
  ...ANSWERS.filter(([pattern]) => !pattern.test('School')),
  [/^School/i, 'Rutgers Univ'],
];

describe('the option list actually reaches the choice provider', () => {
  it('hands the real options and the trusted answer to the chooser when nothing matches', async () => {
    const { outcome, choiceRequests } = await runProductionLoop((request) => {
      const target = request.choices.find((choice) => choice.label === 'Rutgers University');
      return Promise.resolve({
        decision: 'SELECT' as const,
        optionId: target?.optionId,
        confidence: 0.9,
        reason: 'The saved school is offered under its full name.',
      });
    }, UNMATCHABLE_SCHOOL);

    const schoolRequest = choiceRequests.find((request) => request.question.includes('School'));
    expect(schoolRequest, 'the chooser was never given the School options').toBeDefined();
    // The ACTUAL options the page is offering, and the trusted answer alongside
    // them — never a list the agent composed for itself.
    expect(schoolRequest!.choices.length).toBeGreaterThan(0);
    expect(schoolRequest!.candidateContext.trustedAnswerAvailable).toBe(true);
    expect(schoolRequest!.choices.map((choice) => choice.label)).toContain('Rutgers University');

    const chose = dropdownTraces(outcome, 'School').find(
      (entry) => entry.decisionReturnedTool === 'select_option',
    );
    expect(chose?.optionsPassedToDecisionProvider).toBe(true);
    expect(chose?.optionIdExistsInCurrentOptions).toBe(true);
    expect(chose?.optionClickCompleted).toBe(true);
    expect(chose?.verified).toBe(true);
  });

  it('reports an unusable choice model as an infrastructure failure, not a question', async () => {
    const { outcome } = await runProductionLoop(() => {
      throw Object.assign(new Error('Configured model "qwen3.5:9b" is not installed.'), {
        code: 'MODEL_NOT_FOUND',
      });
    }, UNMATCHABLE_SCHOOL);

    // A missing model says nothing about which state somebody lives in, so it
    // must never be converted into a question asking them.
    const asked = outcome.trace.steps.filter((step) => step.tool === 'ask_user');
    for (const step of asked) {
      expect(step.targetLabel).not.toMatch(/State\/Province|School|Area of Study|Education Type/);
    }
    expect(JSON.stringify(outcome.trace)).toContain('MODEL_NOT_FOUND');
  });
});
