import type { FieldOption } from '../schemas/fields.js';
import type { DropdownMatchMethod } from '../schemas/dropdownExecution.js';
import { allowsRegionSuffix, matchOption, normalizeOptionText } from './optionMatcher.js';
import { matchIntentToOption } from './semanticOptionResolver.js';
import { matchLocationOption, type LocationTarget } from './locationMatcher.js';
import { intentForBooleanAnswer, readBooleanAnswer } from './questionIntent.js';
import { DECLINE_PHRASINGS, isSelfDescribePhrasing, normalizeOptionLabel } from './synonyms.js';
import type { CanonicalQuestion } from '../constants/questions.js';

/**
 * Choosing one of the options a dropdown is *currently* offering.
 *
 * The rule this file enforces is that an option is never invented. Every layer
 * below narrows the list the page rendered; none of them can produce a label
 * that is not in it. That is the difference between "the engine picked Job
 * Board because the form offers no Internship Pilot" and hallucinating a choice
 * nobody could have clicked.
 *
 * Layers, in order, most literal first:
 *
 *   1. the page's own wording, or a documented spelling alias
 *   2. the intent behind a yes/no answer, read through the question
 *   3. semantic equivalence, scored only across the offered labels
 *   4. an explicit "Other" fallback, and only when the caller permits it
 *
 * A layer that finds several equally good candidates reports ambiguity rather
 * than picking one, at every level.
 */

export interface DropdownMatchInput {
  /** The answer the resolver settled on. Never a selector, never an index. */
  desiredSemanticValue: string;
  /** The choices read from the live control, disabled ones included. */
  options: readonly FieldOption[];
  /** The canonical intent of the question, when one was resolved. */
  canonicalQuestion?: string | undefined;
  /**
   * Permits falling back to "Other". Off by default: on a Country dropdown
   * "Other" is a wrong answer, and on an Area of Study dropdown that does not
   * list the degree it is the correct one. The caller knows which.
   */
  allowOtherFallback?: boolean;
  /**
   * Saved city, state, and country for a location control.
   *
   * Matched on all three together, never on the city alone: a location list
   * offering "Clifton, Colorado" and "Clifton, New Jersey" resolves a bare
   * "Clifton" to whichever came first, and the applicant is then applying from
   * the wrong state.
   */
  locationTarget?: LocationTarget | undefined;
}

export interface DropdownMatchOutcome {
  option?: FieldOption;
  method: DropdownMatchMethod;
  ambiguous: boolean;
  reason: string;
}

/**
 * Words that carry no meaning on their own in a dropdown label, so a "semantic"
 * overlap made of nothing but these is not evidence of anything. Without this,
 * "Bachelor of Science in Electrical Engineering" and "Bachelor of Science in
 * Nursing" overlap on four tokens and the wrong degree gets selected.
 */
const STOP_TOKENS = new Set([
  'of',
  'in',
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'my',
  'i',
  'is',
  'are',
  'was',
  'be',
  'have',
  'has',
  'other',
  'please',
  'specify',
  'select',
  'choose',
  'degree',
  'program',
  'study',
  'studies',
  'general',
]);

function tokensOf(value: string): Set<string> {
  return new Set(
    normalizeOptionText(value)
      .split(' ')
      .filter((token) => token.length > 1 && !STOP_TOKENS.has(token)),
  );
}

/** Options a person could actually pick right now. */
export function pickable(options: readonly FieldOption[]): FieldOption[] {
  return options.filter((option) => !option.disabled);
}

/** True when the label is a prompt rather than a choice. */
export function isPlaceholderLabel(label: string, value: string): boolean {
  const text = normalizeOptionText(label);
  if (value.trim() === '' && text.length === 0) return true;
  if (text.length === 0) return true;
  // A way of declining is a real answer, whatever verb it opens with.
  //
  // The prompt rule below matches anything starting "choose" or "select", and a
  // Greenhouse ethnicity list offers "Choose not to disclose" — which it threw
  // away as a prompt, leaving a control whose only permitted answer had been
  // filtered out of its own option list. The field then reported that no option
  // corresponded to "Decline to answer" while that option sat in the open menu,
  // and the one thing the agent is allowed to say about a protected question
  // became unsayable.
  if (
    DECLINE_PHRASINGS.some((phrase) => normalizeOptionLabel(phrase) === normalizeOptionLabel(label))
  ) {
    return false;
  }
  return (
    /^(please )?(select|choose|make a selection|no selection|pick)\b/.test(text) ||
    text === 'select' ||
    text === 'no selection' ||
    text === 'none selected' ||
    text === 'n a' ||
    text === '--'
  );
}

/** The offered choices with prompts, disabled entries, and headers removed. */
export function realChoices(options: readonly FieldOption[]): FieldOption[] {
  return pickable(options).filter((option) => !isPlaceholderLabel(option.label, option.value));
}

/**
 * How well one offered label expresses the desired answer, as a fraction of the
 * desired answer's own meaningful words. Deliberately asymmetric: "Job Board"
 * should score for a desired "Internship job board pilot", and a long label
 * should not be penalised for saying more than was asked.
 */
function overlapScore(desired: Set<string>, offered: Set<string>): number {
  if (desired.size === 0) return 0;
  let shared = 0;
  for (const token of desired) if (offered.has(token)) shared += 1;
  return shared / desired.size;
}

