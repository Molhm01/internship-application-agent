import { afterEach, describe, expect, it } from 'vitest';
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
import { decideDeterministically } from '../../extension/src/agent/agentDecision.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * Changing what a dropdown *shows* is not answering it.
 *
 * This is the live Lincoln Electric failure, written down. Agent Mode took real
 * actions, the Education Type control came to display "BS", the run counted the
 * field filled — and the employer's form went on saying "Education Type is
 * required", because nothing had been selected. The visible text had changed
 * and the form had kept nothing.
 *
 * So a selection is verified against two things the trigger's label cannot
 * fake: the value the widget is holding behind it, and whether the form is
 * still complaining. Either one dissenting makes the step VERIFICATION_FAILED,
 * the control stays unanswered, and the run does not report itself finished.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 200,
    height: 32,
    top: 0,
    left: 0,
    right: 200,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

// ---------------------------------------------------------------------------
describe('the observer reads what the form kept, not what the control shows', () => {
  it('reports a native select sitting on its placeholder as holding nothing', async () => {
    document.body.innerHTML = `
      <label for="state">State/Province *</label>
      <select id="state" name="state" required>
        <option value="" selected>No Selection</option>
        <option value="NJ">New Jersey</option>
      </select>`;
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.currentValue).toBe('');
    expect(state.selectionCommitted).toBe(false);
  });

  it('reports a select holding a real value as committed', async () => {
    document.body.innerHTML = `
      <label for="state">State/Province *</label>
      <select id="state" name="state" required>
        <option value="">No Selection</option>
        <option value="NJ" selected>New Jersey</option>
      </select>`;
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.currentValue).toBe('New Jersey');
    expect(state.selectionCommitted).toBe(true);
    expect(state.validationError).toBe('');
  });

  it('reports "BS" over an empty backing value as unanswered', async () => {
    // The failure exactly. The trigger renders the degree; the input the form
    // actually submits is empty, so the question has not been answered and the
    // agent must not be told otherwise.
    document.body.innerHTML = `
      <label id="eduLabel">Education Type *</label>
      <div id="eduType" role="combobox" aria-labelledby="eduLabel" aria-expanded="false"
           aria-haspopup="listbox">
        <span data-selected-label>BS</span>
        <input type="hidden" name="educationType" value="" />
      </div>`;
    const observed = await observePage();
    const edu = observed.elements.find((entry) => /education type/i.test(entry.label))!;
    expect(edu.selectionCommitted).toBe(false);
    expect(edu.currentValue).toBe('');
  });

  it('reports the same control as answered once the form holds the value', async () => {
    document.body.innerHTML = `
      <label id="eduLabel">Education Type *</label>
      <div id="eduType" role="combobox" aria-labelledby="eduLabel" aria-expanded="false"
           aria-haspopup="listbox">
        <span data-selected-label>BS</span>
        <input type="hidden" name="educationType" value="BS" />
      </div>`;
    const observed = await observePage();
    const edu = observed.elements.find((entry) => /education type/i.test(entry.label))!;
    expect(edu.selectionCommitted).toBe(true);
    expect(edu.currentValue).toBe('BS');
  });

  it('believes the form over the control when it says the question is required', async () => {
    // No backing store this code can find, so the commitment reading has
    // nothing to say. The form's own words settle it.
    document.body.innerHTML = `
      <label id="eduLabel">Education Type *</label>
      <div id="eduType" role="combobox" aria-labelledby="eduLabel" aria-expanded="false"
           aria-haspopup="listbox" aria-invalid="true" aria-describedby="eduError">
        <span data-selected-label>BS</span>
      </div>
      <span id="eduError" role="alert">Education Type is required</span>`;
    const observed = await observePage();
    const edu = observed.elements.find((entry) => /education type/i.test(entry.label))!;
    expect(edu.validationError).toBe('Education Type is required');
    expect(edu.currentValue).toBe('');
  });

  it('does not attribute an unrelated error to a control the page has not flagged', async () => {
    // The guard that keeps this reading from condemning working fields: an
    // error node in the neighbourhood is not this control's unless the page
    // says so.
    document.body.innerHTML = `
      <div class="field-group">
        <label for="state">State/Province *</label>
        <select id="state" name="state" required>
          <option value="NJ" selected>New Jersey</option>
        </select>
        <span class="error-text" role="alert">Postal Code is required</span>
      </div>`;
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.validationError).toBe('');
    expect(state.currentValue).toBe('New Jersey');
  });
});

// ---------------------------------------------------------------------------
// The loop, driven against a page that lies about its own state.
// ---------------------------------------------------------------------------

const DEGREE = 'BS';

