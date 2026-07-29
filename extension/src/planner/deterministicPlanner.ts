import {
  allowsRegionSuffix,
  deterministicFillPlanSchema,
  isLocationQuestion,
  locationSearchText,
  matchLocationOption,
  matchOption,
  type ApplicationScanResult,
  type ApprovedAnswer,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FieldMatch,
  type LocationTarget,
  type MatchHint,
  type Profile,
  type SavedDocument,
} from '@internship-agent/shared';
import { isLegalAttestation, matchField } from '../matcher/deterministicMatcher.js';

/**
 * Page-level facts the planner resolved once and every action may need. The
 * location comes straight from the saved profile; nothing here is inferred.
 */
export interface PlanContext {
  location?: LocationTarget;
  hasPhoneCountryCodeField?: boolean;
}

/** True when the scan found a control that takes the dialling code by itself. */
export function hasPhoneCountryCodeField(scan: ApplicationScanResult): boolean {
  return scan.fields.some((field) => field.canonicalKey === 'phone_country_code');
}

function locationOf(profile: Profile): LocationTarget {
  const address = profile.personal.address;
  return {
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.country ? { country: address.country } : {}),
  };
}

/**
 * The grounding a custom combobox executor needs, because such a control
 * reveals its options only once opened. Carries saved facts only — never a
 * selector, a script, or a position in a list.
 */
function buildMatchHint(field: DetectedField, context: PlanContext): MatchHint | undefined {
  if (!isLocationQuestion(field.canonicalKey) || !context.location?.city) {
    return field.canonicalKey ? { canonicalQuestion: field.canonicalKey } : undefined;
  }
  return {
    canonicalQuestion: field.canonicalKey,
    location: context.location,
    searchText: locationSearchText(context.location),
  };
}

const ACTIONABLE = new Set<DeterministicFillAction['action']>([
  'fill_text',
  'fill_generated_text',
  'select_option',
  'select_suggested_option',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
  'upload_file',
]);

export function actionIdForField(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `action-${(hash >>> 0).toString(36)}`;
}

