import type { CanonicalQuestion } from '../constants/questions.js';

/**
 * How sure the agent has to be before it answers a question without asking.
 *
 * These thresholds are the whole of the "do I fill this or show it to them?"
 * decision for ordinary questions, and they live here — one copy, shared by the
 * approval policy that applies them and the summary that explains them — because
 * two numbers that are supposed to be the same number eventually are not.
 *
 * The bands are not symmetric on purpose. Above 0.90 the answer is effectively
 * a lookup and filling it is what the user asked for. Between 0.75 and 0.89 it
 * is a judgement, so it fills only when something the user actually wrote down
 * supports it, and it is called out afterwards rather than filed away silently.
 * Below 0.75 nothing fills: an unanswered field is visibly unanswered, while a
 * wrong one looks finished.
 */

export const AUTOFILL_CONFIDENCE = {
  /** Fill without qualification. */
  automatic: 0.9,
  /** Fill when grounded in a saved fact, and say so in the summary. */
  grounded: 0.75,
} as const;

export type ConfidenceBand =
  /** Fills. */
  | 'automatic'
  /** Fills only with explicit grounding, and is reported. */
  | 'grounded'
  /** Never fills on its own. */
  | 'confirm';

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= AUTOFILL_CONFIDENCE.automatic) return 'automatic';
  if (confidence >= AUTOFILL_CONFIDENCE.grounded) return 'grounded';
  return 'confirm';
}

/**
 * Questions the agent will not answer by itself at any confidence, because
 * being sure is not the issue — the fact is not ours to state.
 *
 * Two different reasons are collected here and both are absolute:
 *
 * - Protected characteristics and legally weighty declarations. A confident
 *   guess about someone's disability or veteran status is worse than an
 *   unconfident one, not better.
 * - Facts about this person's relationship with this specific employer:
 *   previous employment, a relative who works there, who referred them. There
 *   is no profile-wide default for these and no honest way to infer one, and
 *   getting one wrong on a real application is a misrepresentation under the
 *   applicant's name.
 */
export const ALWAYS_CONFIRM_QUESTIONS: readonly CanonicalQuestion[] = [
  'gender',
  'race_ethnicity',
  'hispanic_latino',
  'transgender',
  'sexual_orientation',
  'religion',
  'veteran_status',
  'disability_status',
  'medical_information',
  'criminal_history',
  'security_clearance',
  'previously_employed',
  'previously_applied',
  'previously_interviewed',
  'family_member_employed',
  'referral',
  'referral_source',
  'referral_name',
  'referral_email',
  'referral_relationship',
  'employee_referral',
  'terms_attestation',
  'signature',
];

/**
 * Questions that may be filled automatically — but only from a value the user
 * explicitly saved, never from inference.
 *
 * These are eligibility and immigration facts. A saved answer is a statement
 * the applicant already made about themselves, so repeating it onto a form is
 * clerical work. Deriving one they never made is not, so with nothing saved
 * these fall through to confirmation rather than to a guess.
 */
export const SAVED_ANSWER_REQUIRED_QUESTIONS: readonly CanonicalQuestion[] = [
  'work_authorization',
  'sponsorship_required',
  'citizenship',
  'willing_to_relocate',
  'salary_expectation',
  'salary_minimum',
];

export function alwaysNeedsConfirmation(question: CanonicalQuestion | undefined): boolean {
  return question !== undefined && ALWAYS_CONFIRM_QUESTIONS.includes(question);
}

export function needsExplicitlySavedAnswer(question: CanonicalQuestion | undefined): boolean {
  return question !== undefined && SAVED_ANSWER_REQUIRED_QUESTIONS.includes(question);
}
