import {
  agentReadyEvaluationSchema,
  logicalFieldKey,
  type AgentFieldOutcome,
  type AgentReadyEvaluation,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';

/**
 * May this application be called ready for the applicant to review?
 *
 * ## The failure this was rewritten for
 *
 * A live Lincoln Electric run reported, in one object:
 *
 *     unresolvedRequired: 9   knownActionableRemaining: 0
 *     askUserRemaining: 0     ready: true
 *
 * over an application with nine blank required fields and five questions the
 * applicant had never seen. Two independent defects produced it, and both were
 * in this file.
 *
 * **`unresolvedRequired` was never consulted.** It was computed, returned, and
 * absent from the `ready` conjunction — a display counter sitting beside a
 * boolean that did not read it. Nine blank required fields therefore blocked
 * nothing.
 *
 * **Asking a question counted as resolving it.** `askUserRemaining` subtracted
 * every question in `askedQuestions`, and that list was filled by the *agent*
 * emitting an ASK_USER decision. So the agent resolved its own questions by
 * asking them: five questions asked, `askUserRemaining: 0`, readiness
 * satisfied, and the applicant told their application was ready. Only an
 * *answer* removes a question now.
 *
 * ## The rule
 *
 * Every required control finishes in exactly one terminal outcome, and the
 * counts are exhaustive over them:
 *
 *     unresolvedRequired
 *       = knownActionableRemaining + askUserRemaining + blockedRequiredRemaining
 *
 * `classifyRequired` is what makes that true, and a test asserts the
 * arithmetic. A required field cannot fall out of the accounting because there
 * is no category for it to fall into — which is precisely what nine of them did
 * on the live run.
 *
 * `ready` is the strict predicate: nothing outstanding, of any kind. "The agent
 * has done everything it safely can" is a *different* question, and it is
 * answered by the run status rather than by weakening this one.
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
 * A visible, enabled, blank control with a trusted saved answer — Address,
 * City, Postal Code, Phone, and a State sitting on "No Selection" all qualify —
 * and while any of them exists the application is not ready, whatever a decider
 * believes.
 */
export function isActionable(element: ObservedElement): boolean {
  if (!isLive(element) || !isBlank(element)) return false;
  return element.policy === 'KNOWN_FACT' && (element.proposedValue ?? '').trim().length > 0;
}

/**
 * A required question nothing saved can answer.
 *
 * Not actionable — there is nothing to write — but emphatically not *finished*
 * either. It has to reach the applicant as a question, and until they have
 * answered it, the application is not ready.
 */
export function needsUser(element: ObservedElement): boolean {
  if (!isLive(element) || !isBlank(element) || !element.required) return false;
  return element.policy !== 'KNOWN_FACT';
}

export interface ReadyInput {
  observation: PageObservation;
  /**
   * Questions the applicant has actually *answered*, by logical key.
   *
   * Not "questions the agent has asked". That distinction is the repair: the
   * previous input was the asked list, and subtracting it made asking a
   * question the same thing as resolving it.
   */
  answeredQuestions?: readonly string[];
  /**
   * Questions the agent has put to the applicant, by label.
   *
   * Used only to tell "asked and waiting" from "not yet asked" — both of which
   * block readiness. It can no longer remove anything from the accounting.
   */
  askedQuestions: readonly string[];
  /** True when a résumé or cover letter is available and still unattached. */
  documentsPending: boolean;
  /** How many *required* documents are available and not yet attached. */
  requiredDocumentsPending?: number;
  /** True when the run has pressed something that submits. Must never be true. */
  finalSubmitReached: boolean;
  /** Controls the agent tried and could not settle, lower-cased labels. */
  unresolvedByAgent?: readonly string[];
}

/**
 * The terminal state one required control ended in.
 *
 * Total over required controls by construction: every branch returns, and the
 * final branch is a real classification rather than a fallthrough. That
 * totality is the guarantee — a required field the agent cannot categorise
 * would previously have been counted nowhere and blocked nothing.
 */
export function classifyRequired(
  element: ObservedElement,
  input: {
    answeredQuestions: ReadonlySet<string>;
    exhausted: ReadonlySet<string>;
  },
): AgentFieldOutcome {
  if (!isLive(element)) return 'NOT_APPLICABLE';
  if (!isBlank(element)) return 'FILLED_VERIFIED';

  const answered = input.answeredQuestions.has(logicalFieldKey(element));
  if (answered) return 'USER_REVIEW_REQUIRED';

  // A saved answer exists and the control is still blank. Either the agent has
  // not got to it yet, or it tried and the page refused — and those are
  // different facts with different remedies.
  if (element.policy === 'KNOWN_FACT' && (element.proposedValue ?? '').trim().length > 0) {
    return input.exhausted.has(element.label.toLowerCase().trim())
      ? 'BLOCKED_EXECUTION'
      : 'BLOCKED_DATA_MISSING';
  }

  // Nothing saved answers it. A protected characteristic or an attestation is
  // the applicant's to state; so is any fact the profile does not hold.
  return 'USER_INPUT_REQUIRED';
}

/**
 * The verdict, evaluated over what the page currently shows.
 *
 * Every count is taken from the observation rather than carried forward,
 * because the failure being prevented is exactly a belief that outlived the
 * evidence for it.
 */
export function evaluateReady(input: ReadyInput): AgentReadyEvaluation {
  const { observation } = input;
  const live = observation.elements.filter(isLive);
  const answeredQuestions = new Set(input.answeredQuestions ?? []);
  const exhausted = new Set(
    (input.unresolvedByAgent ?? []).map((label) => label.toLowerCase().trim()),
  );

  const required = live.filter((element) => element.required);
  const unresolvedRequired = required.filter(isBlank).length;
  const verifiedRequired = required.filter((element) => !isBlank(element)).length;
  const optionalRemaining = live.filter(
    (element) => !element.required && isBlank(element) && isActionable(element),
  ).length;

  // ---- Every unresolved required field, in exactly one bucket. -------------
  //
  // The buckets sum to `unresolvedRequired`, and `agentReadyState.test.ts`
  // asserts that they do. A field that reached none of them would be a field
  // blocking nothing, which is the live bug.
  let knownActionableRemaining = 0;
  let askUserRemaining = 0;
  let blockedRequiredRemaining = 0;
  for (const element of required) {
    if (!isBlank(element)) continue;
    const outcome = classifyRequired(element, { answeredQuestions, exhausted });
    switch (outcome) {
      case 'BLOCKED_DATA_MISSING':
        // A saved answer the agent has not applied yet: still its work to do.
        knownActionableRemaining += 1;
        break;
      case 'BLOCKED_EXECUTION':
        blockedRequiredRemaining += 1;
        break;
      case 'USER_INPUT_REQUIRED':
        // Counted whether or not it has been *asked*. Asking is not answering,
        // and the previous version's subtraction of the asked list here is
        // what let five outstanding questions report as zero.
        askUserRemaining += 1;
        break;
      case 'USER_REVIEW_REQUIRED':
        // The applicant answered it; the value is theirs to enter. Not
        // outstanding agent work and not a blocker.
        break;
      default:
        break;
    }
  }

  // Optional actionable fields the agent has given up on are neither blocking
  // nor pending — they are simply blank, and reported as such.
  const blockedRemaining = live.filter(
    (element) => isActionable(element) && exhausted.has(element.label.toLowerCase().trim()),
  ).length;

  const requiredDocumentsPending = Math.max(0, input.requiredDocumentsPending ?? 0);

  // ---- The predicate. -----------------------------------------------------
  //
  // `unresolvedRequired === 0` leads, and it is the term whose absence caused
  // the live failure. The rest are not redundant with it: documents and the
  // submit guard are not fields, and the per-bucket counts are what make a
  // non-ready verdict *explainable* rather than merely negative.
  const ready =
    unresolvedRequired === 0 &&
    knownActionableRemaining === 0 &&
    askUserRemaining === 0 &&
    blockedRequiredRemaining === 0 &&
    requiredDocumentsPending === 0 &&
    // Kept alongside the count, not replaced by it. A host that supplies only
    // the old boolean — every test harness, and any caller not yet updated —
    // must still be able to block readiness with it. Dropping this in favour of
    // the count would have quietly removed a guarantee while adding one.
    !input.documentsPending &&
    !input.finalSubmitReached;

  return agentReadyEvaluationSchema.parse({
    unresolvedRequired,
    verifiedRequired,
    knownActionableRemaining,
    askUserRemaining,
    blockedRequiredRemaining,
    requiredDocumentsPending,
    optionalRemaining,
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
 * is waiting for rather than leaving somebody to compare counters. Ordered by
 * what the applicant should do first.
 */
export function describeNotReady(evaluation: AgentReadyEvaluation): string {
  if (evaluation.askUserRemaining > 0) {
    return `${evaluation.askUserRemaining} question(s) need your answer.`;
  }
  if (evaluation.knownActionableRemaining > 0) {
    return `${evaluation.knownActionableRemaining} field(s) still have a saved answer that has not been applied.`;
  }
  if (evaluation.blockedRequiredRemaining > 0) {
    return `${evaluation.blockedRequiredRemaining} required field(s) could not be completed and need you.`;
  }
  if (evaluation.requiredDocumentsPending > 0) {
    return `${evaluation.requiredDocumentsPending} required document(s) have not been attached yet.`;
  }
  if (evaluation.unresolvedRequired > 0) {
    return `${evaluation.unresolvedRequired} required field(s) are still blank.`;
  }
  if (evaluation.documentsPending) return 'A document is available and has not been attached yet.';
  if (evaluation.finalSubmitReached) return 'The run reached a control that would submit.';
  return 'The application is ready for your review.';
}
