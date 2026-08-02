import { DEFAULT_ERROR_GUIDANCE } from '@internship-agent/shared';
import { z } from 'zod';
import { trace, traceFailure } from '../utils/trace.js';
import type {
  AgentError,
  ApprovedAnswer,
  ApprovedAnswerInput,
  DocumentListResponse,
  DocumentUpdate,
  DocumentUpload,
  HealthResponse,
  ModelsResponse,
  AiGenerationTestResponse,
  Profile,
  ProfileCompleteness,
  ProfileUpdate,
  SavedDocument,
  DocumentExtraction,
  ScanApplicationResponse,
  ScanMessage,
  GetLastScanResponse,
  FillMessage,
  FillPlanResponse,
  GetFillPlanResponse,
  FillExecutionResponse,
  AnswerGenerationMessage,
  AnswerGenerationRecord,
  AnswerGenerationStore,
  QuestionClassificationResult,
  SettingsUpdatedMessage,
  ApplicationBundle,
  ApplicationBundleTransfer,
  BundleAcknowledgement,
  BundleRejection,
} from '@internship-agent/shared';
import {
  clearLastScanResponseSchema,
  getLastScanResponseSchema,
  scanAckSchema,
  scanApplicationResponseSchema,
  fillAckSchema,
  fillExecutionResponseSchema,
  fillPlanResponseSchema,
  getFillPlanResponseSchema,
  generatedAnswerResponseSchema,
  generatedAnswersResponseSchema,
  answerGenerationAckSchema,
  agentErrorSchema,
  modelsResponseSchema,
  aiGenerationTestResponseSchema,
} from '@internship-agent/shared';

/**
 * Every message crossing an extension boundary is one of these. Keeping the
 * union closed means the background worker can exhaustively switch on `type`
 * and reject anything unrecognized.
 *
 * The popup and options page never call the agent server directly — the
 * background worker is the only network client, so the token lives in exactly
 * one place.
 */
export type ExtensionMessage =
  | { type: 'AGENT_STATUS_REQUEST' }
  | { type: 'CONTENT_PING' }
  | { type: 'SAVE_APPLICATION_BUNDLE'; bundle: ApplicationBundleTransfer }
  | { type: 'GET_ACTIVE_BUNDLE'; url?: string }
  | { type: 'LIST_BUNDLES' }
  | { type: 'SET_ACTIVE_BUNDLE'; bundleId: string }
  | { type: 'DELETE_BUNDLE'; bundleId: string }
  | { type: 'PROFILE_GET' }
  | { type: 'PROFILE_SAVE'; profile: ProfileUpdate }
  | { type: 'DOCUMENTS_LIST' }
  | { type: 'DOCUMENT_CREATE'; document: DocumentUpload }
  | { type: 'DOCUMENT_UPDATE'; id: string; patch: DocumentUpdate }
  | { type: 'DOCUMENT_DELETE'; id: string }
  | { type: 'DOCUMENT_EXTRACT'; id: string }
  | { type: 'OLLAMA_MODELS_LIST' }
  | { type: 'TEST_AI_GENERATION'; model: string; timeoutMs: number }
  | SettingsUpdatedMessage
  | { type: 'ANSWERS_LIST' }
  | { type: 'ANSWER_CREATE'; answer: ApprovedAnswerInput }
  | { type: 'ANSWER_UPDATE'; id: string; answer: ApprovedAnswerInput }
  | { type: 'ANSWER_DELETE'; id: string }
  | ScanMessage
  | FillMessage
  | AnswerGenerationMessage;

/**
 * Uniform result for anything that talks to the server. There is no thrown-error
 * path across the message boundary: a failure is data, so every caller is forced
 * to render it.
 */
export type AgentResult<T> =
  { data: T; error?: undefined } | { data?: undefined; error: AgentError };

export interface ProfilePayload {
  profile: Profile;
  completeness: ProfileCompleteness;
}

/** Which resume would be attached, and why that one. */
export interface ResumeSelection {
  documentId: string;
  name: string;
  reason: 'user_selected' | 'default';
}

