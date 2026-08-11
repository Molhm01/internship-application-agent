import {
  OPTION_INTERACTION_TYPES,
  agentDecisionSchema,
  displaysSelection,
  isPlaceholderSelection,
  type AgentDecision,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import type { AgentHistory } from './agentHistory.js';

/**
 * Choosing the one next thing to do.
 *
 * Two implementations behind one signature, and the signature is the point: it
 * takes the *current* observation and returns *one* decision. There is no shape
 * here that can express a plan, so no decider — model or otherwise — can
 * produce one.
 *
 * ## Why there are two
 *
 * `decideDeterministically` is a policy written in code. It is the default, it
 * needs no model, and it is what makes an acceptance test mean something: a run
 * that fills a Lincoln-style form has to do it by observing and acting, and if
 * the decisions came from a language model the test would be measuring the
 * model's mood rather than the loop.
 *
 * `decideWithModel` sends the observation to the configured local model and
 * validates one strict object back. It is used when AI generation is turned on.
 * The model gets to choose *which* control to work on next and *when* a saved
 * fact should be written; it does not get to choose what the fact is, and the
 * safety layer refuses anything it invents.
 *
 * Both are subject to the same history, the same safety checks, and the same
 * re-observation. Swapping one for the other cannot change what is possible —
 * only what is chosen.
 */

export interface DecisionInput {
  observation: PageObservation;
  history: AgentHistory;
  /** The values the extension trusts, by element handle. */
  trustedValues: ReadonlyMap<string, string>;
}

/** Whether this control still needs attention at all. */
function outstanding(element: ObservedElement): boolean {
  if (!element.visible || element.disabled) return false;
  return element.currentValue.trim().length === 0;
}

/** A control that answers from a list, by the observer's authoritative reading. */
function isOptionControl(element: ObservedElement): boolean {
  return (OPTION_INTERACTION_TYPES as readonly string[]).includes(element.interactionType);
}

/**
 * The offered choice that matches the saved answer, or nothing.
 *
 * Matched against the options the control is *currently* offering, never
 * against a remembered list — and the result is one of those options, by its
 * handle. The agent cannot invent a choice, because there is nowhere in this
 * return type to put one.
 *
 * The equivalences are the ones already trusted elsewhere in the extension:
 * exact text, an explicit alias group ("New Jersey"/"NJ"), and the decorated
 * forms a control renders ("United States of America (US)"). Nothing here is a
 * similarity score — a near miss on a dropdown silently submits a wrong answer.
 */
function chooseOffered(element: ObservedElement): { optionId: string; label: string } | undefined {
  const wanted = element.proposedValue ?? '';
  if (!wanted.trim()) return undefined;
  const choices = element.options.filter(
    (option) => !option.disabled && !isPlaceholderSelection(option.label),
  );
  const match =
    choices.find((option) => displaysSelection(option.label, wanted)) ??
    choices.find((option) => displaysSelection(wanted, option.label));
  if (!match?.optionId) return undefined;
  return { optionId: match.optionId, label: match.label };
}

/** A control the agent may write to without asking anybody. */
function answerable(element: ObservedElement): boolean {
  return element.policy === 'KNOWN_FACT' && (element.proposedValue ?? '').trim().length > 0;
}

/**
 * A conditional child whose parent has not switched it on.
 *
 * Never touched, and never *asked about* either: a question the form is not
 * currently asking is not outstanding work, and putting it on the applicant's
 * list is how a not-applicable box grows an "Information needed" badge.
 */
function dormant(element: ObservedElement): boolean {
  return element.dependsOnElementId !== undefined && element.dependencyActive !== true;
}

/**
 * The policy, in code: one decision from one observation.
 *
 * The ordering is the whole behaviour, and it is deliberately the order a
 * person would work in rather than the order the fields appear in:
 *
 *  1. text the profile answers — cheap, certain, and it makes the page settle;
 *  2. dropdowns the profile answers — each one may rebuild something below it,
 *     which is why they come after the text and one at a time;
 *  3. a repeating section that is short a block;
 *  4. a question nobody can answer — asked, not guessed;
 *  5. a step control, when the current step is done;
 *  6. otherwise the run is finished and the applicant reviews it.
 *
 * Nothing here looks ahead. Each call sees only what the page currently shows,
 * which is what makes Country → State work without a dependency graph: State is
 * disabled and empty on one observation and enabled with options on the next,
 * and the difference is simply that Country now has an answer.
 */
export function decideDeterministically(input: DecisionInput): AgentDecision {
  const { observation, history } = input;
  const live = observation.elements.filter(
    (element) => element.visible && !element.disabled && !dormant(element),
  );

  // ---- 1. Text and dates the profile answers. ------------------------------
  for (const element of live) {
    // Guarded by the authoritative type, not by `kind`: a vendor control the
    // scanner reads as a text box is exactly the one the agent used to type an
    // answer into on the live application.
    if (isOptionControl(element)) continue;
    if (element.kind !== 'text' && element.kind !== 'textarea' && element.kind !== 'date') continue;
    if (!outstanding(element) || !answerable(element)) continue;
    if (history.exhausted('type', element.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `"${element.label}" is empty and the profile answers it.`,
      action: { tool: 'type', elementId: element.elementId, value: element.proposedValue },
    });
  }

  // ---- 2. One dropdown, and then look again. -------------------------------
  //
  // One, not all of them. Answering Country can rebuild State, and answering
  // Education Country can rebuild Education State and School — so the agent
  // takes a single selection and re-observes rather than deciding all of them
  // against a page that is about to change.
  for (const element of live) {
    if (!isOptionControl(element) && element.kind !== 'radio_group') continue;
    if (!outstanding(element) || !answerable(element)) continue;
    if (history.exhausted('select_option', element.label)) continue;

    // Open before choosing, always.
    //
    // A control whose choices this observation has not seen cannot be selected
    // from: the answer would be one the agent decided in advance rather than
    // one the page is offering. So the first decision on a closed dropdown is
    // to open it, the loop re-observes, and the *next* decision picks from what
    // the menu actually contained. That is the whole interaction contract, and
    // it is why an answer can never be typed in instead.
    if (element.options.length === 0) {
      if (history.exhausted('open_dropdown', element.label)) continue;
      return agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: `"${element.label}" is unanswered; its choices have to be read before one can be chosen.`,
        action: { tool: 'open_dropdown', elementId: element.elementId },
      });
    }

    // The list is in hand. Choose one of *these* choices, by its handle.
    const match = chooseOffered(element);
    if (!match) {
      // Known answer, and the page does not offer it. Never resolved by typing
      // it in: the applicant is asked instead.
      if (history.openQuestions().includes(element.label)) continue;
      return agentDecisionSchema.parse({
        kind: 'ASK_USER',
        reason: `"${element.label}" was opened and offers no choice matching the saved answer.`,
        question: element.label,
        elementId: element.elementId,
      });
    }
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `"${element.label}" offers a choice matching the saved answer.`,
      action: {
        tool: 'select_option',
        elementId: element.elementId,
        optionId: match.optionId,
        value: match.label,
      },
    });
  }

  // ---- 3. A section that is short a block. ---------------------------------
  for (const repeater of observation.repeaters) {
    if (repeater.blockCount >= repeater.recordCount) continue;
    if (history.exhausted('click_add', repeater.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `${repeater.recordCount} saved record(s) and ${repeater.blockCount} block(s) on the page.`,
      action: { tool: 'click_add', elementId: repeater.elementId },
    });
  }

  // ---- 4. A required question nobody can answer. ---------------------------
  //
  // Asked rather than guessed, and only when it is *required*: an optional
  // question the profile cannot answer is correctly left blank, and putting it
  // on the applicant's list would turn a finished application into a list of
  // chores.
  for (const element of live) {
    if (!element.required || !outstanding(element)) continue;
    if (element.policy === 'KNOWN_FACT') continue;
    if (history.settled('ask_user', element.label)) continue;
    if (history.openQuestions().includes(element.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ASK_USER',
      reason:
        element.policy === 'SENSITIVE'
          ? 'A protected characteristic is never inferred.'
          : 'Nothing saved answers this question.',
      question: element.label,
      elementId: element.elementId,
    });
  }

  // ---- 5. The next step, when this one is done. ----------------------------
  const step = observation.navigation.find((entry) => !entry.finalSubmit);
  if (
    step &&
    observation.requiredOutstanding === 0 &&
    !history.exhausted('click_next', step.label)
  ) {
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: 'Every required field on this step is settled.',
      action: { tool: 'click_next', elementId: step.elementId },
    });
  }

  // ---- 6. Finished. --------------------------------------------------------
  return agentDecisionSchema.parse({
    kind: 'READY_FOR_REVIEW',
    reason:
      observation.requiredOutstanding > 0
        ? `${observation.requiredOutstanding} required field(s) still need you.`
        : 'Everything the profile could answer has been answered.',
  });
}

