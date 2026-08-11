import { describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  type ObservedElement,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import { evaluateReady, isActionable, needsUser } from '../../extension/src/agent/agentReady.js';

/**
 * The zero-action exit, and the rules that now forbid it.
 *
 * A real Lincoln Electric run reported READY_FOR_REVIEW after one observation
 * and no actions, over a blank application. Two separate defects produced that:
 * the observation was thrown away by a schema cap, and readiness was whatever
 * the decider happened to say when it ran out of ideas.
 *
 * The first is covered by `agentZeroAction.test.ts`. This covers the second: a
 * page with work left on it cannot be called ready, whoever says so.
 */

let handle = 0;
function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  handle += 1;
  return {
    elementId: `e${handle}`,
    section: '',
    label: `Field ${handle}`,
    kind: 'text',
    currentValue: '',
    required: false,
    disabled: false,
    visible: true,
    options: [],
    optionsKnown: false,
    policy: 'UNKNOWN_FACT',
    frameId: 0,
    ...patch,
  };
}

function observation(elements: ObservedElement[]): PageObservation {
  return {
    observationId: `obs-${handle}`,
    origin: 'https://career.lincolnelectric.example',
    title: 'Application',
    sections: [],
    elements,
    repeaters: [],
    navigation: [],
    requiredOutstanding: elements.filter(
      (entry) => entry.required && entry.currentValue.trim().length === 0,
    ).length,
    takenAt: '2026-08-11T00:00:00.000Z',
  };
}

/** The live Lincoln state: identity already filled, the rest blank. */
function lincolnObservation(): ObservedElement[] {
  return [
    element({
      label: 'First Name *',
      required: true,
      currentValue: 'Robin',
      policy: 'KNOWN_FACT',
      proposedValue: 'Robin',
    }),
    element({
      label: 'Last Name *',
      required: true,
      currentValue: 'Vale',
      policy: 'KNOWN_FACT',
      proposedValue: 'Vale',
    }),
    element({
      label: 'Email *',
      required: true,
      currentValue: 'r@example.com',
      policy: 'KNOWN_FACT',
      proposedValue: 'r@example.com',
    }),
    element({
      label: 'Country *',
      kind: 'dropdown',
      required: true,
      currentValue: 'United States',
      policy: 'KNOWN_FACT',
      proposedValue: 'United States',
    }),
    // Blank, and answerable.
    element({
      label: 'Street Address *',
      required: true,
      policy: 'KNOWN_FACT',
      proposedValue: '48 Maple Avenue',
    }),
    element({ label: 'City *', required: true, policy: 'KNOWN_FACT', proposedValue: 'Clifton' }),
    element({
      label: 'Zip/Postal Code *',
      required: true,
      policy: 'KNOWN_FACT',
      proposedValue: '07011',
    }),
    element({
      label: 'Phone *',
      required: true,
      policy: 'KNOWN_FACT',
      proposedValue: '+1 201 555 0134',
    }),
    // "No Selection" has already been reduced to '' by the observer.
    element({
      label: 'State/Province *',
      kind: 'dropdown',
      required: true,
      policy: 'KNOWN_FACT',
      proposedValue: 'New Jersey',
    }),
    // Nothing saved answers this one.
    element({
      label: 'Do you have any relatives employed by our Company? *',
      kind: 'dropdown',
      required: true,
    }),
  ];
}

