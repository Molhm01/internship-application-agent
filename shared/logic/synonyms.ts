import type { CanonicalIntent } from '../constants/intents.js';

/**
 * Deterministic wording sets. Every entry is a phrasing seen on a real
 * application form, written out by hand — never a similarity score, because a
 * near-miss on a dropdown silently submits the wrong answer.
 */

export function normalizeOptionLabel(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bi'm\b/g, 'i am')
    .replace(/\bdon't\b/g, 'do not')
    .replace(/\bdoesn't\b/g, 'does not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every phrasing an application uses to let someone decline. This set is the
 * direct fix for a saved "Decline to answer" failing to match a page that says
 * "I do not wish to self-identify".
 */
export const DECLINE_PHRASINGS: readonly string[] = [
  'decline to answer',
  'decline to self identify',
  'decline to self-identify',
  'decline to disclose',
  'decline to state',
  'declined',
  'prefer not to answer',
  'i prefer not to answer',
  'prefer not to say',
  'prefer not to disclose',
  'i prefer not to disclose',
  'i do not wish to answer',
  'i do not wish to self identify',
  'i do not wish to disclose',
  'i do not wish to provide this information',
  'i do not want to answer',
  'i don t wish to answer',
  'i dont wish to answer',
  'do not wish to answer',
  'do not wish to self identify',
  'choose not to disclose',
  'choose not to answer',
  'choose not to self identify',
  'opt out',
  'opt out of answering',
  'i opt out',
  'not disclosed',
  'no response',
  'i choose not to answer',
  'i choose not to disclose',
  'rather not say',
  'i would rather not say',
  'unspecified',
  'not specified',
];

export const AFFIRMATIVE_PHRASINGS: readonly string[] = [
  'yes',
  'y',
  'true',
  'i am',
  'yes i am',
  'yes i do',
  'yes i have',
  'i do',
  'i have',
  'agree',
  'confirmed',
];

export const NEGATIVE_PHRASINGS: readonly string[] = [
  'no',
  'n',
  'false',
  'i am not',
  'no i am not',
  'no i do not',
  'no i have not',
  'i do not',
  'i have not',
  'none',
  'not applicable',
  'n a',
];

/**
 * Authorization answers are question-aware: a bare "Yes" means opposite things
 * for "Are you authorized to work?" and "Will you require sponsorship?", so
 * these sets are consulted only alongside the canonical question.
 */
export const AUTHORIZED_PHRASINGS: readonly string[] = [
  'yes',
  'i am authorized to work',
  'yes i am authorized to work',
  'authorized',
  'i am legally authorized to work',
  'yes i am legally authorized',
  'us citizen',
  'citizen',
  'permanent resident',
];

export const NOT_AUTHORIZED_PHRASINGS: readonly string[] = [
  'no',
  'i am not authorized to work',
  'not authorized',
  'no i am not authorized',
];

export const SPONSORSHIP_REQUIRED_PHRASINGS: readonly string[] = [
  'yes',
  'yes i will require sponsorship',
  'i will require sponsorship',
  'i require sponsorship',
  'sponsorship required',
  'will require sponsorship',
  'yes now or in the future',
];

export const SPONSORSHIP_NOT_REQUIRED_PHRASINGS: readonly string[] = [
  'no',
  'no i will not require sponsorship',
  'i will not require sponsorship',
  'i do not require sponsorship',
  'no sponsorship required',
  'will not require sponsorship',
  'no i do not now or in the future',
];

export const AVAILABLE_PHRASINGS: readonly string[] = [
  'yes',
  'available',
  'i am available',
  'yes i am available',
  'willing',
  'i am willing',
  'yes i am willing',
];

export const UNAVAILABLE_PHRASINGS: readonly string[] = [
  'no',
  'unavailable',
  'not available',
  'i am not available',
  'not willing',
  'i am not willing',
];

export const RELOCATE_YES_PHRASINGS: readonly string[] = [
  'yes',
  'willing to relocate',
  'i am willing to relocate',
  'yes i am willing to relocate',
  'open to relocation',
];

export const RELOCATE_NO_PHRASINGS: readonly string[] = [
  'no',
  'not willing to relocate',
  'i am not willing to relocate',
  'no i am not willing to relocate',
];

/** Phrasings that satisfy each intent, keyed by intent. */
const INTENT_PHRASINGS: Partial<Record<CanonicalIntent, readonly string[]>> = {
  prefer_not_to_answer: DECLINE_PHRASINGS,
  decline_to_self_identify: DECLINE_PHRASINGS,
  affirmative: AFFIRMATIVE_PHRASINGS,
  negative: NEGATIVE_PHRASINGS,
  authorized: AUTHORIZED_PHRASINGS,
  not_authorized: NOT_AUTHORIZED_PHRASINGS,
  sponsorship_required: SPONSORSHIP_REQUIRED_PHRASINGS,
  sponsorship_not_required: SPONSORSHIP_NOT_REQUIRED_PHRASINGS,
  available: AVAILABLE_PHRASINGS,
  unavailable: UNAVAILABLE_PHRASINGS,
  willing_to_relocate: RELOCATE_YES_PHRASINGS,
  not_willing_to_relocate: RELOCATE_NO_PHRASINGS,
};

/** The phrasings that express an intent, normalized for comparison. */
export function phrasingsForIntent(intent: CanonicalIntent): readonly string[] {
  return (INTENT_PHRASINGS[intent] ?? []).map(normalizeOptionLabel);
}

/** True when the text is any recognized way of declining to answer. */
export function isDeclinePhrasing(text: string): boolean {
  const normalized = normalizeOptionLabel(text);
  return DECLINE_PHRASINGS.some((phrase) => normalizeOptionLabel(phrase) === normalized);
}

/**
 * Maps a saved answer to the intent it expresses, so a user who typed
 * "Prefer not to say" gets the same treatment as one who picked a policy.
 * Returns null when the text states a real value rather than an intent.
 */
export function intentFromSavedText(text: string): CanonicalIntent | null {
  const normalized = normalizeOptionLabel(text);
  if (DECLINE_PHRASINGS.some((phrase) => normalizeOptionLabel(phrase) === normalized)) {
    return 'prefer_not_to_answer';
  }
  if (AFFIRMATIVE_PHRASINGS.some((phrase) => normalizeOptionLabel(phrase) === normalized)) {
    return 'affirmative';
  }
  if (NEGATIVE_PHRASINGS.some((phrase) => normalizeOptionLabel(phrase) === normalized)) {
    return 'negative';
  }
  return null;
}