export interface AgentStatusResult {
  /** Present only when the server answered and its payload validated. */
  health?: HealthResponse;
  error?: AgentError;
  /** Round trip to the local server, for the popup's diagnostics line. */
  latencyMs: number;
  serverUrl: string;
  tokenConfigured: boolean;
  /**
   * Resolved only when a token is configured. `null` means the server answered
   * and no resume is registered — distinct from `undefined`, which means we
   * could not ask.
   */
  selectedResume?: ResumeSelection | null;
}

export interface ContentPingResult {
  present: true;
  url: string;
  /**
   * Milestone 1 does not scan anything. This is reported as `null` — not `0` —
   * so the popup can say "not analyzed" rather than "zero fields found".
   */
  fieldsDetected: null;
}

export type ExtensionResponse<M extends ExtensionMessage['type']> = M extends 'AGENT_STATUS_REQUEST'
  ? AgentStatusResult
  : M extends 'SAVE_APPLICATION_BUNDLE'
    ? { result: BundleAcknowledgement | BundleRejection }
    : M extends 'GET_ACTIVE_BUNDLE' | 'SET_ACTIVE_BUNDLE'
    ? AgentResult<ApplicationBundle | null>
    : M extends 'LIST_BUNDLES'
    ? AgentResult<{ bundles: ApplicationBundle[] }>
    : M extends 'DELETE_BUNDLE'
    ? { ok: true } | { ok: false; error: AgentError }
    : M extends 'OLLAMA_MODELS_LIST'
    ? AgentResult<ModelsResponse>
    : M extends 'TEST_AI_GENERATION'
      ? AgentResult<AiGenerationTestResponse>
      : M extends 'SETTINGS_UPDATED'
        ? { ok: true }
        : M extends 'CONTENT_PING'
          ? ContentPingResult
          : M extends 'PROFILE_GET' | 'PROFILE_SAVE'
            ? AgentResult<ProfilePayload>
            : M extends 'DOCUMENTS_LIST'
              ? AgentResult<DocumentListResponse>
              : M extends 'DOCUMENT_CREATE' | 'DOCUMENT_UPDATE'
                ? AgentResult<SavedDocument>
                : M extends 'DOCUMENT_DELETE' | 'ANSWER_DELETE'
                  ? AgentResult<{ id: string }>
                  : M extends 'DOCUMENT_EXTRACT'
                    ? AgentResult<DocumentExtraction>
                    : M extends 'ANSWERS_LIST'
                      ? AgentResult<{ answers: ApprovedAnswer[] }>
                      : M extends 'ANSWER_CREATE' | 'ANSWER_UPDATE'
                        ? AgentResult<ApprovedAnswer>
                        : M extends 'SCAN_APPLICATION'
                          ? ScanApplicationResponse
                          : M extends
                                'SCAN_CANCEL' | 'SCAN_PROGRESS' | 'SCAN_COMPLETE' | 'SCAN_FAILED'
                            ? { ok: true }
                            : M extends 'GET_LAST_SCAN'
                              ? GetLastScanResponse
                              : M extends 'CLEAR_LAST_SCAN'
                                ? { ok: true } | { ok: false; error: AgentError }
                                : M extends
                                      | 'BUILD_DETERMINISTIC_PLAN'
                                      | 'UPDATE_FILL_ACTION'
                                      | 'APPROVE_FILL_ACTION'
                                      | 'APPROVE_SAFE_ACTIONS'
                                  ? FillPlanResponse
                                  : M extends 'GET_FILL_PLAN'
                                    ? GetFillPlanResponse
                                    : M extends 'EXECUTE_APPROVED_ACTIONS' | 'EXECUTE_FILL_PLAN'
                                      ? FillExecutionResponse
                                      : M extends
                                            | 'FILL_PROGRESS'
                                            | 'FILL_COMPLETE'
                                            | 'FILL_FAILED'
                                            | 'FILL_CANCEL'
                                            | 'CLEAR_FILL_PLAN'
                                            | 'FILL_PLAN_UPDATED'
                                        ? { ok: true } | { ok: false; error: AgentError }
                                        : M extends 'CLASSIFY_CUSTOM_QUESTION'
                                          ? QuestionClassificationResult | { error: AgentError }
                                          : M extends
                                                | 'GENERATE_CUSTOM_ANSWER'
                                                | 'UPDATE_GENERATED_ANSWER'
                                                | 'APPROVE_GENERATED_ANSWER'
                                                | 'REJECT_GENERATED_ANSWER'
                                                | 'REGENERATE_GENERATED_ANSWER'
                                                | 'ADD_ANSWER_EVIDENCE'
                                            ? | { record: AnswerGenerationRecord }
                                              | { error: AgentError }
                                            : M extends
                                                  | 'GENERATE_ALL_CUSTOM_ANSWERS'
                                                  | 'GET_GENERATED_ANSWERS'
                                              ? | { store: AnswerGenerationStore | null }
                                                | { error: AgentError }
                                              : M extends
                                                    | 'CANCEL_ANSWER_GENERATION'
                                                    | 'ANSWER_GENERATION_PROGRESS'
                                                    | 'ANSWER_GENERATION_COMPLETE'
                                                    | 'ANSWER_GENERATION_FAILED'
                                                    | 'SAVE_AS_APPROVED_ANSWER'
                                                    | 'CLEAR_GENERATED_ANSWER'
                                                ? { ok: true } | { ok: false; error: AgentError }
                                                : never;