function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  return observedElementSchema.parse({
    elementId: 'e1',
    label: 'Education Type',
    section: 'Education',
    kind: 'dropdown',
    interactionType: 'CUSTOM_SELECT',
    required: true,
    policy: 'KNOWN_FACT',
    proposedValue: DEGREE,
    ...patch,
  });
}

function observation(elements: ObservedElement[], id: string): PageObservation {
  return {
    observationId: id,
    origin: 'https://employer.example',
    title: 'Application',
    sections: ['Education'],
    elements,
    repeaters: [],
    navigation: [],
    requiredOutstanding: elements.filter((entry) => entry.required && !entry.currentValue).length,
    takenAt: '2026-08-11T00:00:00.000Z',
  };
}

const OPTIONS = [
  { optionId: 'e1::option::0', label: 'No Selection', disabled: false, selected: true },
  { optionId: 'e1::option::1', label: 'BS', disabled: false, selected: false },
  { optionId: 'e1::option::2', label: 'No', disabled: false, selected: false },
];

/**
 * A control that renders whatever it is told and keeps nothing.
 *
 * `displayed` moves when an option is clicked; `committed` never does. That is
 * the whole point — this is a page behaving exactly as Lincoln Electric's did,
 * and the run must not come away from it claiming the field is filled.
 */
class LyingPage {
  open = false;
  displayed = '';
  committed = false;
  validationError = 'Education Type is required';
  executions: AgentToolCall[] = [];

  observe(): PageObservation {
    return observation(
      [
        element({
          // What the observer would report: a display the form contradicts is
          // reduced to nothing before anything downstream ever sees it.
          currentValue: this.committed ? this.displayed : '',
          selectionCommitted: this.committed,
          validationError: this.validationError,
          dropdownState: this.open ? 'OPEN' : 'CLOSED',
          options: this.open ? OPTIONS : [],
          optionsKnown: this.open,
        }),
      ],
      `obs-${this.executions.length}`,
    );
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
      // The lie: the label changes and nothing is stored.
      if (chosen) this.displayed = chosen.label;
      this.open = false;
      return toolExecutionResultSchema.parse({
        tool: call.tool,
        executed: chosen !== undefined,
        options: [],
        optionsSeen: OPTIONS.length,
        pageChanged: true,
        durationMs: 1,
      });
    }
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

async function run(
  page: LyingPage,
  decide: (input: Parameters<NonNullable<AgentLoopHost['decide']>>[0]) => AgentDecision,
) {
  const host: AgentLoopHost = {
    runId: '22222222-2222-4222-8222-222222222222',
    buildId: 'test',
    observe: () => Promise.resolve(page.observe()),
    execute: (call) => Promise.resolve(page.execute(call)),
    trustedValues: () => Promise.resolve(new Map([['e1', DEGREE]])),
    decide: (input) => Promise.resolve(decide(input)),
  };
  return runAgentLoop(host);
}

describe('a selection the form did not keep is a failure, not a success', () => {
  it('marks the step VERIFICATION_FAILED and never reports the run ready', async () => {
    const page = new LyingPage();
    const outcome = await run(page, (input) => decideDeterministically(input));

    // The option really was clicked, by the handle the page offered.
    const chosen = page.executions.find((call) => call.tool === 'select_option');
    expect(chosen?.optionId).toBe('e1::option::1');
    expect(page.displayed).toBe(DEGREE);

    // And the run was not fooled by it.
    const selected = outcome.trace.steps.filter((step) => step.tool === 'select_option');
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((step) => step.verification === 'VERIFICATION_FAILED')).toBe(true);
    // `OPTION_SELECTION_NOT_COMMITTED`, the *verifier's* verdict, rather than
    // `SELECTION_NOT_COMMITTED`, the executor's. The step now carries the code
    // from the layer that read the page back, because that is the reading taken
    // last and against fresh evidence — and because the executor's codes were
    // being applied to controls they did not describe, which is how a failed
    // text write came to be filed under a dropdown code.
    expect(selected.every((step) => step.errorCode === 'OPTION_SELECTION_NOT_COMMITTED')).toBe(
      true,
    );
    // No *answer* is counted as landed. Opening the list verifies — the list
    // really was read — and choosing from it never does, which is the only
    // arrangement under which the two can be told apart afterwards.
    expect(
      outcome.trace.steps.some(
        (step) => step.tool === 'select_option' && step.verification === 'VERIFIED',
      ),
    ).toBe(false);

    // The field is reported as one the applicant has to finish, rather than as
    // one the agent filled. A run may still end READY_FOR_REVIEW over a control
    // it could not settle — that is deliberate, or a single stubborn dropdown
    // would make readiness unreachable — but it ends saying so.
    expect(outcome.trace.finalReadyEvaluation?.blockedRemaining).toBeGreaterThan(0);
    expect(outcome.trace.finalReadyEvaluation?.unresolvedRequired).toBeGreaterThan(0);
  });

  it('writes the contradiction into the exported dropdown trace', async () => {
    const page = new LyingPage();
    const outcome = await run(page, (input) => decideDeterministically(input));
    const selected = outcome.trace.steps.find((step) => step.tool === 'select_option');
    // The defect in two booleans: the control changed what it shows, and the
    // form kept nothing.
    expect(selected?.dropdown?.optionClicked).toBe(true);
    expect(selected?.dropdown?.selectionCommitted).toBe(false);
    expect(selected?.dropdown?.validationErrorPresent).toBe(true);
    expect(selected?.dropdown?.verified).toBe(false);
    expect(selected?.dropdown?.finalStatus).toBe('VERIFICATION_FAILED');
  });

  it('verifies the same sequence once the form actually keeps the choice', async () => {
    // The control between the two runs differs in one respect: it stores what
    // was chosen. That difference, and nothing about the visible text, is what
    // separates a verified field from a failed one.
    const page = new LyingPage();
    const honest = page.execute.bind(page);
    page.execute = (call: AgentToolCall): ToolExecutionResult => {
      const outcome = honest(call);
      if (call.tool === 'select_option' && outcome.executed) {
        page.committed = true;
        page.validationError = '';
      }
      return outcome;
    };

    const outcome = await run(page, (input) => decideDeterministically(input));
    const selected = outcome.trace.steps.find((step) => step.tool === 'select_option');
    expect(selected?.verification).toBe('VERIFIED');
    expect(selected?.dropdown?.selectionCommitted).toBe(true);
    expect(outcome.trace.status).toBe('READY_FOR_REVIEW');
  });
});

