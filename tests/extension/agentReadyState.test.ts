import { afterEach, describe, expect, it } from 'vitest';
import {
  logicalFieldKey,
  observedElementSchema,
  pageObservationSchema,
  profileSchema,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import { classifyRequired, evaluateReady } from '../../extension/src/agent/agentReady.js';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import { AgentHistory } from '../../extension/src/agent/agentHistory.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { trustedValuesFor } from '../../extension/src/background/agentController.js';

/**
 * READY_FOR_REVIEW cannot coexist with unresolved required fields.
 *
 * ## The live failure
 *
 * Two consecutive real Lincoln Electric runs reported, in one object:
 *
 *     unresolvedRequired: 9   knownActionableRemaining: 0
 *     askUserRemaining: 0     ready: true
 *     status: READY_FOR_REVIEW
 *
 * over an application with nine blank required fields and five questions the
 * applicant had never seen. Two defects produced it, and both are held open by
 * the tests below:
 *
 *  1. `unresolvedRequired` was computed and **never referenced** by the `ready`
 *     conjunction — a display counter beside a boolean that did not read it.
 *  2. `askUserRemaining` subtracted every question the *agent had asked*, so
 *     asking five questions drove it to zero. The agent resolved its own
 *     questions by asking them.
 *
 * A third contradiction came from the same family: `resumeVerified: false`
 * beside `documentsPending: false`.
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

let handle = 0;
function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  handle += 1;
  return observedElementSchema.parse({
    elementId: `e${handle}`,
    label: `Field ${handle}`,
    kind: 'text',
    interactionType: 'TEXT_INPUT',
    policy: 'UNKNOWN_FACT',
    ...patch,
  });
}

function observation(elements: ObservedElement[]): PageObservation {
  return pageObservationSchema.parse({
    observationId: 'obs-ready',
    elements,
    requiredOutstanding: elements.filter((entry) => entry.required && !entry.currentValue).length,
  });
}

/** A required question nothing saved can answer. */
function question(label: string): ObservedElement {
  return element({ label, required: true, policy: 'UNKNOWN_FACT' });
}

/** A required field with a saved answer the page has refused. */
function blockedField(label: string): ObservedElement {
  return element({ label, required: true, policy: 'KNOWN_FACT', proposedValue: 'something' });
}

// ---------------------------------------------------------------------------
describe('MANDATORY REGRESSION: the exact live state', () => {
  /**
   * Nine unresolved required fields — five unanswered questions and four the
   * page refused — plus one required document outstanding. This is the run that
   * reported itself ready.
   */
  const LIVE = () => {
    const questions = ['Q1 *', 'Q2 *', 'Q3 *', 'Q4 *', 'Q5 *'].map(question);
    const blocked = ['B1 *', 'B2 *', 'B3 *', 'B4 *'].map(blockedField);
    return evaluateReady({
      observation: observation([...questions, ...blocked]),
      // Every one of the five has been asked. Under the old rule this drove
      // askUserRemaining to zero and readiness followed.
      askedQuestions: questions.map((entry) => entry.label),
      answeredQuestions: [],
      unresolvedByAgent: blocked.map((entry) => entry.label),
      documentsPending: true,
      requiredDocumentsPending: 1,
      finalSubmitReached: false,
    });
  };

  it('reports nine unresolved required fields', () => {
    expect(LIVE().unresolvedRequired).toBe(9);
  });

  it('reports five outstanding questions, not zero', () => {
    // The exact contradiction: five questions asked and none answered.
    expect(LIVE().askUserRemaining).toBe(5);
  });

  it('reports the four blocked fields separately', () => {
    expect(LIVE().blockedRequiredRemaining).toBe(4);
  });

  it('reports the required document as pending', () => {
    expect(LIVE().requiredDocumentsPending).toBe(1);
  });

  it('is NOT ready', () => {
    // The single assertion this whole task exists for.
    expect(LIVE().ready).toBe(false);
  });

  it('accounts for every unresolved required field in exactly one bucket', () => {
    // The invariant that makes a field unable to disappear: the buckets sum to
    // the total. Nine fields fell out of the accounting on the live run, and
    // this is what would have caught it.
    const evaluation = LIVE();
    expect(
      evaluation.knownActionableRemaining +
        evaluation.askUserRemaining +
        evaluation.blockedRequiredRemaining,
    ).toBe(evaluation.unresolvedRequired);
  });
});

// ---------------------------------------------------------------------------
describe('MANDATORY: unresolved required fields always block', () => {
  it('refuses readiness for a single blank required field', () => {
    const evaluation = evaluateReady({
      observation: observation([question('Anything *')]),
      askedQuestions: [],
      documentsPending: false,
      finalSubmitReached: false,
    });
    expect(evaluation.unresolvedRequired).toBe(1);
    expect(evaluation.ready).toBe(false);
  });

  it('cannot be ready while unresolvedRequired is above zero, whatever else is true', () => {
    // Asserted as a property across every combination the other counters can
    // take, because the live bug was precisely a `ready` that ignored this one.
    for (const asked of [[], ['Anything *']]) {
      for (const documentsPending of [false, true]) {
        const evaluation = evaluateReady({
          observation: observation([question('Anything *')]),
          askedQuestions: asked,
          documentsPending,
          finalSubmitReached: false,
        });
        expect(evaluation.unresolvedRequired).toBeGreaterThan(0);
        expect(evaluation.ready).toBe(false);
      }
    }
  });

  it('leaves optional blanks out of the blocking counts', () => {
    // An optional field the profile cannot answer is correctly left blank and
    // must never hold an application open.
    const evaluation = evaluateReady({
      observation: observation([element({ label: 'Optional', required: false })]),
      askedQuestions: [],
      documentsPending: false,
      finalSubmitReached: false,
    });
    expect(evaluation.unresolvedRequired).toBe(0);
    expect(evaluation.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('MANDATORY: the ask-user queue', () => {
  const FIVE = ['Q1 *', 'Q2 *', 'Q3 *', 'Q4 *', 'Q5 *'].map(question);

  const evaluate = (answered: string[]) =>
    evaluateReady({
      observation: observation(FIVE),
      askedQuestions: FIVE.map((entry) => entry.label),
      answeredQuestions: answered,
      documentsPending: false,
      finalSubmitReached: false,
    });

  it('starts at five outstanding', () => {
    expect(evaluate([]).askUserRemaining).toBe(5);
  });

  it('drops to four when one is answered', () => {
    expect(evaluate([logicalFieldKey(FIVE[0]!)]).askUserRemaining).toBe(4);
  });

  it('drops to zero only when all five are answered', () => {
    expect(evaluate(FIVE.map((entry) => logicalFieldKey(entry))).askUserRemaining).toBe(0);
  });

  it('never clears the queue as a side effect of answering one', () => {
    // The live shape of the bug was all five vanishing at once.
    const evaluation = evaluate([logicalFieldKey(FIVE[2]!)]);
    expect(evaluation.askUserRemaining).toBe(4);
    expect(evaluation.ready).toBe(false);
  });

  it('reports the explicit terminal-outcome counters in the final object', () => {
    const evaluation = evaluate([logicalFieldKey(FIVE[0]!)]);
    expect(evaluation.userInputRequired).toBe(4);
    expect(evaluation.userReviewRequired).toBe(1);
    expect(evaluation.blockedExecution).toBe(0);
    expect(evaluation.blockedDataMissing).toBe(0);
    expect(evaluation.readyForReview).toBe(false);
    expect(
      evaluation.userInputRequired +
        evaluation.userReviewRequired +
        evaluation.blockedExecution +
        evaluation.blockedDataMissing,
    ).toBe(evaluation.unresolvedRequired);
  });
});

// ---------------------------------------------------------------------------
describe('the history queue records answers, and only answers', () => {
  const step = (label: string) => ({
    step: 0,
    observationId: 'obs-1',
    observedElements: 1,
    requiredOutstanding: 1,
    decisionType: 'ASK_USER' as const,
    reason: '',
    targetLabel: label,
    targetSection: 'Profile',
    executed: false,
    wroteValue: false,
    optionsSeen: 0,
    pageChanged: false,
    verification: 'NOT_APPLICABLE' as const,
    durationMs: 0,
    decisionProvider: 'deterministic' as const,
  });

  function asked(history: AgentHistory, label: string): string {
    history.record(step(label), {
      kind: 'ASK_USER',
      reason: '',
      question: `Please answer ${label}`,
      elementId: 'e1',
    });
    return logicalFieldKey({ label, section: 'Profile' });
  }

  it('keeps a question outstanding after it is asked', () => {
    const history = new AgentHistory();
    asked(history, 'Q1 *');
    expect(history.unansweredQuestions()).toHaveLength(1);
    expect(history.answeredKeys()).toHaveLength(0);
  });

  it('removes one question per answer', () => {
    const history = new AgentHistory();
    const keys = ['Q1 *', 'Q2 *', 'Q3 *'].map((label) => asked(history, label));
    expect(history.unansweredQuestions()).toHaveLength(3);
    expect(history.recordAnswer(keys[0]!)).toBe(true);
    expect(history.unansweredQuestions()).toHaveLength(2);
    expect(history.answeredKeys()).toHaveLength(1);
  });

  it('will not answer the same question twice', () => {
    const history = new AgentHistory();
    const key = asked(history, 'Q1 *');
    expect(history.recordAnswer(key)).toBe(true);
    expect(history.recordAnswer(key)).toBe(false);
    expect(history.unansweredQuestions()).toHaveLength(0);
  });

  it('keeps every question in the exported list, answered or not', () => {
    const history = new AgentHistory();
    const keys = ['Q1 *', 'Q2 *'].map((label) => asked(history, label));
    history.recordAnswer(keys[0]!);
    expect(history.allQuestions()).toHaveLength(2);
    expect(history.allQuestions().filter((entry) => entry.answeredAt.length > 0)).toHaveLength(1);
  });

  it('does not queue the same control twice', () => {
    const history = new AgentHistory();
    asked(history, 'Q1 *');
    asked(history, 'Q1 *');
    expect(history.allQuestions()).toHaveLength(1);
  });

  it('reconciles exactly one user-entered page answer and leaves the rest pending', () => {
    const history = new AgentHistory();
    ['Q1 *', 'Q2 *', 'Q3 *', 'Q4 *', 'Q5 *'].forEach((label) => asked(history, label));
    const page = observation(
      ['Q1 *', 'Q2 *', 'Q3 *', 'Q4 *', 'Q5 *'].map((label, index) =>
        element({
          label,
          section: 'Profile',
          required: true,
          currentValue: index === 2 ? 'user-entered' : '',
        }),
      ),
    );

    expect(history.reconcileAnswers(page)).toBe(1);
    expect(history.unansweredQuestions()).toHaveLength(4);
    expect(history.answeredKeys()).toEqual([
      logicalFieldKey({ label: 'Q3 *', section: 'Profile' }),
    ]);
    expect(history.openQuestions()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
describe('every required field ends in exactly one terminal state', () => {
  const classify = (entry: ObservedElement, answered: string[] = [], exhausted: string[] = []) =>
    classifyRequired(entry, {
      answeredQuestions: new Set(answered),
      exhausted: new Set(exhausted.map((label) => label.toLowerCase().trim())),
    });

  it('names a filled field FILLED_VERIFIED', () => {
    expect(classify(element({ required: true, currentValue: 'Clifton' }))).toBe('FILLED_VERIFIED');
  });

  it('names an unanswerable blank USER_INPUT_REQUIRED', () => {
    expect(classify(question('Q *'))).toBe('USER_INPUT_REQUIRED');
  });

  it('names an answered blank USER_REVIEW_REQUIRED', () => {
    const entry = question('Q *');
    expect(classify(entry, [logicalFieldKey(entry)])).toBe('USER_REVIEW_REQUIRED');
  });

  it('names a dormant conditional child NOT_APPLICABLE', () => {
    const child = element({
      required: true,
      dependsOnElementId: 'e99',
      dependencyActive: false,
    });
    expect(classify(child)).toBe('NOT_APPLICABLE');
  });

  it('names a refused known answer BLOCKED_EXECUTION', () => {
    const entry = blockedField('B *');
    expect(classify(entry, [], [entry.label])).toBe('BLOCKED_EXECUTION');
  });

  it('names an unapplied known answer BLOCKED_DATA_MISSING', () => {
    expect(classify(blockedField('B *'))).toBe('BLOCKED_DATA_MISSING');
  });
});

// ---------------------------------------------------------------------------
describe('MANDATORY SUCCESS: readiness when everything really is done', () => {
  it('is ready only with every counter at zero', () => {
    const evaluation = evaluateReady({
      observation: observation([
        element({ label: 'City *', required: true, currentValue: 'Clifton' }),
        element({ label: 'Optional note', required: false }),
      ]),
      askedQuestions: [],
      answeredQuestions: [],
      documentsPending: false,
      requiredDocumentsPending: 0,
      finalSubmitReached: false,
    });
    expect(evaluation.unresolvedRequired).toBe(0);
    expect(evaluation.knownActionableRemaining).toBe(0);
    expect(evaluation.askUserRemaining).toBe(0);
    expect(evaluation.blockedRequiredRemaining).toBe(0);
    expect(evaluation.requiredDocumentsPending).toBe(0);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.readyForReview).toBe(true);
  });

  it('is refused by a required document alone', () => {
    const evaluation = evaluateReady({
      observation: observation([
        element({ label: 'City *', required: true, currentValue: 'Clifton' }),
      ]),
      askedQuestions: [],
      documentsPending: true,
      requiredDocumentsPending: 1,
      finalSubmitReached: false,
    });
    expect(evaluation.unresolvedRequired).toBe(0);
    expect(evaluation.ready).toBe(false);
  });

  it('is refused by a submit press alone', () => {
    const evaluation = evaluateReady({
      observation: observation([
        element({ label: 'City *', required: true, currentValue: 'Clifton' }),
      ]),
      askedQuestions: [],
      documentsPending: false,
      finalSubmitReached: true,
    });
    expect(evaluation.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the run status tells the truth about what it finished', () => {
  const PROFILE = profileSchema.parse({
    updatedAt: '2026-08-11T00:00:00.000Z',
    personal: {
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      address: { line1: '48 Maple Avenue', city: 'Clifton', country: 'United States' },
    },
  });

  async function run(html: string) {
    document.body.innerHTML = html;
    let latest = new Map<string, string>();
    const host: AgentLoopHost = {
      runId: 'run-ready-state',
      buildId: 'test',
      observe: async () => {
        const observed = await observePage();
        latest = trustedValuesFor(observed, PROFILE);
        return {
          ...observed,
          elements: observed.elements.map((entry) => {
            const value = latest.get(entry.elementId);
            if (!value) return entry;
            if (entry.policy === 'SENSITIVE' || entry.policy === 'LEGAL_ACKNOWLEDGMENT') {
              return entry;
            }
            return { ...entry, policy: 'KNOWN_FACT' as const, proposedValue: value };
          }),
        } satisfies PageObservation;
      },
      execute: (call) => executeAgentTool(call),
      trustedValues: () => Promise.resolve(latest),
    };
    return runAgentLoop(host);
  }

  it('INCOMPLETE: never returns READY_FOR_REVIEW with questions outstanding', async () => {
    const outcome = await run(`
      <form>
        <label for="city">City *</label>
        <input id="city" name="city" type="text" required />
        <label for="q1">Have you previously been employed by our Company? *</label>
        <input id="q1" name="q1" type="text" required />
        <label for="q2">Emergency contact name *</label>
        <input id="q2" name="q2" type="text" required />
      </form>`);
    expect(outcome.status).not.toBe('READY_FOR_REVIEW');
    expect(['WAITING_FOR_USER', 'READY_FOR_USER_REVIEW', 'BLOCKED']).toContain(outcome.status);
    expect(outcome.trace.finalReadyEvaluation?.ready).toBe(false);
    expect(outcome.trace.finalReadyEvaluation?.unresolvedRequired).toBeGreaterThan(0);
  }, 30000);

  it('INCOMPLETE: says why, and lists the questions', async () => {
    const outcome = await run(`
      <form>
        <label for="q1">Have you previously been employed by our Company? *</label>
        <input id="q1" name="q1" type="text" required />
        <label for="q2">Emergency contact name *</label>
        <input id="q2" name="q2" type="text" required />
      </form>`);
    expect(outcome.trace.statusReason).toBeDefined();
    expect(outcome.trace.pendingQuestions.length).toBeGreaterThan(0);
    // Asked, and none of them answered by the agent itself.
    expect(outcome.trace.pendingQuestions.every((entry) => entry.answeredAt === '')).toBe(true);
  }, 30000);

  it('INCOMPLETE: the summary explains what remains', async () => {
    const outcome = await run(`
      <form>
        <label for="city">City *</label>
        <input id="city" name="city" type="text" required />
        <label for="q1">Emergency contact name *</label>
        <input id="q1" name="q1" type="text" required />
      </form>`);
    expect(outcome.trace.summary).toBeDefined();
    expect(outcome.trace.summary?.headline).toContain('Agent completed');
    expect(outcome.trace.summary?.pendingUserQuestions).toBeGreaterThan(0);
    // Not the old sentence.
    expect(outcome.trace.summary?.headline).not.toBe('Application ready for review');
  }, 30000);

  it('COMPLETE: returns READY_FOR_REVIEW when the profile answers everything', async () => {
    const outcome = await run(`
      <form>
        <label for="firstName">First Name *</label>
        <input id="firstName" name="firstName" type="text" required />
        <label for="lastName">Last Name *</label>
        <input id="lastName" name="lastName" type="text" required />
        <label for="city">City *</label>
        <input id="city" name="city" type="text" required />
      </form>`);
    expect(outcome.status).toBe('READY_FOR_REVIEW');
    expect(outcome.trace.finalReadyEvaluation?.ready).toBe(true);
    expect(outcome.trace.finalReadyEvaluation?.unresolvedRequired).toBe(0);
    expect(outcome.trace.statusReason).toBeUndefined();
  }, 30000);

  it('SECOND RUN: a form already filled is ready without any actions', async () => {
    // The second live run took nine actions and verified none, over a page
    // whose fields were already filled by the first. Zero verified is not
    // automatically wrong there — but nine blank required fields still had to
    // block, and did not.
    const outcome = await run(`
      <form>
        <label for="firstName">First Name *</label>
        <input id="firstName" name="firstName" type="text" required value="Robin" />
        <label for="lastName">Last Name *</label>
        <input id="lastName" name="lastName" type="text" required value="Vale" />
        <label for="city">City *</label>
        <input id="city" name="city" type="text" required value="Clifton" />
      </form>`);
    expect(outcome.status).toBe('READY_FOR_REVIEW');
    expect(outcome.trace.actionCount).toBe(0);
    expect(outcome.trace.finalReadyEvaluation?.unresolvedRequired).toBe(0);
  }, 30000);

  it('SECOND RUN: a partly filled form still blocks on what is blank', async () => {
    const outcome = await run(`
      <form>
        <label for="firstName">First Name *</label>
        <input id="firstName" name="firstName" type="text" required value="Robin" />
        <label for="q1">Emergency contact name *</label>
        <input id="q1" name="q1" type="text" required />
      </form>`);
    expect(outcome.status).not.toBe('READY_FOR_REVIEW');
    expect(outcome.trace.finalReadyEvaluation?.unresolvedRequired).toBe(1);
  }, 30000);

  it('REGRESSION: verified accounting from the previous repair still works', async () => {
    // The previous repair took the first live run from `verified: 0` to
    // `verified: 6`. Nothing here may take that back.
    const outcome = await run(`
      <form>
        <label for="firstName">First Name *</label>
        <input id="firstName" name="firstName" type="text" required aria-describedby="h1" />
        <span id="h1">This field is required</span>
        <label for="lastName">Last Name *</label>
        <input id="lastName" name="lastName" type="text" required />
        <label for="city">City *</label>
        <input id="city" name="city" type="text" required />
      </form>`);
    expect(outcome.trace.actionCount).toBe(3);
    expect(outcome.trace.verifiedCount).toBe(3);
  }, 30000);
});

// ---------------------------------------------------------------------------
describe('document accounting matches what the page asks for', () => {
  it('counts a required, available, unattached document as pending', () => {
    const evaluation = evaluateReady({
      observation: observation([
        element({ label: 'City *', required: true, currentValue: 'Clifton' }),
      ]),
      askedQuestions: [],
      documentsPending: true,
      requiredDocumentsPending: 1,
      finalSubmitReached: false,
    });
    expect(evaluation.requiredDocumentsPending).toBe(1);
    expect(evaluation.ready).toBe(false);
  });

  it('does not let an optional document block readiness', () => {
    // An optional cover letter must never hold an application open.
    const evaluation = evaluateReady({
      observation: observation([
        element({ label: 'City *', required: true, currentValue: 'Clifton' }),
      ]),
      askedQuestions: [],
      documentsPending: false,
      requiredDocumentsPending: 0,
      finalSubmitReached: false,
    });
    expect(evaluation.ready).toBe(true);
  });
});
