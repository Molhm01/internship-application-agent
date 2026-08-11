import {
  agentReadyEvaluationSchema,
  type AgentReadyEvaluation,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';

/**
 * May this application be called ready for the applicant to review?
 *
 * Its own module, and its own record in the trace, because the previous answer
 * to this question was "whenever the decider runs out of ideas" — and on a real
 * Lincoln Electric run that produced:
 *
 *     status: READY_FOR_REVIEW
 *     observations: 1
 *     actions: 0
 *     verified: 0
 *
 * over a blank application. "Nothing left to do" and "I could not see anything
 * to do" are indistinguishable from inside a decider, and only one of them is a
 * finished application.
 *
 * So readiness is no longer something a decision *asserts*. It is a predicate
 * over the current observation, evaluated independently, and a decider that
 * says READY while this disagrees is overridden. The decider proposes; this
 * disposes.
 */

/** A control that is on screen, switched on, and not waiting on its parent. */
export function isLive(element: ObservedElement): boolean {
  if (!element.visible || element.disabled) return false;
  // A conditional child whose parent has not switched it on is not a question
  // the form is currently asking, so it is neither outstanding nor actionable.
  return !(element.dependsOnElementId !== undefined && element.dependencyActive !== true);
}

/** Holds nothing. A placeholder was already reduced to '' by the observer. */
export function isBlank(element: ObservedElement): boolean {
  return element.currentValue.trim().length === 0;
}

/**
 * A control the agent could act on right now.
 *
 * The definition the live bug turned on. A visible, enabled, blank control with
 * a trusted saved answer is actionable — Address, City, Postal Code, Phone, and
 * a State sitting on "No Selection" all qualify — and while any of them exists
 * the application is not ready, whatever a decider believes.
 */
export function isActionable(element: ObservedElement): boolean {
  if (!isLive(element) || !isBlank(element)) return false;
  return element.policy === 'KNOWN_FACT' && (element.proposedValue ?? '').trim().length > 0;
}

/**
 * A required question nothing saved can answer.
 *
 * Not actionable — there is nothing to write — but emphatically not *finished*
 * either. It has to reach the applicant as a question, and until it has, the
 * application is not ready.
 */
export function needsUser(element: ObservedElement): boolean {
  if (!isLive(element) || !isBlank(element) || !element.required) return false;
  return element.policy !== 'KNOWN_FACT';
}

export interface ReadyInput {
  observation: PageObservation;
  /** Questions already surfaced to the applicant, by label. */
  askedQuestions: readonly string[];
  /** True when a résumé or cover letter is available and still unattached. */
  documentsPending: boolean;
  /** True when the run has pressed something that submits. Must never be true. */
  finalSubmitReached: boolean;
  /** Controls the agent tried and could not settle, lower-cased labels. */
  unresolvedByAgent?: readonly string[];
}

/**
 * The nine conditions, evaluated over what the page currently shows.
 *
 * Every one of them is a *count from the observation* rather than a belief
 * carried forward, because the failure being prevented is exactly a belief that
 * outlived the evidence for it.
 */
export function evaluateReady(input: ReadyInput): AgentReadyEvaluation {
  const { observation } = input;
  const live = observation.elements.filter(isLive);

  const unresolvedRequired = live.filter((element) => element.required && isBlank(element)).length;
  // A control the agent has already tried and failed on is not pending work.
  // It is a blocked item the applicant has to finish, and counting it as
  // actionable would make readiness unreachable on any page holding one.
  //
  // A control the agent has *asked the applicant about* is finished in the same
  // sense, even though a saved answer exists for it. That is the Education Type
  // case: the list was opened, read, and offers nothing matching the saved
  // degree — so the applicant was asked, and there is nothing further the agent
  // can do. Counting it as pending would block readiness on a question already
  // surfaced.
  const givenUp = new Set(
    [...(input.unresolvedByAgent ?? []), ...input.askedQuestions].map((label) =>
      label.toLowerCase().trim(),
    ),
  );
  const stillActionable = live.filter(
    (element) => isActionable(element) && !givenUp.has(element.label.toLowerCase().trim()),
  );
  const knownActionableRemaining = stillActionable.length;
  const blockedRemaining = live.filter(
    (element) => isActionable(element) && givenUp.has(element.label.toLowerCase().trim()),
  ).length;
  // A question is outstanding until it has actually been put to the applicant.
  const askUserRemaining = live.filter(
    (element) => needsUser(element) && !input.askedQuestions.includes(element.label),
  ).length;

  const ready =
    knownActionableRemaining === 0 &&
    askUserRemaining === 0 &&
    !input.documentsPending &&
    !input.finalSubmitReached;

  return agentReadyEvaluationSchema.parse({
    unresolvedRequired,
    knownActionableRemaining,
    askUserRemaining,
    documentsPending: input.documentsPending,
    finalSubmitReached: input.finalSubmitReached,
    blockedRemaining,
    ready,
  });
}

/**
 * Why this application is not ready, in one sentence.
 *
 * Written for the trace and the popup, so a run that stops short says what it
 * is waiting for rather than leaving somebody to compare counters.
 */
export function describeNotReady(evaluation: AgentReadyEvaluation): string {
  if (evaluation.knownActionableRemaining > 0) {
    return `${evaluation.knownActionableRemaining} field(s) still have a saved answer that has not been applied.`;
  }
  if (evaluation.askUserRemaining > 0) {
    return `${evaluation.askUserRemaining} required question(s) have not been put to you yet.`;
  }
  if (evaluation.documentsPending) return 'A required document has not been attached yet.';
  if (evaluation.blockedRemaining > 0) {
    return `${evaluation.blockedRemaining} field(s) could not be filled and need you.`;
  }
  if (evaluation.finalSubmitReached) return 'The run reached a control that would submit.';
  return 'The application is ready for your review.';
}
