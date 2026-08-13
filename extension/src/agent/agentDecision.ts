import {
  OPTION_INTERACTION_TYPES,
  agentDecisionSchema,
  applyDayConvention,
  dateQuestionFor,
  describeShape,
  formatNormalizedDate,
  normalizeStoredDate,
  type AgentDecision,
  type DayConvention,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import type { AgentHistory } from './agentHistory.js';
import { matchActualChoice, matchActualChoices } from './choiceMatcher.js';

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
  /**
   * What the applicant approved doing when a form wants a day their record does
   * not hold.
   *
   * Optional, and absent means `ask`. That default is deliberate rather than
   * merely tidy: a caller that forgets to pass the preference gets the
   * behaviour that stops and asks, never the behaviour that quietly writes the
   * first of the month into somebody's employment history.
   */
  dayConvention?: DayConvention;
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
  const match = matchActualChoice(element);
  return match.optionId && match.label
    ? { optionId: match.optionId, label: match.label }
    : undefined;
}

/** A control the agent may write to without asking anybody. */
function answerable(element: ObservedElement): boolean {
  return element.policy === 'KNOWN_FACT' && (element.proposedValue ?? '').trim().length > 0;
}

/** A saved value that positively states "yes". Silence is never one. */
function isAffirmative(value: string): boolean {
  return /^(yes|true|y|1|checked|current|currently)$/i.test(value.trim());
}

/**
 * What to do about one date control the profile has an answer for.
 *
 * Three outcomes, and which one happens turns entirely on whether the record
 * holds every part the control asked for:
 *
 *  - The record is precise enough → `set_date`, carrying the date as *parts*.
 *    The string is composed later, by the executor, against this control. That
 *    is the difference between the agent knowing a date and the agent knowing a
 *    date in the right format, and the live failure was the second one missing.
 *
 *  - The record is a month and a year, the control wants a day, and the
 *    applicant has stored a convention → `set_date` with that convention's day
 *    applied and marked as such. The day is theirs, given once, rather than
 *    chosen here.
 *
 *  - The record is a month and a year, the control wants a day, and no
 *    convention is stored → the applicant is asked. Not the first of the month.
 *    `07/01/2021` on an employment record is a claim about a start date, and it
 *    is not one anybody made.
 *
 * A current role is its own case: it has no end date to format, so the question
 * is left for the applicant while the loop goes on to tick whatever "I
 * currently work here" control the form offers.
 */
function decideDate(
  element: ObservedElement,
  convention: DayConvention,
  history: AgentHistory,
): AgentDecision | null {
  const shape = element.dateRequirement?.shape;
  const stored = normalizeStoredDate(element.proposedValue);
  if (shape === undefined || stored.precision === 'unknown') {
    // The control is a date box and nothing usable is saved for it. Handled by
    // the ask-the-applicant pass below rather than guessed at here.
    return null;
  }

  const formatted = formatNormalizedDate(stored, shape, convention);
  if (formatted.kind === 'value') {
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason:
        `"${element.label}" is empty, the profile records this date, and the control asks for ` +
        `${describeShape(shape)}.`,
      action: {
        tool: 'set_date',
        elementId: element.elementId,
        // Parts, never the rendered string. The executor renders it against
        // the live control, so a page that re-rendered the box into a different
        // format between this decision and its execution still receives a value
        // that control will accept.
        normalizedDate: formatted.usedConvention
          ? applyDayConvention(stored, formatted.usedConvention)
          : stored,
      },
    });
  }

  if (history.askedAbout(element)) return null;
  return agentDecisionSchema.parse({
    kind: 'ASK_USER',
    reason: formatted.reason.slice(0, 600),
    // The full question, not just the label: the applicant is told which
    // record, which date, what is already known, and what the employer asked
    // for — the four things somebody needs to answer without going and reading
    // the page themselves.
    question: dateQuestionFor({
      label: element.label,
      section: element.section,
      date: stored,
      shape,
    }),
    elementId: element.elementId,
    errorCode: formatted.code,
  });
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
 *  1. dates the profile answers — first, because a date is the one saved value
 *     whose representation has to be decided against the control, and letting
 *     one fall through to the text pass is what put `2021-07` into an
 *     `MM/DD/YYYY` box on a live application;
 *  2. text the profile answers — cheap, certain, and it makes the page settle;
 *  3. a checkbox the record positively states, such as "I currently work here";
 *  4. dropdowns the profile answers — each one may rebuild something below it,
 *     which is why they come after the text and one at a time;
 *  5. a repeating section that is short a block;
 *  6. a question nobody can answer — asked, not guessed;
 *  7. a step control, when the current step is done;
 *  8. otherwise the run is finished and the applicant reviews it.
 *
 * Nothing here looks ahead. Each call sees only what the page currently shows,
 * which is what makes Country → State work without a dependency graph: State is
 * disabled and empty on one observation and enabled with options on the next,
 * and the difference is simply that Country now has an answer.
 */
