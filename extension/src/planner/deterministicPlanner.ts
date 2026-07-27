import {
  deterministicFillPlanSchema,
  matchOption,
  type ApplicationScanResult,
  type ApprovedAnswer,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FieldMatch,
  type Profile,
} from '@internship-agent/shared';
import { isLegalAttestation, matchField } from '../matcher/deterministicMatcher.js';

const ACTIONABLE = new Set<DeterministicFillAction['action']>([
  'fill_text',
  'fill_generated_text',
  'select_option',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
]);

export function actionIdForField(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `action-${(hash >>> 0).toString(36)}`;
}

function actionFor(field: DetectedField, match: FieldMatch): DeterministicFillAction {
  const base = {
    id: actionIdForField(field.id),
    fieldId: field.id,
    question: field.question,
    fieldType: field.fieldType,
    source: match.source,
    ...(match.sourceReference ? { sourceReference: match.sourceReference } : {}),
    confidence: match.confidence,
    sensitive: match.sensitive,
    requiresReview: match.requiresReview,
    approved: false,
    reason: match.reason,
    warnings: [...match.warnings],
    originalMatch: match,
  };
  if (!field.visible) {
    return { ...base, action: 'manual_review', reason: 'Scanned field is not visible.' };
  }
  if (field.disabled) {
    return { ...base, action: 'manual_review', reason: 'Scanned field is disabled.' };
  }
  if (field.fieldType === 'file') {
    return {
      ...base,
      action: 'unsupported',
      reason: 'Document upload is intentionally unavailable in Milestone 3.',
    };
  }
  if (['combobox', 'contenteditable', 'unknown'].includes(field.fieldType)) {
    return {
      ...base,
      action: 'unsupported',
      reason: `${field.fieldType} has no deterministic executor strategy.`,
    };
  }
  if (!match.matched || match.formattedValue === undefined) {
    return {
      ...base,
      action: match.requiresReview ? 'manual_review' : 'skip',
    };
  }
  const existing = field.currentValue;
  const hasExistingValue =
    existing !== undefined &&
    existing !== '' &&
    existing !== false &&
    (!Array.isArray(existing) || existing.length > 0);
  if (hasExistingValue && JSON.stringify(existing) !== JSON.stringify(match.formattedValue)) {
    base.requiresReview = true;
    base.warnings.push(
      'The field already contains a different value; it will not be overwritten without review.',
    );
  }
  if (field.fieldType === 'select' || field.fieldType === 'radio') {
    if (typeof match.formattedValue === 'object') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'A single-choice control requires one scalar value.',
      };
    }
    const option = matchOption(match.formattedValue, field.options ?? []);
    if (!option.matched || !option.option) {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: option.reason,
        warnings: [
          ...base.warnings,
          option.ambiguous ? 'Option match is ambiguous.' : 'No exact option exists.',
        ],
      };
    }
    return {
      ...base,
      action: field.fieldType === 'select' ? 'select_option' : 'choose_radio',
      proposedValue: option.option.value,
      matchedOption: { label: option.option.label, value: option.option.value },
    };
  }
  if (field.fieldType === 'checkbox' || field.fieldType === 'multi_select') {
    if (isLegalAttestation(field) && match.source !== 'approved_answer') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'Legal attestation requires an explicit approved answer.',
      };
    }
    if (field.fieldType === 'multi_select') {
      if (!Array.isArray(match.formattedValue)) {
        return {
          ...base,
          action: 'manual_review',
          requiresReview: true,
          reason: 'A checkbox group requires an explicit list of selected values.',
        };
      }
      const exactValues: string[] = [];
      for (const value of match.formattedValue) {
        const option = matchOption(value, field.options ?? []);
        if (!option.matched || !option.option) {
          return {
            ...base,
            action: 'manual_review',
            requiresReview: true,
            reason: option.reason,
          };
        }
        exactValues.push(option.option.value);
      }
      return { ...base, action: 'toggle_checkbox', proposedValue: exactValues };
    }
    if (typeof match.formattedValue !== 'boolean') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'A single checkbox requires an explicit boolean value.',
      };
    }
    return { ...base, action: 'toggle_checkbox', proposedValue: match.formattedValue };
  }
  if (field.fieldType === 'date') {
    return { ...base, action: 'set_date', proposedValue: match.formattedValue };
  }
  return { ...base, action: 'fill_text', proposedValue: match.formattedValue };
}

