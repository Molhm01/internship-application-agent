import {
  DEFAULT_ERROR_GUIDANCE,
  applicationScanResultSchema,
  scanApplicationResponseSchema,
  scanMessageSchema,
  fillMessageSchema,
  fillExecutionResponseSchema,
  answerGenerationMessageSchema,
  settingsUpdatedMessageSchema,
  answerGenerationRecordSchema,
  classifyQuestionDeterministically,
  extractQuestionConstraints,
  isAiEligibleField,
  type AnswerGenerationRecord,
  type RegenerationMode,
  type GenerateAnswerRequest,
  type FillRunReport,
  type AgentError,
  type DeterministicFillPlan,
  type DocumentContentResponse,
} from '@internship-agent/shared';
import type { ExtensionMessage } from '../messaging/messages.js';
import { trace, traceFailure } from '../utils/trace.js';
import {
  createAnswer,
  createDocument,
  deleteAnswer,
  deleteDocument,
  fetchAgentStatus,
  getProfile,
  listAnswers,
  listDocuments,
  saveProfile,
  updateAnswer,
  updateDocument,
  generateAnswer,
  generateAnswerBatch,
  cancelAnswerGeneration,
  extractDocument,
  getDocumentContent,
  listOllamaModels,
  testAiGeneration,
  workerFailure,
  getApplicationSession,
  claimApplicationSession,
} from './agentClient.js';
import { clearLastScan, loadLastScan, saveLastScan } from '../storage/scans.js';
import {
  clearFillState,
  loadFillPlan,
  loadFillReport,
  saveFillPlan,
  saveFillReport,
} from '../storage/fill.js';
import {
  approveSafeActions,
  buildDeterministicPlan,
  resetActionOverride,
  setActionApproval,
  skipAction,
  updateActionOverride,
} from '../planner/deterministicPlanner.js';
import {
  clearAnswerGenerationStore,
  loadAnswerGenerationStore,
  saveAnswerGenerationRecord,
  saveAnswerGenerationStore,
} from '../storage/generatedAnswers.js';
import { loadSettings } from '../storage/settings.js';
import {
  loadApplicationSession,
  saveApplicationSession,
} from '../storage/applicationSession.js';
import {
  answerText,
  applyRecordToPlan,
  synchronizeGeneratedActions,
  updateManualAnswer,
} from '../answers/generatedActions.js';

const SCAN_TIMEOUT_MS = 20_000;
const FILL_TIMEOUT_MS = 30_000;

function scanFailure(
  code: AgentError['code'],
  message: string,
  debugContext: Record<string, unknown> = {},
): { type: 'SCAN_FAILED'; error: AgentError } {
  return {
    type: 'SCAN_FAILED',
    error: {
      code,
      message,
      recoverable: true,
      suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
      debugContext,
    },
  };
}

async function activeApplicationTab(targetUrl?: string): Promise<chrome.tabs.Tab> {
  const tabs = targetUrl
    ? await chrome.tabs.query({})
    : await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = targetUrl ? tabs.find((candidate) => candidate.url === targetUrl) : tabs[0];
  if (!tab?.id || !tab.url) throw new Error('ACTIVE_TAB_UNAVAILABLE');
  if (!/^https?:\/\//i.test(tab.url)) throw new Error('UNSUPPORTED_PAGE');
  return tab;
}

async function startScan(requestedScanId?: string, targetUrl?: string): Promise<unknown> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await activeApplicationTab(targetUrl);
  } catch (cause) {
    const code =
      cause instanceof Error && cause.message === 'UNSUPPORTED_PAGE'
        ? 'UNSUPPORTED_PAGE'
        : 'ACTIVE_TAB_UNAVAILABLE';
    return scanFailure(code, DEFAULT_ERROR_GUIDANCE[code]);
  }

  const scanId = requestedScanId ?? crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw: unknown = await Promise.race([
      chrome.tabs.sendMessage(tab.id!, { type: 'SCAN_APPLICATION', scanId }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SCAN_TIMEOUT')), SCAN_TIMEOUT_MS);
      }),
    ]);
    const response = scanApplicationResponseSchema.parse(raw);
    if (response.type === 'SCAN_COMPLETE') {
      const result = applicationScanResultSchema.parse(response.result);
      await clearFillState();
      await clearAnswerGenerationStore();
      await saveLastScan(result);
      console.info('[agent] scan complete', {
        scanId: result.id,
        adapter: result.ats.id,
        fields: result.statistics.total,
        warnings: result.warnings.length,
        durationMs: result.durationMs,
      });
    } else {
      console.warn('[agent] scan failed', { scanId, code: response.error.code });
    }
    return response;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const code =
      detail === 'SCAN_TIMEOUT'
        ? 'SCAN_TIMEOUT'
        : detail.includes('Receiving end')
          ? 'CONTENT_SCRIPT_UNAVAILABLE'
          : 'INVALID_SCAN_RESULT';
    return scanFailure(code, `Application scan could not complete: ${detail}`, { scanId });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fillFailure(
  code: AgentError['code'],
  message: string,
  debugContext: Record<string, unknown> = {},
): { type: 'FILL_FAILED'; error: AgentError } {
  return {
    type: 'FILL_FAILED',
    error: {
      code,
      message,
      recoverable: true,
      suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
      debugContext,
    },
  };
}

