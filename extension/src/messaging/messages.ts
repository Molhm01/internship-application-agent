import { DEFAULT_ERROR_GUIDANCE } from '@internship-agent/shared';
import { z } from 'zod';
import { trace, traceFailure } from '../utils/trace.js';
import type { ContentScriptConnection } from '../background/contentScript.js';
import type { AutofillRunPhaseState, AutofillRunState } from '../storage/runState.js';
import type {
  AgentError,
  AnnotationKind,
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
  ProfileSourceLabel,
  ProfileSyncEntry,
  ProfileUpdate,
  SavedDocument,
  DocumentExtraction,
  DependencyDirective,
  DropdownDirective,
  RepeaterDirective,
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
  ApplicationAutofillReport,
  AutofillProgress,
  ReviewReason,
  PortalRouteIntent,
  PortalRouteResponse,
  NavigationActivationResult,
  RunTrace,
  AutofillRunTraceExport,
  AttachToControlMessage,
  AttachToControlResponse,
  PageControlTrace,
  UploadControlsResponse,
  DocumentAttachmentReport,
  StoredLatestDocuments,
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
  portalRouteResponseSchema,
  attachToControlResponseSchema,
  uploadControlsResponseSchema,
  latestDocumentSyncResponseSchema,
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
  /**
   * Merge the Internship Pilot profile into the agent server's copy.
   *
   * Sent by the settings page on load and by the Diagnostics button. The reply
   * names keys and statuses only — never a profile value — so it can be
   * rendered and copied into a bug report as-is.
   */
  | { type: 'SYNC_PROFILE'; url?: string }
  // One-button autofill: the whole run, start to review summary.
  | { type: 'ENSURE_CONTENT_SCRIPT'; tabId: number; url?: string }
  | { type: 'GET_PORTAL_ROUTE'; targetUrl?: string }
  | { type: 'FOLLOW_PORTAL_ROUTE'; targetUrl?: string }
  | {
      type: 'ACTIVATE_NAVIGATION';
      intent: PortalRouteIntent;
      selector: string;
      expectedLabel?: string;
    }
  /**
   * Writes one value into one field. The only message that ever carries an
   * employer-site password, deliberately carrying nothing else.
   */
  | { type: 'ACCOUNT_WRITE_FIELD'; selector: string; value?: string; checked?: boolean }
  /** The content script announcing a freshly loaded page. */
  | { type: 'PAGE_READY'; url: string }
  /** Liveness only. Answered before any other work could fail. */
  | { type: 'WORKER_PING' }
  | { type: 'RUN_APPLICATION_AUTOFILL'; targetUrl?: string }
  | { type: 'GET_AUTOFILL_RUN' }
  | { type: 'CANCEL_APPLICATION_AUTOFILL' }
  | { type: 'GET_AUTOFILL_REPORT' }
  /** The last few run traces, for the diagnostics panel. Counts only. */
  | { type: 'GET_RUN_TRACES' }
  | { type: 'CLEAR_RUN_TRACES' }
  /**
   * The most recent run's field-by-field trace, ready to be written to a file.
   *
   * Separate from `GET_RUN_TRACES`, which returns the rolling history for the
   * on-screen list. This answers the question a bug report actually needs —
   * "what happened to each field on the last run, and why" — as one document
   * with its own summary, so the reader does not have to reconstruct it.
   */
  | { type: 'EXPORT_AUTOFILL_RUN_TRACE' }
  | { type: 'AUTOFILL_PROGRESS'; progress: AutofillProgress }
  | {
      type: 'HIGHLIGHT_REVIEW_FIELDS';
      requests: ReadonlyArray<{
        fieldId: string;
        selector: string;
        /** Chosen from the field's final status. The colour follows from this. */
        annotation: AnnotationKind;
        reason?: ReviewReason;
        badge: string;
        question?: string;
      }>;
      scrollToFirst: boolean;
    }
  /**
   * Waits, bounded, for a dependent control's choices to arrive — State after
   * Country. Sent to every frame; a frame holding none of these controls
   * answers immediately. Read-only: the frame observes option sets and can
   * neither open a control nor write to one.
   */
  | { type: 'AWAIT_DEPENDENT_OPTIONS'; selectors: readonly string[]; timeoutMs?: number }
  /**
   * Grows this frame's repeating sections to hold one block per saved record.
   * Carries counts and the employer/institution names that identify a record,
   * so a block the applicant already filled by hand is recognised rather than
   * overwritten. Sent to every frame; a frame with no such section says so.
   */
  | { type: 'RUN_REPEATER_AUTOFILL'; runId: string; directives: readonly RepeaterDirective[] }
  /**
   * Drives this frame's dependent fields — Country → State, Education Country →
   * State → School, a Yes/No question and the box it reveals — parent before
   * child, in the order the worker's topological sort produced.
   */
  | {
      type: 'RUN_DEPENDENCY_RESOLUTION';
      runId: string;
      directives: readonly DependencyDirective[];
    }
  /**
   * Asks this frame which option controls it holds. Read-only: the frame
   * describes every menu it can see and opens none of them, so a page that has
   * only been discovered looks to the applicant exactly as it did before.
   */
  | { type: 'DISCOVER_DROPDOWNS'; runId: string }
  /**
   * Drives the option controls this frame described, one after another, in the
   * order the worker resolved them — parents before the controls that depend on
   * them. Each directive names a control by the handle this frame itself
   * minted, never by a selector the worker invented.
   */
  | { type: 'RUN_DROPDOWN_DIRECTIVES'; runId: string; directives: readonly DropdownDirective[] }
  | { type: 'FOCUS_REVIEW_FIELD'; fieldId: string }
  | { type: 'CLEAR_REVIEW_HIGHLIGHTS' }
  | { type: 'PROFILE_GET' }
  | { type: 'PROFILE_SAVE'; profile: ProfileUpdate }
  | { type: 'DOCUMENTS_LIST' }
  | { type: 'DOCUMENT_CREATE'; document: DocumentUpload }
  | { type: 'DOCUMENT_UPDATE'; id: string; patch: DocumentUpdate }
  | { type: 'DOCUMENT_DELETE'; id: string }
  | { type: 'DOCUMENT_EXTRACT'; id: string }
  /**
   * The document-only path: the latest tailored résumé and cover letter, and
   * attaching them. Deliberately independent of the application bundle, of a
   * page scan, and of the fill plan — a redirect through a job board must not be
   * able to make the user's own documents unreachable.
   */
  | { type: 'GET_LATEST_DOCUMENTS' }
  | { type: 'SYNC_LATEST_DOCUMENTS' }
  | { type: 'ATTACH_DOCUMENTS'; targetUrl?: string }
  /**
   * The two frame-addressed halves of the document path. Discovery carries no
   * bytes and decides nothing; attachment carries one document and a control id
   * the target frame itself minted.
   */
  | { type: 'DISCOVER_UPLOAD_CONTROLS'; runId: string; mayActivateLaunchers: boolean }
  | AttachToControlMessage
  | { type: 'EXPORT_PAGE_CONTROL_TRACE'; targetUrl?: string }
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

/**
 * The document library the popup renders: what this browser holds, when it was
 * last refreshed, and why a refresh failed when one did.
 */
export interface LatestDocumentSyncResult {
  documents: StoredLatestDocuments;
  syncedAt: string | null;
  /** The most recent attachment run, from either command. */
  lastReport: DocumentAttachmentReport | null;
  error?: AgentError;
}

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
   * The build this content script came from.
   *
   * Optional only because a tab injected by an *older* bundle answers without
   * it, and that answer must still parse — an absent id is itself the evidence
   * that the page is running something older than the worker asking.
   */
  buildId?: string;
  /**
   * Milestone 1 does not scan anything. This is reported as `null` — not `0` —
   * so the popup can say "not analyzed" rather than "zero fields found".
   */
  fieldsDetected: null;
  /**
   * Which ATS this page is, detected without scanning it.
   *
   * The popup used to read the vendor off the scan result alone, so any scan
   * failure — including a schema rejection — showed "ATS: Not detected" on a
   * page the detector recognizes perfectly well. That reads as "we do not
   * support this site" when the truth is "the scan broke", and it sent the
   * investigation towards the detector instead of the validator.
   *
   * Detection is a hostname test plus a few `querySelector` calls, so it is
   * cheap enough to answer on every ping and independent of everything that can
   * go wrong later.
   */
  ats?: {
    id: string;
    displayName: string;
    confidence: number;
    reason: string;
  };
}

