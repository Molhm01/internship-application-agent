import {
  ALWAYS_CONFIRM_QUESTIONS,
  SAVED_ANSWER_REQUIRED_QUESTIONS,
  SENSITIVE_CANONICAL_QUESTIONS,
  alwaysNeedsConfirmation,
  confidenceBand,
  isDeclinePhrasing,
  needsExplicitlySavedAnswer,
  type AutofillSettings,
  type CanonicalQuestion,
  type DeterministicFillAction,
  type DetectedField,
  type ReviewReason,
} from '@internship-agent/shared';
import { isLegalAttestation } from '../matcher/deterministicMatcher.js';

/**
 * Decides what one-button autofill may apply without a person looking first.
 *
 * The old workflow answered this by showing every action on a review screen.
 * Removing that screen does not remove the judgement — it moves it here, where
 * it is one set of rules that can be read and tested, rather than a habit of
 * clicking "approve all".
 *
 * The rules are permissive about things the user already wrote down and strict
 * about everything else. Nothing here can approve an answer to a protected,
 * legal, or eligibility question that the user did not explicitly save.
 */

/**
 * Questions no automatic policy may ever answer from inference. A saved value or
 * an explicit disclosure preset can fill them; a guess, a model, or a
 * "high-confidence" heuristic never can.
 *
 * The two halves come from `confidencePolicy`, and the split between them is
 * the substantive change: eligibility facts the user explicitly saved —
 * work authorization, sponsorship, citizenship, relocation, a salary strategy —
 * used to be lumped in with protected characteristics and shown for
 * confirmation every single time. Repeating a statement the applicant already
 * made about themselves is clerical work, and treating it as a disclosure
 * decision meant 26 fields went to review on every form.
 */
const NEVER_GUESSED: readonly CanonicalQuestion[] = [
  ...SENSITIVE_CANONICAL_QUESTIONS,
  ...ALWAYS_CONFIRM_QUESTIONS,
  ...SAVED_ANSWER_REQUIRED_QUESTIONS,
];

export function isNeverGuessed(canonicalQuestion: CanonicalQuestion | undefined): boolean {
  return canonicalQuestion !== undefined && NEVER_GUESSED.includes(canonicalQuestion);
}

/**
 * True when this action carries something the user actually wrote down, rather
 * than something derived for them.
 *
 * `profile` counts: a profile value is a fact the applicant entered. What does
 * not count is `ai_suggestion` — a model's reading of a saved fact is evidence,
 * but it is not the applicant's own statement, and the questions that consult
 * this function are exactly the ones where that distinction matters.
 */
function fromExplicitlySavedAnswer(action: DeterministicFillAction): boolean {
  return (
    action.source === 'approved_answer' ||
    action.source === 'user_override' ||
    action.source === 'profile'
  );
}

/**
 * True when an AI-proposed answer names the saved facts it rests on.
 *
 * An ungrounded model answer to a factual question is an invention with a
 * confidence score attached, and the score is the least trustworthy part of it.
 */
function isGrounded(action: DeterministicFillAction): boolean {
  if (fromExplicitlySavedAnswer(action)) return true;
  return (action.sourceFactIds?.length ?? 0) > 0;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Set when the field should draw attention instead of filling silently. */
  reviewReason?: ReviewReason;
  reason: string;
}

/** Actions that carry an exact option the page really offers. */
const OPTION_ACTIONS = new Set<DeterministicFillAction['action']>([
  'select_option',
  'select_resolved_option',
  'select_suggested_option',
  'choose_radio',
]);

/**
 * Whether this action may be applied automatically, and if not, why the field
 * should be highlighted.
 *
 * `field` is optional so the policy can be tested and reused where only the
 * action is available; the canonical question is read from it when present.
 */
