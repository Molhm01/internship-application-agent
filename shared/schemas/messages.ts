import { z } from 'zod';
import { agentErrorSchema } from './error.js';
import { applicationScanResultSchema, scanProgressSchema } from './scan.js';
import { deterministicFillPlanSchema, fillProgressSchema, fillRunReportSchema } from './fill.js';
import { fieldValueSchema } from './fields.js';
import { documentContentResponseSchema } from './documents.js';
import { repeaterDirectiveSchema, repeaterSectionTraceSchema } from './repeaterRun.js';
import {
  answerGenerationRecordSchema,
  answerGenerationStateSchema,
  answerGenerationStoreSchema,
  regenerationModeSchema,
} from './ai.js';

export const settingsUpdatedMessageSchema = z.object({
  type: z.literal('SETTINGS_UPDATED'),
  aiGenerationEnabled: z.boolean(),
  settingsVersion: z.number().int().nonnegative(),
  settingsUpdatedAt: z.string().datetime(),
});
export type SettingsUpdatedMessage = z.infer<typeof settingsUpdatedMessageSchema>;

export const scanApplicationMessageSchema = z.object({
  type: z.literal('SCAN_APPLICATION'),
  scanId: z.string().min(1).max(128).optional(),
  targetUrl: z.string().url().max(2048).optional(),
});

export const scanProgressMessageSchema = z.object({
  type: z.literal('SCAN_PROGRESS'),
  progress: scanProgressSchema,
});

export const scanCompleteMessageSchema = z.object({
  type: z.literal('SCAN_COMPLETE'),
  result: applicationScanResultSchema,
});

export const scanFailedMessageSchema = z.object({
  type: z.literal('SCAN_FAILED'),
  scanId: z.string().min(1).max(128).optional(),
  error: agentErrorSchema,
});

export const scanCancelMessageSchema = z.object({
  type: z.literal('SCAN_CANCEL'),
  scanId: z.string().min(1).max(128).optional(),
  targetUrl: z.string().url().max(2048).optional(),
});

export const getLastScanMessageSchema = z.object({ type: z.literal('GET_LAST_SCAN') });
export const clearLastScanMessageSchema = z.object({ type: z.literal('CLEAR_LAST_SCAN') });

export const scanMessageSchema = z.discriminatedUnion('type', [
  scanApplicationMessageSchema,
  scanProgressMessageSchema,
  scanCompleteMessageSchema,
  scanFailedMessageSchema,
  scanCancelMessageSchema,
  getLastScanMessageSchema,
  clearLastScanMessageSchema,
]);

export const scanAckSchema = z.object({ ok: z.literal(true) });
export const scanApplicationResponseSchema = z.union([
  scanCompleteMessageSchema,
  scanFailedMessageSchema,
]);
export const getLastScanResponseSchema = z.object({
  scan: applicationScanResultSchema.nullable(),
  error: agentErrorSchema.optional(),
});
export const clearLastScanResponseSchema = z.union([
  scanAckSchema,
  z.object({ ok: z.literal(false), error: agentErrorSchema }),
]);

export type ScanMessage = z.infer<typeof scanMessageSchema>;
export type ScanApplicationResponse = z.infer<typeof scanApplicationResponseSchema>;
export type GetLastScanResponse = z.infer<typeof getLastScanResponseSchema>;

export const buildDeterministicPlanMessageSchema = z.object({
  type: z.literal('BUILD_DETERMINISTIC_PLAN'),
  scanId: z.string().min(1).max(128).optional(),
});
export const getFillPlanMessageSchema = z.object({ type: z.literal('GET_FILL_PLAN') });
export const updateFillActionMessageSchema = z.object({
  type: z.literal('UPDATE_FILL_ACTION'),
  actionId: z.string().min(1).max(128),
  operation: z.enum(['override', 'reset', 'skip']),
  value: fieldValueSchema.optional(),
});
export const approveFillActionMessageSchema = z.object({
  type: z.literal('APPROVE_FILL_ACTION'),
  actionId: z.string().min(1).max(128),
  approved: z.boolean(),
});
export const approveSafeActionsMessageSchema = z.object({
  type: z.literal('APPROVE_SAFE_ACTIONS'),
});
export const executeApprovedActionsMessageSchema = z.object({
  type: z.literal('EXECUTE_APPROVED_ACTIONS'),
  targetUrl: z.string().url().max(2048).optional(),
});
/** Worker-to-content payload. Callers cannot supply their own selectors or DOM instructions. */
export const executeFillPlanMessageSchema = z.object({
  type: z.literal('EXECUTE_FILL_PLAN'),
  runId: z.string().min(1).max(128),
  scan: applicationScanResultSchema,
  plan: deterministicFillPlanSchema,
  /** Only files referenced by approved upload actions are included. */
  documentContents: z.array(documentContentResponseSchema).max(10).default([]),
  /**
   * The URL of the frame this slice of the plan is for.
   *
   * A form split across frames is executed one frame at a time, and a subframe's
   * URL is legitimately not the scan's. Present, the receiving frame checks
   * itself against this instead of against `scan.url`; absent, it checks against
   * `scan.url` exactly as before, so a single-frame page is unaffected.
   */
  frameUrl: z.string().max(2048).optional(),
});
/**
 * Wait for a control whose choices another control produces.
 *
 * Sent between passes, after the pass that answered Country, naming only the
 * controls the planner already reported as dependent. It carries selectors and
 * a bound and nothing else: the frame observes, it never writes.
 */
