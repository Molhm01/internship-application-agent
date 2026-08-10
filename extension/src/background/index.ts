import {
  BUILD_MISMATCH_MESSAGE,
  DEFAULT_ERROR_GUIDANCE,
  RECONNECT_MESSAGE,
  compareBuilds,
  describeRunTrace,
  autofillRunTraceExportSchema,
  applicationScanResultSchema,
  scanApplicationResponseSchema,
  scanMessageSchema,
  fillMessageSchema,
  fillExecutionResponseSchema,
  answerGenerationMessageSchema,
  settingsUpdatedMessageSchema,
  answerGenerationRecordSchema,
  applicationBundleTransferSchema,
  classifyQuestionDeterministically,
  describeSchemaFailure,
  extractQuestionConstraints,
  isAiEligibleField,
  schemaFailureContext,
  selectPortalRoute,
  portalRoutes,
  navigationActivationResultSchema,
  dependentOptionsResultSchema,
  type PortalRouteResponse,
  type PortalStrategy,
  type AnswerGenerationRecord,
  type RegenerationMode,
  type GenerateAnswerRequest,
  type ApplicationAutofillReport,
  type FillRunReport,
  type AgentError,
  type ApplicationBundle,
  type DetectedField,
  type DeterministicFillPlan,
  type DocumentContentResponse,
  type ProfileImportRequest,
  type ProfileSourceLabel,
  type ProfileSyncEntry,
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
  importProfile,
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
  analyzeForm,
  workerFailure,
} from './agentClient.js';
import { clearLastScan, loadLastScan, saveLastScan } from '../storage/scans.js';
import {
  clearFillState,
  loadFillPlan,
  loadFillReport,
  loadAutofillReport,
  saveAutofillReport,
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
  activeRun,
  finishRun,
  loadRun,
  recordProgress,
  recordState,
  startRun,
} from '../storage/runState.js';
import { ensureContentScript } from './contentScript.js';
import { askEveryFrame, discoverFrames, tellEveryFrame, type FrameTarget } from './frames.js';
import { asRepeatedSectionOutcome, runRepeaterAutofill } from './repeatersAcrossFrames.js';
import { runDependencyResolution } from './dependenciesAcrossFrames.js';
import { runDropdownAutofill } from './dropdownAcrossFrames.js';
import { mergeFrameScans, type FrameScan } from './mergeFrameScans.js';
import { fillAcrossFrames } from './fillAcrossFrames.js';
import { fillAccountForm } from './accountForm.js';
import { armAutoStart, shouldAutoStart } from './autoStart.js';
import {
  bundleForUrl,
  encodeBase64,
  readBundleDocument,
  deleteBundle,
  listBundles,
  loadActiveBundle,
  rememberPortalJourney,
  saveBundle,
  setActiveBundle,
} from '../storage/bundleStore.js';
import { applyAnalysisToPlan, buildAnalysisRequest } from '../analysis/formAnalysis.js';
import {
  analysisFingerprint,
  analysisScope,
  beginAnalysisScope,
  endAnalysisScope,
} from '../analysis/analysisMemo.js';
import { attachBundleDocuments, isBundleDocumentReference } from '../uploads/bundleUploads.js';
import {
  attachLatestDocuments,
  exportPageControlTrace,
  readLatestDocuments,
  syncLatestDocuments,
} from './latestDocuments.js';
import { selectSavedResume } from './standaloneResources.js';
import {
  answerText,
  applyRecordToPlan,
  synchronizeGeneratedActions,
  updateManualAnswer,
} from '../answers/generatedActions.js';
import { runApplicationAutofill } from '../autofill/orchestrator.js';
import { BUILD_ID } from '../generated/buildInfo.js';
import { clearRunTraces, loadRunTraces, saveRunTrace } from '../storage/runTraces.js';
import {
  agentAvailability,
  availabilityMessage,
  canAnalyze,
  clearAgentAvailabilityCache,
} from './agentAvailability.js';

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

/**
 * Scans every frame and merges the results into one scan.
 *
 * A frame that fails is not fatal: a cross-origin advertising iframe cannot be
 * scanned and has nothing to contribute, and letting it end the run would make
 * the extension useless on any page that carries one. The run only fails when
 * *no* frame produced a scan.
 */
