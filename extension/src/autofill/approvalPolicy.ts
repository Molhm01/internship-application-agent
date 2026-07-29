import {
  SENSITIVE_CANONICAL_QUESTIONS,
  isDeclinePhrasing,
  type AutofillSettings,
  type CanonicalQuestion,
  type DeterministicFillAction,
  type DetectedField,
  type ReviewReason,
} from '@internship-agent/shared';

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
 */
const NEVER_GUESSED: readonly CanonicalQuestion[] = [
  ...SENSITIVE_CANONICAL_QUESTIONS,
  'transgender',
  'work_authorization',
  'sponsorship_required',
  'citizenship',
  'security_clearance',
  'criminal_history',
  'salary_expectation',
  'terms_attestation',
  'signature',
];

export function isNeverGuessed(canonicalQuestion: CanonicalQuestion | undefined): boolean {
  return canonicalQuestion !== undefined && NEVER_GUESSED.includes(canonicalQuestion);
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

  // ---- Legally weighty answers ------------------------------------------
  // An attestation or signature is a statement the user makes, not a field the
  // agent completes. No setting turns this on.
  if (canonicalQuestion === 'terms_attestation' || canonicalQuestion === 'signature') {
    return {
      approved: false,
      reviewReason: 'manual_required',
      reason: 'Terms and signatures are never accepted on your behalf.',
    };
  }

  // ---- Protected and eligibility questions -------------------------------
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
    return {
      approved: true,
      reviewReason: 'ai_suggestion',
      reason: 'Best grounded answer; highlighted for review.',
    };
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
      if (action.confidence < 0.8) {
        return {
          approved: false,
          reviewReason: 'ai_suggestion',
          reason: 'This match is not certain enough to apply on its own.',
        };
      }
      return { approved: true, reason: 'Your saved value in this form’s wording.' };
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
