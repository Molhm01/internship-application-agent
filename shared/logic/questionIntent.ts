import type { CanonicalIntent } from '../constants/intents.js';
import type { CanonicalQuestion } from '../constants/questions.js';

/**
 * Question-aware interpretation of a yes/no answer.
 *
 * "Yes" is not an answer on its own. On "Are you authorized to work in the
 * United States?" it means authorized; on "Will you now or in the future require
 * sponsorship?" it means the opposite kind of thing entirely. Forms word both as
 * long sentences ("I am legally authorized to work", "Yes, I will require
 * sponsorship"), so a bare yes/no has to be turned into the intent the question
 * is actually asking about before any option can be matched.
 */

/** Maps a saved boolean to what it means for a specific question. */
const BOOLEAN_INTENTS: Partial<
  Record<CanonicalQuestion, { affirmative: CanonicalIntent; negative: CanonicalIntent }>
> = {
  work_authorization: { affirmative: 'authorized', negative: 'not_authorized' },
  sponsorship_required: {
    affirmative: 'sponsorship_required',
    negative: 'sponsorship_not_required',
  },
  willing_to_relocate: {
    affirmative: 'willing_to_relocate',
    negative: 'not_willing_to_relocate',
  },
  onsite_availability: { affirmative: 'available', negative: 'unavailable' },
  hybrid_availability: { affirmative: 'available', negative: 'unavailable' },
  remote_availability: { affirmative: 'available', negative: 'unavailable' },
  internship_availability: { affirmative: 'available', negative: 'unavailable' },
  willing_to_travel: { affirmative: 'available', negative: 'unavailable' },
};

/**
 * The intent a yes/no answer expresses for this question.
 *
 * Falls back to the plain affirmative/negative intents, which is correct for a
 * question whose options really are just "Yes" and "No".
 */
export function intentForBooleanAnswer(
  canonicalQuestion: CanonicalQuestion | undefined,
  affirmative: boolean,
): CanonicalIntent {
  const mapped = canonicalQuestion ? BOOLEAN_INTENTS[canonicalQuestion] : undefined;
  if (!mapped) return affirmative ? 'affirmative' : 'negative';
  return affirmative ? mapped.affirmative : mapped.negative;
}

/** True when this question needs its own wording rather than a bare yes/no. */
export function isQuestionAwareBoolean(canonicalQuestion: CanonicalQuestion | undefined): boolean {
  return canonicalQuestion !== undefined && canonicalQuestion in BOOLEAN_INTENTS;
}

const AFFIRMATIVE_TEXT = /^(yes|y|true|1)$/;
const NEGATIVE_TEXT = /^(no|n|false|0)$/;

/**
 * Reads a saved answer as a boolean when — and only when — it plainly is one.
 * Returns null for anything else, so a substantive answer is never coerced into
 * a yes/no it did not state.
 */
export function readBooleanAnswer(value: string | boolean | number): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (AFFIRMATIVE_TEXT.test(text)) return true;
  if (NEGATIVE_TEXT.test(text)) return false;
  return null;
}