export const awaitDependentOptionsMessageSchema = z.object({
  type: z.literal('AWAIT_DEPENDENT_OPTIONS'),
  selectors: z.array(z.string().min(1).max(2000)).max(50),
  /** Bounded on both sides, so neither end can turn this into a long sleep. */
  timeoutMs: z.number().int().min(100).max(5000).default(2000),
});

export const dependentOptionsResultSchema = z.object({
  type: z.literal('DEPENDENT_OPTIONS_RESULT'),
  populated: z.array(z.string()).max(50),
  pending: z.array(z.string()).max(50),
  missing: z.array(z.string()).max(50),
  waitedMs: z.number().int().nonnegative(),
});
export type AwaitDependentOptionsMessage = z.infer<typeof awaitDependentOptionsMessageSchema>;
export type DependentOptionsResult = z.infer<typeof dependentOptionsResultSchema>;

/**
 * Grow every repeating section in this frame to hold one block per saved record.
 *
 * Sent to every frame on the first pass. A frame with no Work Experience section
 * answers with a trace saying exactly that, rather than with silence — "this
 * page has no education section" and "this frame never replied" are different
 * facts and only one of them is a problem.
 *
 * The directive carries counts and anchor values only. The frame presses the
 * page's own Add control and observes what the page does; it never decides how
 * many blocks there should be, because that is a fact about the applicant.
 */
export const runRepeaterAutofillMessageSchema = z.object({
  type: z.literal('RUN_REPEATER_AUTOFILL'),
  runId: z.string().min(1).max(120),
  directives: z.array(repeaterDirectiveSchema).max(12),
});

export const repeaterRunCompleteSchema = z.object({
  type: z.literal('REPEATER_RUN_COMPLETE'),
  runId: z.string().min(1).max(120),
  sections: z.array(repeaterSectionTraceSchema).max(12),
});

export type RunRepeaterAutofillMessage = z.infer<typeof runRepeaterAutofillMessageSchema>;
export type RepeaterRunComplete = z.infer<typeof repeaterRunCompleteSchema>;

export const fillProgressMessageSchema = z.object({
  type: z.literal('FILL_PROGRESS'),
  progress: fillProgressSchema,
});
export const fillCompleteMessageSchema = z.object({
  type: z.literal('FILL_COMPLETE'),
  report: fillRunReportSchema,
});
export const fillFailedMessageSchema = z.object({
  type: z.literal('FILL_FAILED'),
  runId: z.string().min(1).max(128).optional(),
  error: agentErrorSchema,
});
export const fillCancelMessageSchema = z.object({
  type: z.literal('FILL_CANCEL'),
  runId: z.string().min(1).max(128).optional(),
  targetUrl: z.string().url().max(2048).optional(),
});
export const clearFillPlanMessageSchema = z.object({ type: z.literal('CLEAR_FILL_PLAN') });
export const fillPlanUpdatedMessageSchema = z.object({
  type: z.literal('FILL_PLAN_UPDATED'),
  planId: z.string().min(1).max(128),
  updatedAt: z.string().datetime(),
});

export const fillMessageSchema = z.discriminatedUnion('type', [
  buildDeterministicPlanMessageSchema,
  getFillPlanMessageSchema,
  updateFillActionMessageSchema,
  approveFillActionMessageSchema,
  approveSafeActionsMessageSchema,
  executeApprovedActionsMessageSchema,
  executeFillPlanMessageSchema,
  fillProgressMessageSchema,
  fillCompleteMessageSchema,
  fillFailedMessageSchema,
  fillCancelMessageSchema,
  clearFillPlanMessageSchema,
  fillPlanUpdatedMessageSchema,
]);

export const fillPlanResponseSchema = z.union([
  z.object({ plan: deterministicFillPlanSchema }),
  z.object({ error: agentErrorSchema }),
]);
export const getFillPlanResponseSchema = z.object({
  plan: deterministicFillPlanSchema.nullable(),
  report: fillRunReportSchema.nullable(),
  error: agentErrorSchema.optional(),
});
export const fillExecutionResponseSchema = z.union([
  fillCompleteMessageSchema,
  fillFailedMessageSchema,
]);
export const fillAckSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: agentErrorSchema }),
]);