// ---------------------------------------------------------------------------
describe('a placeholder never verifies as an answer', () => {
  /** One `select_option`, verified against a control in the given state. */
  const verifyOnce = async (
    chosen: { optionId: string; value: string },
    after: Partial<ObservedElement>,
  ) => {
    let observations = 0;
    const host: AgentLoopHost = {
      runId: '33333333-3333-4333-8333-333333333333',
      buildId: 'test',
      observe: () => {
        observations += 1;
        return Promise.resolve(
          observations === 1
            ? observation(
                [element({ dropdownState: 'OPEN', options: OPTIONS, optionsKnown: true })],
                'obs-open',
              )
            : observation([element({ dropdownState: 'CLOSED', ...after })], `obs-${observations}`),
        );
      },
      execute: (call) =>
        Promise.resolve(
          toolExecutionResultSchema.parse({
            tool: call.tool,
            executed: true,
            options: [],
            optionsSeen: OPTIONS.length,
            pageChanged: true,
            durationMs: 1,
          }),
        ),
      trustedValues: () => Promise.resolve(new Map([['e1', chosen.value]])),
      decide: () =>
        Promise.resolve(
          agentDecisionSchema.parse({
            kind: 'ACTION',
            reason: 'Choosing the saved degree.',
            action: {
              tool: 'select_option',
              elementId: 'e1',
              optionId: chosen.optionId,
              value: chosen.value,
            },
          }),
        ),
    };
    const outcome = await runAgentLoop(host);
    return outcome.trace.steps.find((step) => step.tool === 'select_option');
  };

  it('refuses to read "No Selection" as an answer of "No"', async () => {
    // Substring containment approved this, and it is the reason a form full of
    // untouched dropdowns once reported as filled. "No" is inside "No
    // Selection" and is not what the control is holding.
    const step = await verifyOnce(
      { optionId: 'e1::option::2', value: 'No' },
      { currentValue: 'No Selection', selectionCommitted: true },
    );
    expect(step?.verification).toBe('VERIFICATION_FAILED');
  });

  it("accepts the choice under the control's own decoration", async () => {
    // The decorated cases the containment rule existed to serve are kept: a
    // trigger that renders a clear button beside the label still verifies.
    const step = await verifyOnce(
      { optionId: 'e1::option::1', value: 'BS' },
      { currentValue: 'BS ✕', selectionCommitted: true },
    );
    expect(step?.verification).toBe('VERIFIED');
  });

  it('fails a control left displaying nothing at all', async () => {
    const step = await verifyOnce(
      { optionId: 'e1::option::1', value: 'BS' },
      { currentValue: '', selectionCommitted: true },
    );
    expect(step?.verification).toBe('VERIFICATION_FAILED');
  });

  it('fails a control the form is still complaining about', async () => {
    const step = await verifyOnce(
      { optionId: 'e1::option::1', value: 'BS' },
      {
        currentValue: 'BS',
        selectionCommitted: true,
        validationError: 'Education Type is required',
      },
    );
    expect(step?.verification).toBe('VERIFICATION_FAILED');
  });
});