async function buildPlan(scanId?: string): Promise<unknown> {
  const scan = await loadLastScan();
  if (!scan || (scanId && scan.id !== scanId)) {
    return { error: fillFailure('INVALID_FILL_PLAN', 'No matching completed scan exists.').error };
  }
  const [profileResult, answersResult, documentsResult, settings, applicationSession] = await Promise.all([
    getProfile(),
    listAnswers(),
    listDocuments(),
    loadSettings(),
    loadApplicationSession(),
  ]);
  if (profileResult.error) return { error: profileResult.error };
  if (answersResult.error) return { error: answersResult.error };
  if (documentsResult.error) return { error: documentsResult.error };
  const selectedDocument =
    (applicationSession &&
    applicationSession.tailoredResumeDocumentId &&
    samePageUrl(applicationSession.officialApplyUrl ?? applicationSession.url, scan.url)
      ? documentsResult.data.documents.find(
          (document) => document.id === applicationSession.tailoredResumeDocumentId,
        )
      : undefined) ??
    documentsResult.data.documents.find(
      (document) => document.id === settings.selectedDocumentId,
    ) ??
    documentsResult.data.documents.find(
      (document) => document.id === documentsResult.data.defaultResumeId,
    );
  const plan = buildDeterministicPlan(
    scan,
    profileResult.data.profile,
    answersResult.data.answers,
    selectedDocument,
  );
  await persistPlan(plan);
  await clearAnswerGenerationStore();
  return { plan };
}

function samePageUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return false;
  }
}

async function claimSessionForTab(
  sessionId: string,
  tabUrl: string | undefined,
): Promise<unknown> {
  const current = await getApplicationSession(sessionId);
  if (current.error) return current;
  const expectedUrl = current.data.officialApplyUrl ?? current.data.url;
  if (!tabUrl || !samePageUrl(expectedUrl, tabUrl)) {
    return {
      error: answerFailure(
        'VALIDATION_FAILED',
        'The application session does not match the page that attempted to claim it.',
      ),
    };
  }
  const result =
    current.data.status === 'available'
      ? await claimApplicationSession(sessionId)
      : current;
  if (result.error) return result;
  await saveApplicationSession(result.data);
  return result;
}

function answerFailure(code: AgentError['code'], message: string, fieldId?: string): AgentError {
  return {
    code,
    message,
    ...(fieldId ? { fieldId } : {}),
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
    debugContext: {},
  };
}

async function answerContext(fieldId: string): Promise<
  | {
      scan: NonNullable<Awaited<ReturnType<typeof loadLastScan>>>;
      plan: DeterministicFillPlan;
      field: NonNullable<NonNullable<Awaited<ReturnType<typeof loadLastScan>>>['fields'][number]>;
      settings: Awaited<ReturnType<typeof loadSettings>>;
    }
  | { error: AgentError }
> {
  const [scan, plan, settings] = await Promise.all([
    loadLastScan(),
    loadFillPlan(),
    loadSettings(),
  ]);
  if (!scan || !plan || plan.scanId !== scan.id) {
    return { error: answerFailure('INVALID_FILL_PLAN', 'Build a current fill plan first.') };
  }
  const field = scan.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    return {
      error: answerFailure('FIELD_NOT_FOUND', 'The custom-answer field is missing.', fieldId),
    };
  }
  if (!isAiEligibleField(field)) {
    return {
      error: answerFailure(
        classifyQuestionDeterministically(field.question).classification.startsWith('prohibited')
          ? 'PROHIBITED_QUESTION'
          : 'UNSUPPORTED_QUESTION',
        'This field is not eligible for AI answer generation.',
        fieldId,
      ),
    };
  }
  return { scan, plan, field, settings };
}

function makeGenerationRequest(
  context: Exclude<Awaited<ReturnType<typeof answerContext>>, { error: AgentError }>,
  generationId: string,
  mode: RegenerationMode,
  userEvidence: string[] = [],
): GenerateAnswerRequest {
  const classification = classifyQuestionDeterministically(context.field.question);
  return {
    generationId,
    scanId: context.scan.id,
    planId: context.plan.id,
    fieldId: context.field.id,
    question: context.field.question,
    ...(classification.deterministic ? { classification: classification.classification } : {}),
    constraints: extractQuestionConstraints(context.field),
    jobContext: context.scan.jobContext,
    selectedDocumentId: context.settings.selectedDocumentId,
    userEvidence,
    aiGenerationEnabled: context.settings.aiGenerationEnabled,
    settingsUpdatedAt: context.settings.settingsUpdatedAt,
    settingsVersion: context.settings.settingsVersion,
    settings: context.settings.ai,
    regenerationMode: mode,
  };
}