export type FillMessage = z.infer<typeof fillMessageSchema>;
export type FillPlanResponse = z.infer<typeof fillPlanResponseSchema>;
export type GetFillPlanResponse = z.infer<typeof getFillPlanResponseSchema>;
export type FillExecutionResponse = z.infer<typeof fillExecutionResponseSchema>;

export const classifyCustomQuestionMessageSchema = z.object({
  type: z.literal('CLASSIFY_CUSTOM_QUESTION'),
  fieldId: z.string().min(1).max(128),
});
export const generateCustomAnswerMessageSchema = z.object({
  type: z.literal('GENERATE_CUSTOM_ANSWER'),
  fieldId: z.string().min(1).max(128),
});
export const generateAllCustomAnswersMessageSchema = z.object({
  type: z.literal('GENERATE_ALL_CUSTOM_ANSWERS'),
});
export const cancelAnswerGenerationMessageSchema = z.object({
  type: z.literal('CANCEL_ANSWER_GENERATION'),
  generationId: z.string().min(1).max(128).optional(),
});
export const answerGenerationProgressMessageSchema = z.object({
  type: z.literal('ANSWER_GENERATION_PROGRESS'),
  generationId: z.string().min(1).max(128).optional(),
  fieldId: z.string().min(1).max(128).optional(),
  state: answerGenerationStateSchema,
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  message: z.string().min(1).max(500),
});
export const answerGenerationCompleteMessageSchema = z.object({
  type: z.literal('ANSWER_GENERATION_COMPLETE'),
  record: answerGenerationRecordSchema,
});
export const answerGenerationFailedMessageSchema = z.object({
  type: z.literal('ANSWER_GENERATION_FAILED'),
  generationId: z.string().min(1).max(128).optional(),
  fieldId: z.string().min(1).max(128).optional(),
  error: agentErrorSchema,
});
export const getGeneratedAnswersMessageSchema = z.object({
  type: z.literal('GET_GENERATED_ANSWERS'),
});
export const updateGeneratedAnswerMessageSchema = z.object({
  type: z.literal('UPDATE_GENERATED_ANSWER'),
  generationId: z.string().min(1).max(128),
  operation: z.enum(['edit', 'reset', 'leave_blank']).default('edit'),
  answer: z.string().max(20_000).optional(),
});
export const approveGeneratedAnswerMessageSchema = z.object({
  type: z.literal('APPROVE_GENERATED_ANSWER'),
  generationId: z.string().min(1).max(128),
});
export const rejectGeneratedAnswerMessageSchema = z.object({
  type: z.literal('REJECT_GENERATED_ANSWER'),
  generationId: z.string().min(1).max(128),
});
export const regenerateGeneratedAnswerMessageSchema = z.object({
  type: z.literal('REGENERATE_GENERATED_ANSWER'),
  generationId: z.string().min(1).max(128),
  mode: regenerationModeSchema,
});
export const addAnswerEvidenceMessageSchema = z.object({
  type: z.literal('ADD_ANSWER_EVIDENCE'),
  generationId: z.string().min(1).max(128),
  text: z.string().min(1).max(4000),
});
export const saveAsApprovedAnswerMessageSchema = z.object({
  type: z.literal('SAVE_AS_APPROVED_ANSWER'),
  generationId: z.string().min(1).max(128),
  scope: z.enum(['general', 'company', 'job']),
});
export const clearGeneratedAnswerMessageSchema = z.object({
  type: z.literal('CLEAR_GENERATED_ANSWER'),
  generationId: z.string().min(1).max(128),
});

export const answerGenerationMessageSchema = z.discriminatedUnion('type', [
  classifyCustomQuestionMessageSchema,
  generateCustomAnswerMessageSchema,
  generateAllCustomAnswersMessageSchema,
  cancelAnswerGenerationMessageSchema,
  answerGenerationProgressMessageSchema,
  answerGenerationCompleteMessageSchema,
  answerGenerationFailedMessageSchema,
  getGeneratedAnswersMessageSchema,
  updateGeneratedAnswerMessageSchema,
  approveGeneratedAnswerMessageSchema,
  rejectGeneratedAnswerMessageSchema,
  regenerateGeneratedAnswerMessageSchema,
  addAnswerEvidenceMessageSchema,
  saveAsApprovedAnswerMessageSchema,
  clearGeneratedAnswerMessageSchema,
]);

export const generatedAnswerResponseSchema = z.union([
  z.object({ record: answerGenerationRecordSchema }),
  z.object({ error: agentErrorSchema }),
]);
export const generatedAnswersResponseSchema = z.union([
  z.object({ store: answerGenerationStoreSchema.nullable() }),
  z.object({ error: agentErrorSchema }),
]);
export const answerGenerationAckSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: agentErrorSchema }),
]);

export type AnswerGenerationMessage = z.infer<typeof answerGenerationMessageSchema>;