async function scanEveryFrame(
  tabId: number,
  frames: readonly FrameTarget[],
  scanId: string,
): Promise<unknown> {
  const replies = await askEveryFrame<unknown>(tabId, frames, { type: 'SCAN_APPLICATION', scanId });

  const scans: FrameScan[] = [];
  let lastFailure: unknown = null;
  for (const reply of replies) {
    const parsed = scanApplicationResponseSchema.safeParse(reply.response);
    if (!parsed.success) continue;
    if (parsed.data.type === 'SCAN_COMPLETE') {
      scans.push({ frame: reply.frame, result: parsed.data.result });
    } else {
      lastFailure = parsed.data;
    }
  }

  const merged = mergeFrameScans(scans);
  if (!merged) {
    return (
      lastFailure ??
      scanFailure('ATS_DETECTION_FAILED', 'No frame of this page could be scanned.', { scanId })
    );
  }
  console.info('[agent] scan merged across frames', {
    scanId,
    frames: frames.length,
    scanned: scans.length,
    fields: merged.fields.length,
  });
  return { type: 'SCAN_COMPLETE', result: merged };
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

  // Reconnect before scanning rather than after failing. An extension reload
  // leaves every open tab without a content script, and a scan that dies at
  // "receiving end does not exist" is indistinguishable, from the popup, from a
  // page that has no application form on it.
  const connection = await ensureContentScript(tab.id!, tab.url);
  if (!connection.reachable) {
    return scanFailure('CONTENT_SCRIPT_UNAVAILABLE', connection.reason ?? RECONNECT_MESSAGE, {
      reinjected: connection.injected,
    });
  }

  const scanId = requestedScanId ?? crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Every frame, each addressed by id. An application form split between an
    // outer page and an embedded widget is two documents, and a scan of only
    // the first reports the widget's fields as not existing.
    const frames = await discoverFrames(tab.id!, tab.url);
    if (frames.length === 0) {
      return scanFailure('CONTENT_SCRIPT_UNAVAILABLE', RECONNECT_MESSAGE, { scanId });
    }
    const raw: unknown = await Promise.race([
      scanEveryFrame(tab.id!, frames, scanId),
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
    // A ZodError's `message` is a JSON dump of its issues, and interpolating it
    // here is what put a raw schema blob in the popup. The sentence goes to the
    // user; the structured issues go to debugContext for the diagnostics page.
    const message =
      code === 'INVALID_SCAN_RESULT'
        ? describeSchemaFailure(cause, 'The scan of this page')
        : code === 'CONTENT_SCRIPT_UNAVAILABLE'
          ? // The script was reachable a moment ago and is not now: the page
            // navigated mid-scan. A refresh is the honest instruction, not a
            // Chrome internal error string.
            RECONNECT_MESSAGE
          : `Application scan could not complete: ${detail}`;
    return scanFailure(code, message, { scanId, ...schemaFailureContext(cause) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The strategy in force: the extension's own setting, else the one the website
 * sent with the bundle.
 *
 * The extension's wins because it is the more local and more recent statement
 * of what the user wants on this machine — they changed it in the options page
 * they are looking at, not on a website they visited earlier.
 */
async function effectivePortalStrategy(url: string): Promise<PortalStrategy | undefined> {
  const [settings, bundle] = await Promise.all([loadSettings(), bundleForUrl(url)]);
  return settings.employerAccounts.portalStrategy ?? bundle?.accountPreferences?.portalStrategy;
}

/**
 * Decides which route to take off an employer portal page, and — when `act` is
 * true — takes it and rescans what it landed on.
 *
 * The decision is deterministic (`selectPortalRoute`) and the click is guarded
 * in the page (`activateNavigation`). This function's own job is only to gather
 * the inputs and sequence the steps, so that neither of the two things that
 * must never happen — acting on a blocked page, clicking a final Submit — can
 * be reintroduced here by accident.
 */
async function portalRoute(act: boolean, targetUrl?: string): Promise<PortalRouteResponse> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await activeApplicationTab(targetUrl);
  } catch {
    return { error: scanFailure('ACTIVE_TAB_UNAVAILABLE', RECONNECT_MESSAGE).error };
  }

  const connection = await ensureContentScript(tab.id!, tab.url);
  if (!connection.reachable) {
    return {
      error: scanFailure('CONTENT_SCRIPT_UNAVAILABLE', connection.reason ?? RECONNECT_MESSAGE)
        .error,
    };
  }

  const stored = await loadLastScan();
  // A scan of a different page tells us nothing about this one, and acting on
  // its selectors would click controls that are no longer there.
  const scan = stored && stored.url === tab.url ? stored : null;
  if (!scan?.navigation) {
    return {
      decision: 'none',
      reason: 'This page has not been analyzed yet, so its routes are unknown.',
    };
  }

  const decision = selectPortalRoute(scan.navigation, await effectivePortalStrategy(tab.url!));

  if (decision.decision !== 'act') {
    return {
      decision: decision.decision,
      reason: decision.reason,
      ...(decision.decision === 'ask' ? { options: decision.options } : {}),
    };
  }
  if (!act) {
    return { decision: 'act', reason: decision.reason, takenIntent: decision.action.intent };
  }

  // The main frame, explicitly. Navigation controls are read from the merged
  // scan's top-frame navigation state, so that is the only document whose
  // selectors are meaningful — and a broadcast would let an embedded frame
  // answer for the page.
  const raw: unknown = await chrome.tabs.sendMessage(
    tab.id!,
    {
      type: 'ACTIVATE_NAVIGATION',
      intent: decision.action.intent,
      selector: decision.action.selector,
      expectedLabel: decision.action.label,
    },
    { frameId: 0 },
  );
  const activation = navigationActivationResultSchema.safeParse(raw);
  // Falls back to the human choice rather than retrying: a route that could not
  // be activated once will not activate on a second identical attempt.
  if (!activation.success) {
    return {
      decision: 'ask',
      reason: 'The page did not confirm the route was taken. Choose one yourself.',
      options: portalRoutes(scan.navigation),
    };
  }
  if (activation.data.status === 'refused') {
    return {
      decision: 'ask',
      reason: activation.data.reason,
      options: portalRoutes(scan.navigation),
    };
  }

  // The page moved, so everything downstream — the field list, the page kind,
  // the account form — has to be re-read. Rescanning here rather than leaving it
  // to the popup is what makes the bundle and the new form line up in one step.
  console.info('[agent] portal route taken', {
    intent: activation.data.intent,
    navigated: activation.data.navigated,
  });
  // Recorded before the rescan, so the bundle lookup that the rescan and the
  // popup both perform already knows this page belongs to the run in progress.
  await rememberPortalJourney(activation.data.url);
  await startScan(undefined, activation.data.url);

  return {
    decision: 'act',
    reason: decision.reason,
    takenIntent: activation.data.intent,
    url: activation.data.url,
  };
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

/**
 * Builds the plan for a scan.
 *
 * `analyze` decides whether the one batched model call is part of this call or
 * a separate stage. The orchestrator passes `false` and calls `analyzePlan`
 * afterwards, so the profile's own answers are written and verified on the page
 * before the model is asked anything — the fix for a form that sat untouched
 * for the twenty-plus seconds a model call takes. Every other caller (the
 * review screen, a manual rebuild) wants the finished plan in one step and
 * leaves it defaulted.
 */
async function buildPlan(scanId?: string, options: { analyze?: boolean } = {}): Promise<unknown> {
  const scan = await loadLastScan();
  if (!scan || (scanId && scan.id !== scanId)) {
    return { error: fillFailure('INVALID_FILL_PLAN', 'No matching completed scan exists.').error };
  }
  const bundle = await bundleForUrl(scan.url);
  const [profileResult, answersResult, documentsResult, settings] = await Promise.all([
    getProfile(),
    listAnswers(),
    listDocuments(),
    loadSettings(),
  ]);

  // Internship Pilot is the source of truth. The bundle's snapshot is used when
  // it exists; the agent server is only a fallback for a standalone run.
  //
  // Critically, a server that is down is no longer fatal. It used to abort the
  // whole plan — so a user with a complete profile and tailored documents in
  // the bundle got nothing filled because a local process was not running.
  const profile = bundle?.profile ?? profileResult.data?.profile;
  if (!profile) {
    return {
      error: fillFailure(
        'PROFILE_MISSING',
        bundle
          ? 'This application bundle carried no profile, and the local agent server has no saved profile either.'
          : 'No profile is available. Open a job on Internship Pilot and click "Apply with Application Agent", or start the local agent server.',
      ).error,
    };
  }
  const answers = [...(bundle?.approvedAnswers ?? []), ...(answersResult.data?.answers ?? [])];
  const warnings: string[] = [];
  if (profileResult.error && !bundle?.profile) {
    warnings.push(`Saved profile could not be read: ${profileResult.error.message}`);
  }
  const selectedDocument = documentsResult.data
    ? selectSavedResume(
        documentsResult.data.documents,
        settings.selectedDocumentId,
        documentsResult.data.defaultResumeId,
      )
    : undefined;

  let plan = buildDeterministicPlan(scan, profile, answers, selectedDocument);

  // Documents the website tailored for *this* job outrank whatever generic
  // resume is registered on the server, so upload actions are rebound before
  // anything else looks at the plan.
  if (bundle) plan = attachBundleDocuments(plan, scan, bundle);

  // One batched analysis for everything the deterministic pass could not
  // settle. A fully resolved page makes no model call at all.
  if (options.analyze !== false) {
    const analysisNote = await analyzePage(plan, scan, profile, answers, bundle, settings);
    if (analysisNote.plan) plan = analysisNote.plan;
    warnings.push(...analysisNote.warnings);
  }

  await persistPlan(plan);
  await clearAnswerGenerationStore();
  return { plan, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Runs the batched analysis over the plan already stored for this scan.
 *
 * The second half of what `buildPlan` used to do in one step. Reads the stored
 * plan rather than rebuilding it, so the deterministic answers that are by now
 * written and verified on the page are the ones the analysis is layered onto —
 * rebuilding would discard the executor's record of them.
 */
async function analyzePlan(
  scanId?: string,
): Promise<{ plan?: DeterministicFillPlan; ran: boolean; error?: AgentError }> {
  const [scan, stored, settings] = await Promise.all([
    loadLastScan(),
    loadFillPlan(),
    loadSettings(),
  ]);
  if (!scan || (scanId && scan.id !== scanId) || !stored || stored.scanId !== scan.id) {
    return {
      ran: false,
      error: fillFailure('INVALID_FILL_PLAN', 'No matching current plan exists to analyze.').error,
    };
  }
  const bundle = await bundleForUrl(scan.url);
  const [profileResult, answersResult] = await Promise.all([getProfile(), listAnswers()]);
  const profile = bundle?.profile ?? profileResult.data?.profile;
  if (!profile) return { ran: false };

  const answers = [...(bundle?.approvedAnswers ?? []), ...(answersResult.data?.answers ?? [])];
  const note = await analyzePage(stored, scan, profile, answers, bundle, settings);
  if (note.plan) {
    await persistPlan(note.plan);
    return { plan: note.plan, ran: true };
  }
  // No plan came back. Either the analysis was switched off, the agent was
  // unreachable, or the request failed — each of which the note names, and none
  // of which may be reported as "the analysis found nothing".
  return {
    ran: false,
    ...(note.warnings.length
      ? { error: answerFailure('ANALYSIS_FAILED', note.warnings.join(' ')) }
      : {}),
  };
}

/**
 * Runs the one page-level analysis, if there is anything left to analyze and
 * the user has local AI switched on. Never throws: a failed analysis leaves the
 * deterministic plan exactly as it was and reports why.
 */
async function analyzePage(
  plan: DeterministicFillPlan,
  scan: Awaited<ReturnType<typeof loadLastScan>> & object,
  profile: Parameters<typeof buildAnalysisRequest>[0]['profile'],
  answers: Parameters<typeof buildAnalysisRequest>[0]['answers'],
  bundle: Awaited<ReturnType<typeof bundleForUrl>>,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<{ plan?: DeterministicFillPlan; warnings: string[] }> {
  if (!settings.aiGenerationEnabled) return { warnings: [] };

  // One cached health check, not one per field, and a truthful outcome when it
  // fails: everything the deterministic pass filled stays filled, and the
  // questions that needed interpreting are reported as pending rather than as
  // analyzed-and-empty.
  const availability = await agentAvailability(() => fetchAgentStatus());
  if (!canAnalyze(availability)) {
    return { warnings: [availabilityMessage(availability)] };
  }

  const built = buildAnalysisRequest({
    scan,
    plan,
    profile,
    answers,
    bundle,
    model: settings.ai.generationModel,
    timeoutMs: settings.ai.generationTimeoutMs,
  });
  if (!built.request) return { warnings: [] };

  // Has this exact set of unresolved questions, with these exact options,
  // already been analyzed successfully during this run? The orchestrator calls
  // `buildPlan` once per pass, so without this a five-pass run made five full
  // model calls over an unchanged page — minutes of waiting for answers the
  // first call had already produced.
  const memo = analysisScope();
  const fingerprint = analysisFingerprint(scan.id, built.questions);
  if (!memo.shouldAnalyze(fingerprint)) {
    trace('analysis', 'skipping batched analysis; this question set is unchanged', {
      pageId: scan.id,
      questions: built.questions.length,
    });
    return { warnings: [] };
  }

  trace('analysis', 'requesting batched page analysis', {
    pageId: scan.id,
    questions: built.request.questions.length,
    facts: built.request.facts.length,
    requests: 1,
  });
  // The model call is the long part of this stage, and the popup was showing
  // "Matching profile information" throughout it — a truthful label for the
  // stage and a useless one for the wait. Naming the state here is what lets
  // the popup say how many custom questions are being analyzed.
  if (activeAutofill) {
    await recordState(activeAutofill.runId, 'ANALYZING_AI');
  }

  const response = await analyzeForm(built.request, activeAutofill?.controller.signal);
  if (response.error) {
    traceFailure('analysis', 'batched page analysis failed', { code: response.error.code });
    // Deliberately not memoised: a failure is not an answer, and the next pass
    // may well succeed. What must not happen is the run *looping* on it, and
    // that is prevented by the pass limit plus the question ledger rather than
    // by pretending the call succeeded.
    return {
      warnings: [
        `Page analysis did not run: ${response.error.message} Everything your profile could answer was still filled.`,
      ],
    };
  }
  memo.record(fingerprint, true);

  const applied = applyAnalysisToPlan(
    plan,
    scan,
    response.data.plan,
    built.fieldsByQuestionId,
    built.questions,
    bundle,
    // The facts the model was actually given. An answer citing anything else is
    // referencing a profile fact that does not exist.
    built.request.facts,
  );
  console.info('[agent] page analysis applied', {
    pageId: scan.id,
    proposed: response.data.plan.answers.length,
    applied: applied.applied,
    discarded: applied.discarded.length,
    rejectedByServer: response.data.rejected.length,
    durationMs: response.data.durationMs,
  });
  return {
    plan: applied.plan,
    warnings: [
      ...response.data.rejected.map((reason) => `Analysis output rejected: ${reason}`),
      ...applied.discarded.map((entry) => `Analysis answer discarded: ${entry.reason}`),
      ...(response.data.error ? [response.data.error.message] : []),
    ],
  };
}

/**
 * Stores a bundle the website handed over and answers with the acknowledgement
 * the page is waiting for. The website opens the employer URL only after this
 * resolves, so a failure here means the user never leaves Internship Pilot with
 * documents that were not saved.
 */
/**
 * What one profile-sync attempt did, at key level only.
 *
 * Never carries a profile value. This is what Diagnostics renders and what the
 * worker logs, and both must be safe to read over someone's shoulder.
 */
export interface ProfileSyncOutcome {
  ok: boolean;
  report: ProfileSyncEntry[];
  changed: boolean;
  migratedFrom: number | null;
  /** Present when the sync could not run at all. */
  error?: AgentError;
  /** Which stores contributed. Empty when there was nothing to import from. */
  sources: ProfileSourceLabel[];
}

/**
 * Copies the profile Internship Pilot sent into the agent server's own copy.
 *
 * Non-destructive: the server merges rather than overwrites, and cannot replace
 * a populated value with an empty one. Never throws — a sync that could not run
 * is reported as a sync that could not run, and the caller decides whether that
 * matters. For the bundle handoff it does not; for the Diagnostics button it is
 * the whole answer.
 */
async function syncProfileFromBundle(
  bundle: ApplicationBundle | null,
): Promise<ProfileSyncOutcome> {
  const sources: ProfileImportRequest['sources'] = bundle?.profile
    ? [{ label: 'internship_pilot', profile: bundle.profile }]
    : [];

  if (sources.length === 0) {
    return {
      ok: false,
      report: [],
      changed: false,
      migratedFrom: null,
      sources: [],
      error: answerFailure(
        'PROFILE_MISSING',
        bundle
          ? 'This application bundle carried no profile, so there was nothing to import from Internship Pilot.'
          : 'No application bundle is stored, so there is no Internship Pilot profile to import. Open a job on Internship Pilot and click "Apply with Application Agent".',
      ),
    };
  }

  const result = await importProfile(sources);
  if (result.error || !result.data) {
    return {
      ok: false,
      report: [],
      changed: false,
      migratedFrom: null,
      sources: sources.map((source) => source.label),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  return {
    ok: true,
    report: result.data.report,
    changed: result.data.changed,
    migratedFrom: result.data.migratedFrom,
    sources: sources.map((source) => source.label),
  };
}

/**
 * The Diagnostics "Sync profile now" action.
 *
 * Uses the bundle for the page the user is looking at when there is one, and
 * otherwise the most recent bundle, so the button works on the settings page as
 * well as on an employer form.
 */
async function syncProfileNow(url?: string): Promise<ProfileSyncOutcome> {
  const bundle = url
    ? ((await bundleForUrl(url).catch(() => null)) ?? (await loadActiveBundle().catch(() => null)))
    : ((await loadActiveBundle().catch(() => null)) ??
      (await listBundles().catch(() => []))[0] ??
      null);
  return syncProfileFromBundle(bundle);
}

async function storeApplicationBundle(transfer: unknown): Promise<unknown> {
  const parsed = applicationBundleTransferSchema.safeParse(transfer);
  if (!parsed.success) {
    return {
      result: {
        ok: false as const,
        reason: `The application bundle failed schema validation: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      },
    };
  }
  try {
    const bundle = await saveBundle(parsed.data);
    // Arms this one origin. The employer tab the website is about to open will
    // start filling by itself, so "Apply with Agent" stays a single action.
    await armAutoStart(bundle);
    // The profile travels onward into the agent server's own copy, so the
    // settings page stops asking for experience and education the user already
    // entered on Internship Pilot. Deliberately awaited *and* deliberately
    // non-fatal: the acknowledgement is about the bytes landing, and a local
    // server that happens to be down must not fail a handoff whose documents
    // are already stored.
    const sync = await syncProfileFromBundle(bundle);
    console.info('[agent] application bundle saved', {
      bundleId: bundle.id,
      company: bundle.company,
      documents: [bundle.resume?.kind, bundle.coverLetter?.kind].filter(Boolean),
      profileSynced: sync.ok,
      profileKeysImported: sync.ok
        ? sync.report.filter((entry) => entry.status === 'imported').length
        : 0,
    });
    return {
      result: {
        ok: true as const,
        bundleId: bundle.id,
        storedDocuments: [
          ...(bundle.resume ? ['resume' as const] : []),
          ...(bundle.coverLetter ? ['cover_letter' as const] : []),
        ],
        storedAt: new Date().toISOString(),
      },
    };
  } catch (cause) {
    return {
      result: {
        ok: false as const,
        reason: `The extension could not store the bundle: ${describeSchemaFailure(
          cause,
          'The application bundle',
        )}`,
      },
    };
  }
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
    return {
      error: fillFailure(
        code,
        `The fill-plan update failed: ${describeSchemaFailure(cause, 'The updated plan')}`,
      ).error,
    };
  }
}

/**
 * Reads a tailored document out of the bundle store and shapes it like a
 * server-supplied document, so the executor has one upload path rather than two.
 */
async function bundleDocumentContent(
  bundle: Awaited<ReturnType<typeof bundleForUrl>>,
  documentId: string,
): Promise<{ data: DocumentContentResponse } | { error: AgentError }> {
  const document =
    bundle?.resume?.bytesReference === documentId
      ? bundle.resume
      : bundle?.coverLetter?.bytesReference === documentId
        ? bundle.coverLetter
        : undefined;
  if (!document) {
    return {
      error: answerFailure(
        'BUNDLE_DOCUMENT_MISSING',
        'The tailored document for this upload is no longer in the saved bundle.',
      ),
    };
  }
  const bytes = await readBundleDocument(document);
  if (!bytes) {
    return {
      error: answerFailure(
        'BUNDLE_DOCUMENT_MISSING',
        `The stored bytes for ${document.filename} could not be read.`,
      ),
    };
  }
  return {
    data: {
      id: document.bytesReference,
      fileName: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.byteLength,
      contentBase64: encodeBase64(bytes),
    },
  };
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
  const activeBundle = await bundleForUrl(plan.url);
  for (const action of plan.actions.filter(
    (candidate) => candidate.action === 'upload_file' && candidate.approved,
  )) {
    if (!action.documentId) {
      return fillFailure('DOCUMENT_MISSING', 'An approved upload has no document reference.');
    }
    // A bundle document is already in the extension. Only a server-registered
    // document needs a round trip, so the tailored files work with the agent
    // server closed.
    if (isBundleDocumentReference(action.documentId)) {
      const content = await bundleDocumentContent(activeBundle, action.documentId);
      if ('error' in content) return { error: content.error };
      documentContents.push(content.data);
      continue;
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
    const frames = await discoverFrames(tab.id!, tab.url);
    if (frames.length === 0) {
      return fillFailure('ACTIVE_TAB_UNAVAILABLE', RECONNECT_MESSAGE);
    }
    const raw: unknown = await Promise.race([
      // Sliced by the frame each field was discovered in. Sending the whole plan
      // to the top frame leaves every field of an embedded widget reported as
      // "not found", which reads as a scanning failure and is an addressing one.
      fillAcrossFrames({ tabId: tab.id!, frames, scan, plan, documentContents, runId }).then(
        (outcome) =>
          'report' in outcome
            ? { type: 'FILL_COMPLETE', report: outcome.report }
            : fillFailure('INVALID_FILL_PLAN', `The fill run could not complete: ${outcome.error}`),
      ),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('FILL_TIMEOUT')), FILL_TIMEOUT_MS);
      }),
    ]);
    if (raw && typeof raw === 'object' && 'error' in raw) return raw;
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
      `The deterministic fill run could not complete: ${describeSchemaFailure(
        cause,
        "The page's response",
      )}`,
      { runId, planId: plan.id, ...schemaFailureContext(cause) },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelFill(runId?: string, targetUrl?: string): Promise<unknown> {
  try {
    const plan = await loadFillPlan();
    const tab = await activeApplicationTab(targetUrl ?? plan?.url);
    // Every frame: the run may be executing in any of them, and a cancel that
    // reaches only the top frame leaves an embedded widget still being filled.
    await tellEveryFrame(tab.id!, await discoverFrames(tab.id!, tab.url), {
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
    await tellEveryFrame(tab.id!, await discoverFrames(tab.id!, tab.url), {
      type: 'SCAN_CANCEL',
      ...(scanId ? { scanId } : {}),
    });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** The one in-flight autofill run, so a second click cancels rather than races. */
let activeAutofill: { runId: string; cancelled: boolean; controller: AbortController } | null =
  null;

/**
 * The single "Autofill Application" action.
 *
 * This sequences the modules that already exist — it re-implements none of
 * them. Scanning, planning, analysis, approval policy, execution, and
 * highlighting each stay where they are, so there is exactly one copy of every
 * rule and no second path that can drift.
 */
/**
 * Accepts an autofill request and answers immediately.
 *
 * This is the fix for `EXTENSION_RELOAD_REQUIRED … no response within 15000ms`.
 * The popup used to hold one `sendMessage` open for the entire run — scan, AI
 * batch, fill, verify, rescan, up to five passes — against a fifteen-second
 * deadline. That deadline is shorter than a single AI batch, so the call
 * *always* timed out on a real form. Nothing was broken, which is exactly why
 * reloading the extension never helped.
 *
 * The request now returns an acknowledgement in milliseconds and the work runs
 * detached, reporting through durable run state that survives the service
 * worker being suspended underneath it.
 */
/**
 * Refuses a run whose components are not all from the same build.
 *
 * The check is here, at the one entry point that starts work, rather than
 * scattered through the stages that would each fail differently. A mixed-version
 * run is not a degraded run — the scan, the plan, and the fill each cross a
 * bundle boundary, and a disagreement anywhere produces an error naming a value
 * rather than the build. Returns the refusal, or null when everything agrees.
 */
async function buildMismatchRefusal(targetUrl?: string): Promise<AgentError | null> {
  const tab = await activeApplicationTab(targetUrl).catch(() => null);
  if (!tab?.id) return null; // Reported later, by the stage that needs the tab.
  const connection = await ensureContentScript(tab.id, tab.url);
  // An unreachable content script is a different problem with a different
  // remedy, and the stages below already name it.
  if (!connection.reachable) return null;

  const agreement = compareBuilds([
    { component: 'worker', buildId: BUILD_ID },
    { component: 'content', buildId: connection.buildId },
  ]);
  if (agreement.agreed) return null;
  console.warn('[agent] refusing a mixed-build run', {
    worker: BUILD_ID,
    content: connection.buildId ?? 'unstamped',
  });
  return {
    code: 'BUILD_MISMATCH',
    message: agreement.message ?? BUILD_MISMATCH_MESSAGE,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.BUILD_MISMATCH,
    // Build ids only. No page content, no profile, nothing about the user.
    debugContext: { worker: BUILD_ID, content: connection.buildId ?? 'unstamped' },
  };
}

async function acceptAutofillRun(targetUrl?: string): Promise<unknown> {
  // Before anything else: are the parts of this extension the same extension?
  // Every symptom this repair began from was produced by a browser running a
  // bundle two commits behind the source it was tested against.
  const mismatch = await buildMismatchRefusal(targetUrl);
  if (mismatch) return { error: mismatch };

  // One click, one run. Without this a second click minted a second id,
  // overwrote the stored run, and left the first orchestrator running
  // invisibly — two passes over the same page, two batched model calls, and a
  // cancel button that could only reach the newer of them.
  const existing = await activeRun();
  if (existing) {
    return {
      ok: true as const,
      accepted: false as const,
      runId: existing.runId,
      state: existing.state,
      reason: 'A run is already in progress on this page.',
    };
  }
  const runId = `autofill-${crypto.randomUUID()}`;
  let url = targetUrl ?? '';
  if (!url) {
    url = await activeApplicationTab()
      .then((tab) => tab.url ?? '')
      .catch(() => '');
  }
  await startRun(runId, url);

  // Deliberately not awaited. The floating promise is the point: the response
  // below must not wait for it, and every failure inside it is recorded in the
  // run state rather than thrown at a caller who has already gone.
  void runAutofill(targetUrl, runId)
    .then(async (result) => {
      const outcome = result as { report?: ApplicationAutofillReport; error?: AgentError };
      // The document path runs after the fields, on the settled page — but only
      // when the run itself attached nothing.
      //
      // A run started from an Internship Pilot bundle has already attached that
      // job's tailored documents, and those are the right ones: they were
      // generated for this employer and travelled with this application.
      // Re-attaching the globally newest pair over them would replace a
      // job-specific résumé with whatever happened to be generated most
      // recently. This step exists for the case that was broken — no bundle
      // could be matched to the page at all — and stays out of the way of the
      // case that works.
      //
      // Deliberately not folded into the autofill report: an upload widget that
      // refuses a file is a fact about a document, not a field, and the two are
      // reported separately so neither can mask the other.
      if ((outcome.report?.documentsAttached ?? 0) === 0) {
        const attached = await attachLatestDocuments(
          { resolveTab: activeApplicationTab, ensureContentScript, discoverFrames },
          targetUrl,
        ).catch(() => null);
        if (attached && 'report' in attached) {
          console.info('[agent] documents attached after autofill', {
            runId,
            resumeVerified: attached.report.resume.verified,
            coverLetterVerified: attached.report.coverLetter.verified,
          });
        }
      }
      await finishRun(runId, outcome);
    })
    .catch(async (cause: unknown) => {
      traceFailure('worker', 'autofill run threw', {
        runId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      await finishRun(runId, {
        error: answerFailure(
          'INTERNAL_ERROR',
          'The autofill run stopped unexpectedly. Try it again.',
        ),
      });
    });

  return { ok: true as const, accepted: true as const, runId };
}

async function runAutofill(targetUrl?: string, requestedRunId?: string): Promise<unknown> {
  const state = {
    runId: requestedRunId ?? `autofill-${crypto.randomUUID()}`,
    cancelled: false,
    // Reaches an in-flight model call, which the cancelled flag cannot: that
    // flag is only read between phases.
    controller: new AbortController(),
  };
  activeAutofill = state;
  // One memo per run. Scoped here rather than globally because a new click is
  // the user asking us to look again — a memo that outlived the run would make
  // the second click a silent no-op.
  beginAnalysisScope();
  try {
    const report = await runApplicationAutofill({
      buildId: BUILD_ID,
      onTrace: (trace) => {
        // Stored and logged, never sent anywhere. The one line below is what
        // turns "it filled two of twenty-seven" into a diagnosis without a
        // debugger attached to a worker Chrome keeps suspending.
        console.info('[agent] run trace', {
          runId: trace.runId,
          buildId: trace.buildId,
          scanned:
            `${trace.rawControls} raw → ${trace.normalizedQuestions} questions ` +
            `(−${trace.falseControlsRemoved} not questions, −${trace.duplicateControlsRemoved} duplicates)`,
          deterministic: `${trace.deterministicPlanned} planned / ${trace.deterministicExecuted} executed / ${trace.deterministicVerified} verified`,
          ai: `${trace.aiRequests} request(s), ${trace.aiActionsReturned} answers, ${trace.aiActionsVerified} verified`,
          remaining: trace.requiredFieldsRemaining,
          totalMs: trace.totalDurationMs,
          why: describeRunTrace(trace),
        });
        void saveRunTrace(trace).catch(() => undefined);
      },
      loadSettings: async () => (await loadSettings()).autofill,
      scan: async () => {
        const response = await startScan(undefined, targetUrl);
        const parsed = scanApplicationResponseSchema.safeParse(response);
        if (!parsed.success) {
          return { error: answerFailure('SCAN_FAILED', 'The application could not be read.') };
        }
        return parsed.data.type === 'SCAN_COMPLETE'
          ? { scan: parsed.data.result }
          : { error: parsed.data.error };
      },
      plan: async (scanId) => {
        // Deterministic only. The analysis is the separate stage below, so the
        // profile's answers reach the page before any model call is made.
        const built = (await buildPlan(scanId, { analyze: false })) as {
          plan?: DeterministicFillPlan;
          error?: AgentError;
        };
        return built.plan ? { plan: built.plan } : { error: built.error };
      },
      analyze: (scanId) => analyzePlan(scanId),
      fillAccountForm: async (scan) => {
        const [settings, bundle, profileResult] = await Promise.all([
          loadSettings(),
          bundleForUrl(scan.url),
          getProfile(),
        ]);
        const tab = await activeApplicationTab(targetUrl).catch(() => null);
        if (!tab?.id) return { filled: false, reason: 'The application tab could not be reached.' };
        const write = async (selector: string, payload: { value?: string; checked?: boolean }) => {
          const response: unknown = await chrome.tabs
            .sendMessage(tab.id!, { type: 'ACCOUNT_WRITE_FIELD', selector, ...payload })
            .catch(() => null);
          return (response as { ok?: boolean } | null)?.ok === true;
        };
        return fillAccountForm({
          scan,
          settings,
          profile: bundle?.profile ?? profileResult.data?.profile,
          accountPreferences: bundle?.accountPreferences,
          writeField: (selector, value) => write(selector, { value }),
          writeCheckbox: (selector, checked) => write(selector, { checked }),
        });
      },
      approve: async (decisions) => {
        const result = (await mutatePlan((plan) => {
          let next = plan;
          for (const [actionId, approved] of decisions) {
            next = setActionApproval(next, actionId, approved);
          }
          return next;
        })) as { error?: AgentError };
        return result.error ? { error: result.error } : {};
      },
      execute: async () => {
        const response = (await executeApproved(targetUrl)) as
          | { type: 'FILL_COMPLETE'; report: FillRunReport }
          | { type: 'FILL_FAILED'; error: AgentError }
          | { error: AgentError };
        if ('report' in response) return { report: response.report };
        return { error: 'error' in response ? response.error : undefined };
      },
      highlight: async (requests, scrollToFirst) => {
        try {
          const tab = await activeApplicationTab(targetUrl);
          // Every frame. A field needing review can be in any of them, and each
          // frame ignores requests for fields it does not hold.
          await tellEveryFrame(tab.id!, await discoverFrames(tab.id!, tab.url), {
            type: 'HIGHLIGHT_REVIEW_FIELDS',
            requests,
            scrollToFirst,
          });
          return {};
        } catch (cause) {
          return {
            error: answerFailure(
              'CONTENT_SCRIPT_UNAVAILABLE',
              `Fields needing review could not be marked on the page: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            ),
          };
        }
      },
      onProgress: (progress) => {
        // Written first, broadcast second. A closed popup misses the broadcast
        // entirely, and a popup opened halfway through a run has to be able to
        // find out where it got to — so the durable copy is the source of
        // truth and the message is only a nudge to read it sooner.
        void recordProgress(state.runId, progress);
        void chrome.runtime
          .sendMessage({ type: 'AUTOFILL_PROGRESS', progress })
          .catch(() => undefined);
      },
      isCancelled: () => state.cancelled,
      // Long enough for a framework to re-render a revealed section, short
      // enough that five passes stay responsive.
      waitForStability: () => new Promise((resolve) => setTimeout(resolve, 350)),
      // The Country → State handoff. Every frame is asked at once — a 2s bound
      // per frame taken one after another would be a long sleep wearing an
      // observer's clothes — and a frame holding none of these controls answers
      // immediately.
      awaitDependentOptions: async (selectors) => {
        const populated = new Set<string>();
        const pending = new Set<string>(selectors);
        try {
          const tab = await activeApplicationTab(targetUrl);
          const tabId = tab.id!;
          const frames = await discoverFrames(tabId, tab.url);
          const replies = await Promise.allSettled(
            frames.map((frame) =>
              chrome.tabs.sendMessage(
                tabId,
                { type: 'AWAIT_DEPENDENT_OPTIONS', selectors, timeoutMs: 2000 },
                { frameId: frame.frameId },
              ),
            ),
          );
          for (const reply of replies) {
            if (reply.status !== 'fulfilled') continue;
            const parsed = dependentOptionsResultSchema.safeParse(reply.value);
            if (!parsed.success) continue;
            for (const selector of parsed.data.populated) {
              populated.add(selector);
              pending.delete(selector);
            }
          }
        } catch {
          // A frame that cannot be reached is reported as still pending, which
          // is the truthful reading: nothing observed those options arriving.
        }
        return { populated: [...populated], pending: [...pending] };
      },
      /**
       * Presses each repeating section's Add control until the page holds one
       * block per saved record.
       *
       * This dependency is why an applicant with three jobs used to submit one.
       * The orchestrator has called it on the first pass since repeating
       * sections were supported; this worker never passed it, so the optional
       * chaining read `undefined`, the whole block was skipped without a
       * warning, and every run filled whatever blocks the page happened to load
       * with. The only caller that ever supplied it was a test — which passed,
       * the entire time.
       */
      growRepeatedSections: async () => {
        const [tab, profileResult] = await Promise.all([
          activeApplicationTab(targetUrl).catch(() => null),
          getProfile(),
        ]);
        // The bundle for *this* page when the tab named one, so two
        // applications open in two tabs each grow from their own profile.
        const bundle = tab?.url ? await bundleForUrl(tab.url).catch(() => null) : null;
        const profile = bundle?.profile ?? profileResult.data?.profile;
        if (!tab?.id || !profile) return [];

        const outcome = await runRepeaterAutofill({
          tabId: tab.id,
          frames: await discoverFrames(tab.id, tab.url),
          runId: state.runId,
          profile,
        });
        return outcome.sections.map(asRepeatedSectionOutcome);
      },
      /**
       * The Dropdown Engine pass, over every frame of this application.
       *
       * This dependency is why a live form came back with eight menus reading
       * "No Selection" while the engine that drives them built cleanly and
       * passed its own tests. Nothing imported `runDropdownAutofill`: it was a
       * complete pass — discovery, resolution, dependency rounds, per-control
       * outcomes — reachable only from a test file, and the content script had
       * no handler for either of its two messages. The engine was not broken.
       * It was never called.
       */
      runDropdownStage: async () => {
        const [tab, profileResult, answersResult] = await Promise.all([
          activeApplicationTab(targetUrl).catch(() => null),
          getProfile(),
          listAnswers(),
        ]);
        const bundle = tab?.url ? await bundleForUrl(tab.url).catch(() => null) : null;
        const profile = bundle?.profile ?? profileResult.data?.profile;
        if (!tab?.id || !profile) return [];

        const outcome = await runDropdownAutofill({
          tabId: tab.id,
          frames: await discoverFrames(tab.id, tab.url),
          runId: state.runId,
          profile,
          approvedAnswers: [
            ...(bundle?.approvedAnswers ?? []),
            ...(answersResult.data?.answers ?? []),
          ],
          companyName: bundle?.company ?? '',
          ...(bundle?.companyRelationship === undefined
            ? {}
            : { companyRelationship: bundle.companyRelationship }),
        });
        // Counts and outcomes only — never an answer. The one line that says
        // whether the pass reached the page at all.
        console.info('[agent] dropdown engine', {
          runId: state.runId,
          ...outcome.summary,
          unreachableFrames: outcome.unreachableFrames.length,
        });
        return outcome.results;
      },
      /**
       * Drives every field whose answer another field produces.
       *
       * Given the scan the orchestrator just used, so the graph is built over
       * the same questions the plan was — including the blocks the Repeater
       * Engine created a moment earlier, each with its own Country → State →
       * School chain.
       */
      resolveDependencies: async (scan) => {
        const [tab, profileResult, answersResult] = await Promise.all([
          activeApplicationTab(targetUrl).catch(() => null),
          getProfile(),
          listAnswers(),
        ]);
        const bundle = tab?.url ? await bundleForUrl(tab.url).catch(() => null) : null;
        const profile = bundle?.profile ?? profileResult.data?.profile;
        if (!tab?.id || !profile) return [];

        // Grouped by the frame each control actually lives in, because an edge
        // is only drivable where both of its controls are — and a page that
        // renders Education in an iframe has its whole chain in that frame.
        const fieldsByFrame = new Map<number, DetectedField[]>();
        for (const field of scan.fields) {
          const frameId = field.frameId ?? 0;
          fieldsByFrame.set(frameId, [...(fieldsByFrame.get(frameId) ?? []), field]);
        }

        const outcome = await runDependencyResolution({
          tabId: tab.id,
          frames: await discoverFrames(tab.id, tab.url),
          runId: state.runId,
          profile,
          approvedAnswers: [
            ...(bundle?.approvedAnswers ?? []),
            ...(answersResult.data?.answers ?? []),
          ],
          companyName: bundle?.company ?? '',
          ...(bundle?.companyRelationship === undefined
            ? {}
            : { companyRelationship: bundle.companyRelationship }),
          fieldsByFrame,
        });
        return [...outcome.edges];
      },
      now: () => new Date().toISOString(),
    });
    await saveAutofillReport(report);
    return { report };
  } finally {
    endAnalysisScope();
    if (activeAutofill === state) activeAutofill = null;
  }
}

/**
 * Starts a run on a page the user reached through "Apply with Agent".
 *
 * Always resolves with an acknowledgement, never an error: a page announcing
 * itself is not making a request that can fail, and the content script does not
 * wait on the answer.
 */
async function maybeAutoStart(url: string): Promise<unknown> {
  const bundle = await bundleForUrl(url).catch(() => null);
  if (!(await shouldAutoStart(url, bundle))) return { started: false };
  console.info('[agent] auto-starting the run armed by Apply with Agent', {
    company: bundle?.company,
  });
  // Through the same gate as a click, and for the same reason: an auto-start
  // racing a user's own click used to produce two concurrent orchestrators over
  // one page. `acceptAutofillRun` refuses the second, whichever arrives first,
  // and records the run so the popup can adopt it.
  const accepted = (await acceptAutofillRun(url)) as { accepted: boolean };
  return { started: accepted.accepted };
}

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[agent] installed', { reason: details.reason });
});

/** Maps a message to the client call that serves it. */
function handle(message: ExtensionMessage): Promise<unknown> | null {
  switch (message.type) {
    case 'AGENT_STATUS_REQUEST':
      // A fresh request from the UI means the user is asking now; the cache
      // exists to stop per-field probes, not to stale the popup.
      clearAgentAvailabilityCache();
      return fetchAgentStatus();
    case 'SAVE_APPLICATION_BUNDLE':
      return storeApplicationBundle(message.bundle);
    case 'GET_ACTIVE_BUNDLE':
      // A page-specific lookup when the caller knows which tab it means, so two
      // applications open in two tabs each see their own documents.
      return (message.url ? bundleForUrl(message.url) : loadActiveBundle()).then((bundle) => ({
        data: bundle,
      }));
    case 'LIST_BUNDLES':
      return listBundles().then((bundles) => ({ data: { bundles } }));
    case 'SET_ACTIVE_BUNDLE':
      return setActiveBundle(message.bundleId).then((bundle) => ({ data: bundle }));
    case 'DELETE_BUNDLE':
      return deleteBundle(message.bundleId).then(() => ({ ok: true as const }));
    case 'SYNC_PROFILE':
      return syncProfileNow(message.url);
    case 'ENSURE_CONTENT_SCRIPT':
      return ensureContentScript(message.tabId, message.url);
    case 'GET_PORTAL_ROUTE':
      return portalRoute(false, message.targetUrl);
    case 'FOLLOW_PORTAL_ROUTE':
      return portalRoute(true, message.targetUrl);
    case 'PAGE_READY':
      return maybeAutoStart(message.url);
    case 'WORKER_PING':
      // Answered before anything else could fail. This is how the popup tells
      // "the worker is gone" from "the worker is busy", instead of blaming a
      // timeout on a stale install and telling the user to reload.
      // The build id rides along, so the popup can compare its own without a
      // second round trip and without a message that exists only to ask.
      return Promise.resolve({ ok: true as const, at: Date.now(), buildId: BUILD_ID });
    case 'GET_RUN_TRACES':
      return loadRunTraces().then((traces) => ({ traces }));
    case 'CLEAR_RUN_TRACES':
      return clearRunTraces().then(() => ({ cleared: true as const }));
    case 'EXPORT_AUTOFILL_RUN_TRACE':
      // The most recent run, field by field, with its own diagnosis attached.
      // Counts and outcomes only: `runTraceSchema` is strict and no member of
      // `fieldTraceSchema` can hold a value, so this is safe to attach to a bug
      // report without reading it first.
      return loadRunTraces().then((traces) => {
        const latest = traces[0];
        if (!latest) {
          return {
            error: answerFailure(
              'NO_RUN_RECORDED',
              'No autofill run has been recorded yet, so there is nothing to export. Run autofill on an application page first.',
            ),
          };
        }
        return {
          export: autofillRunTraceExportSchema.parse({
            exportedAt: new Date().toISOString(),
            buildId: BUILD_ID,
            summary: describeRunTrace(latest),
            trace: latest,
          }),
        };
      });
    case 'RUN_APPLICATION_AUTOFILL':
      return acceptAutofillRun(message.targetUrl);
    case 'GET_AUTOFILL_RUN':
      return loadRun().then((run) => ({ run }));
    case 'CANCEL_APPLICATION_AUTOFILL':
      if (activeAutofill) {
        activeAutofill.cancelled = true;
        // The flag alone is only read between phases, so a cancel arriving
        // during a sixty-second model call did nothing until the call returned.
        // Aborting the controller reaches the in-flight request itself.
        activeAutofill.controller.abort();
      }
      return loadRun().then(async (run) => {
        // Recorded as cancelled even when the worker restarted and no longer
        // holds the run in memory, so the popup stops waiting either way.
        if (run?.status === 'running') {
          await finishRun(run.runId, {
            error: answerFailure('AUTOFILL_CANCELLED', 'You cancelled this run.'),
          });
        }
        return { ok: true as const };
      });
    case 'GET_AUTOFILL_REPORT':
      return loadAutofillReport().then((report) => ({ report }));
    case 'AUTOFILL_PROGRESS':
      // Delivered straight to extension-page listeners; the worker only
      // acknowledges so a closed popup cannot fail the run.
      return Promise.resolve({ ok: true });
    case 'FOCUS_REVIEW_FIELD':
      return activeApplicationTab()
        .then(async (tab) =>
          tellEveryFrame(tab.id!, await discoverFrames(tab.id!, tab.url), {
            type: 'FOCUS_REVIEW_FIELD',
            fieldId: message.fieldId,
          }),
        )
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false }));
    case 'CLEAR_REVIEW_HIGHLIGHTS':
      return activeApplicationTab()
        .then(async (tab) =>
          tellEveryFrame(tab.id!, await discoverFrames(tab.id!, tab.url), {
            type: 'CLEAR_REVIEW_HIGHLIGHTS',
          }),
        )
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false }));
    case 'HIGHLIGHT_REVIEW_FIELDS':
      // Handled by the content script, not here.
      return null;
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
    case 'GET_LATEST_DOCUMENTS':
      return readLatestDocuments();
    case 'SYNC_LATEST_DOCUMENTS':
      return syncLatestDocuments();
    case 'ATTACH_DOCUMENTS':
      return attachLatestDocuments(
        { resolveTab: activeApplicationTab, ensureContentScript, discoverFrames },
        message.targetUrl,
      );
    case 'EXPORT_PAGE_CONTROL_TRACE':
      return exportPageControlTrace(
        { resolveTab: activeApplicationTab, ensureContentScript, discoverFrames },
        message.targetUrl,
      );
    case 'DISCOVER_UPLOAD_CONTROLS':
    case 'ATTACH_DOCUMENT_TO_CONTROL':
      // Handled by the content script, not here.
      return null;
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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
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
  const pending = handle(message);

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
          `The background worker failed handling ${message.type}: ${describeSchemaFailure(
            cause,
            'That message',
          )}`,
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
