import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTION_BUDGET,
  observedElementSchema,
  agentDecisionSchema,
  agentToolCallSchema,
  type AgentDecision,
  type AgentToolCall,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import { checkDecision } from '../../extension/src/agent/agentSafety.js';
import {
  decideDeterministically,
  parseModelDecision,
} from '../../extension/src/agent/agentDecision.js';
import { AgentHistory } from '../../extension/src/agent/agentHistory.js';

/**
 * Agent Mode, decided and refused.
 *
 * The architecture's whole claim is that the agent takes one action against the
 * page as it *currently* is, and that a decision it should not act on cannot be
 * acted on. Both halves are tested here: the decider's ordering, and the safety
 * layer's refusals — which are what actually hold, because they do not depend on
 * the decider being any good.
 */

let handle = 0;
function element(patch: Partial<PageObservation['elements'][number]> = {}) {
  handle += 1;
  // Parsed rather than cast: the factory then produces exactly what the
  // observer produces, defaults included, so a test cannot describe a control
  // the real observation could never emit.
  return observedElementSchema.parse({
    elementId: `e${handle}`,
    section: '',
    label: `Field ${handle}`,
    kind: 'text' as const,
    currentValue: '',
    required: false,
    disabled: false,
    visible: true,
    options: [],
    optionsKnown: false,
    policy: 'UNKNOWN_FACT' as const,
    frameId: 0,
    ...patch,
  });
}

function observation(patch: Partial<PageObservation> = {}): PageObservation {
  return {
    observationId: 'obs-1',
    origin: 'https://employer.example',
    title: 'Application',
    sections: [],
    elements: [],
    repeaters: [],
    navigation: [],
    requiredOutstanding: 0,
    takenAt: '2026-08-11T00:00:00.000Z',
    ...patch,
  };
}

