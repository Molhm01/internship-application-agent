import type { CanonicalIntent } from '../constants/intents.js';
import { SENSITIVE_CANONICAL_QUESTIONS, type CanonicalQuestion } from '../constants/questions.js';
import type { FieldOption } from '../schemas/fields.js';
import {
  semanticOptionDecisionSchema,
  type ApplicationPreset,
  type AvailableOption,
  type SemanticOptionDecision,
} from '../schemas/semanticOption.js';
import { matchOption, allowsRegionSuffix } from './optionMatcher.js';
import { normalizeOptionLabel, phrasingsForIntent } from './synonyms.js';

/**
 * Chooses one option from the choices a page actually offers, given what the
 * user's saved data supports.
 *
 * Order of attempts: the literal saved value, then a documented alias, then the
 * phrasings that express the saved *intent*. Every attempt matches against
 * `availableOptions` and nothing else, so no step can produce an option the page
 * does not have.
 */

export interface SemanticResolveInput {
  fieldId: string;
  question: string;
  canonicalQuestion: CanonicalQuestion;
  options: readonly FieldOption[];
  /** The value the user's data supports, if any. */
  intendedAnswer?: string;
  /** The meaning to convey, used when no literal value matches. */
  canonicalIntent?: CanonicalIntent;
  source: SemanticOptionDecision['source'];
  sourceReference?: string;
  sensitive?: boolean;
}

function toAvailable(options: readonly FieldOption[]): AvailableOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    disabled: Boolean(option.disabled),
  }));
}

function decision(
  input: SemanticResolveInput,
  patch: Partial<SemanticOptionDecision> & Pick<SemanticOptionDecision, 'status' | 'reason'>,
): SemanticOptionDecision {
  const available = toAvailable(input.options);
  const sensitive =
    input.sensitive ?? SENSITIVE_CANONICAL_QUESTIONS.includes(input.canonicalQuestion);

  return semanticOptionDecisionSchema.parse({
    fieldId: input.fieldId,
    question: input.question,
    canonicalQuestion: input.canonicalQuestion,
    availableOptions: available,
    intendedAnswer: input.intendedAnswer ?? input.canonicalIntent ?? '',
    ...(input.canonicalIntent ? { canonicalIntent: input.canonicalIntent } : {}),
    source: input.source,
    ...(input.sourceReference ? { sourceReference: input.sourceReference } : {}),
    confidence: 'low',
    requiresReview: true,
    sensitive,
    warnings: [],
    ...patch,
  });
}

/** Options the user can actually pick. A disabled option is not a choice. */
function selectable(options: readonly FieldOption[]): FieldOption[] {
  return options.filter((option) => !option.disabled);
}

/**
 * Finds the page option that expresses an intent, by comparing against the
 * documented phrasings for that intent. Returns `ambiguous` when several
 * options qualify, because picking one would be a guess.
 */
export function matchIntentToOption(
  intent: CanonicalIntent,
  options: readonly FieldOption[],
): { option?: FieldOption; ambiguous: boolean } {
  const phrasings = new Set(phrasingsForIntent(intent));
  if (phrasings.size === 0) return { ambiguous: false };

  const hits = selectable(options).filter(
    (option) =>
      phrasings.has(normalizeOptionLabel(option.label)) ||
      phrasings.has(normalizeOptionLabel(option.value)),
  );

  if (hits.length === 1 && hits[0]) return { option: hits[0], ambiguous: false };
  return { ambiguous: hits.length > 1 };
}

export function resolveSemanticOption(input: SemanticResolveInput): SemanticOptionDecision {
  const options = input.options;
  const sensitive =
    input.sensitive ?? SENSITIVE_CANONICAL_QUESTIONS.includes(input.canonicalQuestion);

  if (options.length === 0) {
    return decision(input, {
      status: 'unsupported',
      reason: 'No options were detected for this control.',
    });
  }

  const usable = selectable(options);
  if (usable.length === 0) {
    return decision(input, {
      status: 'unsupported',
      reason: 'Every option on this control is disabled.',
    });
  }

  // ---- Literal value or documented alias --------------------------------
  if (input.intendedAnswer && input.intendedAnswer.length > 0) {
    const match = matchOption(input.intendedAnswer, usable, {
      allowRegionSuffix: allowsRegionSuffix(input.canonicalQuestion),
    });

    if (match.matched && match.option) {
      const exact = match.matchKind === 'literal';
      return decision(input, {
        status: 'matched',
        selectedOption: { label: match.option.label, value: match.option.value },
        confidence: exact ? 'high' : 'medium',
        // A sensitive answer is confirmed by the user even when the wording
        // matched exactly; so is anything reached through inference.
        requiresReview: sensitive || match.matchKind === 'region_suffix',
        reason: exact
          ? `Your saved answer matches "${match.option.label}".`
          : `Your saved answer "${input.intendedAnswer}" corresponds to "${match.option.label}".`,
        warnings: match.warnings,
      });
    }

    if (match.ambiguous) {
      return decision(input, {
        status: 'ambiguous',
        reason: `"${input.intendedAnswer}" matches more than one option equally.`,
        warnings: ['Choose the correct option yourself.'],
      });
    }
  }

  // ---- Intent phrasings --------------------------------------------------
  // This is what makes a saved "Decline to answer" find "I do not wish to
  // self-identify" without the user maintaining a list of every wording.
  if (input.canonicalIntent) {
    const byIntent = matchIntentToOption(input.canonicalIntent, usable);
    if (byIntent.option) {
      return decision(input, {
        status: 'matched',
        selectedOption: { label: byIntent.option.label, value: byIntent.option.value },
        confidence: 'medium',
        requiresReview: sensitive,
        reason: `"${byIntent.option.label}" is this form's wording for your saved preference.`,
        warnings: [],
      });
    }
    if (byIntent.ambiguous) {
      return decision(input, {
        status: 'ambiguous',
        reason: 'Several options express your saved preference equally.',
        warnings: ['Choose the correct option yourself.'],
      });
    }

    // A decline preference with no decline option is a real dead end: the form
    // offers only substantive answers, and guessing one would disclose a trait
    // the user chose not to reveal.
    if (
      input.canonicalIntent === 'prefer_not_to_answer' ||
      input.canonicalIntent === 'decline_to_self_identify'
    ) {
      return decision(input, {
        status: 'missing_information',
        reason: 'This form offers no way to decline this question.',
        warnings: ['Answer it yourself or leave it blank; a value will never be chosen for you.'],
      });
    }
  }

  return decision(input, {
    status: 'missing_information',
    reason: input.intendedAnswer
      ? `No option on this form corresponds to "${input.intendedAnswer}".`
      : 'No saved answer applies to this question.',
    warnings: ['Choose one of the detected options yourself.'],
  });
}