export function decideDeterministically(input: DecisionInput): AgentDecision {
  const { observation, history } = input;
  const dayConvention: DayConvention = input.dayConvention ?? 'ask';
  const live = observation.elements.filter(
    (element) => element.visible && !element.disabled && !dormant(element),
  );

  // ---- 1. Dates the profile answers, in the shape the control asked for. ----
  //
  // Before the text pass, and separate from it, because a date is the one saved
  // value whose *representation* has to be decided against the control. The
  // live failure was this branch not existing: a From Date box fell through to
  // the text pass, which wrote the profile's `2021-07` verbatim into a control
  // whose placeholder read `MM/DD/YYYY`, and the employer answered "Invalid
  // date."
  for (const element of live) {
    if (element.interactionType !== 'DATE_INPUT') continue;
    if (!outstanding(element) || !answerable(element)) continue;
    if (history.exhausted('set_date', element.label)) continue;
    // A control already put to the applicant is *finished* as far as this
    // decider is concerned, and this guard is load-bearing rather than a
    // shortcut.
    //
    // Some refusals do not come from here at all. Two saved dates that
    // contradict each other look perfectly fillable from this side — each is a
    // real date, precise enough for its control — and it is the safety layer,
    // which can see both, that turns the write into a question. Without this
    // line the decider proposed the same write on the next cycle, the safety
    // layer turned it into the same question again, and the run never ended.
    if (history.askedAbout(element)) continue;
    const decision = decideDate(element, dayConvention, history);
    if (decision) return decision;
  }

  // ---- 2. Text the profile answers. ----------------------------------------
  for (const element of live) {
    // Guarded by the authoritative type, not by `kind`: a vendor control the
    // scanner reads as a text box is exactly the one the agent used to type an
    // answer into on the live application. A date control is excluded for the
    // same reason — it is not a box that takes any string, it is a box that
    // takes one shape of string, and only `set_date` knows which.
    if (isOptionControl(element)) continue;
    if (element.interactionType === 'DATE_INPUT') continue;
    if (element.kind !== 'text' && element.kind !== 'textarea' && element.kind !== 'date') continue;
    if (!outstanding(element) || !answerable(element)) continue;
    if (history.exhausted('type', element.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `"${element.label}" is empty and the profile answers it.`,
      action: { tool: 'type', elementId: element.elementId, value: element.proposedValue },
    });
  }

  // ---- 2b. A "currently employed" box the record positively states. --------
  //
  // Placed here rather than left to the applicant because it is the *correct
  // answer to the End Date problem*. A role the record marks current has no end
  // date, and the honest way to say so on a form that offers "I currently work
  // here" is to tick it — not to write today's date, which is a claim the role
  // ended today.
  //
  // Only ever ticked on a positively saved affirmative. An absent value is the
  // applicant not having said, and an unticked box is already the right
  // rendering of that.
  for (const element of live) {
    if (element.interactionType !== 'SINGLE_CHECKBOX') continue;
    if (!outstanding(element) || !answerable(element)) continue;
    if (!isAffirmative(element.proposedValue ?? '')) continue;
    if (history.exhausted('click', element.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `"${element.label}" is stated by the saved record.`,
      action: { tool: 'set_checked', elementId: element.elementId, checked: true },
    });
  }

  // ---- 4. One dropdown, and then look again. -------------------------------
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
      const readTool =
        element.interactionType === 'RADIO_GROUP' || element.interactionType === 'CHECKBOX_GROUP'
          ? 'get_options'
          : 'open_dropdown';
      if (history.exhausted(readTool, element.label)) continue;
      return agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: `"${element.label}" is unanswered; its choices have to be read before one can be chosen.`,
        action: { tool: readTool, elementId: element.elementId },
      });
    }

    // The list is in hand. Choose one of *these* choices, by its handle.
    const multiMatches =
      element.interactionType === 'CHECKBOX_GROUP' ? matchActualChoices(element) : [];
    const match = element.interactionType === 'CHECKBOX_GROUP' ? multiMatches[0] : chooseOffered(element);
    if (!match) {
      // A searchable list that has not been searched yet.
      //
      // Its open menu shows only what it has chosen to render — often the first
      // few dozen rows of several thousand — so "the saved answer is not here"
      // is not yet true, it is only unproven. The query goes into the menu's own
      // search box, which the observer emits as a separate `TEXT_INPUT`; the
      // dropdown itself stays untypeable, and the field stays unanswered until a
      // real option is chosen from the narrowed list.
      const search = element.searchInputId;
      if (search !== undefined && element.dropdownState === 'OPEN') {
        const searchElement = live.find((candidate) => candidate.elementId === search);
        if (searchElement && !history.exhausted('type', searchElement.label)) {
          return agentDecisionSchema.parse({
            kind: 'ACTION',
            reason: `"${element.label}" offers a search box; narrowing the list before choosing.`,
            action: {
              tool: 'type',
              elementId: search,
              value: element.proposedValue,
            },
          });
        }
      }

      // Known answer, and the page does not offer it — including after the list
      // was searched. Never resolved by typing it into the control: the
      // applicant is asked instead.
      if (history.askedAbout(element)) continue;
      return agentDecisionSchema.parse({
        kind: 'ASK_USER',
        reason: `"${element.label}" was opened and offers no choice matching the saved answer.`,
        question: element.label,
        elementId: element.elementId,
        errorCode: 'DROPDOWN_TARGET_NOT_FOUND',
      });
    }
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `"${element.label}" offers a choice matching the saved answer.`,
      action: {
        tool: element.interactionType === 'CHECKBOX_GROUP' ? 'select_options' : 'select_option',
        elementId: element.elementId,
        ...(element.interactionType === 'CHECKBOX_GROUP'
          ? { optionIds: multiMatches.map((choice) => choice.optionId!) }
          : { optionId: match.optionId }),
      },
    });
  }

  // ---- 5. A section that is short a block. ---------------------------------
  for (const repeater of observation.repeaters) {
    if (repeater.blockCount >= repeater.recordCount) continue;
    if (history.exhausted('click_add', repeater.label)) continue;
    return agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: `${repeater.recordCount} saved record(s) and ${repeater.blockCount} block(s) on the page.`,
      action: { tool: 'click_add', elementId: repeater.elementId },
    });
  }

  // ---- 6. A required question nobody can answer. ---------------------------
  //
  // Asked rather than guessed, and only when it is *required*: an optional
  // question the profile cannot answer is correctly left blank, and putting it
  // on the applicant's list would turn a finished application into a list of
  // chores.
  for (const element of live) {
    if (!element.required || !outstanding(element)) continue;
    if (element.policy === 'KNOWN_FACT') continue;
    if (history.settled('ask_user', element.label)) continue;
    if (history.askedAbout(element)) continue;
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

  // ---- 7. The next step, when this one is done. ----------------------------
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

  // ---- 8. Finished. --------------------------------------------------------
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
      candidateContext:
        (element.proposedValue ?? '').length > 0
          ? { trustedAnswer: element.proposedValue }
          : { trustedAnswerAvailable: false },
      // The control's stated format, and how precisely the record knows this
      // date. Both are needed for the model to tell "write it" from "ask", and
      // neither reveals the date itself.
      ...(element.dateRequirement ? { dateRequirement: element.dateRequirement } : {}),
      ...(element.interactionType === 'DATE_INPUT'
        ? { savedDatePrecision: normalizeStoredDate(element.proposedValue).precision }
        : {}),
      optionsKnown: element.optionsKnown,
      optionCount: element.options.length,
      // The handles a select_option may name. Nothing else is selectable.
      choices: element.options.slice(0, 60).map((option) => ({
        optionId: option.optionId,
        label: option.label,
        disabled: option.disabled,
        selected: option.selected,
      })),
      // The only element a query may be typed into for this control.
      searchInputId: element.searchInputId,
      searchInputFor: element.searchInputFor,
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
    '- For interactionType NATIVE_SELECT, CUSTOM_SELECT, RADIO_GROUP, or CHECKBOX_GROUP: NEVER call type.',
    '  Call open_dropdown first, look at the options the next observation',
    '  reports, then call select_option with one of their optionIds.',
    '- For SEARCHABLE_COMBOBOX: open first. The opened menu reports its own',
    '  search box as a separate element, named by searchInputId. Type the query',
    '  into THAT elementId, never into the dropdown. Then select a real result.',
    '  Typing a query is not choosing an answer, and the field is not done until',
    '  an option is selected and verified.',
    '- dropdownState tells you where a control is: CLOSED (open it), OPEN (read',
    '  its options and choose), SEARCHING (a query is already narrowing it).',
    '- RADIO_GROUP uses get_options/select_option. CHECKBOX_GROUP uses get_options/select_options.',
    '- SINGLE_CHECKBOX uses set_checked or click.',
    '- Never invent an option. select_option takes an optionId from the current',
    '  observation; anything else names nothing and will be refused.',
    '- If the opened list offers no match, ask the user. Do not type the answer.',
    '',
    'DATES — also enforced in code, not merely requested:',
    '- For interactionType DATE_INPUT: NEVER call type. Call set_date.',
    '  A date control states a format (dateRequirement.shape) and rejects',
    '  anything else — typing a saved value verbatim is how "2021-07" reached an',
    '  MM/DD/YYYY box and came back as "Invalid date."',
    '- set_date takes normalizedDate: {year, month, day, precision}. The',
    '  extension renders the string against the control; you never format it.',
    '- Never supply a day the profile does not hold. If precision is "month" and',
    '  the control needs a day, use ask_user. Do not pick the 1st or the 15th.',
    '- Never write today’s date. A current role has no end date: tick the',
    '  form’s own "I currently work here" control instead.',
    '',
    'TOOLS: observe_page, click, type, set_date, clear, focus, open_dropdown,',
    'get_options, select_option, select_options, set_checked, scroll_page, scroll_element, wait_for_change,',
    'click_add, upload_document, click_next, ask_user, finish_for_review',
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