/**
 * A message must never leave a caller waiting indefinitely. The background worker
 * is a service worker that Chrome can terminate mid-flight, so this is a real
 * failure mode rather than a theoretical one.
 */
const MESSAGE_TIMEOUT_MS = 15_000;
const SCAN_MESSAGE_TIMEOUT_MS = 25_000;
const FILL_MESSAGE_TIMEOUT_MS = 35_000;
const ANSWER_MESSAGE_TIMEOUT_MS = 390_000;

function timeoutFor(type: ExtensionMessage['type']): number {
  if (type === 'SCAN_APPLICATION') return SCAN_MESSAGE_TIMEOUT_MS;
  if (type === 'EXECUTE_APPROVED_ACTIONS' || type === 'EXECUTE_FILL_PLAN') {
    return FILL_MESSAGE_TIMEOUT_MS;
  }
  if (
    type.includes('ANSWER') ||
    type.includes('CUSTOM_QUESTION') ||
    type === 'CANCEL_ANSWER_GENERATION'
  ) {
    return ANSWER_MESSAGE_TIMEOUT_MS;
  }
  if (type === 'TEST_AI_GENERATION') return ANSWER_MESSAGE_TIMEOUT_MS;
  return MESSAGE_TIMEOUT_MS;
}

function validateScanResponse(type: ExtensionMessage['type'], response: unknown): unknown {
  switch (type) {
    case 'OLLAMA_MODELS_LIST':
      return z
        .union([z.object({ data: modelsResponseSchema }), z.object({ error: agentErrorSchema })])
        .parse(response);
    case 'TEST_AI_GENERATION':
      return z
        .union([
          z.object({ data: aiGenerationTestResponseSchema }),
          z.object({ error: agentErrorSchema }),
        ])
        .parse(response);
    case 'SETTINGS_UPDATED':
      return z.object({ ok: z.literal(true) }).parse(response);
    case 'SCAN_APPLICATION':
      return scanApplicationResponseSchema.parse(response);
    case 'SCAN_CANCEL':
    case 'SCAN_PROGRESS':
    case 'SCAN_COMPLETE':
    case 'SCAN_FAILED':
      return scanAckSchema.parse(response);
    case 'GET_LAST_SCAN':
      return getLastScanResponseSchema.parse(response);
    case 'CLEAR_LAST_SCAN':
      return clearLastScanResponseSchema.parse(response);
    case 'BUILD_DETERMINISTIC_PLAN':
    case 'UPDATE_FILL_ACTION':
    case 'APPROVE_FILL_ACTION':
    case 'APPROVE_SAFE_ACTIONS':
      return fillPlanResponseSchema.parse(response);
    case 'GET_FILL_PLAN':
      return getFillPlanResponseSchema.parse(response);
    case 'EXECUTE_APPROVED_ACTIONS':
    case 'EXECUTE_FILL_PLAN':
      return fillExecutionResponseSchema.parse(response);
    case 'FILL_PROGRESS':
    case 'FILL_COMPLETE':
    case 'FILL_FAILED':
    case 'FILL_CANCEL':
    case 'CLEAR_FILL_PLAN':
    case 'FILL_PLAN_UPDATED':
      return fillAckSchema.parse(response);
    case 'GENERATE_CUSTOM_ANSWER':
    case 'UPDATE_GENERATED_ANSWER':
    case 'APPROVE_GENERATED_ANSWER':
    case 'REJECT_GENERATED_ANSWER':
    case 'REGENERATE_GENERATED_ANSWER':
    case 'ADD_ANSWER_EVIDENCE':
      return generatedAnswerResponseSchema.parse(response);
    case 'GENERATE_ALL_CUSTOM_ANSWERS':
    case 'GET_GENERATED_ANSWERS':
      return generatedAnswersResponseSchema.parse(response);
    case 'CANCEL_ANSWER_GENERATION':
    case 'ANSWER_GENERATION_PROGRESS':
    case 'ANSWER_GENERATION_COMPLETE':
    case 'ANSWER_GENERATION_FAILED':
    case 'SAVE_AS_APPROVED_ANSWER':
    case 'CLEAR_GENERATED_ANSWER':
      return answerGenerationAckSchema.parse(response);
    default:
      return response;
  }
}