/**
 * Applies a saved preset to a field.
 *
 * A sensitive preset may only ever decline automatically; any other sensitive
 * value is surfaced for confirmation regardless of its policy, so a protected
 * trait is never disclosed by a background process.
 */
export function resolveFromPreset(
  preset: ApplicationPreset,
  field: { fieldId: string; question: string; options: readonly FieldOption[] },
): SemanticOptionDecision {
  if (preset.autofillPolicy === 'always_manual' || preset.autofillPolicy === 'leave_blank') {
    return semanticOptionDecisionSchema.parse({
      fieldId: field.fieldId,
      question: field.question,
      canonicalQuestion: preset.canonicalQuestion,
      availableOptions: toAvailable(field.options),
      intendedAnswer: preset.value ?? preset.intent ?? '',
      ...(preset.intent ? { canonicalIntent: preset.intent } : {}),
      source: preset.sensitive ? 'sensitive_policy' : 'profile',
      sourceReference: `presets.${preset.id}`,
      confidence: 'high',
      requiresReview: true,
      sensitive: preset.sensitive,
      reason:
        preset.autofillPolicy === 'leave_blank'
          ? 'Your preset leaves this question blank.'
          : 'Your preset marks this question for manual completion.',
      warnings: [],
      status: preset.autofillPolicy === 'leave_blank' ? 'prohibited' : 'missing_information',
    });
  }

  const resolved = resolveSemanticOption({
    fieldId: field.fieldId,
    question: field.question,
    canonicalQuestion: preset.canonicalQuestion,
    options: field.options,
    ...(preset.value ? { intendedAnswer: preset.value } : {}),
    ...(preset.intent ? { canonicalIntent: preset.intent } : {}),
    source: preset.sensitive ? 'sensitive_policy' : 'profile',
    sourceReference: `presets.${preset.id}`,
    sensitive: preset.sensitive,
  });

  const declining =
    preset.intent === 'prefer_not_to_answer' || preset.intent === 'decline_to_self_identify';
  const mayFillWithoutReview =
    preset.autofillPolicy === 'auto_fill_exact'
      ? resolved.confidence === 'high'
      : preset.autofillPolicy === 'prefer_not_to_answer'
        ? declining
        : preset.autofillPolicy === 'auto_fill_semantic'
          ? !preset.sensitive || declining
          : false;

  // Declining is the one sensitive answer that discloses nothing, so a decline
  // preset may fill without a per-field confirmation. Every other sensitive
  // value keeps the review the resolver asked for.
  const inheritedReview = declining ? false : resolved.requiresReview;

  return semanticOptionDecisionSchema.parse({
    ...resolved,
    requiresReview: preset.requiresReview || !mayFillWithoutReview || inheritedReview,
  });
}

/**
 * Presets a new profile starts with. Declining is the recommended default for
 * every voluntary self-identification question: it is the answer that reveals
 * nothing, and it is never chosen to influence an outcome.
 */
export function defaultSensitivePresets(now: string): ApplicationPreset[] {
  const sensitiveQuestions: CanonicalQuestion[] = [
    'gender',
    'race_ethnicity',
    'hispanic_latino',
    'veteran_status',
    'disability_status',
    'sexual_orientation',
  ];

  return sensitiveQuestions.map((canonicalQuestion) => ({
    id: `preset-${canonicalQuestion}`,
    canonicalQuestion,
    intent: 'prefer_not_to_answer',
    aliases: [],
    sensitive: true,
    autofillPolicy: 'prefer_not_to_answer',
    requiresReview: false,
    lastUpdatedAt: now,
  }));
}
