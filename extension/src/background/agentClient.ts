import {
  AUTH_HEADER,
  DEFAULT_ERROR_GUIDANCE,
  TIMEOUTS,
  agentErrorSchema,
  answerListResponseSchema,
  approvedAnswerSchema,
  documentListResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  modelsResponseSchema,
  aiGenerationTestRequestSchema,
  aiGenerationTestResponseSchema,
  profileCompletenessSchema,
  profileImportRequestSchema,
  profileSchema,
  profileSyncEntrySchema,
  type ProfileImportRequest,
  savedDocumentSchema,
  generateAnswerRequestSchema,
  generateAnswerResponseSchema,
  generateBatchRequestSchema,
  generateBatchResponseSchema,
  generationCancelResponseSchema,
  documentExtractionSchema,
  documentContentResponseSchema,
  latestDocumentListResponseSchema,
  latestDocumentContentResponseSchema,
  type LatestDocumentListResponse,
  type LatestDocumentContentResponse,
  formAnalysisResponseSchema,
  agentChoiceDecisionSchema,
  agentChoiceRequestSchema,
  type AgentChoiceDecision,
  type AgentChoiceRequest,
  type AgentError,
  type ApprovedAnswer,
  type ApprovedAnswerInput,
  type DocumentListResponse,
  type DocumentUpdate,
  type DocumentUpload,
  type ProfileUpdate,
  type SavedDocument,
  type GenerateAnswerRequest,
  type AnswerGenerationRecord,
  type DocumentExtraction,
  type DocumentContentResponse,
  type ModelsResponse,
  type AiGenerationTestResponse,
  type FormAnalysisRequest,
  type FormAnalysisResponse,
} from '@internship-agent/shared';
import { z } from 'zod';
import type {
  AgentResult,
  AgentStatusResult,
  ProfilePayload,
  ResumeSelection,
} from '../messaging/messages.js';
import { loadSettings } from '../storage/settings.js';
import { trace, traceFailure } from '../utils/trace.js';

function toAgentError(
  code: AgentError['code'],
  message: string,
  debugContext: Record<string, unknown> = {},
  recoverable = true,
): AgentError {
  return {
    code,
    message,
    recoverable,
    suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
    debugContext,
  };
}

const profilePayloadSchema = z.object({
  profile: profileSchema,
  completeness: profileCompletenessSchema,
});

const profileImportPayloadSchema = profilePayloadSchema.extend({
  report: z.array(profileSyncEntrySchema),
  changed: z.boolean(),
  migratedFrom: z.number().int().positive().nullable(),
});

export type ProfileImportPayload = z.infer<typeof profileImportPayloadSchema>;

const idOnlySchema = z.object({ id: z.string().min(1) });

interface RequestOptions<T> {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  body?: unknown;
  timeoutMs?: number;
  /** Some callers (the popup) need the round-trip time. */
  onLatency?: (latencyMs: number) => void;
  /**
   * The caller's own cancellation signal, when it has one. Aborting it aborts
   * the in-flight request, which is what makes Cancel reach a model call
   * already in progress rather than only taking effect at the next phase.
   */
  signal?: AbortSignal;
}

/**
 * The only function in the extension that performs a network request. Content
 * scripts, the popup, and the options page all reach the server through the
 * background worker, which means the token is read in exactly one place and page
 * code never sees it.
 */
