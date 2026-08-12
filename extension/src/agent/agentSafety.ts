import {
  AGENT_TOOLS,
  MUTATING_TOOLS,
  OPTION_INTERACTION_TYPES,
  agentDecisionSchema,
  type AgentDecision,
  type AgentTool,
  type AgentToolCall,
  type ErrorCode,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';

/**
 * Everything the agent is not allowed to do, enforced between the decision and
 * the page.
 *
 * The model is untrusted. Not because it is malicious, but because a decision
 * is a *claim* about a page — "element e42 is the State control" — and a claim
 * is only as good as the observation it was made against. By the time a
 * decision comes back the page may have moved on, and the model has no way to
 * know that. So every decision is re-checked here, against the observation it
 * was actually made from, before anything touches the DOM.
 *
 * This layer is also the last word on the two things that must never happen:
 * the final Submit is never pressed, and a factual answer is never invented.
 */

export interface SafetyVerdict {
  allowed: boolean;
  /**
   * Why it was refused, as a code the history and the trace can both key on.
   *
   * Named rather than free text so a rejected action is a *fact about the run*
   * — countable, testable, and reportable — rather than a sentence somebody has
   * to read.
   */
  code?: ErrorCode;
  /** What to do instead, told to the next decision cycle. */
  suggestedTool?: AgentTool;
  /** Why it was refused, in words the trace and the popup can both use. */
  reason: string;
  /** The decision to run instead, when refusing implies one. */
  replacement?: AgentDecision;
}

const ALLOWED = new Set<string>(AGENT_TOOLS);

/**
 * Whether this decision may be executed against this observation.
 *
 * Checked in order of severity, so the *reason* a decision was refused is the
 * most serious thing wrong with it rather than whichever check ran first.
 */
export function checkDecision(
  decision: AgentDecision,
  observation: PageObservation,
  trustedValues: ReadonlyMap<string, string>,
): SafetyVerdict {
  if (decision.kind !== 'ACTION') return { allowed: true, reason: '' };
  const action = decision.action;
  if (!action)
    return { allowed: false, reason: 'The decision claimed an action and carried none.' };

  // ---- 1. The tool must exist. ---------------------------------------------
  //
  // `agentToolSchema` already refused anything else at the parse boundary; this
  // is the second reading, because a tool name arriving from a model is exactly
  // the kind of value that must not be trusted on one check alone.
  if (!ALLOWED.has(action.tool)) {
    return { allowed: false, reason: `"${action.tool}" is not a tool this agent has.` };
  }

  // ---- 2. Nothing that looks like code or a selector. -----------------------
  //
  // The schema strips unknown keys, so a model cannot smuggle `script` or
  // `selector` through as a field. This catches the other shape of the same
  // attempt: a *value* that is really an instruction. A form value never needs
  // to contain a script tag or a javascript: URL, so one that does is refused
  // rather than typed into somebody's application.
  const suspicious = /<script|javascript:|on\w+\s*=|\bfunction\s*\(|=>/i;
  if (action.value && suspicious.test(action.value)) {
    return { allowed: false, reason: 'That value looks like code rather than an answer.' };
  }

  // ---- 3. The target must come from *this* observation. ---------------------
  //
  // The mechanism that makes stale references impossible. A handle from an
  // earlier observation names nothing here, so a decision made against a page
  // that has since re-rendered is refused instead of executed against whatever
  // now occupies that position.
  const needsTarget = action.tool !== 'scroll_page' && action.tool !== 'observe_page';
  const element = action.elementId ? findElement(observation, action.elementId) : undefined;
  const navigation = action.elementId
    ? observation.navigation.find((entry) => entry.elementId === action.elementId)
    : undefined;
  const repeater = action.elementId
    ? observation.repeaters.find((entry) => entry.elementId === action.elementId)
    : undefined;
  if (needsTarget && action.elementId && !element && !navigation && !repeater) {
    return {
      allowed: false,
      reason: 'That element is not in the current observation, so it may no longer exist.',
    };
  }

  // ---- 4. The final Submit is never pressed. --------------------------------
  //
  // Permanent, and deliberately not a judgement the model participates in. The
  // observer marks a control `finalSubmit` when its wording says so *or when
  // nothing identifies it as a step control* — an unrecognised button is
  // treated as a submit. The two mistakes are not symmetric: refusing a "Next"
  // costs a paused run, and pressing a "Submit Application" sends an
  // incomplete application to an employer under the applicant's name.
  if (navigation?.finalSubmit) {
    return {
      allowed: false,
      reason: `"${navigation.label}" would submit the application, so the agent stopped instead.`,
      replacement: agentDecisionSchema.parse({
        kind: 'READY_FOR_REVIEW',
        reason: 'The next control submits the application. That is yours to press.',
      }),
    };
  }
  if (action.tool === 'click_next' && !navigation) {
    return { allowed: false, reason: 'That is not a navigation control this page offered.' };
  }

  // ---- 4a. A control is operated the way its type permits. ------------------
  //
  // The rule this whole layer exists for now. On a live application the agent
  // called `type` on a dropdown: the control kept its placeholder, nothing was
  // selected, and the run believed the field was answered. No prompt wording
  // prevents that — the decision was reasonable given what the decider had been
  // told the control was — so it is refused here, in code, against a type the
  // *observer* computed from the live element.
  //
  // A searchable combobox is refused too. Its search box takes characters and
  // the control does not, and a run that treated typing a query as choosing an
  // answer would leave the field unanswered while reporting success.
  if (element && action.tool === 'type') {
    if ((OPTION_INTERACTION_TYPES as readonly string[]).includes(element.interactionType)) {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        suggestedTool: element.dropdownState === 'OPEN' ? 'select_option' : 'open_dropdown',
        reason: `"${element.label}" answers from a list, so it cannot be typed into. Open it and choose one of the choices it offers.`,
      };
    }
  }

  // ---- 4b. The search box inside an open menu. ------------------------------
  //
  // The one place a query may be typed, and it is a real control rather than an
  // exception: the observer only emits it while the menu is genuinely open, and
  // it is typed as `TEXT_INPUT` because that is what it is.
  //
  // What is checked here is that the query comes from the answer being looked
  // for. `typeSearchNarrowing` shortens a saved value — "Clifton, New Jersey,
  // United States" becomes "Clifton" — so a prefix or a word of the owner's
  // trusted answer is accepted, and anything else is a string the model made up
  // to see what came back.
  if (element?.searchInputFor !== undefined && action.tool === 'type') {
    const owner = findElement(observation, element.searchInputFor);
    if (!owner) {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        reason: 'That search box belongs to a dropdown this observation no longer shows.',
      };
    }
    if (owner.dropdownState === 'CLOSED') {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        suggestedTool: 'open_dropdown',
        reason: `"${owner.label}" is not open, so there is nothing to search.`,
      };
    }
    const intended = trustedValues.get(owner.elementId) ?? owner.proposedValue ?? '';
    const query = (action.value ?? '').trim();
    if (query.length > 0 && intended.trim().length > 0 && !isNarrowingOf(query, intended)) {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        reason: `That search text is not part of the saved answer for "${owner.label}".`,
      };
    }
    // Deliberately falls through to nothing else. A query is not an answer, so
    // none of the value-bearing rules below apply to it — and, just as
    // deliberately, typing it does not make the owner answered. Only a verified
    // `select_option` does that.
    return { allowed: true, reason: '' };
  }

  // Choosing requires the list to have been read. A control whose options this
  // observation has never seen cannot be selected from, because the choice
  // would be one the agent imagined rather than one the page offered.
  if (element && action.tool === 'select_option') {
    if (element.options.length === 0) {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        suggestedTool: 'open_dropdown',
        reason: `"${element.label}" has not been opened yet, so its choices are not known.`,
      };
    }
    // Named by a handle this observation minted, when one was given. A handle
    // from an earlier observation, or an invented one, names nothing.
    if (action.optionId && !element.options.some((option) => option.optionId === action.optionId)) {
      return {
        allowed: false,
        code: 'OPTION_HANDLE_UNKNOWN',
        reason: `That choice is not one "${element.label}" is currently offering.`,
      };
    }
  }

  // Opening is only meaningful for something that opens.
  if (element && action.tool === 'open_dropdown') {
    if (!(OPTION_INTERACTION_TYPES as readonly string[]).includes(element.interactionType)) {
      return {
        allowed: false,
        code: 'WRONG_TOOL_FOR_CONTROL_TYPE',
        suggestedTool: 'type',
        reason: `"${element.label}" is not a list control, so there is nothing to open.`,
      };
    }
  }

  // ---- 5. Sensitive questions are never answered by the agent. --------------
  if (element && MUTATING_TOOLS.includes(action.tool)) {
    if (element.policy === 'SENSITIVE') {
      return {
        allowed: false,
        reason: `"${element.label}" is a protected characteristic. Only you may answer it.`,
      };
    }
    if (element.policy === 'LEGAL_ACKNOWLEDGMENT') {
      return {
        allowed: false,
        reason: `"${element.label}" is a legal attestation. Only you may make it.`,
      };
    }
  }

  // ---- 6. A conditional child stays untouched until its parent says so. -----
  //
  // The relatives box. The parent question — "Do you have any relatives …
  // employed by our Company?" — is unanswered, so the box below it is not a
  // question about the applicant yet, and writing anything into it states
  // something nobody said.
  if (element && MUTATING_TOOLS.includes(action.tool) && element.dependsOnElementId) {
    if (element.dependencyActive !== true) {
      const parent = findElement(observation, element.dependsOnElementId);
      return {
        allowed: false,
        reason: `"${element.label}" only applies once "${parent?.label ?? 'the question above it'}" is answered, and it is not.`,
      };
    }
  }

  // ---- 7. A factual answer must be one the extension already trusted. -------
  //
  // The model may decide *when* to write a saved fact. It may not decide *what*
  // the fact is. `trustedValues` is built by the extension from the profile and
  // from what the control is currently offering, so a value the model invented
  // — a plausible-looking employment type, somebody's name — matches nothing
  // and is refused.
  //
  // `SUBJECTIVE` controls are exempt: free prose is the one place a model is
  // allowed to compose rather than restate, and it is grounded elsewhere.
  if (element && element.policy === 'KNOWN_FACT' && isValueBearing(action)) {
    const trusted = trustedValues.get(element.elementId);
    const offered = element.options.map((option) => option.label);
    const value = action.value ?? '';
    const acceptable =
      (trusted !== undefined && sameAnswer(value, trusted)) ||
      offered.some((option) => sameAnswer(option, value));
    if (!acceptable) {
      return {
        allowed: false,
        reason: `"${element.label}" would have been answered with something the profile does not contain.`,
      };
    }
  }
  if (element && element.policy === 'UNKNOWN_FACT' && isValueBearing(action)) {
    return {
      allowed: false,
      reason: `Nothing saved answers "${element.label}", so the agent must ask rather than write.`,
      replacement: agentDecisionSchema.parse({
        kind: 'ASK_USER',
        reason: 'No saved fact answers this question.',
        question: element.label,
        elementId: element.elementId,
      }),
    };
  }

  // ---- 8. Add is pressed only when a saved record needs a block. ------------
  if (action.tool === 'click_add') {
    if (!repeater)
      return { allowed: false, reason: 'That is not an Add control this page offered.' };
    if (repeater.blockCount >= repeater.recordCount) {
      return {
        allowed: false,
        reason: `The page already has ${repeater.blockCount} block(s) for ${repeater.recordCount} saved record(s), so Add would create an empty one.`,
      };
    }
  }

  return { allowed: true, reason: '' };
}

/** Whether this call writes a value the applicant would be stating as fact. */
function isValueBearing(action: AgentToolCall): boolean {
  return (
    (action.tool === 'type' || action.tool === 'select_option') &&
    (action.value ?? '').trim().length > 0
  );
}

/**
 * Whether a search query is drawn from the answer being searched for.
 *
 * Accepts the whole value, any leading part of it, and any single word in it —
 * the three shapes `searchQueriesFor` produces when it shortens a saved value
 * to something a filtered list will actually match. Rejects anything that
 * introduces text the saved answer does not contain.
 */
function isNarrowingOf(query: string, intended: string): boolean {
  const reduce = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const q = reduce(query);
  const source = reduce(intended);
  if (!q || !source) return false;
  if (source.startsWith(q)) return true;
  const words = new Set(source.split(' '));
  return q.split(' ').every((word) => words.has(word));
}

/** Loose comparison, so "New Jersey" and "new jersey" are the same answer. */
function sameAnswer(left: string, right: string): boolean {
  const reduce = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const a = reduce(left);
  const b = reduce(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findElement(observation: PageObservation, handle: string): ObservedElement | undefined {
  return observation.elements.find((element) => element.elementId === handle);
}
