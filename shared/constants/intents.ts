/**
 * What an answer *means*, independent of how a given application words it.
 *
 * A saved policy of "decline to answer" is an intent, not a string. Storing the
 * intent is what lets the resolver find "I do not wish to self-identify" on one
 * form and "Choose not to disclose" on the next without the user maintaining a
 * list of every employer's phrasing.
 */
export const CANONICAL_INTENTS = [
  // Boolean
  'affirmative',
  'negative',
  'uncertain',
  'not_applicable',

  // Disclosure
  'disclose_value',
  'prefer_not_to_answer',
  'decline_to_self_identify',
  'leave_blank',

  // Availability
  'available',
  'unavailable',
  'partially_available',
  'needs_review',

  // Authorization
  'authorized',
  'not_authorized',
  'sponsorship_required',
  'sponsorship_not_required',

  // Location
  'exact_location',
  'willing_to_relocate',
  'not_willing_to_relocate',
  'location_flexible',
] as const;

export type CanonicalIntent = (typeof CANONICAL_INTENTS)[number];

/**
 * Intents that decline to reveal something. Grouped because a form usually
 * offers one decline option and any of these should map to it.
 */
export const DECLINE_INTENTS: readonly CanonicalIntent[] = [
  'prefer_not_to_answer',
  'decline_to_self_identify',
];

/** Intents that must never be resolved without an explicit saved answer. */
export const INTENTS_REQUIRING_EXPLICIT_ANSWER: readonly CanonicalIntent[] = ['disclose_value'];

export const AUTOFILL_POLICIES = [
  'auto_fill_exact',
  'auto_fill_semantic',
  'review_before_fill',
  'prefer_not_to_answer',
  'leave_blank',
  'always_manual',
] as const;

export type AutofillPolicy = (typeof AUTOFILL_POLICIES)[number];

/** Policies that permit filling without a per-field confirmation. */
export const AUTOMATIC_POLICIES: readonly AutofillPolicy[] = [
  'auto_fill_exact',
  'auto_fill_semantic',
  'prefer_not_to_answer',
];