/** The minimum overlap that counts as evidence rather than coincidence. */
const SEMANTIC_THRESHOLD = 0.5;

/**
 * Semantic matching, scored only across the labels the page rendered.
 *
 * Returns nothing rather than a best guess when the leader is not clearly ahead
 * of the runner-up: on a dropdown of degrees, two options half a point apart are
 * two different degrees, and submitting either is a claim about the applicant's
 * education that the profile never made.
 */
export function matchSemanticOption(
  desiredSemanticValue: string,
  options: readonly FieldOption[],
): DropdownMatchOutcome {
  const desired = tokensOf(desiredSemanticValue);
  const choices = realChoices(options).filter((option) => !isSelfDescribePhrasing(option.label));
  if (desired.size === 0 || choices.length === 0) {
    return {
      method: 'none',
      ambiguous: false,
      reason: `No offered option is equivalent to "${desiredSemanticValue}".`,
    };
  }

  const scored = choices
    .map((option) => ({
      option,
      score: Math.max(
        overlapScore(desired, tokensOf(option.label)),
        overlapScore(desired, tokensOf(option.value)),
      ),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < SEMANTIC_THRESHOLD) {
    return {
      method: 'none',
      ambiguous: false,
      reason: `No offered option is defensibly equivalent to "${desiredSemanticValue}".`,
    };
  }
  if (runnerUp && runnerUp.score === best.score) {
    return {
      method: 'semantic',
      ambiguous: true,
      reason: `"${desiredSemanticValue}" describes "${best.option.label}" and "${runnerUp.option.label}" equally well.`,
    };
  }
  return {
    option: best.option,
    method: 'semantic',
    ambiguous: false,
    reason: `"${best.option.label}" is the closest option this form offers to "${desiredSemanticValue}".`,
  };
}

/** The page's own "Other" entry, when it has exactly one. */
export function otherOption(options: readonly FieldOption[]): FieldOption | undefined {
  const hits = pickable(options).filter((option) => {
    const label = normalizeOptionText(option.label);
    return label === 'other' || label === 'others' || label.startsWith('other ');
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The one entry point the dropdown engine uses.
 *
 * Runs the layers in order and stops at the first that produces a single
 * option. Never returns an option that is disabled, a placeholder, or absent
 * from `input.options`.
 */
export function matchDropdownOption(input: DropdownMatchInput): DropdownMatchOutcome {
  const desired = input.desiredSemanticValue.trim();
  if (desired.length === 0) {
    return { method: 'none', ambiguous: false, reason: 'No value was proposed for this control.' };
  }

  const choices = realChoices(input.options);
  if (choices.length === 0) {
    return {
      method: 'none',
      ambiguous: false,
      reason: 'The control offered no selectable choices.',
    };
  }

  // ---- 0. A place is matched on city, state, and country together ---------
  if (input.locationTarget?.city) {
    const located = matchLocationOption(input.locationTarget, choices);
    if (located.matched && located.option) {
      return {
        option: located.option,
        method: located.stateConfirmed ? 'literal' : 'region_suffix',
        ambiguous: false,
        reason: located.reason,
      };
    }
    return { method: 'none', ambiguous: located.ambiguous, reason: located.reason };
  }

  // ---- 1. Literal wording, then a documented spelling alias ---------------
  const literal = matchOption(desired, choices, {
    allowRegionSuffix: allowsRegionSuffix(input.canonicalQuestion),
  });
  if (literal.matched && literal.option) {
    return {
      option: literal.option,
      method:
        literal.matchKind === 'literal'
          ? 'literal'
          : literal.matchKind === 'region_suffix'
            ? 'region_suffix'
            : 'alias',
      ambiguous: false,
      reason: literal.reason,
    };
  }
  if (literal.ambiguous) {
    return { method: 'none', ambiguous: true, reason: literal.reason };
  }

  // ---- 2. The intent behind a yes/no, read through the question -----------
  // A saved "Yes" is worded as a sentence on half the forms that ask it ("I am
  // legally authorized to work"), and a literal "yes" matches none of them.
  const boolean = readBooleanAnswer(desired);
  if (boolean !== null && input.canonicalQuestion) {
    const intent = intentForBooleanAnswer(input.canonicalQuestion as CanonicalQuestion, boolean);
    const byIntent = matchIntentToOption(intent, choices);
    if (byIntent.option) {
      return {
        option: byIntent.option,
        method: 'alias',
        ambiguous: false,
        reason: `"${byIntent.option.label}" is this form's wording for "${desired}" on this question.`,
      };
    }
    if (byIntent.ambiguous) {
      return {
        method: 'none',
        ambiguous: true,
        reason: `Several options could express "${desired}" for this question.`,
      };
    }
  }

  // ---- 3. Semantic equivalence, across the offered labels only ------------
  const semantic = matchSemanticOption(desired, choices);
  if (semantic.option || semantic.ambiguous) return semantic;

  // ---- 4. The form's own escape hatch, only where it is the true answer ---
  if (input.allowOtherFallback) {
    const other = otherOption(choices);
    if (other) {
      return {
        option: other,
        method: 'other_fallback',
        ambiguous: false,
        reason: `This form does not list "${desired}", so its "${other.label}" option was chosen; the free-text box beside it carries the real answer.`,
      };
    }
  }

  return {
    method: 'none',
    ambiguous: false,
    reason: `No option this control offers corresponds to "${desired}".`,
  };
}