export function decideApproval(
  action: DeterministicFillAction,
  settings: AutofillSettings,
  field?: DetectedField,
): ApprovalDecision {
  const canonicalQuestion = field?.canonicalKey;

  if (!settings.applicationAutofillEnabled) {
    return { approved: false, reviewReason: 'missing_information', reason: 'Autofill is off.' };
  }

  // ---- Legally weighty answers, before anything else ---------------------
  // An attestation or a signature is a statement the user makes. It is not
  // "information we are missing"; it is a response only a person can give, and
  // no setting and no action kind changes that.
  const legalAttestation =
    canonicalQuestion === 'terms_attestation' ||
    canonicalQuestion === 'signature' ||
    (field !== undefined && isLegalAttestation(field));
  if (legalAttestation) {
    return {
      approved: false,
      reviewReason: 'manual_required',
      reason: 'Terms, consent, and attestations are never accepted on your behalf.',
    };
  }

  // ---- Fields that are not answers at all ------------------------------
  switch (action.action) {
    case 'unsupported':
      return {
        approved: false,
        reviewReason: 'manual_required',
        reason: 'This control cannot be driven safely.',
      };
    case 'manual_review':
      return {
        approved: false,
        reviewReason: action.sensitive ? 'manual_required' : 'missing_information',
        reason: action.reason,
      };
    case 'missing_information':
      return {
        approved: false,
        reviewReason: action.sensitive ? 'manual_required' : 'missing_information',
        reason: action.reason,
      };
    case 'skip':
      return { approved: false, reason: 'Skipped.' };
    default:
      break;
  }

  // ---- Eligibility facts the user explicitly saved ------------------------
  // Work authorization, sponsorship, citizenship, relocation, a salary
  // strategy. Checked before the protected-characteristic branch below,
  // because several of these are marked sensitive and would otherwise be
  // caught by it — which is precisely the behaviour being fixed. With nothing
  // saved they fall through and are confirmed, never guessed.
  if (
    needsExplicitlySavedAnswer(canonicalQuestion) &&
    !alwaysNeedsConfirmation(canonicalQuestion)
  ) {
    if (fromExplicitlySavedAnswer(action) && !action.requiresReview) {
      return {
        approved: true,
        reason: 'You saved this answer yourself; it is being repeated onto this form.',
      };
    }
    return {
      approved: false,
      reviewReason: 'manual_required',
      reason: 'Nothing saved answers this, and it is not a fact the agent will infer for you.',
    };
  }

  // ---- Protected characteristics and employer-relationship facts ----------
  if (action.sensitive || isNeverGuessed(canonicalQuestion)) {
    const declining =
      typeof action.proposedValue === 'string' && isDeclinePhrasing(action.proposedValue);
    const fromExplicitPolicy =
      action.source === 'approved_answer' || action.source === 'user_override';

    // Declining is the one sensitive answer that discloses nothing, so an
    // explicit decline preset may apply without a per-field confirmation.
    if (declining && fromExplicitPolicy && settings.autoFillSensitiveDisclosurePresets) {
      return { approved: true, reason: 'Your saved preference is to decline this question.' };
    }
    // A substantive protected answer the user saved themselves is still shown
    // to them before it is disclosed.
    if (fromExplicitPolicy) {
      return {
        approved: false,
        reviewReason: 'manual_required',
        reason: 'A saved answer exists; confirm it before it is disclosed.',
      };
    }
    return {
      approved: false,
      reviewReason: 'manual_required',
      reason: 'This question is only ever answered from an explicit saved answer.',
    };
  }

  // ---- Model-written prose ----------------------------------------------
  if (action.action === 'fill_generated_text') {
    if (action.answerValidationPassed !== true) {
      return {
        approved: false,
        reviewReason: 'ai_suggestion',
        reason: 'The generated answer has not passed validation.',
      };
    }
    if (!settings.autoFillValidatedAiAnswers) {
      return {
        approved: false,
        reviewReason: 'ai_suggestion',
        reason: 'Generated answers are filled only after you turn that on.',
      };
    }
    return { approved: true, reviewReason: 'ai_suggestion', reason: 'Validated generated answer.' };
  }

  // ---- A model-normalized suggestion -------------------------------------
  if (action.source === 'ai_suggestion') {
    if (!settings.allowGroundedNonSensitiveGuesses) {
      return {
        approved: false,
        reviewReason: 'ai_suggestion',
        reason: 'Uncertain answers are left for you unless guessing is enabled.',
      };
    }
    switch (confidenceBand(action.confidence)) {
      case 'automatic':
        return { approved: true, reason: 'Confident answer from your saved data.' };
      case 'grounded':
        // The middle band is the one that needs a condition. An answer this
        // sure fills only when it names the saved facts it rests on, and it is
        // reported afterwards rather than blending in with the certain ones.
        return isGrounded(action)
          ? {
              approved: true,
              reviewReason: 'ai_suggestion',
              reason: 'Grounded in your saved facts; listed in the summary so you can check it.',
            }
          : {
              approved: false,
              reviewReason: 'ai_suggestion',
              reason: 'This answer is not certain enough and names no saved fact to rest on.',
            };
      default:
        return {
          approved: false,
          reviewReason: 'ai_suggestion',
          reason: 'This answer is not certain enough to apply without you seeing it.',
        };
    }
  }

  // ---- Documents ---------------------------------------------------------
  if (action.action === 'upload_file') {
    return settings.autoAttachApprovedDocuments
      ? { approved: true, reason: 'Approved document attached.' }
      : {
          approved: false,
          reviewReason: 'missing_information',
          reason: 'Attach the document yourself, or turn on automatic attachment.',
        };
  }

  // ---- Ordinary saved values ---------------------------------------------
  const exact = action.confidence >= 0.99 && !action.requiresReview;
  const isOption = OPTION_ACTIONS.has(action.action);

  if (action.source === 'approved_answer') {
    if (!settings.autoFillApprovedAnswers) {
      return {
        approved: false,
        reviewReason: 'missing_information',
        reason: 'Approved answers are not filled automatically.',
      };
    }
    if (action.requiresReview) {
      return {
        approved: false,
        reviewReason: 'missing_information',
        reason: 'This saved answer asks to be reviewed each time.',
      };
    }
    return { approved: true, reason: 'Exact approved-answer match.' };
  }

  if (action.source === 'profile') {
    if (action.requiresReview) {
      return {
        approved: false,
        reviewReason: 'missing_information',
        reason: action.reason || 'This value needs confirming on this form.',
      };
    }
    if (exact && !isOption) {
      if (!settings.autoFillExactProfileValues) {
        return {
          approved: false,
          reviewReason: 'missing_information',
          reason: 'Exact profile values are not filled automatically.',
        };
      }
      return { approved: true, reason: 'Exact saved profile value.' };
    }
    // An option match is the same saved value written in the form's own words.
    if (isOption || !exact) {
      if (!settings.autoFillSemanticProfileMatches) {
        return {
          approved: false,
          reviewReason: 'missing_information',
          reason: 'Matched values are not filled automatically.',
        };
      }
      switch (confidenceBand(action.confidence)) {
        case 'automatic':
          return { approved: true, reason: 'Your saved value in this form’s wording.' };
        case 'grounded':
          // Grounded by construction: the value came from the profile. It fills
          // and is named in the summary.
          return {
            approved: true,
            reviewReason: 'ai_suggestion',
            reason: 'Your saved value, matched to this form’s wording; listed so you can check it.',
          };
        default:
          return {
            approved: false,
            reviewReason: 'ai_suggestion',
            reason: 'This match is not certain enough to apply on its own.',
          };
      }
    }
  }

  if (action.source === 'user_override') {
    return { approved: true, reason: 'You entered this value yourself.' };
  }

  return {
    approved: false,
    reviewReason: 'missing_information',
    reason: 'Nothing saved answers this question yet.',
  };
}

/** Applies the policy across a plan, returning the actions to execute. */
export function applyApprovalPolicy(
  actions: readonly DeterministicFillAction[],
  settings: AutofillSettings,
  fieldsById: ReadonlyMap<string, DetectedField>,
): Map<string, ApprovalDecision> {
  const decisions = new Map<string, ApprovalDecision>();
  for (const action of actions) {
    decisions.set(action.id, decideApproval(action, settings, fieldsById.get(action.fieldId)));
  }
  return decisions;
}
