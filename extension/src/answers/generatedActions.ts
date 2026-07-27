import {
  deterministicFillPlanSchema,
  validateManualAnswer,
  type AnswerGenerationRecord,
  type AnswerGenerationStore,
  type DeterministicFillPlan,
  type DetectedField,
} from '@internship-agent/shared';
import { actionIdForField, calculatePlanStatistics } from '../planner/deterministicPlanner.js';

const CONFIDENCE = { high: 0.9, medium: 0.75, low: 0.5 } as const;

export function answerText(record: AnswerGenerationRecord): string | undefined {
  return record.editedAnswer ?? record.candidate?.answer;
}

const GENERATED_STATES = new Set<AnswerGenerationRecord['state']>([
  'ready_for_review',
  'approved',
  'filled',
  'verified',
]);
const ACTIVE_STATES = new Set<AnswerGenerationRecord['state']>([
  'queued',
  'gathering_context',
  'generating',
  'validating',
]);

export function generationStatistics(
  store: AnswerGenerationStore | null,
  eligibleNotRequested: number,
) {
  const records = store?.records ?? [];
  return {
    generated: records.filter(
      (record) => GENERATED_STATES.has(record.state) && Boolean(answerText(record)?.trim()),
    ).length,
    failed: records.filter((record) => record.state === 'failed').length,
    needsInput: records.filter((record) => record.state === 'needs_user_input').length,
    prohibited: records.filter((record) => record.state === 'prohibited').length,
    generating: records.filter((record) => ACTIVE_STATES.has(record.state)).length,
    eligibleNotRequested,
  };
}

export function updateManualAnswer(
  record: AnswerGenerationRecord,
  answer: string,
): AnswerGenerationRecord {
  const { candidate, validation } = validateManualAnswer(answer, record);
  return {
    ...record,
    originalCandidate:
      record.source === 'ai_generated' ? record.candidate : record.originalCandidate,
    originalValidation:
      record.source === 'ai_generated' ? record.validation : record.originalValidation,
    candidate,
    validation,
    editedAnswer: answer,
    source: 'user_override',
    state: validation.valid ? 'ready_for_review' : 'failed',
    approved: false,
    rejected: false,
    error: undefined,
    updatedAt: new Date().toISOString(),
    warnings: [...record.warnings, ...validation.warnings],
  };
}

export function applyRecordToPlan(
  plan: DeterministicFillPlan,
  record: AnswerGenerationRecord,
  scannedField?: DetectedField,
): DeterministicFillPlan {
  const value =
    GENERATED_STATES.has(record.state) && record.validation?.valid === true
      ? answerText(record)
      : undefined;
  const field = scannedField ?? record.targetField;
  const existing = plan.actions.find((action) => action.fieldId === record.fieldId);
  if (!existing && !field) {
    throw new Error('GENERATED_ACTION_NOT_IN_PLAN');
  }
  const base =
    existing ??
    ({
      id: actionIdForField(record.fieldId),
      fieldId: record.fieldId,
      question: field!.question,
      fieldType: field!.fieldType,
      action: 'manual_review',
      source: 'none',
      confidence: field!.confidence,
      sensitive: false,
      requiresReview: true,
      approved: false,
      reason: 'This custom response requires generation and explicit approval.',
      warnings: [],
    } as const);
  const sourceActions = existing ? plan.actions : [...plan.actions, base];
  const actions = sourceActions.map((action) => {
    if (action.fieldId !== record.fieldId) return action;
    if (!value || record.leaveBlank || record.rejected) {
      return {
        ...action,
        action: 'manual_review' as const,
        proposedValue: undefined,
        source: 'none' as const,
        sourceReference: undefined,
        approved: false,
        requiresReview: true,
        reason: record.leaveBlank
          ? 'The user marked this custom answer leave blank.'
          : 'The generated answer was rejected or cleared.',
        generationId: undefined,
        evidenceIds: undefined,
        wordCount: undefined,
        characterCount: undefined,
        answerValidationPassed: undefined,
      };
    }
    return {
      ...action,
      action: 'fill_generated_text' as const,
      proposedValue: value,
      source: record.source,
      sourceReference: `answerGenerations.${record.id}`,
      confidence: CONFIDENCE[record.candidate?.confidence ?? 'low'],
      sensitive: false,
      requiresReview: true,
      approved: record.approved && record.validation?.valid === true,
      reason:
        record.source === 'user_override'
          ? 'Explicit user-edited custom answer.'
          : 'Locally generated answer grounded in displayed evidence.',
      warnings: [...record.warnings, ...(record.candidate?.warnings ?? [])],
      generationId: record.id,
      evidenceIds: record.candidate?.evidenceUsed ?? [],
      wordCount: record.candidate?.wordCount ?? 0,
      characterCount: record.candidate?.characterCount ?? value.length,
      answerValidationPassed: record.validation?.valid === true,
    };
  });
  return deterministicFillPlanSchema.parse({
    ...plan,
    updatedAt: new Date().toISOString(),
    actions,
    statistics: calculatePlanStatistics(actions),
  });
}

/** Reattaches every current generation record to the one persisted executable plan. */
export function synchronizeGeneratedActions(
  plan: DeterministicFillPlan,
  store: AnswerGenerationStore | null,
  fields: readonly DetectedField[],
): DeterministicFillPlan {
  if (!store || store.scanId !== plan.scanId || store.planId !== plan.id) return plan;
  const synchronized = store.records.reduce((current, record) => {
    const field = fields.find((candidate) => candidate.id === record.fieldId);
    return applyRecordToPlan(current, record, field);
  }, plan);
  return JSON.stringify(synchronized.actions) === JSON.stringify(plan.actions) &&
    JSON.stringify(synchronized.statistics) === JSON.stringify(plan.statistics)
    ? plan
    : synchronized;
}