// ---------------------------------------------------------------------------
describe('actionability, on the live Lincoln shape', () => {
  const page = observation(lincolnObservation());

  it.each(['Street Address *', 'City *', 'Zip/Postal Code *', 'Phone *'])(
    '%s is actionable: blank, visible, enabled, and the profile answers it',
    (label) => {
      const target = page.elements.find((entry) => entry.label === label)!;
      expect(isActionable(target)).toBe(true);
    },
  );

  it('a dropdown sitting on its placeholder is actionable', () => {
    const state = page.elements.find((entry) => entry.label === 'State/Province *')!;
    expect(isActionable(state)).toBe(true);
  });

  it('a control that already holds its answer is not actionable', () => {
    const first = page.elements.find((entry) => entry.label === 'First Name *')!;
    expect(isActionable(first)).toBe(false);
  });

  it('an unknown required question is a question, not a write', () => {
    const relatives = page.elements.find((entry) => /relatives/i.test(entry.label))!;
    expect(isActionable(relatives)).toBe(false);
    expect(needsUser(relatives)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the READY_FOR_REVIEW predicate', () => {
  const ready = (elements: ObservedElement[], patch = {}) =>
    evaluateReady({
      observation: observation(elements),
      askedQuestions: [],
      documentsPending: false,
      finalSubmitReached: false,
      ...patch,
    });

  it('refuses readiness while a saved answer is unapplied', () => {
    const evaluation = ready(lincolnObservation());
    expect(evaluation.ready).toBe(false);
    expect(evaluation.knownActionableRemaining).toBe(5);
    expect(evaluation.askUserRemaining).toBe(1);
  });

  it('refuses readiness while a required question has not been asked', () => {
    const evaluation = ready([
      element({ label: 'Relatives? *', kind: 'dropdown', required: true }),
    ]);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.askUserRemaining).toBe(1);
  });

  it('allows readiness once every question has been put to the applicant', () => {
    const relatives = element({ label: 'Relatives? *', kind: 'dropdown', required: true });
    const evaluation = evaluateReady({
      observation: observation([relatives]),
      askedQuestions: [relatives.label],
      documentsPending: false,
      finalSubmitReached: false,
    });
    expect(evaluation.ready).toBe(true);
  });

  it('refuses readiness while a document is available and unattached', () => {
    expect(ready([], { documentsPending: true }).ready).toBe(false);
    expect(ready([], { documentsPending: true }).documentsPending).toBe(true);
  });

  it('refuses readiness if anything submitted', () => {
    expect(ready([], { finalSubmitReached: true }).ready).toBe(false);
  });

  it('ignores a dormant conditional child', () => {
    const parent = element({ label: 'Relatives? *', kind: 'dropdown', required: true });
    const child = element({
      label: 'If you have any relatives currently employed, provide their full name…',
      kind: 'textarea',
      required: true,
      dependsOnElementId: parent.elementId,
      dependencyActive: false,
    });
    const evaluation = evaluateReady({
      observation: observation([parent, child]),
      askedQuestions: [parent.label],
      documentsPending: false,
      finalSubmitReached: false,
    });
    // The child is not a question the form is currently asking, so it neither
    // blocks readiness nor becomes a chore on the applicant's list.
    expect(evaluation.askUserRemaining).toBe(0);
    expect(evaluation.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the loop, against the live Lincoln shape', () => {
  /**
   * A page that actually changes when written to.
   *
   * The controls are built once and their *values* change, which is what a real
   * page does. Rebuilding them per observation would mint new handles each time
   * — which is also what the real observer does, but the real executor resolves
   * a handle through the live DOM, and a fake that cannot would make every
   * action fail for a reason that has nothing to do with the loop.
   */
  function host(overrides: Partial<AgentLoopHost> = {}): AgentLoopHost {
    const base = lincolnObservation();
    const values = new Map<string, string>();
    const build = (): PageObservation =>
      observation(
        base.map((entry) =>
          values.has(entry.elementId)
            ? { ...entry, currentValue: values.get(entry.elementId)! }
            : entry,
        ),
      );
    return {
      runId: 'run-lincoln',
      buildId: 'test',
      observe: () => Promise.resolve(build()),
      execute: (call) => {
        if (call.elementId && call.value) values.set(call.elementId, call.value);
        return Promise.resolve({
          tool: call.tool,
          executed: true,
          observedValue: call.value ?? '',
          options: [],
          pageChanged: true,
          reason: '',
          durationMs: 1,
        } satisfies ToolExecutionResult);
      },
      trustedValues: (page) =>
        Promise.resolve(
          new Map(
            page.elements
              .filter((entry) => entry.proposedValue)
              .map((entry) => [entry.elementId, entry.proposedValue!]),
          ),
        ),
      ...overrides,
    };
  }

  it('takes a real first action rather than exiting', async () => {
    const outcome = await runAgentLoop(host());
    expect(outcome.trace.observationCount).toBeGreaterThanOrEqual(2);
    expect(outcome.trace.actionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.trace.verifiedCount).toBeGreaterThanOrEqual(1);
  });

  it('reports what it could see and act on from the first observation', async () => {
    const outcome = await runAgentLoop(host());
    // The counts that make a zero-action run diagnosable.
    expect(outcome.trace.observedFieldsInitial).toBe(10);
    expect(outcome.trace.actionableFieldsInitial).toBe(5);
    expect(outcome.trace.askUserFieldsInitial).toBe(1);
  });

  it('applies every saved answer and asks about the rest', async () => {
    const outcome = await runAgentLoop(host());
    expect(outcome.trace.actionCount).toBeGreaterThanOrEqual(5);
    expect(outcome.trace.questionsAsked).toBeGreaterThanOrEqual(1);
    expect(outcome.trace.finalReadyEvaluation?.knownActionableRemaining).toBe(0);
  });

  it('records that a decision provider was called', async () => {
    const outcome = await runAgentLoop(host());
    expect(outcome.trace.decisionProviderCalled).toBe(true);
    expect(outcome.trace.decider).toBe('deterministic');
  });

  it('emits the markers a live console needs', async () => {
    const outcome = await runAgentLoop(host());
    const emitted = new Set(outcome.trace.markers.map((entry) => entry.marker));
    for (const marker of [
      'AGENT_RUN_STARTED',
      'AGENT_OBSERVATION_CREATED',
      'AGENT_DECISION_REQUEST_STARTED',
      'AGENT_DECISION_REQUEST_FINISHED',
      'AGENT_DECISION_PARSED',
      'AGENT_ACTION_SELECTED',
      'AGENT_ACTION_EXECUTION_STARTED',
      'AGENT_ACTION_EXECUTION_FINISHED',
      'AGENT_VERIFICATION_FINISHED',
      'AGENT_READY_EVALUATION',
    ]) {
      expect(emitted, `marker ${marker} was never emitted`).toContain(marker);
    }
  });

  it('overrides a decider that claims READY while work remains', async () => {
    // The exact live failure, forced: a decider that says "ready" on the first
    // observation of a blank application.
    let asked = 0;
    const outcome = await runAgentLoop(
      host({
        decide: () => {
          asked += 1;
          return Promise.resolve(
            agentDecisionSchema.parse({ kind: 'READY_FOR_REVIEW', reason: 'looks done to me' }),
          );
        },
      }),
    );
    expect(asked).toBeGreaterThan(0);
    // Refused: the page had five unapplied saved answers.
    expect(outcome.trace.actionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.status).not.toBe('READY_FOR_REVIEW');
  });

  it('never turns a failed decision into a finished application', async () => {
    const outcome = await runAgentLoop(
      host({ decide: () => Promise.reject(new Error('fetch failed: model unavailable')) }),
    );
    expect(outcome.status).toBe('FAILED');
    expect(outcome.trace.failureCode).toBe('AGENT_MODEL_UNAVAILABLE');
    expect(outcome.trace.actionCount).toBe(0);
  });

  it.each([
    ['request timed out', 'AGENT_DECISION_TIMEOUT'],
    ['invalid schema in response', 'AGENT_INVALID_DECISION'],
    ['something else went wrong', 'AGENT_DECISION_FAILED'],
  ])('reports %j as %s rather than ready', async (message, code) => {
    const outcome = await runAgentLoop(host({ decide: () => Promise.reject(new Error(message)) }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.trace.failureCode).toBe(code);
  });
});