function broadcastGenerationProgress(
  generationId: string | undefined,
  fieldId: string | undefined,
  state: AnswerGenerationRecord['state'],
  completed: number,
  total: number,
  message: string,
): void {
  void chrome.runtime
    .sendMessage({
      type: 'ANSWER_GENERATION_PROGRESS',
      ...(generationId ? { generationId } : {}),
      ...(fieldId ? { fieldId } : {}),
      state,
      completed,
      total,
      message,
    })
    .catch(() => undefined);
}

function broadcastPlanUpdated(plan: DeterministicFillPlan): void {
  console.info('[agent] fill plan updated', {
    planId: plan.id,
    scanId: plan.scanId,
    actionCount: plan.actions.length,
    approvedCount: plan.actions.filter((action) => action.approved).length,
  });
  void chrome.runtime
    .sendMessage({ type: 'FILL_PLAN_UPDATED', planId: plan.id, updatedAt: plan.updatedAt })
    .catch(() => undefined);
}

async function persistPlan(plan: DeterministicFillPlan): Promise<DeterministicFillPlan> {
  await saveFillPlan(plan);
  broadcastPlanUpdated(plan);
  return plan;
}

async function loadSynchronizedPlan(): Promise<{
  plan: DeterministicFillPlan | null;
  scan: Awaited<ReturnType<typeof loadLastScan>>;
}> {
  const [plan, scan, store] = await Promise.all([
    loadFillPlan(),
    loadLastScan(),
    loadAnswerGenerationStore(),
  ]);
  if (!plan || !scan || plan.scanId !== scan.id) return { plan, scan };
  try {
    const synchronized = synchronizeGeneratedActions(plan, store, scan.fields);
    if (synchronized.updatedAt !== plan.updatedAt) await persistPlan(synchronized);
    return { plan: synchronized, scan };
  } catch (cause) {
    console.warn('[agent] generated plan reconciliation failed', {
      planId: plan.id,
      scanId: scan.id,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return { plan, scan };
  }
}

async function persistGeneratedRecord(
  plan: DeterministicFillPlan,
  record: AnswerGenerationRecord,
  field: NonNullable<Awaited<ReturnType<typeof loadLastScan>>>['fields'][number],
  pageUrl: string,
): Promise<{ record: AnswerGenerationRecord }> {
  const retained = answerGenerationRecordSchema.parse({
    ...record,
    targetField: field,
    pageUrl,
  });
  await saveAnswerGenerationRecord(retained.scanId, retained.planId, retained);
  await persistPlan(applyRecordToPlan(plan, retained, field));
  return { record: retained };
}

async function updateGeneratedFillStates(
  plan: DeterministicFillPlan,
  report: FillRunReport,
): Promise<void> {
  const store = await loadAnswerGenerationStore();
  if (!store || store.planId !== plan.id) return;
  const resultByAction = new Map(report.results.map((result) => [result.actionId, result]));
  const records = store.records.map((record) => {
    const action = plan.actions.find((candidate) => candidate.generationId === record.id);
    const result = action ? resultByAction.get(action.id) : undefined;
    if (!result) return record;
    return answerGenerationRecordSchema.parse({
      ...record,
      state:
        result.status === 'verified'
          ? 'verified'
          : result.status === 'failed' || result.status === 'cancelled'
            ? 'failed'
            : 'filled',
      updatedAt: new Date().toISOString(),
      ...(result.error ? { error: result.error } : {}),
    });
  });
  await saveAnswerGenerationStore({
    ...store,
    records,
    updatedAt: new Date().toISOString(),
  });
}

async function generateOne(
  fieldId: string,
  generationId = `generation-${crypto.randomUUID()}`,
  mode: RegenerationMode = 'default',
  userEvidence: string[] = [],
): Promise<unknown> {
  const context = await answerContext(fieldId);
  if ('error' in context) return { error: context.error };
  broadcastGenerationProgress(
    generationId,
    fieldId,
    'gathering_context',
    0,
    1,
    'Gathering verified evidence…',
  );
  broadcastGenerationProgress(
    generationId,
    fieldId,
    'generating',
    0,
    1,
    'Generating locally with Ollama…',
  );
  const generationRequest = makeGenerationRequest(context, generationId, mode, userEvidence);
  trace('generation', 'requesting local answer', {
    generationId,
    fieldId,
    planId: context.plan.id,
    configuredModel: generationRequest.settings.generationModel,
    aiGenerationEnabled: generationRequest.aiGenerationEnabled,
    settingsSource: 'chrome.storage.local.settings',
    settingsUpdatedAt: generationRequest.settingsUpdatedAt,
    settingsVersion: generationRequest.settingsVersion,
    backgroundCacheVersion: 'none',
    regenerationMode: mode,
    evidenceOverrideCount: userEvidence.length,
  });
  const response = await generateAnswer(generationRequest);
  if (response.error) {
    traceFailure('generation', 'local answer request failed', {
      generationId,
      fieldId,
      code: response.error.code,
    });
    broadcastGenerationProgress(generationId, fieldId, 'failed', 1, 1, response.error.message);
    return { error: response.error };
  }
  const record = answerGenerationRecordSchema.parse(response.data);
  trace('generation', 'local answer request completed', {
    generationId,
    fieldId,
    state: record.state,
    model: record.model,
    durationMs: record.generationDurationMs,
  });
  broadcastGenerationProgress(
    generationId,
    fieldId,
    record.state,
    1,
    1,
    record.state === 'ready_for_review'
      ? 'Answer ready for review.'
      : (record.error?.message ?? `Generation ended: ${record.state}.`),
  );
  return persistGeneratedRecord(context.plan, record, context.field, context.scan.url);
}

async function generateAll(): Promise<unknown> {
  const [scan, plan, settings, existing] = await Promise.all([
    loadLastScan(),
    loadFillPlan(),
    loadSettings(),
    loadAnswerGenerationStore(),
  ]);
  if (!scan || !plan || plan.scanId !== scan.id) {
    return { error: answerFailure('INVALID_FILL_PLAN', 'Build a current fill plan first.') };
  }
  if (!settings.aiGenerationEnabled) {
    return { error: answerFailure('AI_DISABLED', 'Local AI generation is disabled.') };
  }
  const approvedFields = new Set(
    existing?.records.filter((record) => record.approved).map((record) => record.fieldId) ?? [],
  );
  const fields = scan.fields
    .filter((field) => isAiEligibleField(field) && !approvedFields.has(field.id))
    .sort((left, right) => Number(right.required) - Number(left.required));
  if (!fields.length) {
    return {
      store:
        existing ??
        ({
          scanId: scan.id,
          planId: plan.id,
          records: [],
          updatedAt: new Date().toISOString(),
        } as const),
    };
  }
  const requests = fields.map((field) =>
    makeGenerationRequest(
      { scan, plan, field, settings },
      `generation-${crypto.randomUUID()}`,
      'default',
    ),
  );
  broadcastGenerationProgress(
    undefined,
    undefined,
    'queued',
    0,
    requests.length,
    'Queued custom answers…',
  );
  const result = await generateAnswerBatch(requests);
  if (result.error) return { error: result.error };
  let nextPlan = plan;
  const records = [
    ...(existing?.scanId === scan.id && existing.planId === plan.id ? existing.records : []),
  ];
  for (let index = 0; index < result.data.records.length; index += 1) {
    const serverRecord = result.data.records[index]!;
    const field = scan.fields.find((candidate) => candidate.id === serverRecord.fieldId);
    if (!field) {
      console.warn('[agent] generated record has no scan field', {
        planId: plan.id,
        generationId: serverRecord.id,
        fieldId: serverRecord.fieldId,
      });
      continue;
    }
    const record = answerGenerationRecordSchema.parse({
      ...serverRecord,
      targetField: field,
      pageUrl: scan.url,
    });
    const previous = records.findIndex((candidate) => candidate.id === record.id);
    if (previous >= 0) records[previous] = record;
    else records.push(record);
    nextPlan = applyRecordToPlan(nextPlan, record, field);
    broadcastGenerationProgress(
      record.id,
      record.fieldId,
      record.state,
      index + 1,
      result.data.records.length,
      record.state === 'ready_for_review'
        ? 'Answer ready for review.'
        : (record.error?.message ?? `Generation ended: ${record.state}.`),
    );
  }
  const store = await saveAnswerGenerationStore({
    scanId: scan.id,
    planId: plan.id,
    records,
    updatedAt: new Date().toISOString(),
  });
  await persistPlan(nextPlan);
  return { store };
}

async function mutateGeneratedRecord(
  generationId: string,
  mutate: (record: AnswerGenerationRecord) => AnswerGenerationRecord,
): Promise<unknown> {
  const [store, plan, scan] = await Promise.all([
    loadAnswerGenerationStore(),
    loadFillPlan(),
    loadLastScan(),
  ]);
  const record = store?.records.find((candidate) => candidate.id === generationId);
  if (!store || !plan || !record || store.planId !== plan.id) {
    return { error: answerFailure('NOT_FOUND', 'The generated answer is missing or stale.') };
  }
  const updated = answerGenerationRecordSchema.parse(mutate(record));
  await saveAnswerGenerationRecord(store.scanId, store.planId, updated);
  const field = scan?.fields.find((candidate) => candidate.id === updated.fieldId);
  await persistPlan(applyRecordToPlan(plan, updated, field));
  return { record: updated };
}

async function regenerate(generationId: string, mode: RegenerationMode): Promise<unknown> {
  const store = await loadAnswerGenerationStore();
  const record = store?.records.find((candidate) => candidate.id === generationId);
  if (!record) return { error: answerFailure('NOT_FOUND', 'The generated answer is missing.') };
  return generateOne(
    record.fieldId,
    generationId,
    mode,
    record.userEvidence.map((evidence) => evidence.text),
  );
}

async function approveGenerated(generationId: string): Promise<unknown> {
  const store = await loadAnswerGenerationStore();
  const record = store?.records.find((candidate) => candidate.id === generationId);
  if (!record || !answerText(record) || record.validation?.valid !== true) {
    return {
      error: answerFailure(
        'ANSWER_NOT_APPROVED',
        'The answer must be non-empty, valid, and reviewed before approval.',
        record?.fieldId,
      ),
    };
  }
  return mutateGeneratedRecord(generationId, (current) => ({
    ...current,
    approved: true,
    rejected: false,
    leaveBlank: false,
    state: 'approved',
    updatedAt: new Date().toISOString(),
  }));
}

async function saveGeneratedAsApproved(
  generationId: string,
  scope: 'general' | 'company' | 'job',
): Promise<unknown> {
  const [store, scan] = await Promise.all([loadAnswerGenerationStore(), loadLastScan()]);
  const record = store?.records.find((candidate) => candidate.id === generationId);
  const answer = record ? answerText(record) : undefined;
  if (!record || !answer || !record.approved || record.validation?.valid !== true) {
    return {
      error: answerFailure('ANSWER_NOT_APPROVED', 'Approve a valid answer before saving it.'),
    };
  }
  const created = await createAnswer({
    canonicalQuestion: record.question,
    normalizedQuestion: record.question.toLowerCase().replace(/\s+/g, ' ').trim(),
    aliases: [],
    answerType: 'text',
    answer,
    category: record.classification,
    approved: true,
    autoFillAllowed: false,
    sensitive: false,
    tailoringAllowed: true,
    requiresReview: true,
    classification: record.classification,
    evidenceReferences: record.candidate?.evidenceUsed ?? [],
    scope,
    ...(scope === 'company' && scan?.jobContext.company
      ? { scopeReference: scan.jobContext.company }
      : scope === 'job' && scan?.jobContext.jobTitle
        ? { scopeReference: scan.jobContext.jobTitle }
        : {}),
    wordCount: record.candidate?.wordCount,
    createdAt: record.createdAt,
  });
  return created.error ? { ok: false, error: created.error } : { ok: true };
}

async function clearGenerated(generationId: string): Promise<unknown> {
  const [store, plan, scan] = await Promise.all([
    loadAnswerGenerationStore(),
    loadFillPlan(),
    loadLastScan(),
  ]);
  if (!store || !plan) return { ok: true };
  const record = store.records.find((candidate) => candidate.id === generationId);
  if (!record) return { ok: true };
  const cleared: AnswerGenerationRecord = {
    ...record,
    approved: false,
    rejected: true,
    leaveBlank: false,
    state: 'rejected',
    updatedAt: new Date().toISOString(),
  };
  await saveAnswerGenerationStore({
    ...store,
    records: store.records.filter((candidate) => candidate.id !== generationId),
    updatedAt: new Date().toISOString(),
  });
  const field = scan?.fields.find((candidate) => candidate.id === cleared.fieldId);
  await persistPlan(applyRecordToPlan(plan, cleared, field));
  return { ok: true };
}

async function mutatePlan(
  mutation: (
    plan: DeterministicFillPlan,
    scan: NonNullable<Awaited<ReturnType<typeof loadLastScan>>>,
  ) => DeterministicFillPlan,
): Promise<unknown> {
  const [plan, scan] = await Promise.all([loadFillPlan(), loadLastScan()]);
  if (!plan || !scan || plan.scanId !== scan.id) {
    return { error: fillFailure('INVALID_FILL_PLAN', 'The fill plan is missing or stale.').error };
  }
  try {
    const updated = mutation(plan, scan);
    await persistPlan(updated);
    return { plan: updated };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const code = detail === 'FIELD_NOT_FOUND' ? 'FIELD_NOT_FOUND' : 'INVALID_FILL_PLAN';
    return { error: fillFailure(code, `The fill-plan update failed: ${detail}`).error };
  }
}

async function executeApproved(targetUrl?: string): Promise<unknown> {
  const { plan, scan } = await loadSynchronizedPlan();
  if (!plan || !scan || plan.scanId !== scan.id || plan.url !== scan.url) {
    return fillFailure('STALE_FILL_PLAN', 'The fill plan does not match the latest scan.');
  }
  const store = await loadAnswerGenerationStore();
  for (const action of plan.actions.filter(
    (candidate) => candidate.action === 'fill_generated_text' && candidate.approved,
  )) {
    const record = store?.records.find((candidate) => candidate.id === action.generationId);
    if (!record) {
      return fillFailure(
        'GENERATED_ACTION_NOT_IN_PLAN',
        'An approved generated action has no current generation record.',
        { planId: plan.id, generationId: action.generationId, fieldId: action.fieldId },
      );
    }
    if (!record.approved) {
      return fillFailure('GENERATED_ACTION_NOT_APPROVED', 'The generated record is not approved.', {
        planId: plan.id,
        generationId: record.id,
        fieldId: record.fieldId,
      });
    }
  }
  const approvedRecords =
    store?.planId === plan.id
      ? store.records.filter((record) => record.approved && !record.rejected && !record.leaveBlank)
      : [];
  for (const record of approvedRecords) {
    const action = plan.actions.find(
      (candidate) =>
        candidate.fieldId === record.fieldId &&
        candidate.generationId === record.id &&
        candidate.action === 'fill_generated_text',
    );
    if (!action) {
      return fillFailure(
        'GENERATED_ACTION_NOT_IN_PLAN',
        'An approved generated answer is not attached to the active fill plan.',
        { planId: plan.id, generationId: record.id, fieldId: record.fieldId },
      );
    }
    if (record.validation?.valid !== true || action.answerValidationPassed !== true) {
      return fillFailure(
        'GENERATED_ACTION_NOT_VALIDATED',
        'An approved generated answer no longer has a passing validation result.',
        { planId: plan.id, generationId: record.id, fieldId: record.fieldId },
      );
    }
    if (!action.approved) {
      return fillFailure(
        'GENERATED_ACTION_NOT_APPROVED',
        'The generated action is not approved in the active fill plan.',
        { planId: plan.id, generationId: record.id, fieldId: record.fieldId },
      );
    }
  }
  if (!plan.actions.some((action) => action.approved)) {
    return fillFailure('ACTION_NOT_APPROVED', 'No fill action is approved.');
  }
  const documentContents: DocumentContentResponse[] = [];
  for (const action of plan.actions.filter(
    (candidate) => candidate.action === 'upload_file' && candidate.approved,
  )) {
    if (!action.documentId) {
      return fillFailure('DOCUMENT_MISSING', 'An approved upload has no document reference.');
    }
    const content = await getDocumentContent(action.documentId);
    if (content.error) return { error: content.error };
    documentContents.push(content.data);
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await activeApplicationTab(targetUrl ?? plan.url);
  } catch {
    try {
      const current = await activeApplicationTab();
      if (current.url && new URL(current.url).hostname === plan.domain) {
        return fillFailure(
          'PAGE_CHANGED',
          'The application tab navigated away from the scanned URL.',
        );
      }
    } catch {
      // The terminal unavailable error below is more useful than the fallback error.
    }
    return fillFailure('ACTIVE_TAB_UNAVAILABLE', 'The scanned application tab is not open.');
  }
  if (tab.url !== plan.url || new URL(tab.url).hostname !== plan.domain) {
    return fillFailure(
      'PAGE_CHANGED',
      'The current tab no longer matches the scanned application.',
    );
  }
  const runId = `fill-${crypto.randomUUID()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw: unknown = await Promise.race([
      chrome.tabs.sendMessage(tab.id!, {
        type: 'EXECUTE_FILL_PLAN',
        runId,
        scan,
        plan,
        documentContents,
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('FILL_TIMEOUT')), FILL_TIMEOUT_MS);
      }),
    ]);
    const response = fillExecutionResponseSchema.parse(raw);
    if (response.type === 'FILL_COMPLETE') {
      await saveFillReport(response.report);
      await updateGeneratedFillStates(plan, response.report);
      console.info('[agent] fill complete', {
        runId: response.report.id,
        planId: plan.id,
        adapter: plan.ats,
        approved: response.report.approvedActions,
        verified: response.report.verifiedActions,
        failed: response.report.failedActions,
      });
    }
    return response;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return fillFailure(
      detail === 'FILL_TIMEOUT' ? 'FILL_TIMEOUT' : 'INVALID_FILL_PLAN',
      `The deterministic fill run could not complete: ${detail}`,
      { runId, planId: plan.id },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelFill(runId?: string, targetUrl?: string): Promise<unknown> {
  try {
    const plan = await loadFillPlan();
    const tab = await activeApplicationTab(targetUrl ?? plan?.url);
    await chrome.tabs.sendMessage(tab.id!, {
      type: 'FILL_CANCEL',
      ...(runId ? { runId } : {}),
    });
  } catch {
    // Cancellation is idempotent.
  }
  return { ok: true };
}

async function cancelScan(scanId?: string, targetUrl?: string): Promise<unknown> {
  try {
    const tab = await activeApplicationTab(targetUrl);
    await chrome.tabs.sendMessage(tab.id!, { type: 'SCAN_CANCEL', ...(scanId ? { scanId } : {}) });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[agent] installed', { reason: details.reason });
});

/** Maps a message to the client call that serves it. */
function handle(message: ExtensionMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> | null {
  switch (message.type) {
    case 'AGENT_STATUS_REQUEST':
      return fetchAgentStatus();
    case 'APPLICATION_SESSION_CLAIM':
      return claimSessionForTab(message.sessionId, sender?.tab?.url);
    case 'GET_APPLICATION_SESSION':
      return loadApplicationSession().then((data) => ({ data }));
    case 'OLLAMA_MODELS_LIST':
      return listOllamaModels();
    case 'TEST_AI_GENERATION':
      return testAiGeneration(message.model, message.timeoutMs);
    case 'SETTINGS_UPDATED':
      trace('settings', 'persisted settings notification received', {
        aiGenerationEnabled: message.aiGenerationEnabled,
        settingsVersion: message.settingsVersion,
        settingsUpdatedAt: message.settingsUpdatedAt,
        backgroundCacheVersion: 'none',
      });
      return Promise.resolve({ ok: true });
    case 'PROFILE_GET':
      return getProfile();
    case 'PROFILE_SAVE':
      return saveProfile(message.profile);
    case 'DOCUMENTS_LIST':
      return listDocuments();
    case 'DOCUMENT_CREATE':
      return createDocument(message.document);
    case 'DOCUMENT_UPDATE':
      return updateDocument(message.id, message.patch);
    case 'DOCUMENT_DELETE':
      return deleteDocument(message.id);
    case 'DOCUMENT_EXTRACT':
      return extractDocument(message.id);
    case 'ANSWERS_LIST':
      return listAnswers();
    case 'ANSWER_CREATE':
      return createAnswer(message.answer);
    case 'ANSWER_UPDATE':
      return updateAnswer(message.id, message.answer);
    case 'ANSWER_DELETE':
      return deleteAnswer(message.id);
    case 'SCAN_APPLICATION':
      return startScan(message.scanId, message.targetUrl);
    case 'SCAN_PROGRESS':
      // Content progress is also delivered directly to extension-page listeners.
      return Promise.resolve({ ok: true });
    case 'SCAN_COMPLETE':
      return saveLastScan(message.result).then(() => ({ ok: true }));
    case 'SCAN_FAILED':
      return Promise.resolve({ ok: true });
    case 'SCAN_CANCEL':
      return cancelScan(message.scanId, message.targetUrl);
    case 'GET_LAST_SCAN':
      return loadLastScan().then((scan) => ({ scan }));
    case 'CLEAR_LAST_SCAN':
      return Promise.all([clearLastScan(), clearFillState(), clearAnswerGenerationStore()]).then(
        () => ({ ok: true }),
      );
    case 'BUILD_DETERMINISTIC_PLAN':
      return buildPlan(message.scanId);
    case 'GET_FILL_PLAN':
      return Promise.all([loadSynchronizedPlan(), loadFillReport()]).then(([current, report]) => ({
        plan: current.plan,
        report,
      }));
    case 'UPDATE_FILL_ACTION':
      return mutatePlan((plan, scan) => {
        const action = plan.actions.find((candidate) => candidate.id === message.actionId);
        const field = scan.fields.find((candidate) => candidate.id === action?.fieldId);
        if (!field) throw new Error('FIELD_NOT_FOUND');
        if (message.operation === 'reset')
          return resetActionOverride(plan, field, message.actionId);
        if (message.operation === 'skip') return skipAction(plan, message.actionId);
        if (message.value === undefined) throw new Error('Override value is required.');
        return updateActionOverride(plan, field, message.actionId, message.value);
      });
    case 'APPROVE_FILL_ACTION':
      return mutatePlan((plan) => {
        if (!plan.actions.some((action) => action.id === message.actionId)) {
          throw new Error('FIELD_NOT_FOUND');
        }
        return setActionApproval(plan, message.actionId, message.approved);
      });
    case 'APPROVE_SAFE_ACTIONS':
      return mutatePlan((plan) => approveSafeActions(plan));
    case 'EXECUTE_APPROVED_ACTIONS':
      return executeApproved(message.targetUrl);
    case 'FILL_PROGRESS':
      return Promise.resolve({ ok: true });
    case 'FILL_COMPLETE':
      return saveFillReport(message.report).then(() => ({ ok: true }));
    case 'FILL_FAILED':
      return Promise.resolve({ ok: true });
    case 'FILL_CANCEL':
      return cancelFill(message.runId, message.targetUrl);
    case 'FILL_PLAN_UPDATED':
      return Promise.resolve({ ok: true });
    case 'CLEAR_FILL_PLAN':
      return Promise.all([clearFillState(), clearAnswerGenerationStore()]).then(() => ({
        ok: true,
      }));
    case 'CLASSIFY_CUSTOM_QUESTION':
      return answerContext(message.fieldId).then((context) =>
        'error' in context
          ? { error: context.error }
          : classifyQuestionDeterministically(context.field.question),
      );
    case 'GENERATE_CUSTOM_ANSWER':
      return generateOne(message.fieldId);
    case 'GENERATE_ALL_CUSTOM_ANSWERS':
      return generateAll();
    case 'CANCEL_ANSWER_GENERATION':
      return cancelAnswerGeneration(message.generationId).then((result) =>
        result.error ? { ok: false, error: result.error } : { ok: true },
      );
    case 'GET_GENERATED_ANSWERS':
      return loadAnswerGenerationStore().then((store) => ({ store }));
    case 'UPDATE_GENERATED_ANSWER':
      return mutateGeneratedRecord(message.generationId, (record) => {
        if (message.operation === 'leave_blank') {
          return {
            ...record,
            approved: false,
            rejected: true,
            leaveBlank: true,
            state: 'rejected',
            updatedAt: new Date().toISOString(),
          };
        }
        if (message.operation === 'reset') {
          const candidate = record.originalCandidate ?? record.candidate;
          return {
            ...record,
            candidate,
            originalCandidate: undefined,
            originalValidation: undefined,
            editedAnswer: undefined,
            source: 'ai_generated',
            validation: record.originalValidation ?? record.validation,
            approved: false,
            rejected: false,
            leaveBlank: false,
            state: (record.originalValidation ?? record.validation)?.valid
              ? 'ready_for_review'
              : 'failed',
            updatedAt: new Date().toISOString(),
          };
        }
        return updateManualAnswer(record, message.answer ?? '');
      });
    case 'APPROVE_GENERATED_ANSWER':
      return approveGenerated(message.generationId);
    case 'REJECT_GENERATED_ANSWER':
      return mutateGeneratedRecord(message.generationId, (record) => ({
        ...record,
        approved: false,
        rejected: true,
        leaveBlank: false,
        state: 'rejected',
        updatedAt: new Date().toISOString(),
      }));
    case 'REGENERATE_GENERATED_ANSWER':
      return regenerate(message.generationId, message.mode);
    case 'ADD_ANSWER_EVIDENCE':
      return mutateGeneratedRecord(message.generationId, (record) => ({
        ...record,
        userEvidence: [
          ...record.userEvidence,
          {
            id: `user-evidence-${crypto.randomUUID()}`,
            source: 'user_override',
            sourceReference: `answerGenerations.${record.id}.userEvidence`,
            category: 'other',
            text: message.text,
            facts: [message.text],
            relevanceScore: 100,
            sensitive: false,
            verified: true,
          },
        ],
        approved: false,
        state: 'needs_user_input',
        updatedAt: new Date().toISOString(),
      }));
    case 'SAVE_AS_APPROVED_ANSWER':
      return saveGeneratedAsApproved(message.generationId, message.scope);
    case 'CLEAR_GENERATED_ANSWER':
      return clearGenerated(message.generationId);
    case 'ANSWER_GENERATION_PROGRESS':
    case 'ANSWER_GENERATION_COMPLETE':
    case 'ANSWER_GENERATION_FAILED':
      return Promise.resolve({ ok: true });
    case 'EXECUTE_FILL_PLAN':
      return null;
    case 'CONTENT_PING':
      // Handled by the content script, not here.
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'SETTINGS_UPDATED'
  ) {
    const parsed = settingsUpdatedMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendResponse({
        ok: false,
        error: answerFailure(
          'VALIDATION_FAILED',
          'A settings update message failed shared schema validation.',
        ),
      });
      return false;
    }
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    String(message.type).startsWith('SCAN_')
  ) {
    const parsed = scanMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendResponse(
        scanFailure('INVALID_SCAN_RESULT', 'A scan message failed shared schema validation.'),
      );
      return false;
    }
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (String(message.type).includes('ANSWER') ||
      String(message.type).includes('CUSTOM_QUESTION') ||
      String(message.type) === 'CANCEL_ANSWER_GENERATION')
  ) {
    const parsed = answerGenerationMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendResponse({
        error: answerFailure(
          'VALIDATION_FAILED',
          'An answer-generation message failed shared schema validation.',
        ),
      });
      return false;
    }
  }
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (String(message.type).startsWith('FILL_') ||
      [
        'BUILD_DETERMINISTIC_PLAN',
        'GET_FILL_PLAN',
        'UPDATE_FILL_ACTION',
        'APPROVE_FILL_ACTION',
        'APPROVE_SAFE_ACTIONS',
        'EXECUTE_APPROVED_ACTIONS',
        'CLEAR_FILL_PLAN',
      ].includes(String(message.type)))
  ) {
    const parsed = fillMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendResponse(
        fillFailure('INVALID_FILL_PLAN', 'A fill message failed shared schema validation.'),
      );
      return false;
    }
  }
  trace('worker', 'received request', { type: message?.type });
  const pending = handle(message, sender);

  if (!pending) {
    // Returning false makes Chrome resolve the sender's promise with `undefined`.
    // Log it loudly: in practice it means the page is newer than this worker, and
    // the sender turns it into an "reload the extension" error.
    traceFailure('worker', 'no handler for message type', { type: message?.type });
    return false;
  }

  pending.then(
    (result) => {
      trace('worker', 'responding', { type: message.type });
      sendResponse(result);
    },
    (cause: unknown) => {
      // The client converts server failures into results, so reaching here means
      // the worker itself broke. The caller must still see something actionable.
      traceFailure('worker', 'handler threw', {
        type: message.type,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      sendResponse({
        error: workerFailure(
          `The background worker failed handling ${message.type}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
        // Also satisfies AgentStatusResult, whose consumers read these fields.
        latencyMs: 0,
        serverUrl: '',
        tokenConfigured: false,
      });
    },
  );

  return true; // response is asynchronous
});