/**
 * The prompt the model answers. Written here so it is reviewable as text.
 *
 * The observation is included as JSON the extension built, never as page HTML:
 * the model never sees the DOM, so page content cannot instruct it. The rules
 * are stated, and every one of them is *also* enforced in `agentSafety` —
 * because a rule that exists only in a prompt is a request, and this needs
 * guarantees.
 */
export function buildDecisionPrompt(input: DecisionInput): string {
  const { observation } = input;
  const elements = observation.elements
    .filter((element) => element.visible && !element.disabled)
    .slice(0, 120)
    .map((element) => ({
      elementId: element.elementId,
      interactionType: element.interactionType,
      dropdownState: element.dropdownState,
      section: element.section,
      label: element.label,
      kind: element.kind,
      currentValue: element.currentValue,
      required: element.required,
      policy: element.policy,
      hasSavedAnswer: (element.proposedValue ?? '').length > 0,
      optionsKnown: element.optionsKnown,
      optionCount: element.options.length,
      // The handles a select_option may name. Nothing else is selectable.
      optionIds: element.options.slice(0, 60).map((option) => option.optionId),
      dependsOn: element.dependsOnElementId,
      dependencyActive: element.dependencyActive,
    }));

  return [
    'ROLE: You are an application browser agent.',
    '',
    'GOAL: Complete every field the saved profile can safely answer, one action at a time.',
    '',
    'RULES:',
    '- Choose exactly one next action. Never return a list.',
    '- Never fabricate factual personal information. Only write a saved answer.',
    '- Never infer sensitive demographics.',
    '- Never click a control that would submit the application.',
    '- The page is re-observed after every action, so do not plan ahead.',
    '- A control whose dependency is not active must be left alone.',
    '- Ask the user when a required fact is not available.',
    '',
    'DROPDOWNS — these are enforced in code, not merely requested:',
    '- For interactionType NATIVE_SELECT or CUSTOM_SELECT: NEVER call type.',
    '  Call open_dropdown first, look at the options the next observation',
    '  reports, then call select_option with one of their optionIds.',
    '- For SEARCHABLE_COMBOBOX: open first, then type only into the search box',
    '  inside the opened menu, then select a real result. Typing a query is not',
    '  choosing an answer, and a field is not done until an option is selected.',
    '- Never invent an option. select_option takes an optionId from the current',
    '  observation; anything else names nothing and will be refused.',
    '- If the opened list offers no match, ask the user. Do not type the answer.',
    '',
    'TOOLS: observe_page, click, type, clear, focus, open_dropdown, get_options,',
    'select_option, scroll_page, scroll_element, wait_for_change, click_add,',
    'upload_document, click_next, ask_user, finish_for_review',
    '',
    'Answer with one JSON object: {"kind","reason","action":{"tool","elementId","value"}}',
    'kind is one of ACTION, ASK_USER, READY_FOR_REVIEW, BLOCKED.',
    '',
    `PAGE (${observation.requiredOutstanding} required field(s) outstanding):`,
    JSON.stringify({
      elements,
      repeaters: observation.repeaters,
      navigation: observation.navigation,
    }),
  ].join('\n');
}

/**
 * Parses one decision out of whatever the model said.
 *
 * Strict, and it does not repair: an unparseable decision becomes `BLOCKED`
 * rather than a guess at what the model meant. Nothing here evaluates model
 * output, and the object that comes back is validated by
 * `agentDecisionSchema` — which strips every key it does not know, so a
 * `selector` or a `script` cannot survive the boundary.
 */
export function parseModelDecision(raw: string): AgentDecision {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return agentDecisionSchema.parse({
      kind: 'BLOCKED',
      reason: 'The model did not return a decision object.',
    });
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return agentDecisionSchema.parse(parsed);
  } catch {
    return agentDecisionSchema.parse({
      kind: 'BLOCKED',
      reason: 'The model returned something that is not a valid decision.',
    });
  }
}