function actionFor(
  field: DetectedField,
  match: FieldMatch,
  selectedDocument?: SavedDocument,
  context: PlanContext = {},
): DeterministicFillAction {
  const hint = buildMatchHint(field, context);
  const base = {
    ...(hint ? { matchHint: hint } : {}),
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
    const isResumeField =
      field.canonicalKey === 'resume' || /\b(resume|cv|curriculum vitae)\b/i.test(field.question);
    if (selectedDocument?.type === 'resume' && isResumeField) {
      return {
        ...base,
        action: 'upload_file',
        source: 'document',
        sourceReference: `documents.${selectedDocument.id}`,
        confidence: 1,
        requiresReview: true,
        approved: false,
        documentId: selectedDocument.id,
        documentName: selectedDocument.name,
        reason: `Attach ${selectedDocument.name} only after explicit approval.`,
        warnings: [
          ...base.warnings,
          'Document uploads always require explicit approval and never submit the application.',
        ],
      };
    }
    // An upload field the executor can drive, waiting only on a document choice.
    // Reporting this as `unsupported` hid a one-click fix behind a dead end.
    return {
      ...base,
      action: 'missing_information',
      requiresReview: true,
      reason: isResumeField
        ? 'No approved document selected.'
        : 'No approved document is selected for this upload field.',
      warnings: [
        ...base.warnings,
        'Choose a resume in settings, or pick one here, then approve the upload.',
      ],
    };
  }
  // `combobox` is handled below, alongside `select`: its options were read off
  // the page by the scanner, and the executor drives it deterministically.
  if (['contenteditable', 'unknown'].includes(field.fieldType)) {
    return {
      ...base,
      action: 'unsupported',
      reason: `${field.fieldType} has no deterministic executor strategy.`,
    };
  }
  if (!match.matched || match.formattedValue === undefined) {
    // Nothing grounded this field. If an executor exists for the control, say so
    // — the blocker is a missing value, not a missing strategy.
    if (match.requiresReview) return { ...base, action: 'manual_review' };
    return {
      ...base,
      action: match.sensitive ? 'missing_information' : 'skip',
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
  if (
    field.fieldType === 'select' ||
    field.fieldType === 'radio' ||
    field.fieldType === 'combobox'
  ) {
    if (typeof match.formattedValue === 'object') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'A single-choice control requires one scalar value.',
      };
    }
    const options = field.options ?? [];
    const selectKind =
      field.fieldType === 'radio'
        ? ('choose_radio' as const)
        : field.fieldType === 'combobox'
          ? ('select_suggested_option' as const)
          : ('select_option' as const);

    // A custom combobox often renders its list only once opened, so the scanner
    // may have seen no options. The executor reads the real list at fill time and
    // refuses anything that is not an exact match there.
    if (options.length === 0 && field.fieldType === 'combobox') {
      const deferred = String(match.formattedValue);
      return {
        ...base,
        action: 'select_suggested_option',
        proposedValue: deferred,
        matchedOption: { label: deferred, value: deferred },
        requiresReview: true,
        warnings: [
          ...base.warnings,
          'Options are read when the list opens; the exact match is confirmed at fill time.',
        ],
      };
    }

    // A place is matched on city, state, and country together. Matching on the
    // city alone would happily pick Clifton, Colorado for a New Jersey profile.
    if (isLocationQuestion(field.canonicalKey) && context.location?.city) {
      const located = matchLocationOption(context.location, options);
      if (located.matched && located.option) {
        return {
          ...base,
          action: selectKind,
          proposedValue: located.option.value,
          matchedOption: { label: located.option.label, value: located.option.value },
          // An option that never named a region confirms nothing, so the user
          // confirms it instead.
          requiresReview: base.requiresReview || !located.stateConfirmed,
          reason: located.reason,
          warnings: [...base.warnings, ...located.warnings],
        };
      }
      return {
        ...base,
        action: located.ambiguous ? 'manual_review' : 'missing_information',
        requiresReview: true,
        reason: located.reason,
        warnings: [...base.warnings, ...located.warnings],
      };
    }

    const option = matchOption(match.formattedValue, options, {
      allowRegionSuffix: allowsRegionSuffix(field.canonicalKey),
    });
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
    // A spelling alias ("United States" → "United States of America") is an
    // equivalent wording of the saved value, so it stays auto-approvable. A
    // region-suffix match adds information the profile never stated, so it is
    // always confirmed by the user first.
    const inferredRegion = option.matchKind === 'region_suffix';
    return {
      ...base,
      action: selectKind,
      proposedValue: option.option.value,
      matchedOption: { label: option.option.label, value: option.option.value },
      requiresReview: base.requiresReview || inferredRegion,
      warnings: option.aliasUsed
        ? [...base.warnings, `Matched via ${option.aliasUsed}.`]
        : base.warnings,
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

/** True only when the action carries a value an executor can actually apply. */
export function isExecutable(action: DeterministicFillAction): boolean {
  if (!ACTIONABLE.has(action.action)) return false;
  if (action.action === 'upload_file') return Boolean(action.documentId);
  return action.proposedValue !== undefined;
}

/**
 * Assigns every action to exactly one bucket, in priority order, so the totals
 * always reconcile. Previously an action could be counted in several buckets and
 * an unsupported one could still look approved.
 */
export function classifyAction(
  action: DeterministicFillAction,
): 'approved' | 'ready' | 'review' | 'missingInformation' | 'skipped' | 'unsupported' {
  if (action.action === 'unsupported') return 'unsupported';
  if (action.action === 'skip') return 'skipped';
  if (action.action === 'missing_information') return 'missingInformation';
  // No value means nothing to be ready or approved about, whatever the flags say.
  if (!isExecutable(action))
    return action.action === 'manual_review' ? 'review' : 'missingInformation';
  if (action.approved) return 'approved';
  if (action.requiresReview || action.confidence < 0.8) return 'review';
  return 'ready';
}

export function calculatePlanStatistics(actions: readonly DeterministicFillAction[]) {
  const buckets = actions.map(classifyAction);
  const count = (name: ReturnType<typeof classifyAction>): number =>
    buckets.filter((bucket) => bucket === name).length;

  return {
    total: actions.length,
    ready: count('ready'),
    approved: count('approved'),
    review: count('review'),
    missingInformation: count('missingInformation'),
    skipped: count('skipped'),
    unsupported: count('unsupported'),
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
  selectedDocument?: SavedDocument,
): DeterministicFillPlan {
  const context: PlanContext = {
    location: locationOf(profile),
    hasPhoneCountryCodeField: hasPhoneCountryCodeField(scan),
  };
  const actions = scan.fields.map((field) =>
    actionFor(
      field,
      matchField(field, profile, answers, undefined, {
        ...(context.hasPhoneCountryCodeField ? { hasPhoneCountryCodeField: true } : {}),
      }),
      selectedDocument,
      context,
    ),
  );
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
      // Nothing without a real value can be approved, so the review screen can
      // never show "Approved" beside "No proposed value".
      const canApprove =
        isExecutable(action) &&
        (action.action === 'upload_file'
          ? action.requiresReview
          : action.action === 'fill_generated_text'
            ? action.answerValidationPassed === true
            : action.action === 'select_suggested_option'
              ? true
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
      // "Resolve safe fields" approves only what is grounded, unambiguous, and
      // non-sensitive. A sensitive answer is never bulk-approved.
      approved:
        isExecutable(action) &&
        action.confidence >= 0.8 &&
        !action.requiresReview &&
        !action.sensitive &&
        action.source !== 'ai_suggestion',
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
      return {
        ...actionFor(field, match),
        ...(action.matchHint ? { matchHint: action.matchHint } : {}),
        originalMatch: action.originalMatch,
      };
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
        ? {
            ...actionFor(field, action.originalMatch),
            // The saved location the plan was built with survives a reset; it is
            // profile data, not part of the edit being undone.
            ...(action.matchHint ? { matchHint: action.matchHint } : {}),
          }
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