export type ExtensionResponse<M extends ExtensionMessage['type']> = M extends
  'GET_LATEST_DOCUMENTS' | 'SYNC_LATEST_DOCUMENTS'
  ? LatestDocumentSyncResult
  : M extends 'ATTACH_DOCUMENTS'
    ? { report: DocumentAttachmentReport } | { error: AgentError }
    : M extends 'DISCOVER_UPLOAD_CONTROLS'
      ? UploadControlsResponse
      : M extends 'ATTACH_DOCUMENT_TO_CONTROL'
        ? AttachToControlResponse
        : M extends 'EXPORT_PAGE_CONTROL_TRACE'
          ? { trace: PageControlTrace } | { error: AgentError }
          : M extends 'AGENT_STATUS_REQUEST'
            ? AgentStatusResult
            : M extends 'SAVE_APPLICATION_BUNDLE'
              ? { result: BundleAcknowledgement | BundleRejection }
              : M extends 'GET_ACTIVE_BUNDLE' | 'SET_ACTIVE_BUNDLE'
                ? AgentResult<ApplicationBundle | null>
                : M extends 'LIST_BUNDLES'
                  ? AgentResult<{ bundles: ApplicationBundle[] }>
                  : M extends 'SYNC_PROFILE'
                    ? {
                        ok: boolean;
                        report: ProfileSyncEntry[];
                        changed: boolean;
                        migratedFrom: number | null;
                        sources: ProfileSourceLabel[];
                        error?: AgentError;
                      }
                    : M extends 'DELETE_BUNDLE'
                      ? { ok: true } | { ok: false; error: AgentError }
                      : M extends 'RUN_APPLICATION_AUTOFILL'
                        ? // `accepted: false` means a run already owns this page. It carries
                          // that run's id so the caller can follow it instead of starting a
                          // second one — refusing the click is not the same as failing it.
                          | {
                              ok: true;
                              accepted: true;
                              runId: string;
                              state?: AutofillRunPhaseState;
                              reason?: string;
                            }
                          | {
                              ok: true;
                              accepted: false;
                              runId: string;
                              state?: AutofillRunPhaseState;
                              reason?: string;
                            }
                          | { error: AgentError }
                        : M extends 'GET_AUTOFILL_REPORT'
                          ? { report: ApplicationAutofillReport | null }
                          : M extends 'ENSURE_CONTENT_SCRIPT'
                            ? ContentScriptConnection
                            : M extends 'GET_PORTAL_ROUTE' | 'FOLLOW_PORTAL_ROUTE'
                              ? PortalRouteResponse
                              : M extends 'ACTIVATE_NAVIGATION'
                                ? NavigationActivationResult
                                : M extends 'WORKER_PING'
                                  ? { ok: true; at: number; buildId: string }
                                  : M extends 'GET_RUN_TRACES'
                                    ? { traces: RunTrace[] }
                                    : M extends 'EXPORT_AUTOFILL_RUN_TRACE'
                                      ? { export: AutofillRunTraceExport } | { error: AgentError }
                                      : M extends 'CLEAR_RUN_TRACES'
                                        ? { cleared: true }
                                        : M extends 'GET_AUTOFILL_RUN'
                                          ? { run: AutofillRunState | null }
                                          : M extends 'PAGE_READY'
                                            ? { started: boolean }
                                            : M extends 'ACCOUNT_WRITE_FIELD'
                                              ? { ok: boolean }
                                              : M extends
                                                    | 'CANCEL_APPLICATION_AUTOFILL'
                                                    | 'AUTOFILL_PROGRESS'
                                                    | 'HIGHLIGHT_REVIEW_FIELDS'
                                                    | 'FOCUS_REVIEW_FIELD'
                                                    | 'CLEAR_REVIEW_HIGHLIGHTS'
                                                ? { ok: boolean }
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
                                                            : M extends
                                                                  | 'DOCUMENT_CREATE'
                                                                  | 'DOCUMENT_UPDATE'
                                                              ? AgentResult<SavedDocument>
                                                              : M extends
                                                                    | 'DOCUMENT_DELETE'
                                                                    | 'ANSWER_DELETE'
                                                                ? AgentResult<{ id: string }>
                                                                : M extends 'DOCUMENT_EXTRACT'
                                                                  ? AgentResult<DocumentExtraction>
                                                                  : M extends 'ANSWERS_LIST'
                                                                    ? AgentResult<{
                                                                        answers: ApprovedAnswer[];
                                                                      }>
                                                                    : M extends
                                                                          | 'ANSWER_CREATE'
                                                                          | 'ANSWER_UPDATE'
                                                                      ? AgentResult<ApprovedAnswer>
                                                                      : M extends 'SCAN_APPLICATION'
                                                                        ? ScanApplicationResponse
                                                                        : M extends
                                                                              | 'SCAN_CANCEL'
                                                                              | 'SCAN_PROGRESS'
                                                                              | 'SCAN_COMPLETE'
                                                                              | 'SCAN_FAILED'
                                                                          ? { ok: true }
                                                                          : M extends 'GET_LAST_SCAN'
                                                                            ? GetLastScanResponse
                                                                            : M extends 'CLEAR_LAST_SCAN'
                                                                              ? | { ok: true }
                                                                                | {
                                                                                    ok: false;
                                                                                    error: AgentError;
                                                                                  }
                                                                              : M extends
                                                                                    | 'BUILD_DETERMINISTIC_PLAN'
                                                                                    | 'UPDATE_FILL_ACTION'
                                                                                    | 'APPROVE_FILL_ACTION'
                                                                                    | 'APPROVE_SAFE_ACTIONS'
                                                                                ? FillPlanResponse
                                                                                : M extends 'GET_FILL_PLAN'
                                                                                  ? GetFillPlanResponse
                                                                                  : M extends
                                                                                        | 'EXECUTE_APPROVED_ACTIONS'
                                                                                        | 'EXECUTE_FILL_PLAN'
                                                                                    ? FillExecutionResponse
                                                                                    : M extends
                                                                                          | 'FILL_PROGRESS'
                                                                                          | 'FILL_COMPLETE'
                                                                                          | 'FILL_FAILED'
                                                                                          | 'FILL_CANCEL'
                                                                                          | 'CLEAR_FILL_PLAN'
                                                                                          | 'FILL_PLAN_UPDATED'
                                                                                      ? | {
                                                                                            ok: true;
                                                                                          }
                                                                                        | {
                                                                                            ok: false;
                                                                                            error: AgentError;
                                                                                          }
                                                                                      : M extends 'CLASSIFY_CUSTOM_QUESTION'
                                                                                        ? | QuestionClassificationResult
                                                                                          | {
                                                                                              error: AgentError;
                                                                                            }
                                                                                        : M extends
                                                                                              | 'GENERATE_CUSTOM_ANSWER'
                                                                                              | 'UPDATE_GENERATED_ANSWER'
                                                                                              | 'APPROVE_GENERATED_ANSWER'
                                                                                              | 'REJECT_GENERATED_ANSWER'
                                                                                              | 'REGENERATE_GENERATED_ANSWER'
                                                                                              | 'ADD_ANSWER_EVIDENCE'
                                                                                          ? | {
                                                                                                record: AnswerGenerationRecord;
                                                                                              }
                                                                                            | {
                                                                                                error: AgentError;
                                                                                              }
                                                                                          : M extends
                                                                                                | 'GENERATE_ALL_CUSTOM_ANSWERS'
                                                                                                | 'GET_GENERATED_ANSWERS'
                                                                                            ? | {
                                                                                                  store: AnswerGenerationStore | null;
                                                                                                }
                                                                                              | {
                                                                                                  error: AgentError;
                                                                                                }
                                                                                            : M extends
                                                                                                  | 'CANCEL_ANSWER_GENERATION'
                                                                                                  | 'ANSWER_GENERATION_PROGRESS'
                                                                                                  | 'ANSWER_GENERATION_COMPLETE'
                                                                                                  | 'ANSWER_GENERATION_FAILED'
                                                                                                  | 'SAVE_AS_APPROVED_ANSWER'
                                                                                                  | 'CLEAR_GENERATED_ANSWER'
                                                                                              ? | {
                                                                                                    ok: true;
                                                                                                  }
                                                                                                | {
                                                                                                    ok: false;
                                                                                                    error: AgentError;
                                                                                                  }
                                                                                              : never;

