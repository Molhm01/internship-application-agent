import {
  aliasesMatch,
  matchDropdownOption,
  normalizeOptionText,
  type CollectedOption,
  type DropdownDirective,
  type DropdownMatchMethod,
  type FieldOption,
} from '@internship-agent/shared';

/**
 * Choosing which of the offered choices expresses the intended answer.
 *
 * Two facts arrive here and neither is negotiable: what the applicant's saved
 * record says, and what the control is actually offering. The only judgement is
 * the correspondence between them, and it is made in a fixed order of
 * decreasing certainty — the page's own wording, then an exact underlying
 * value, then a documented alias, then a scored semantic reading. A layer that
 * finds two equally good candidates reports ambiguity rather than picking one.
 *
 * ## What it may not do
 *
 * It may not change what the answer *means*. "Freelance" may reach an option
 * labelled "Self-Employed", because those are two names for one arrangement.
 * It may not reach "Contractor", because a form offering both is asking a
 * distinction the applicant answered differently. That line is drawn in the
 * alias table, deliberately, where it can be read and argued with — not here in
 * a scoring function where it would be a threshold nobody can inspect.
 */

/** How the chosen option was tied to the answer, and why. */
export interface DropdownMatchResult {
  option?: CollectedOption;
  method: DropdownMatchMethod;
  ambiguous: boolean;
  reason: string;
  /** Which of the directive's wordings matched, for the diagnostic. */
  matchedCandidate?: string;
}

function asFieldOption(option: CollectedOption): FieldOption {
  return {
    label: option.displayedText,
    value: option.value,
    ...(option.disabled ? { disabled: true } : {}),
    ...(option.selected ? { selected: true } : {}),
  };
}

/**
 * The exact underlying `value`, matched before anything scored.
 *
 * Priority 2 in the specification, and it earns its place: a form whose
 * "United States of America" entry carries `value="United States"` is offering
 * the saved answer under a label that would only ever match semantically. This
 * finds it as a certainty.
 */
function byUnderlyingValue(
  candidate: string,
  options: readonly CollectedOption[],
): CollectedOption | undefined {
  const wanted = normalizeOptionText(candidate);
  if (wanted.length === 0) return undefined;
  const hits = options.filter(
    (option) => !option.disabled && normalizeOptionText(option.value) === wanted,
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/** An explicitly aliased wording, matched as a certainty rather than a score. */
function byAlias(
  candidate: string,
  options: readonly CollectedOption[],
): { option?: CollectedOption; ambiguous: boolean } {
  const hits = options.filter(
    (option) => !option.disabled && aliasesMatch(candidate, option.displayedText),
  );
  if (hits.length === 1) return { option: hits[0], ambiguous: false };
  // Two options that both alias to the answer is a list this table cannot
  // safely choose from. Reported, never resolved by taking the first.
  return { ambiguous: hits.length > 1 };
}

/**
 * Matches the directive against the live list, trying each wording in turn.
 *
 * One question can be worded as two taxonomies by two employers, and only the
 * page can say which it is using: one form's "Education Type" lists institutions
 * and the next one's lists degree programmes. The directive carries both
 * readings of the same saved record, most specific first, and the page's own
 * list decides. Nothing is invented — every candidate is a restatement of one
 * fact, and the first that corresponds to an offered option wins.
 */
export function matchIntendedAnswer(
  directive: DropdownDirective,
  options: readonly CollectedOption[],
): DropdownMatchResult {
  const candidates = [directive.intendedAnswer, ...directive.alternativeValues].filter(
    (value) => value.trim().length > 0,
  );
  if (candidates.length === 0) {
    return {
      method: 'none',
      ambiguous: false,
      reason: 'No answer was proposed for this control.',
    };
  }
  if (options.length === 0) {
    return { method: 'none', ambiguous: false, reason: 'The control offered no choices.' };
  }

  const offered = options.map(asFieldOption);
  const byLabel = new Map(
    options.map((option) => [normalizeOptionText(option.displayedText), option]),
  );
  let firstMiss: DropdownMatchResult | null = null;

  for (const candidate of candidates) {
    // 1 and 3 — the page's own wording and the documented spellings of it,
    // both certainties, delegated to the one matcher the executor also uses so
    // the two can never reach different answers on the same list.
    const literal = matchDropdownOption({
      desiredSemanticValue: candidate,
      options: offered,
      canonicalQuestion: directive.canonicalQuestion,
      // Tried only after every real reading has failed, below. A form that does
      // list the answer must never be sent to "Other" because the first wording
      // missed.
      allowOtherFallback: false,
    });
    if (literal.option) {
      const found = byLabel.get(normalizeOptionText(literal.option.label));
      if (found) {
        return {
          option: found,
          method: literal.method,
          ambiguous: false,
          reason: literal.reason,
          matchedCandidate: candidate,
        };
      }
    }
    // An ambiguous list is a decision for the applicant. Trying the next
    // wording and picking something else is how ambiguity becomes a wrong
    // answer instead of a question.
    if (literal.ambiguous) {
      return { method: literal.method, ambiguous: true, reason: literal.reason };
    }

    // 2 — the exact underlying value.
    const valued = byUnderlyingValue(candidate, options);
    if (valued) {
      return {
        option: valued,
        method: 'literal',
        ambiguous: false,
        reason: `"${valued.displayedText}" carries the saved answer as its stored value.`,
        matchedCandidate: candidate,
      };
    }

    // 3 — the alias table, as a certainty rather than a score.
    const aliased = byAlias(candidate, options);
    if (aliased.option) {
      return {
        option: aliased.option,
        method: 'alias',
        ambiguous: false,
        reason: `"${aliased.option.displayedText}" is another name for the saved answer.`,
        matchedCandidate: candidate,
      };
    }
    if (aliased.ambiguous) {
      return {
        method: 'alias',
        ambiguous: true,
        reason: 'Several choices are equally valid names for this answer.',
      };
    }

    firstMiss ??= { method: literal.method, ambiguous: false, reason: literal.reason };
  }

  // 4 — the form's own "Other", and only where the caller said it is a real
  // answer. On a Country list "Other" is wrong; on an Area of Study list that
  // does not name the degree it is correct.
  if (directive.allowOtherFallback) {
    const other = matchDropdownOption({
      desiredSemanticValue: directive.intendedAnswer,
      options: offered,
      canonicalQuestion: directive.canonicalQuestion,
      allowOtherFallback: true,
    });
    if (other.option) {
      const found = byLabel.get(normalizeOptionText(other.option.label));
      if (found) {
        return {
          option: found,
          method: 'other_fallback',
          ambiguous: false,
          reason: other.reason,
          matchedCandidate: directive.intendedAnswer,
        };
      }
    }
  }

  return (
    firstMiss ?? {
      method: 'none',
      ambiguous: false,
      reason: 'No offered choice corresponds to the saved answer.',
    }
  );
}