async function request<T>(options: RequestOptions<T>): Promise<AgentResult<T>> {
  const settings = await loadSettings();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUTS.healthMs);
  // The run's own signal, when the caller has one. Without it, Cancel during a
  // sixty-second model call did nothing until the call returned on its own —
  // the cancelled flag is only read between phases.
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  trace('http', 'requesting', { method: options.method, path: options.path });

  try {
    const response = await fetch(`${settings.serverUrl}${options.path}`, {
      method: options.method,
      signal: controller.signal,
      headers: {
        ...(settings.authToken ? { [AUTH_HEADER]: settings.authToken } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    options.onLatency?.(Date.now() - startedAt);
    trace('http', 'received response', { path: options.path, status: response.status });
    const raw: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const parsedError = errorResponseSchema.safeParse(raw);
      if (parsedError.success) {
        if (parsedError.data.error.code === 'UNAUTHORIZED') {
          return {
            error: toAgentError(
              'SERVER_AUTH_FAILED',
              'The local agent server rejected the configured access token.',
              { status: response.status, path: options.path },
            ),
          };
        }
        return { error: parsedError.data.error };
      }

      return {
        error: toAgentError(
          options.path.startsWith('/ai/') ? 'SERVER_REQUEST_FAILED' : 'AGENT_SERVER_UNAVAILABLE',
          `The agent server answered ${response.status} ${response.statusText} without a readable error body.`,
          { status: response.status, path: options.path },
        ),
      };
    }

    const envelope = raw as { ok?: unknown; data?: unknown } | null;
    const parsed = options.schema.safeParse(envelope?.data);
    if (!parsed.success) {
      traceFailure('http', 'response failed schema validation', {
        path: options.path,
        issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')),
      });
      return {
        error: toAgentError(
          'VALIDATION_FAILED',
          `The agent server returned a ${options.path} payload that did not match the shared schema. The server and extension builds are probably out of sync.`,
          { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')) },
          false,
        ),
      };
    }

    trace('http', 'response validated', { path: options.path });
    return { data: parsed.data };
  } catch (cause) {
    options.onLatency?.(Date.now() - startedAt);
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    traceFailure('http', 'request failed', {
      path: options.path,
      aborted,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return {
      error: toAgentError(
        options.path.startsWith('/ai/') ? 'SERVER_REQUEST_FAILED' : 'AGENT_SERVER_UNAVAILABLE',
        aborted
          ? `The agent server at ${settings.serverUrl} did not respond in time for ${options.method} ${options.path}.`
          : `Could not reach the agent server at ${settings.serverUrl}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
        { aborted, path: options.path },
      ),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Resolves which resume would be attached: the user's explicit choice if it
 * still exists, otherwise the stored default. Never invents one.
 */
function resolveResume(
  documents: DocumentListResponse,
  selectedDocumentId: string | null,
): ResumeSelection | null {
  if (selectedDocumentId) {
    const chosen = documents.documents.find((document) => document.id === selectedDocumentId);
    if (chosen) {
      return { documentId: chosen.id, name: chosen.name, reason: 'user_selected' };
    }
  }

  const fallback = documents.documents.find(
    (document) => document.id === documents.defaultResumeId,
  );
  return fallback ? { documentId: fallback.id, name: fallback.name, reason: 'default' } : null;
}

export async function fetchAgentStatus(): Promise<AgentStatusResult> {
  const settings = await loadSettings();
  let latencyMs = 0;

  const health = await request({
    method: 'GET',
    path: '/health',
    schema: healthResponseSchema,
    onLatency: (value) => {
      latencyMs = value;
    },
  });

  const base: AgentStatusResult = {
    latencyMs,
    serverUrl: settings.serverUrl,
    tokenConfigured: settings.authToken.length > 0,
  };

  if (health.error) return { ...base, error: health.error };

  // Documents need a token. Without one, `selectedResume` stays undefined so the
  // popup can say "token required" instead of implying no resume exists.
  if (!settings.authToken) return { ...base, health: health.data };

  const documents = await request({
    method: 'GET',
    path: '/documents',
    schema: documentListResponseSchema,
  });

  return {
    ...base,
    health: health.data,
    ...(documents.data
      ? { selectedResume: resolveResume(documents.data, settings.selectedDocumentId) }
      : {}),
  };
}

/**
 * One batched analysis for a whole page — never one request per field. The
 * timeout follows the request, so a page with eighty questions is not judged by
 * the same clock as one with three.
 */
export function analyzeForm(
  body: FormAnalysisRequest,
  signal?: AbortSignal,
): Promise<AgentResult<FormAnalysisResponse>> {
  return request({
    method: 'POST',
    path: '/ai/analyze-form',
    schema: formAnalysisResponseSchema,
    body,
    timeoutMs: body.timeoutMs + 5_000,
    ...(signal ? { signal } : {}),
  });
}

/** One level-4 multiple-choice judgement over real webpage choices. */
export function chooseAgentOption(
  input: AgentChoiceRequest,
  signal?: AbortSignal,
): Promise<AgentResult<AgentChoiceDecision>> {
  return request({
    method: 'POST',
    path: '/ai/choose-agent-option',
    schema: agentChoiceDecisionSchema,
    body: agentChoiceRequestSchema.parse(input),
    timeoutMs: 35_000,
    ...(signal ? { signal } : {}),
  });
}

export function getProfile(): Promise<AgentResult<ProfilePayload>> {
  return request({ method: 'GET', path: '/profile', schema: profilePayloadSchema });
}

export function saveProfile(profile: ProfileUpdate): Promise<AgentResult<ProfilePayload>> {
  return request({
    method: 'PUT',
    path: '/profile',
    schema: profilePayloadSchema,
    body: profile,
    timeoutMs: TIMEOUTS.ollamaProbeMs,
  });
}

/**
 * Merges profiles held elsewhere into the agent server's stored one.
 *
 * The whole point of the profile-sync repair: the settings page reads the agent
 * server, Internship Pilot's profile arrives in a bundle, and until this call
 * existed nothing carried the second into the first — so the settings page kept
 * asking for experience and education the user had already entered.
 */
export function importProfile(
  sources: ProfileImportRequest['sources'],
): Promise<AgentResult<ProfileImportPayload>> {
  return request({
    method: 'POST',
    path: '/profile/import',
    schema: profileImportPayloadSchema,
    body: profileImportRequestSchema.parse({ sources }),
    timeoutMs: TIMEOUTS.ollamaProbeMs,
  });
}

export function listDocuments(): Promise<AgentResult<DocumentListResponse>> {
  return request({ method: 'GET', path: '/documents', schema: documentListResponseSchema });
}

export function listOllamaModels(): Promise<AgentResult<ModelsResponse>> {
  return request({ method: 'GET', path: '/models', schema: modelsResponseSchema });
}

export function testAiGeneration(
  model: string,
  timeoutMs: number,
): Promise<AgentResult<AiGenerationTestResponse>> {
  const body = aiGenerationTestRequestSchema.parse({ model, timeoutMs });
  return request({
    method: 'POST',
    path: '/ai/test-generation',
    schema: aiGenerationTestResponseSchema,
    body,
    timeoutMs: body.timeoutMs + 15_000,
  });
}

export function createDocument(document: DocumentUpload): Promise<AgentResult<SavedDocument>> {
  return request({
    method: 'POST',
    path: '/documents',
    schema: savedDocumentSchema,
    body: document,
    // A multi-megabyte base64 body takes longer than a health probe.
    timeoutMs: 30_000,
  });
}

export function updateDocument(
  id: string,
  patch: DocumentUpdate,
): Promise<AgentResult<SavedDocument>> {
  return request({
    method: 'PUT',
    path: `/documents/${encodeURIComponent(id)}`,
    schema: savedDocumentSchema,
    body: patch,
  });
}

export function deleteDocument(id: string): Promise<AgentResult<{ id: string }>> {
  return request({
    method: 'DELETE',
    path: `/documents/${encodeURIComponent(id)}`,
    schema: idOnlySchema,
  });
}

export function listAnswers(): Promise<AgentResult<{ answers: ApprovedAnswer[] }>> {
  return request({ method: 'GET', path: '/answers', schema: answerListResponseSchema });
}

export function createAnswer(answer: ApprovedAnswerInput): Promise<AgentResult<ApprovedAnswer>> {
  return request({ method: 'POST', path: '/answers', schema: approvedAnswerSchema, body: answer });
}

export function updateAnswer(
  id: string,
  answer: ApprovedAnswerInput,
): Promise<AgentResult<ApprovedAnswer>> {
  return request({
    method: 'PUT',
    path: `/answers/${encodeURIComponent(id)}`,
    schema: approvedAnswerSchema,
    body: answer,
  });
}

export function deleteAnswer(id: string): Promise<AgentResult<{ id: string }>> {
  return request({
    method: 'DELETE',
    path: `/answers/${encodeURIComponent(id)}`,
    schema: idOnlySchema,
  });
}

export function generateAnswer(
  input: GenerateAnswerRequest,
): Promise<AgentResult<AnswerGenerationRecord>> {
  const body = generateAnswerRequestSchema.parse(input);
  return request({
    method: 'POST',
    path: '/ai/generate-answer',
    schema: generateAnswerResponseSchema.transform((response) => response.record),
    body,
    timeoutMs: body.settings.generationTimeoutMs * (body.settings.maximumRetries + 1) + 15_000,
  });
}

export function generateAnswerBatch(
  inputs: GenerateAnswerRequest[],
): Promise<AgentResult<{ records: AnswerGenerationRecord[] }>> {
  const body = generateBatchRequestSchema.parse({ requests: inputs });
  const longest = Math.max(...inputs.map((input) => input.settings.generationTimeoutMs));
  return request({
    method: 'POST',
    path: '/ai/generate-batch',
    schema: generateBatchResponseSchema,
    body,
    timeoutMs: longest * Math.ceil(inputs.length / 2) + 30_000,
  });
}

export function cancelAnswerGeneration(
  generationId?: string,
): Promise<AgentResult<{ cancelled: boolean; generationId?: string }>> {
  return request({
    method: 'POST',
    path: '/ai/cancel-generation',
    schema: generationCancelResponseSchema,
    body: generationId ? { generationId } : {},
    timeoutMs: 10_000,
  });
}

export function extractDocument(documentId: string): Promise<AgentResult<DocumentExtraction>> {
  return request({
    method: 'POST',
    path: `/documents/${encodeURIComponent(documentId)}/extract`,
    schema: documentExtractionSchema,
    body: {},
    timeoutMs: 60_000,
  });
}

export function getDocumentContent(
  documentId: string,
): Promise<AgentResult<DocumentContentResponse>> {
  return request({
    method: 'GET',
    path: `/documents/${encodeURIComponent(documentId)}/content`,
    schema: documentContentResponseSchema,
    timeoutMs: 30_000,
  });
}

/**
 * The newest tailored résumé and cover letter the agent holds.
 *
 * Metadata only — a listing must stay cheap enough to run every time the popup
 * opens, and the bytes are fetched separately and only when they are actually
 * newer than what this browser already has.
 */
export function listLatestDocuments(): Promise<AgentResult<LatestDocumentListResponse>> {
  return request({
    method: 'GET',
    path: '/documents/latest',
    schema: latestDocumentListResponseSchema,
    timeoutMs: 10_000,
  });
}

export function getLatestDocumentContent(
  documentId: string,
): Promise<AgentResult<LatestDocumentContentResponse>> {
  return request({
    method: 'GET',
    path: `/documents/latest/${encodeURIComponent(documentId)}/content`,
    schema: latestDocumentContentResponseSchema,
    timeoutMs: 30_000,
  });
}

/** Exported for the worker's last-resort handler. */
export const workerFailure = (message: string): AgentError =>
  agentErrorSchema.parse({
    code: 'AGENT_SERVER_UNAVAILABLE',
    message,
    recoverable: true,
    suggestedAction: 'Reload the extension from chrome://extensions and try again.',
    debugContext: {},
  });