function reloadRequired(message: string, debugContext: Record<string, unknown>): AgentError {
  return {
    code: 'EXTENSION_RELOAD_REQUIRED',
    message,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.EXTENSION_RELOAD_REQUIRED,
    debugContext,
  };
}

/**
 * Every failure shape is folded into one object that satisfies both response
 * shapes in this union: `error` for `AgentResult`, plus the scalar fields
 * `AgentStatusResult` consumers read. That keeps a caller's `result.error` check
 * valid no matter how the round trip failed.
 */
function failureResponse(error: AgentError): Record<string, unknown> {
  return { error, latencyMs: 0, serverUrl: '', tokenConfigured: false };
}

/**
 * Sends a message to the background worker and **always** resolves with a usable
 * result — never `undefined`, and never a rejected promise.
 *
 * Chrome resolves `sendMessage` with `undefined` when no listener handles a
 * message type. That happens whenever the worker in the browser is older than the
 * page asking it, which used to surface as a `TypeError` inside the caller and a
 * screen stuck on "Loading…". It is now reported as a recoverable error naming
 * the remedy.
 */
export async function sendMessage<M extends ExtensionMessage>(
  message: M,
): Promise<ExtensionResponse<M['type']>> {
  trace('messaging', 'sending message to background', { type: message.type });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response within ${timeoutFor(message.type)}ms`)),
          timeoutFor(message.type),
        );
      }),
    ]);

    if (response === undefined || response === null || typeof response !== 'object') {
      traceFailure('messaging', 'background did not answer', {
        type: message.type,
        received: typeof response,
      });
      return failureResponse(
        reloadRequired(
          `The background worker did not answer "${message.type}". Its build is probably older than this page.`,
          { messageType: message.type, received: typeof response },
        ),
      ) as ExtensionResponse<M['type']>;
    }

    const validated = validateScanResponse(message.type, response);
    trace('messaging', 'received response', { type: message.type });
    return validated as ExtensionResponse<M['type']>;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    traceFailure('messaging', 'message failed', { type: message.type, error: detail });
    return failureResponse(
      reloadRequired(`Could not reach the background worker for "${message.type}": ${detail}`, {
        messageType: message.type,
      }),
    ) as ExtensionResponse<M['type']>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