// ---------------------------------------------------------------------------
describe('the decision schema cannot express a plan', () => {
  it('accepts exactly one action', () => {
    const decision = agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: 'ok',
      action: { tool: 'type', elementId: 'e1', value: 'Robin' },
    });
    expect(decision.action?.tool).toBe('type');
  });

  it('refuses an ACTION carrying no tool call', () => {
    expect(() => agentDecisionSchema.parse({ kind: 'ACTION', reason: 'x' })).toThrow();
  });

  it('refuses a tool call on a non-action decision', () => {
    expect(() =>
      agentDecisionSchema.parse({
        kind: 'READY_FOR_REVIEW',
        reason: 'x',
        action: { tool: 'type', elementId: 'e1' },
      }),
    ).toThrow();
  });

  it('has no shape that holds a list of actions', () => {
    // Stronger than stripping the key: `.strict()` rejects the object outright,
    // so a decider that returns twenty-six writes produces no decision at all
    // rather than a decision with the list quietly removed.
    expect(() =>
      agentDecisionSchema.parse({
        kind: 'READY_FOR_REVIEW',
        reason: 'x',
        actions: [{ tool: 'type' }, { tool: 'type' }],
      }),
    ).toThrow();
  });

  it('refuses a tool that is not on the allowlist', () => {
    expect(() => agentToolCallSchema.parse({ tool: 'evaluate_script' })).toThrow();
    expect(() => agentToolCallSchema.parse({ tool: 'navigate' })).toThrow();
  });

  it.each(['selector', 'script', 'xpath', 'js', 'code'])(
    'rejects a tool call carrying %s',
    (key) => {
      // The model cannot address the page by anything except a handle this
      // observation issued. A call carrying its own selector is refused at the
      // schema boundary rather than partially honoured.
      expect(() =>
        agentToolCallSchema.parse({ tool: 'click', elementId: 'e1', [key]: 'anything' }),
      ).toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
describe('the model’s output is parsed, never evaluated', () => {
  it('reads one decision out of surrounding prose', () => {
    const decision = parseModelDecision(
      'Sure! Here is my choice:\n{"kind":"ACTION","reason":"r","action":{"tool":"type","elementId":"e1","value":"Robin"}}\nHope that helps.',
    );
    expect(decision.kind).toBe('ACTION');
  });

  it('blocks rather than guessing when the output is not a decision', () => {
    expect(parseModelDecision('I will fill everything now.').kind).toBe('BLOCKED');
    expect(parseModelDecision('{oops').kind).toBe('BLOCKED');
  });

  it('blocks a decision naming a tool that does not exist', () => {
    expect(
      parseModelDecision('{"kind":"ACTION","action":{"tool":"exec","elementId":"e1"}}').kind,
    ).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
describe('the safety layer', () => {
  const allow = (
    decision: AgentDecision,
    page: PageObservation,
    trusted = new Map<string, string>(),
  ) => checkDecision(decision, page, trusted);

  it('refuses an element the current observation never issued', () => {
    const page = observation({ elements: [element({ elementId: 'e1' })] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'stale',
        action: { tool: 'type', elementId: 'e999', value: 'x' },
      }),
      page,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not in the current observation/i);
  });

  it('refuses a value that looks like code', () => {
    const target = element({ policy: 'KNOWN_FACT', proposedValue: 'Robin' });
    const page = observation({ elements: [target] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'type', elementId: target.elementId, value: '<script>alert(1)</script>' },
      }),
      page,
      new Map([[target.elementId, 'Robin']]),
    );
    expect(verdict.allowed).toBe(false);
  });

  it('never presses a control that would submit the application', () => {
    const page = observation({
      navigation: [
        { elementId: 'nav1', label: 'Submit Application', finalSubmit: true, frameId: 0 },
      ],
    });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'finish',
        action: { tool: 'click_next', elementId: 'nav1' },
      }),
      page,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.replacement?.kind).toBe('READY_FOR_REVIEW');
  });

  it('never answers a protected characteristic', () => {
    const target = element({ policy: 'SENSITIVE', kind: 'dropdown', label: 'Race' });
    const page = observation({ elements: [target] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'select_option', elementId: target.elementId, value: 'Decline' },
      }),
      page,
    );
    expect(verdict.allowed).toBe(false);
  });

  it('refuses a factual value the profile does not contain', () => {
    // The model inventing a plausible answer is the failure this catches: the
    // trusted map is built by the extension, and anything else matches nothing.
    const target = element({ policy: 'KNOWN_FACT', kind: 'dropdown', label: 'Employment Type' });
    const page = observation({ elements: [target] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'select_option', elementId: target.elementId, value: 'Full Time' },
      }),
      page,
      new Map([[target.elementId, 'Internship']]),
    );
    expect(verdict.allowed).toBe(false);
  });

  it('turns an unanswerable factual write into a question', () => {
    const target = element({ policy: 'UNKNOWN_FACT', label: 'Reason for Leaving' });
    const page = observation({ elements: [target] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'type', elementId: target.elementId, value: 'Career advancement' },
      }),
      page,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.replacement?.kind).toBe('ASK_USER');
  });

  it('leaves a conditional child alone while its parent is unanswered', () => {
    // The relatives box, in the agent's own vocabulary.
    const parent = element({ label: 'Do you have any relatives…', kind: 'dropdown' });
    const child = element({
      label: 'If you have any relatives currently employed, provide their full name…',
      kind: 'textarea',
      policy: 'KNOWN_FACT',
      proposedValue: 'Robin Vale',
      dependsOnElementId: parent.elementId,
      dependencyActive: false,
    });
    const page = observation({ elements: [parent, child] });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'type', elementId: child.elementId, value: 'Robin Vale' },
      }),
      page,
      new Map([[child.elementId, 'Robin Vale']]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/only applies once/i);
  });

  it('refuses Add when the page already has a block per saved record', () => {
    const page = observation({
      repeaters: [
        {
          elementId: 'add1',
          section: 'experience',
          label: '+ Add',
          blockCount: 2,
          recordCount: 2,
          frameId: 0,
        },
      ],
    });
    const verdict = allow(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'click_add', elementId: 'add1' },
      }),
      page,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/already has/i);
  });

  it('permits Add when a saved record has no block', () => {
    const page = observation({
      repeaters: [
        {
          elementId: 'add1',
          section: 'experience',
          label: '+ Add',
          blockCount: 1,
          recordCount: 2,
          frameId: 0,
        },
      ],
    });
    expect(
      allow(
        agentDecisionSchema.parse({
          kind: 'ACTION',
          reason: 'x',
          action: { tool: 'click_add', elementId: 'add1' },
        }),
        page,
      ).allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the deterministic policy chooses one thing at a time', () => {
  const decide = (page: PageObservation, history = new AgentHistory()) =>
    decideDeterministically({ observation: page, history, trustedValues: new Map() });

  it('fills a known text field before opening any dropdown', () => {
    const text = element({ policy: 'KNOWN_FACT', proposedValue: 'Robin', label: 'First Name' });
    const menu = element({
      policy: 'KNOWN_FACT',
      proposedValue: 'United States',
      kind: 'dropdown',
      label: 'Country',
    });
    const decision = decide(observation({ elements: [menu, text] }));
    expect(decision.action?.tool).toBe('type');
    expect(decision.action?.elementId).toBe(text.elementId);
  });

  it('works one dropdown at a time, and opens it before choosing', () => {
    const country = element({
      policy: 'KNOWN_FACT',
      proposedValue: 'United States',
      kind: 'dropdown',
      interactionType: 'NATIVE_SELECT',
    });
    const state = element({
      policy: 'KNOWN_FACT',
      proposedValue: 'New Jersey',
      kind: 'dropdown',
      interactionType: 'NATIVE_SELECT',
    });
    const decision = decide(observation({ elements: [country, state] }));
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.elementId).toBe(country.elementId);
    // The first thing done to a dropdown is to read its choices — never to
    // select an answer decided before the list was seen.
    expect(decision.action?.tool).toBe('open_dropdown');
  });

  it('skips a control that is disabled, and returns to it once it is not', () => {
    // Country → State without a dependency graph: the only thing that changed
    // between these two observations is what the page is offering.
    const state = element({
      policy: 'KNOWN_FACT',
      proposedValue: 'New Jersey',
      kind: 'dropdown',
      interactionType: 'NATIVE_SELECT',
      label: 'State',
      disabled: true,
    });
    expect(decide(observation({ elements: [state] })).kind).toBe('READY_FOR_REVIEW');
    // Enabled now, so it is worked on — starting by reading its choices.
    expect(decide(observation({ elements: [{ ...state, disabled: false }] })).action?.tool).toBe(
      'open_dropdown',
    );
  });

  it('asks about a required question nothing saved answers', () => {
    const unknown = element({
      required: true,
      policy: 'UNKNOWN_FACT',
      label: 'Reason for Leaving',
    });
    const decision = decide(observation({ elements: [unknown], requiredOutstanding: 1 }));
    expect(decision.kind).toBe('ASK_USER');
    expect(decision.question).toBe('Reason for Leaving');
  });

  it('does not ask about a dormant conditional child', () => {
    const parent = element({ kind: 'dropdown', required: true, policy: 'UNKNOWN_FACT' });
    const child = element({
      required: true,
      policy: 'UNKNOWN_FACT',
      label: 'If you have any relatives…',
      dependsOnElementId: parent.elementId,
      dependencyActive: false,
    });
    const decision = decide(observation({ elements: [child, parent], requiredOutstanding: 2 }));
    // The parent is asked about; the child is not a question the form is
    // currently asking, so it is not outstanding work.
    expect(decision.question).toBe(parent.label);
  });

  it('stops for review rather than pressing a submitting control', () => {
    const page = observation({
      navigation: [
        { elementId: 'nav1', label: 'Submit Application', finalSubmit: true, frameId: 0 },
      ],
    });
    expect(decide(page).kind).toBe('READY_FOR_REVIEW');
  });

  it('takes a step control once the step is settled', () => {
    const page = observation({
      navigation: [
        { elementId: 'nav1', label: 'Save and Continue', finalSubmit: false, frameId: 0 },
      ],
      requiredOutstanding: 0,
    });
    expect(decide(page).action?.tool).toBe('click_next');
  });
});