export function calculatePlanStatistics(actions: readonly DeterministicFillAction[]) {
  return {
    total: actions.length,
    ready: actions.filter(
      (action) =>
        ACTIONABLE.has(action.action) && action.confidence >= 0.8 && !action.requiresReview,
    ).length,
    review: actions.filter(
      (action) =>
        action.action !== 'skip' &&
        action.action !== 'unsupported' &&
        (action.action === 'manual_review' || action.requiresReview || action.confidence < 0.8),
    ).length,
    skipped: actions.filter((action) => action.action === 'skip').length,
    unsupported: actions.filter((action) => action.action === 'unsupported').length,
    sensitive: actions.filter((action) => action.sensitive).length,
  };
}

function withActions(
  plan: DeterministicFillPlan,
  actions: DeterministicFillAction[],
): DeterministicFillPlan {
  return deterministicFillPlanSchema.parse({
    ...plan,
    updatedAt: new Date().toISOString(),
    actions,
    statistics: calculatePlanStatistics(actions),
  });
}

export function buildDeterministicPlan(
  scan: ApplicationScanResult,
  profile: Profile,
  answers: readonly ApprovedAnswer[],
): DeterministicFillPlan {
  const actions = scan.fields.map((field) => actionFor(field, matchField(field, profile, answers)));
  const now = new Date().toISOString();
  return deterministicFillPlanSchema.parse({
    id: `plan-${crypto.randomUUID()}`,
    scanId: scan.id,
    createdAt: now,
    updatedAt: now,
    url: scan.url,
    domain: scan.domain,
    ats: scan.ats.id,
    actions,
    warnings: [
      'This deterministic plan never submits or advances the application.',
      ...(scan.ats.id === 'workday'
        ? ['Workday support covers only the scanned, currently rendered step.']
        : []),
    ],
    statistics: calculatePlanStatistics(actions),
  });
}

export function setActionApproval(
  plan: DeterministicFillPlan,
  actionId: string,
  approved: boolean,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => {
      if (action.id !== actionId) return action;
      const canApprove =
        ACTIONABLE.has(action.action) &&
        (action.action === 'fill_generated_text'
          ? action.answerValidationPassed === true
          : action.confidence >= 0.8);
      return { ...action, approved: approved && canApprove };
    }),
  );
}

export function approveSafeActions(plan: DeterministicFillPlan): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => ({
      ...action,
      approved:
        ACTIONABLE.has(action.action) &&
        action.confidence >= 0.8 &&
        !action.requiresReview &&
        !action.sensitive,
    })),
  );
}

export function updateActionOverride(
  plan: DeterministicFillPlan,
  field: DetectedField,
  actionId: string,
  value: string | string[] | boolean,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => {
      if (action.id !== actionId) return action;
      const match = matchField(field, {} as Profile, [], value);
      return { ...actionFor(field, match), originalMatch: action.originalMatch };
    }),
  );
}

export function resetActionOverride(
  plan: DeterministicFillPlan,
  field: DetectedField,
  actionId: string,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) =>
      action.id === actionId && action.originalMatch
        ? actionFor(field, action.originalMatch)
        : action,
    ),
  );
}

export function skipAction(plan: DeterministicFillPlan, actionId: string): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) =>
      action.id === actionId
        ? {
            ...action,
            action: 'skip' as const,
            approved: false,
            requiresReview: false,
            reason: 'Skipped explicitly by the user.',
          }
        : action,
    ),
  );
}