/**
 * A message must never leave a caller waiting indefinitely. The background worker
 * is a service worker that Chrome can terminate mid-flight, so this is a real
 * failure mode rather than a theoretical one.
 */
const MESSAGE_TIMEOUT_MS = 15_000;
const SCAN_MESSAGE_TIMEOUT_MS = 25_000;
const FILL_MESSAGE_TIMEOUT_MS = 35_000;
const ROUTE_MESSAGE_TIMEOUT_MS = 40_000;
const ANSWER_MESSAGE_TIMEOUT_MS = 390_000;
const ATTACH_MESSAGE_TIMEOUT_MS = 30_000;
const SYNC_DOCUMENTS_TIMEOUT_MS = 45_000;

function timeoutFor(type: ExtensionMessage['type']): number {
  if (type === 'SCAN_APPLICATION') return SCAN_MESSAGE_TIMEOUT_MS;
  // Downloading two documents, then giving each upload widget its own
  // verification window before judging the result.
  if (type === 'ATTACH_DOCUMENTS' || type === 'ATTACH_DOCUMENT_TO_CONTROL') {
    return ATTACH_MESSAGE_TIMEOUT_MS;
  }
  if (type === 'SYNC_LATEST_DOCUMENTS') return SYNC_DOCUMENTS_TIMEOUT_MS;
  // A route hop is a click, a wait for the portal to settle, and a full rescan
  // of whatever it landed on — three waits in series, not one.
  if (type === 'FOLLOW_PORTAL_ROUTE') return ROUTE_MESSAGE_TIMEOUT_MS;
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
    case 'GET_LATEST_DOCUMENTS':
    case 'SYNC_LATEST_DOCUMENTS':
      return latestDocumentSyncResponseSchema.parse(response);
    case 'ATTACH_DOCUMENT_TO_CONTROL':
      return attachToControlResponseSchema.parse(response);
    case 'DISCOVER_UPLOAD_CONTROLS':
      return uploadControlsResponseSchema.parse(response);
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
    case 'GET_PORTAL_ROUTE':
    case 'FOLLOW_PORTAL_ROUTE':
      return portalRouteResponseSchema.parse(response);
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

/**
 * Whether the service worker is alive, asked with the cheapest possible
 * question and a short deadline.
 *
 * `WORKER_PING` is answered from the top of the handler before anything that
 * could fail, so a `true` here means "running and reachable" — which turns a
 * timeout into "busy, try again" rather than "your install is broken".
 */
const PING_TIMEOUT_MS = 1_500;

async function workerResponds(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      chrome.runtime.sendMessage({ type: 'WORKER_PING' }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS);
      }),
    ]);
    return (response as { ok?: boolean } | null)?.ok === true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
    // A timeout is not evidence that the install is stale, and saying so sent
    // people through repeated extension reloads for a problem no reload could
    // fix. Ask the worker whether it is there before diagnosing anything.
    const alive = message.type === 'WORKER_PING' ? false : await workerResponds();
    return failureResponse(
      alive
        ? {
            code: 'INTERNAL_ERROR',
            message: `The background worker is running but did not answer "${message.type}" in time.`,
            recoverable: true,
            suggestedAction: 'Try again. If it keeps happening, reload this page.',
            debugContext: { messageType: message.type, detail },
          }
        : reloadRequired(`Could not reach the background worker for "${message.type}": ${detail}`, {
            messageType: message.type,
          }),
    ) as ExtensionResponse<M['type']>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