// ---------------------------------------------------------------------------
describe('the loop', () => {
  /** A page that answers one field and then has nothing left. */
  function host(overrides: Partial<AgentLoopHost> = {}): {
    host: AgentLoopHost;
    calls: AgentToolCall[];
    observations: number;
  } {
    const calls: AgentToolCall[] = [];
    const state = { filled: false, observations: 0 };
    const base: AgentLoopHost = {
      runId: 'run-1',
      buildId: 'test',
      observe: () => {
        state.observations += 1;
        return Promise.resolve(
          observation({
            observationId: `obs-${state.observations}`,
            elements: [
              {
                ...element({
                  elementId: 'e1',
                  label: 'First Name',
                  policy: 'KNOWN_FACT',
                  proposedValue: 'Robin',
                }),
                currentValue: state.filled ? 'Robin' : '',
              },
            ],
          }),
        );
      },
      execute: (call) => {
        calls.push(call);
        if (call.tool === 'type') state.filled = true;
        return Promise.resolve({
          tool: call.tool,
          executed: true,
          observedValue: 'Robin',
          options: [],
          optionsSeen: 0,
          pageChanged: true,
          reason: '',
          durationMs: 1,
        } satisfies ToolExecutionResult);
      },
      trustedValues: () => Promise.resolve(new Map([['e1', 'Robin']])),
      ...overrides,
    };
    return { host: base, calls, observations: state.observations };
  }

  it('observes again after every action', async () => {
    const { host: subject } = host();
    const outcome = await runAgentLoop(subject);
    // One before the first decision, one after the action, and one more for
    // the decision that ends the run.
    expect(outcome.trace.observationCount).toBeGreaterThan(outcome.trace.actionCount);
  });

  it('reaches READY_FOR_REVIEW and presses nothing that submits', async () => {
    const { host: subject } = host();
    const outcome = await runAgentLoop(subject);
    expect(outcome.status).toBe('READY_FOR_REVIEW');
    expect(outcome.trace.submitActionCount).toBe(0);
  });

  it('verifies against the page after the action, not the tool’s own word', async () => {
    // The tool claims success and the page does not change. The verifier reads
    // the page, so this must not be recorded as verified.
    const { host: subject } = host({
      observe: () =>
        Promise.resolve(
          observation({
            elements: [
              element({
                elementId: 'e1',
                label: 'First Name',
                policy: 'KNOWN_FACT',
                proposedValue: 'Robin',
              }),
            ],
          }),
        ),
    });
    const outcome = await runAgentLoop(subject);
    expect(outcome.trace.verifiedCount).toBe(0);
  });

  it('stops rather than repeating a failing action forever', async () => {
    const { host: subject, calls } = host({
      observe: () =>
        Promise.resolve(
          observation({
            elements: [
              element({
                elementId: 'e1',
                label: 'First Name',
                policy: 'KNOWN_FACT',
                proposedValue: 'Robin',
              }),
            ],
          }),
        ),
      execute: (call) =>
        Promise.resolve({
          tool: call.tool,
          executed: false,
          observedValue: '',
          options: [],
          optionsSeen: 0,
          pageChanged: false,
          reason: 'refused',
          errorCode: 'VALUE_NOT_VERIFIED',
          durationMs: 1,
        } satisfies ToolExecutionResult),
    });
    const outcome = await runAgentLoop(subject);
    // Bounded well below the budget: the history refuses a tool that has failed
    // on the same control three times, so the loop gives up on that field
    // instead of spending 150 actions on it.
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.length).toBeLessThan(AGENT_ACTION_BUDGET);
    // And it reaches a terminal state rather than spinning.
    expect(['READY_FOR_REVIEW', 'BLOCKED']).toContain(outcome.status);
    expect(outcome.trace.verifiedCount).toBe(0);
  });

  it('stops when the user cancels', async () => {
    const { host: subject } = host({ isCancelled: () => true });
    const outcome = await runAgentLoop(subject);
    expect(outcome.status).toBe('CANCELLED');
  });

  it('records a trace with no answer in it', async () => {
    const { host: subject } = host();
    const outcome = await runAgentLoop(subject);
    // The question wording is the employer's; the answer is the applicant's.
    expect(JSON.stringify(outcome.trace)).toContain('First Name');
    expect(JSON.stringify(outcome.trace)).not.toContain('Robin');
  });
});
