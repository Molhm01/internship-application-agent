import {
  DEFAULT_ERROR_GUIDANCE,
  applicationAutofillReportSchema,
  QuestionLedger,
  auditRequiredFields,
  contractViolation,
  autofillFieldResultSchema,
  type AgentError,
  type ApplicationAutofillReport,
  type ApplicationScanResult,
  type AutofillFieldResult,
  type AutofillPhase,
  type AutofillProgress,
  type AutofillSettings,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FillExecutionResult,
  type FillRunReport,
  type ReviewReason,
  type FieldTrace,
  type RunTrace,
  runTraceSchema,
  traceOrigin,
  ANNOTATION_BADGES,
  annotationFor,
  assertNoTemporaryStatuses,
  classifyQuestionDeterministically,
  countFinalStatuses,
  isSettledStatus,
  resolveFinalFieldStatus,
  resolveRunningFieldStatus,
  type AnnotationKind,
  type FieldRunStatus,
  type FinalFieldOutcome,
  type FinalFieldStatus,
} from '@internship-agent/shared';
import { finalizePendingResult, pendingResults } from '@internship-agent/shared';
import { decideApproval, type ApprovalDecision } from './approvalPolicy.js';
import { buildCoverage, describeCoverage } from './coverage.js';
import { isFinalSubmitControl } from '../scanner/adapters.js';
import { isDependentControl } from '../planner/deterministicPlanner.js';

/**
 * One-button autofill.
 *
 * This module sequences work; it does not do it. Scanning, option discovery,
 * matching, generation, execution, and verification all stay in the modules
 * that already own them, reached through the `AutofillDependencies` below. That
 * keeps a single implementation of each rule — a second copy of "may this be
 * filled?" living here is exactly how the two paths would drift apart.
 */

export const MAX_ITERATIONS = 5;

/**
 * Text that means the next control ends the application rather than continues
 * it. Matched against a URL with its separators flattened, so
 * `/review-and-submit` and `/review_and_submit` read the same as the words.
 */
const FINAL_STAGE = /\b(submit application|submit your application|review and submit)\b/i;

function flattenSeparators(value: string): string {
  return value.replace(/[-_+/]+/g, ' ');
}
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|i'?m not a robot)\b/i;
const MFA =
  /\b(verification code|two[- ]factor|2fa|authenticator|one[- ]time (code|password)|multi[- ]factor)\b/i;

export interface AutofillDependencies {
  /**
   * The build this run is executing as. Recorded in the trace so a report can
   * never be attributed to the wrong bundle — the failure that made three
   * rounds of repairs look ineffective.
   */
  buildId?: string;
  /**
   * Receives the finished run trace. Optional: the trace is a diagnostic, and a
   * caller that does not want one must not have to fabricate a sink for it.
   */
  onTrace?(trace: RunTrace): void;
  loadSettings(): Promise<AutofillSettings>;
  /** Runs the existing scanner against the live page. */
  scan(): Promise<{ scan?: ApplicationScanResult; error?: AgentError }>;
  /**
   * Runs the deterministic planner over the latest scan.
   *
   * Deterministic only. The batched analysis used to live inside this call,
   * which meant nothing at all was written until the model answered — a page
   * whose profile fields could fill in under a second showed an untouched form
   * for twenty-plus seconds. It is `analyze` below now, and it runs after these
   * answers are already on the page.
   */
  plan(scanId: string): Promise<{ plan?: DeterministicFillPlan; error?: AgentError }>;
  /**
   * One batched analysis of whatever the deterministic pass could not settle,
   * returning the plan it produced. Optional: a run with no local model, or a
   * page the profile fully answered, never calls it.
   *
   * `ran` distinguishes "the analysis happened and had nothing to add" from
   * "the analysis never happened" — two states that leave a field looking
   * identical and need completely different responses from the user.
   */
  analyze?(
    scanId: string,
  ): Promise<{ plan?: DeterministicFillPlan; ran: boolean; error?: AgentError }>;
  /** Generates written answers for eligible fields. Optional. */
  generate?(plan: DeterministicFillPlan): Promise<{ error?: AgentError }>;
  /**
   * Fills the username and password on an account-creation page, when the user
   * enabled that. Optional, and a no-op on every other kind of page.
   *
   * Kept out of the ordinary plan on purpose: an employer-site password must
   * never enter a `DeterministicFillPlan`, which is stored, sent to the popup,
   * and shown on a review screen.
   */
  fillAccountForm?(scan: ApplicationScanResult): Promise<{ filled: boolean; reason?: string }>;
  /** Records the approval decisions the policy reached. */
  approve(decisions: ReadonlyMap<string, boolean>): Promise<{ error?: AgentError }>;
  /** Runs the existing executor over the approved actions. */
  execute(): Promise<{ report?: FillRunReport; error?: AgentError }>;
  /** Draws the in-page marks and optionally scrolls to the first. */
  highlight(
    requests: readonly HighlightPlan[],
    scrollToFirst: boolean,
  ): Promise<{ error?: AgentError }>;
  onProgress(progress: AutofillProgress): void;
  /** Resolves true when the run has been cancelled. */
  isCancelled(): boolean;
  /** Lets a revealed field settle before the next scan. */
  waitForStability(): Promise<void>;
  now(): string;
}

export interface HighlightPlan {
  fieldId: string;
  selector: string;
  /**
   * What this mark means, derived from the field's final status and from
   * nothing else. The previous input was `reason`, a review flag computed
   * before the executor ran — which is why a field that filled and verified
   * went on wearing "Information needed".
   */
  annotation: AnnotationKind;
  /** Kept for the review queue's wording. It no longer chooses the colour. */
  reason?: ReviewReason;
  badge: string;
  question: string;
}

function agentError(code: AgentError['code'], message: string): AgentError {
  return {
    code,
    message,
    recoverable: code !== 'AUTOFILL_DISABLED',
    suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
    debugContext: {},
  };
}

/** A page state that must stop the run rather than be worked around. */
function blockingCondition(scan: ApplicationScanResult): AgentError | null {
  const haystack = scan.fields
    .map((field) => `${field.question} ${field.helpText ?? ''}`)
    .join(' \n ');
  if (CAPTCHA.test(haystack)) return agentError('CAPTCHA_DETECTED', 'A CAPTCHA is on this page.');
  if (MFA.test(haystack)) {
    return agentError('MFA_DETECTED', 'This step asks for a verification code.');
  }
  return null;
}

/**
 * True when this scan looks like the final confirm-and-submit step.
 *
 * A step with nothing left to answer, on a URL that names submission, is the
 * review page. The adapter's own wording is consulted as well, so a vendor that
 * calls it something else is still recognized — and a vendor-neutral list backs
 * both up, because an unrecognized employer form must refuse it too.
 */
export function isFinalSubmissionStage(scan: ApplicationScanResult): boolean {
  const answerable = scan.fields.filter(
    (field) => field.visible && !field.disabled && field.fieldType !== 'unknown',
  );
  if (answerable.length > 0) return false;
  const url = flattenSeparators(scan.url);
  return FINAL_STAGE.test(url) || isFinalSubmitControl(scan.ats.id, url);
}

function reviewReasonFor(
  action: DeterministicFillAction,
  decision: { approved: boolean; reviewReason?: ReviewReason },
  executed: { verified: boolean; failed: boolean } | undefined,
): ReviewReason | undefined {
  if (executed?.failed) return 'failed';
  // An approved action that filled and verified has nothing left to review,
  // even if the policy flagged it as a suggestion on the way in.
  if (decision.approved && executed?.verified && decision.reviewReason !== 'ai_suggestion') {
    return undefined;
  }
  if (decision.approved && executed?.verified) return decision.reviewReason;
  if (decision.approved && !executed) return undefined;
  return decision.reviewReason ?? (action.sensitive ? 'manual_required' : 'missing_information');
}

function countSource(results: readonly AutofillFieldResult[], source: string): number {
  return results.filter((result) => result.source === source).length;
}

/**
 * Whether an executor result means the page was actually touched.
 *
 * The content script returns one result per action in the plan, including the
 * ones it deliberately did nothing about: an action that is not approved comes
 * back `skipped`, a `manual_review` action comes back `needs_review`, a control
 * it cannot drive comes back `unsupported`. Those are refusals, not attempts.
 *
 * Reading them as attempts is what made a run that filled and verified
 * twenty-five fields report one. The deterministic pass verified twenty-five;
 * the next pass re-approved only the single dependent control the page had just
 * revealed, and every other action came back `skipped` — which the orchestrator
 * read as "executed, and not verified", downgrading twenty-four verified fields
 * to failed. The pass after that, which executed nothing at all, rewrote those
 * to unverified. The page was correctly filled the whole time and the report
 * said otherwise.
 */
function wasExecuted(status: FillExecutionResult['status']): boolean {
  return status === 'verified' || status === 'filled_unverified' || status === 'failed';
}

/**
 * How long each stage took, and how much work it did.
 *
 * Counts and durations only — never a field value, a password, a document, or a
 * model prompt. The question this answers is "where did the run stop, and how
 * many actions actually reached the executor?", which was previously
 * unanswerable without attaching a debugger to the service worker.
 */
export interface StageTiming {
  stage: 'scan' | 'plan' | 'execute' | 'analyze' | 'execute_ai';
  pass: number;
  durationMs: number;
  /** Fields scanned, actions planned, or actions executed, per stage. */
  count: number;
}

/**
 * What the run observed about one field, stage by stage.
 *
 * One record per normalized question, written as the field passes each stage
 * rather than reconstructed afterwards from whatever survived. Reconstruction is
 * how the report and the page came to disagree: the popup counted results, the
 * page counted review flags, the audit counted required fields, and each of the
 * three was computed in a different module from a different subset.
 *
 * Nothing here can hold a value. `profileValueAvailable` is a boolean about
 * whether an answer existed, never the answer; `failureCode` is an
 * `ERROR_CODES` member, never a message that could quote what was typed.
 */
export interface FieldDiagnostic {
  runId: string;
  buildId: string;
  fieldId: string;
  /** 0 is the top document. A field found in a subframe is filled there too. */
  frameId: number;
  label: string;
  section?: string;
  controlType: string;
  required: boolean;
  intent?: string;
  profileValueAvailable: boolean;
  plannerSource: string;
  plannedAction?: string;
  contractResult: 'accepted' | 'repaired' | 'rejected' | 'not_applicable';
  executionAttempted: boolean;
  verification: string;
  /**
   * Where the field stands right now.
   *
   * While the run is moving this is a `RUNNING_FIELD_STATUSES` member; when it
   * stops, every one of them has been resolved into `finalStatus` and this
   * agrees with it. Keeping both lets the completion check assert the
   * difference instead of trusting it.
   */
  runStatus: FieldRunStatus;
  finalStatus: FinalFieldStatus;
  annotation: AnnotationKind;
  failureCode?: string;
  durationMs?: number;
}

/**
 * True when a saved source actually produced an answer for this field.
 *
 * `source` is the planner's own account of where the answer came from, so this
 * is a fact about the profile rather than a guess about it. `none` covers both
 * "nothing was found" and "nothing may be used", which are alike from here:
 * either way there was no value to write.
 */
function hadProfileValue(source: string | undefined, action: string | undefined): boolean {
  if (source === undefined || source === 'none') return false;
  return action !== 'missing_information' && action !== 'manual_review';
}

/** A field's stored value, in a form two scans can be compared by. */
function valueKey(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return JSON.stringify(value);
}

function timed<T>(
  stage: StageTiming['stage'],
  pass: number,
  timings: StageTiming[],
  work: () => Promise<T>,
  size: (value: T) => number,
): Promise<T> {
  const started = Date.now();
  return work().then((value) => {
    timings.push({ stage, pass, durationMs: Date.now() - started, count: size(value) });
    return value;
  });
}

/**
 * Fills an application from saved data in one pass, repeating while the form
 * keeps revealing new questions.
 *
 * Always terminates: the loop is bounded, every await is on a dependency that
 * resolves with data rather than throwing, and cancellation is checked between
 * phases.
 */
export async function runApplicationAutofill(
  dependencies: AutofillDependencies,
): Promise<ApplicationAutofillReport> {
  const runId = `autofill-${crypto.randomUUID()}`;
  const startedAt = dependencies.now();
  const startedAtMs = Date.now();
  const scanIds: string[] = [];
  const warnings: string[] = [];
  /** Per-stage durations and counts. Never a value, only how much and how long. */
  const timings: StageTiming[] = [];
  const resultsByField = new Map<string, AutofillFieldResult>();
  /** How to find each field again when the marks are drawn. */
  const selectorsByField = new Map<string, string>();
  /**
   * Every scanned field's selector, not only the planned ones.
   *
   * A field the planner produced no action for still has to be markable — an
   * unanswered required question with no mark on it is the one the user walks
   * past — and `selectorsByField` above only ever held fields that reached a
   * plan.
   */
  const fieldSelectors = new Map<string, string>();
  let iterations = 0;
  let url = '';
  let ats: ApplicationAutofillReport['ats'] = 'unknown';
  let terminal: AgentError | null = null;
  /** The last plan built, for the closing coverage diagnostic. */
  let lastPlan: DeterministicFillPlan | null = null;
  /**
   * Whether the batched analysis actually ran. A field left pending means
   * something different depending on this, and the user needs the difference:
   * "the analysis had nothing to offer" is a dead end, "the analysis never ran"
   * is fixable by starting the local agent.
   */
  let analysisRan = false;
  /**
   * The fields as the last scan saw them, for the closing required-field audit.
   * The *last* scan specifically: a field revealed by an earlier answer only
   * exists in the later one, and auditing the first scan would report a
   * required field as absent rather than as unanswered.
   */
  let lastFields: readonly DetectedField[] = [];
  /**
   * What this run has already tried, keyed by an identity that survives a
   * rerender. This is what makes the loop converge instead of re-attempting the
   * same failing fields until it hits the pass limit.
   */
  const ledger = new QuestionLedger();
  /**
   * Fields the executor was actually invoked for.
   *
   * "The planner produced an action" and "the executor was asked to apply it"
   * are different claims, and conflating them is how a run could report work it
   * never attempted. This set records only the second.
   */
  const executorAttempted = new Set<string>();
  /** When the first scan started and the last one finished, for the trace. */
  let scanStartedAt = startedAt;
  let scanCompletedAt = startedAt;
  /** The scan that produced `lastFields`, for its census. */
  let lastScan: ApplicationScanResult | null = null;
  /** How many passes re-read a control whose choices another field produces. */
  let dependentRescans = 0;
  /**
   * What each field already held when the run first looked at it.
   *
   * This is the only way to tell "the agent filled it" from "it was already
   * right". Both are good outcomes, but only the first is evidence the executor
   * works, and reporting a pre-filled field as an agent success is how a broken
   * fill can look like a working one.
   */
  const preexisting = new Map<string, string>();
  /** True once a CAPTCHA, MFA, or verification step stopped the run. */
  let pageBlocked = false;
  /**
   * False while the loop is still moving.
   *
   * A field's `runStatus` is a stage marker until this flips and a final status
   * afterwards. Having one flag rather than a per-field state machine is what
   * makes "no field may still be pending at completion" a single assertion
   * instead of an invariant spread over five call sites.
   */
  let runFinished = false;
  /**
   * How long the executor spent on each field, and what it reported. Kept beside
   * the results rather than inside them because a later stage that does not
   * touch a field must not erase what an earlier one measured.
   */
  const durationByField = new Map<string, number>();

  /**
   * One record per question on the form, each carrying exactly one final status.
   *
   * The authoritative field set is the *last* scan — the form as it stands now.
   * That is deliberate and it is what makes the counters match the page: a
   * result left over from an identity an earlier pass used, for a control this
   * scan no longer sees, is not a field the user can look at, and counting it
   * inflated every total the popup printed.
   *
   * `plan` is consulted only for what the planner intended; the verdict comes
   * from what was observed.
   */
  const buildDiagnostics = (
    fields: readonly DetectedField[],
    plan: DeterministicFillPlan | null,
  ): FieldDiagnostic[] => {
    const actionsByField = new Map((plan?.actions ?? []).map((action) => [action.fieldId, action]));
    return fields.map((field): FieldDiagnostic => {
      const result = resultsByField.get(field.id);
      const action = actionsByField.get(field.id);
      const source = result?.source ?? action?.source;
      const plannedAction = result?.attemptedAction ?? result?.action ?? action?.action;
      // "Already valid" is decided against what the page held *before* the run,
      // not against what it holds now — afterwards every filled field looks
      // pre-filled.
      const alreadyValidBeforeRun =
        result?.verification === 'verified' &&
        preexisting.get(field.id) !== undefined &&
        preexisting.get(field.id) !== '' &&
        preexisting.get(field.id) === valueKey(result.actualValue);
      const finalStatus = resolveFinalFieldStatus({
        field,
        ...(result ? { result } : {}),
        alreadyValidBeforeRun,
        // Only fields the run did not settle inherit the block. A field that
        // verified before the CAPTCHA appeared is still verified.
        blocked: pageBlocked && result?.verification !== 'verified',
      });
      // Purple is for a decision only the applicant may make. Two things earn
      // it: the planner having flagged the action sensitive, and the question
      // itself carrying legal-attestation or protected-characteristic language.
      //
      // The second is needed because the first is a property of an *action*, and
      // a legal confirmation the planner refused to act on has no action to
      // carry the flag — which is exactly how "I certify that this information
      // is true" ended up orange, indistinguishable from a missing postcode.
      // `classifyQuestionDeterministically` is the existing single source of
      // truth for that language; this does not add a second copy of it.
      const classification = classifyQuestionDeterministically(
        field.question || field.label,
      ).classification;
      const sensitive =
        (result?.sensitive ?? false) ||
        classification === 'prohibited_legal' ||
        classification === 'prohibited_sensitive';
      // The contract's verdict, read off the action rather than re-derived: the
      // planner records a repair as a warning naming the mismatch, and a refusal
      // as `manual_review` carrying the same reason.
      const violation = action ? contractViolation(field.fieldType, action.action) : null;
      const repaired = action?.warnings.some((warning) => /must be (typed|chosen)/i.test(warning));
      const executionAttempted = executorAttempted.has(field.id);
      return {
        runId,
        buildId: dependencies.buildId ?? 'unstamped',
        fieldId: field.id,
        frameId: field.frameId ?? 0,
        label: (field.question || field.label || field.id).slice(0, 300),
        ...(field.section ? { section: field.section } : {}),
        controlType: field.fieldType,
        required: field.required,
        ...(field.canonicalKey ? { intent: field.canonicalKey } : {}),
        profileValueAvailable: hadProfileValue(source, plannedAction),
        plannerSource: source ?? 'none',
        ...(plannedAction ? { plannedAction } : {}),
        contractResult: !action
          ? 'not_applicable'
          : violation
            ? 'rejected'
            : repaired
              ? 'repaired'
              : 'accepted',
        executionAttempted,
        verification: result?.verification ?? 'not_attempted',
        // While the loop is running this is the stage the field is waiting in;
        // once it has stopped, `report()` has resolved every one of them and
        // this equals `finalStatus`. Both are recorded so the completion check
        // can assert the difference rather than assume it.
        runStatus: runFinished
          ? finalStatus
          : resolveRunningFieldStatus({
              planned: plannedAction !== undefined,
              executionAttempted,
              verificationObserved: result?.verification === 'verified',
            }),
        finalStatus,
        annotation: annotationFor(finalStatus, sensitive),
        ...(result?.failureCode ? { failureCode: result.failureCode } : {}),
        ...(durationByField.has(field.id) ? { durationMs: durationByField.get(field.id)! } : {}),
      };
    });
  };

  /** The diagnostic list as one terminal outcome per field. */
  const toOutcomes = (diagnostics: readonly FieldDiagnostic[]): FinalFieldOutcome[] =>
    diagnostics.map((entry) => ({
      fieldId: entry.fieldId,
      label: entry.label,
      status: entry.finalStatus,
      annotation: entry.annotation,
      required: entry.required,
      reason: resultsByField.get(entry.fieldId)?.reason ?? '',
    }));

  /**
   * Redraws every mark on the page from the fields' current final statuses.
   *
   * Called after each verification stage rather than once at the end. That is
   * the repair for the stale marks: a mark used to be drawn a single time, from
   * a review flag decided before the executor ran, and nothing ever revisited it
   * — so a field that filled and verified kept whatever the planner's
   * uncertainty had earned it. Every field is sent every time, verified ones
   * included, so a mark can be *replaced* rather than only added.
   */
  const annotate = async (scrollToFirst: boolean): Promise<void> => {
    if (lastFields.length === 0) return;
    const requests: HighlightPlan[] = buildDiagnostics(lastFields, lastPlan).flatMap((entry) => {
      const selector = selectorsByField.get(entry.fieldId) ?? fieldSelectors.get(entry.fieldId);
      if (!selector) return [];
      const result = resultsByField.get(entry.fieldId);
      // `none` is still sent. The content script reads it as "remove whatever is
      // on this field and draw nothing", which is not the same as omitting the
      // field — an omitted field keeps the mark an earlier pass gave it, and
      // that is the whole class of bug this redraw exists to end.
      return [
        {
          fieldId: entry.fieldId,
          selector,
          annotation: entry.annotation,
          ...(result?.reviewReason ? { reason: result.reviewReason } : {}),
          badge: ANNOTATION_BADGES[entry.annotation],
          question: entry.label,
        },
      ];
    });
    const drawn = await dependencies.highlight(requests, scrollToFirst);
    if (drawn.error) warnings.push(drawn.error.message);
  };

  const report = (
    status: ApplicationAutofillReport['status'],
    error?: AgentError,
  ): ApplicationAutofillReport => {
    // A run may not complete holding stage markers.
    //
    // The deterministic pass marks a field it could not settle as pending and
    // hands it to the batched analysis. When that analysis does not run, the
    // marker used to be rendered verbatim: eighteen cards reading "<question>
    // is waiting on the page analysis", beside a summary claiming nothing
    // needed confirmation and nothing had failed. The marker is a stage, never
    // a verdict, so every one left is resolved into a truthful outcome here —
    // naming the stage that did not happen rather than blaming the question.
    for (const stale of pendingResults([...resultsByField.values()])) {
      resultsByField.set(
        stale.fieldId,
        finalizePendingResult(stale, analysisRan ? 'analysis_no_answer' : 'analysis_unavailable'),
      );
    }
    const results = [...resultsByField.values()];
    // When almost nothing resolved, say why once, at the top — rather than
    // leaving the user to infer it from twenty-six identical cards. An empty
    // synchronised profile and a page nobody understood produce the same list
    // of unanswered questions and need completely different responses.
    const grounded = results.filter(
      (result) => result.source === 'profile' || result.source === 'approved_answer',
    ).length;
    if (results.length >= 5 && grounded <= 2) {
      warnings.push(
        'Almost nothing could be answered from saved data. Open the extension settings and check that your Internship Pilot profile has synchronised — a page this size should resolve most of its fields without asking you anything.',
      );
    }
    const reviewing = results.filter((result) => result.reviewReason && !result.reviewed);
    // The one list every count below is taken from.
    //
    // Previously each number was computed over a different subset — one over
    // `results`, one over the required-field audit, one over review flags — and
    // no two of them could be made to agree, which is how "Could not fill: 0"
    // ended up printed above a list of fields the user still had to answer.
    // There is now a single authoritative record per question on the form, and
    // every counter is a tally of its final status.
    const diagnostics = buildDiagnostics(lastFields, lastPlan);
    const statusCounts = countFinalStatuses(toOutcomes(diagnostics));
    // Every required field ends in exactly one of three states. A field the run
    // never reached is not omitted — it is reported as needing the user, which
    // is what makes the gap visible instead of invisible.
    const audit = auditRequiredFields({
      fields: lastFields,
      results: results.map((result) => ({
        fieldId: result.fieldId,
        status: result.verification === 'verified' ? 'verified' : 'needs_review',
        reason: result.reason,
        ...(result.reviewReason ? { reviewReason: result.reviewReason } : {}),
      })),
      ...(error?.code === 'CAPTCHA_DETECTED' || error?.code === 'MFA_DETECTED'
        ? { blockedReason: error.message }
        : {}),
    });
    return applicationAutofillReportSchema.parse({
      requiredFields: audit.verdicts,
      id: runId,
      scanIds,
      startedAt,
      completedAt: dependencies.now(),
      url: url || 'https://invalid.local/',
      ats,
      iterations,
      // The questions on the form, not the entries in a map. These were the
      // same number only by luck: a result keyed by an identity a rerender had
      // already replaced counted as a field the user could look at, and could
      // not be found on the page.
      fieldsFound: diagnostics.length,
      // Settled work — filled, already correct, or correctly left blank. It
      // used to mean "verification is not `not_attempted`", which counted a
      // write the page rejected as completed work.
      fieldsCompleted: diagnostics.filter((entry) => isSettledStatus(entry.finalStatus)).length,
      fieldsVerified: statusCounts.FILLED_VERIFIED + statusCounts.SKIPPED_ALREADY_VALID,
      semanticMatches: results.filter(
        (result) =>
          result.action === 'select_resolved_option' ||
          result.action === 'select_suggested_option' ||
          result.action === 'select_option',
      ).length,
      generatedAnswers: results.filter((result) => result.action === 'fill_generated_text').length,
      // Counted from what verified on the page, not from what was planned. The
      // popup shows this line as "Documents uploaded", and it read 0 beside two
      // files that were sitting in the employer's upload controls, because
      // nothing ever set it.
      documentsAttached: results.filter(
        (result) => result.action === 'upload_file' && result.verification === 'verified',
      ).length,
      exactProfileMatches: countSource(results, 'profile'),
      approvedAnswerMatches: countSource(results, 'approved_answer'),
      uncertainSuggestions: reviewing.filter((result) => result.reviewReason === 'ai_suggestion')
        .length,
      manualBlockers: reviewing.filter((result) => result.reviewReason === 'manual_required')
        .length,
      // Every one of these is now a tally of the same list, so the five lines
      // the popup prints add up to the number above them by construction.
      failedFields: statusCounts.FAILED_EXECUTION,
      skippedFields: statusCounts.SKIPPED_ALREADY_VALID,
      optionalLeftBlank: statusCounts.OPTIONAL_LEFT_BLANK,
      userInputRequired: statusCounts.USER_CONFIRMATION_REQUIRED,
      blockedFields: statusCounts.BLOCKED,
      finalStatusCounts: statusCounts,
      fieldOutcomes: toOutcomes(diagnostics),
      totalDurationMs: Math.max(0, Date.now() - startedAtMs),
      submissionPrevented: true,
      status,
      results,
      warnings,
      ...(error ? { error } : {}),
    });
  };

  const emit = (phase: AutofillPhase, message: string): void => {
    dependencies.onProgress({
      runId,
      phase,
      iteration: iterations,
      message,
      fieldsCompleted: [...resultsByField.values()].filter(
        (result) => result.verification === 'verified',
      ).length,
      fieldsTotal: resultsByField.size,
    });
  };

  emit('preparing', 'Preparing');
  const settings = await dependencies.loadSettings();
  if (!settings.applicationAutofillEnabled) {
    return report('failed', agentError('AUTOFILL_DISABLED', 'Autofill is switched off.'));
  }
  if (dependencies.isCancelled()) {
    return report('cancelled', agentError('AUTOFILL_CANCELLED', 'Cancelled before starting.'));
  }

  // `pass` is the loop counter; `iterations` is how many passes actually ran.
  // Keeping them apart is what stops the report claiming a sixth pass when the
  // loop merely finished its fifth and exited through the condition.
  for (let pass = 1; pass <= MAX_ITERATIONS; pass += 1) {
    iterations = pass;
    emit(
      iterations === 1 ? 'scanning' : 'rescanning',
      iterations === 1 ? 'Scanning' : 'Rescanning',
    );
    if (pass === 1) scanStartedAt = dependencies.now();
    const scanned = await timed(
      'scan',
      pass,
      timings,
      () => dependencies.scan(),
      (value) => (value.scan ? value.scan.fields.length : 0),
    );
    scanCompletedAt = dependencies.now();
    if (scanned.error || !scanned.scan) {
      terminal = scanned.error ?? agentError('SCAN_FAILED', 'The application could not be read.');
      break;
    }
    const scan = scanned.scan;
    scanIds.push(scan.id);
    url = scan.url;
    ats = scan.ats.id;

    // Recorded before anything can cut the pass short. A page that turns out to
    // be blocked still has questions on it, and each of them still deserves a
    // final status — BLOCKED — rather than being absent from a report that then
    // claims the form had no fields.
    lastFields = scan.fields;
    lastScan = scan;
    for (const field of scan.fields) {
      fieldSelectors.set(field.id, field.selector);
      // Only the first sighting. After the executor has written a value, the
      // page holds it, and re-reading it would make every filled field look as
      // though it had been correct all along.
      if (!preexisting.has(field.id)) preexisting.set(field.id, valueKey(field.currentValue));
    }

    const blocked = blockingCondition(scan);
    if (blocked) {
      pageBlocked = true;
      terminal = blocked;
      break;
    }
    if (isFinalSubmissionStage(scan)) {
      terminal = agentError('FINAL_SUBMISSION_STAGE', 'This is the final submission step.');
      break;
    }
    if (dependencies.isCancelled()) {
      terminal = agentError('AUTOFILL_CANCELLED', 'Cancelled.');
      break;
    }

    emit('normalizing', 'Reading the questions');
    // A control still offering nothing but prompts on a pass after the first is
    // one this run came back for because another field produced its choices.
    if (pass > 1) {
      const dependent = scan.fields.filter((field) => isDependentControl(field)).length;
      if (dependent > 0) {
        dependentRescans += dependent;
        emit('rescanning_dependencies', 'Reading choices the page just produced');
      }
    }
    const fieldsById = new Map<string, DetectedField>(
      scan.fields.map((field) => [field.id, field]),
    );

    // Credentials first, and outside the plan. On a registration page the
    // username and password are what the rest of the form is gated behind, and
    // they are the one thing the ordinary plan must never carry.
    if (dependencies.fillAccountForm && scan.navigation?.kind === 'account_creation') {
      const account = await dependencies.fillAccountForm(scan);
      if (!account.filled && account.reason) warnings.push(account.reason);
    }

    /**
     * Approves what this run has not settled, executes it, and records what
     * really happened to each field.
     *
     * Extracted so it can run twice per pass — once for the deterministic plan
     * and once for whatever the analysis added. That split is the point: the
     * deterministic answers used to wait behind a model call inside `plan()`,
     * so a page whose profile fields could have filled in under a second showed
     * nothing at all for the twenty-plus seconds the analysis took. Now they are
     * written, verified, and visible before the analysis is even requested, and
     * an analysis that fails or times out leaves every one of them in place.
     *
     * Returns how many actions were attempted, which is what the convergence
     * check below reads.
     */
    const applyPlan = async (
      plan: DeterministicFillPlan,
      stage: 'deterministic' | 'ai',
    ): Promise<{ attempted: number; error?: AgentError }> => {
      const decisions = new Map<string, ApprovalDecision>();
      const approvals = new Map<string, boolean>();
      for (const action of plan.actions) {
        const decision = decideApproval(action, settings, fieldsById.get(action.fieldId));
        decisions.set(action.id, decision);
        approvals.set(action.id, decision.approved);
      }

      // Only questions this run has not already settled.
      //
      // This used to read "approved and not yet verified", which never
      // converges: a field that is approved, written, and then fails
      // verification is not verified, forever. Every pass re-approved and
      // re-executed the identical failing set, learned nothing, and burned all
      // five passes. The ledger answers "have I tried this already, and has
      // anything about it changed since?" using an identity that survives a
      // rerender, so a question is retried only when it is genuinely different.
      const newlyApproved = [...approvals.entries()].filter(([actionId, approved]) => {
        if (!approved) return false;
        const action = plan.actions.find((candidate) => candidate.id === actionId);
        const field = action ? fieldsById.get(action.fieldId) : undefined;
        if (!field) return false;
        return ledger.shouldAttempt(field);
      });

      let run: FillRunReport | undefined;
      if (newlyApproved.length > 0) {
        const approved = await dependencies.approve(new Map(newlyApproved));
        if (approved.error) return { attempted: 0, error: approved.error };
        if (dependencies.isCancelled()) {
          return { attempted: 0, error: agentError('AUTOFILL_CANCELLED', 'Cancelled.') };
        }
        emit(
          stage === 'deterministic' ? 'filling' : 'filling_ai',
          stage === 'deterministic' ? 'Filling saved answers' : 'Filling analyzed answers',
        );
        const executed = await timed(
          stage === 'deterministic' ? 'execute' : 'execute_ai',
          pass,
          timings,
          () => dependencies.execute(),
          (value) => (value.report ? value.report.results.length : 0),
        );
        if (executed.error) {
          // One failed stage does not stop the rest. Whatever filled stays
          // filled, and the fields it could not reach are reported as such.
          warnings.push(`Some fields could not be filled: ${executed.error.message}`);
        }
        run = executed.report;
        emit(
          stage === 'deterministic' ? 'verifying' : 'verifying_ai',
          stage === 'deterministic' ? 'Verifying saved answers' : 'Verifying analyzed answers',
        );
      }

      for (const action of plan.actions) {
        const field = fieldsById.get(action.fieldId);
        const decision: ApprovalDecision = decisions.get(action.id) ?? {
          approved: false,
          reason: 'No decision was recorded for this action.',
        };
        const reported = run?.results.find((result) => result.actionId === action.id);
        // A result the executor produced without touching the page is not an
        // attempt, and must not overwrite what an earlier pass verified.
        const outcome = reported && wasExecuted(reported.status) ? reported : undefined;
        if (outcome) {
          executorAttempted.add(action.fieldId);
          durationByField.set(action.fieldId, outcome.durationMs);
        }
        const executed = outcome
          ? { verified: outcome.status === 'verified', failed: outcome.status === 'failed' }
          : undefined;
        const previous = resultsByField.get(action.fieldId);
        // Never downgrade a field that already verified. This is what protects
        // the deterministic results from being overwritten by the AI stage's
        // view of a field it had nothing to say about.
        if (previous?.verification === 'verified' && !executed) continue;
        // The planner skips an optional question whose correct answer is
        // silence. Nothing was attempted, and nothing should have been.
        const optionalLeftBlank =
          action.action === 'skip' && field !== undefined && !field.required && !executed;

        resultsByField.set(
          action.fieldId,
          autofillFieldResultSchema.parse({
            fieldId: action.fieldId,
            question: action.question,
            ...(field?.canonicalKey ? { canonicalQuestion: field.canonicalKey } : {}),
            action: action.action,
            source: action.source,
            confidence: action.confidence,
            sensitive: action.sensitive,
            ...(outcome?.actualValue !== undefined
              ? { actualValue: String(outcome.actualValue).slice(0, 2000) }
              : {}),
            verification: executed
              ? executed.verified
                ? 'verified'
                : 'failed'
              : decision.approved
                ? 'unverified'
                : optionalLeftBlank
                  ? 'optional_left_blank'
                  : 'not_attempted',
            // An optional field the planner deliberately left empty is settled,
            // not outstanding. Giving it a review reason is what put "Middle
            // Name" and "Address 2" on a list of things needing the user.
            ...(!optionalLeftBlank && reviewReasonFor(action, decision, executed)
              ? { reviewReason: reviewReasonFor(action, decision, executed) }
              : {}),
            reviewed: false,
            attemptedAction: action.action,
            ...(outcome?.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
            ...(outcome?.error?.code ? { failureCode: outcome.error.code } : {}),
            // The executor's own words when it failed, the policy's when it
            // declined to act, and the planner's otherwise.
            reason:
              outcome?.error?.message ?? (decision.approved ? action.reason : decision.reason),
          }),
        );
        if (field) {
          selectorsByField.set(action.fieldId, field.selector);
          // Recorded whatever happened. An attempt that failed verification is
          // still an attempt, and forgetting that is what made the loop spin.
          if (executed || decision.approved) {
            ledger.record(field, executed?.verified ? 'verified' : 'unverified');
          } else {
            ledger.observe(field);
          }
        }
      }
      // Immediately after verification, not at the end of the run.
      //
      // This is the repair for the stale marks. Marks used to be drawn once,
      // after the last pass, from a review flag decided before the executor
      // ran — so a field that verified in pass one wore the planner's
      // uncertainty until the run finished, and a field verified by a later
      // pass had already been marked by an earlier one. Redrawing the whole
      // page from the current final statuses means a field that verifies stops
      // being marked as needing anything, at the moment it verifies.
      await annotate(false);
      return { attempted: newlyApproved.length };
    };

    // ---- Deterministic: everything the saved profile can answer, first. ----
    emit('discovering_options', 'Inspecting answer choices');
    emit('resolving', 'Matching profile information');
    const planned = await timed(
      'plan',
      pass,
      timings,
      () => dependencies.plan(scan.id),
      (value) => (value.plan ? value.plan.actions.length : 0),
    );
    if (planned.error || !planned.plan) {
      terminal =
        planned.error ?? agentError('RESOLUTION_FAILED', 'The saved answers could not be matched.');
      break;
    }
    let plan = planned.plan;
    lastPlan = plan;

    emit('planning', 'Preparing answers');
    const deterministic = await applyPlan(plan, 'deterministic');
    if (deterministic.error) {
      terminal = deterministic.error;
      break;
    }
    let attemptedCount = deterministic.attempted;

    // ---- Analysis: one batched request, for what is genuinely left. ----
    //
    // After the writes above, never before them. An analysis that fails, times
    // out, or has nothing to offer now costs the user nothing they had already
    // been given.
    if (dependencies.analyze) {
      emit('analyzing', 'Analyzing the remaining questions');
      const analyzed = await timed(
        'analyze',
        pass,
        timings,
        () => dependencies.analyze!(scan.id),
        (value) => (value.plan ? value.plan.actions.length : 0),
      );
      if (analyzed.error) {
        warnings.push(
          `Page analysis did not run: ${analyzed.error.message} Everything your profile could answer was still filled.`,
        );
      }
      if (analyzed.ran) analysisRan = true;
      if (analyzed.plan) {
        plan = analyzed.plan;
        lastPlan = plan;
        const aiStage = await applyPlan(plan, 'ai');
        if (aiStage.error) {
          terminal = aiStage.error;
          break;
        }
        attemptedCount += aiStage.attempted;
      }
    }

    if (dependencies.generate && settings.autoFillValidatedAiAnswers) {
      emit('generating', 'Generating written answers');
      const generated = await dependencies.generate(plan);
      if (generated.error) {
        // A failed generation is not a failed run: everything else still fills,
        // and the affected fields are highlighted below.
        warnings.push(`Written answers could not be generated: ${generated.error.message}`);
      } else {
        const refreshed = await dependencies.plan(scan.id);
        if (refreshed.plan) {
          plan = refreshed.plan;
          lastPlan = plan;
          const generatedStage = await applyPlan(plan, 'ai');
          if (generatedStage.error) {
            terminal = generatedStage.error;
            break;
          }
          attemptedCount += generatedStage.attempted;
        }
      }
    }

    // Convergence, not a fill count. The pass ends when this page has stopped
    // producing questions nobody has looked at yet — which is the condition the
    // loop is actually waiting for, and the one the old check never expressed.
    const revealed = ledger.unseen(scan.fields);
    for (const field of revealed) ledger.observe(field);
    if (attemptedCount === 0 && revealed.length === 0) break;

    await dependencies.waitForStability();
    if (dependencies.isCancelled()) {
      terminal = agentError('AUTOFILL_CANCELLED', 'Cancelled.');
      break;
    }
    if (iterations === MAX_ITERATIONS) {
      warnings.push('The form kept revealing new questions; autofill stopped after five passes.');
      terminal = agentError('MAX_ITERATIONS_REACHED', 'Stopped after five passes.');
    }
  }

  // The loop has stopped. From here every field's `runStatus` is its verdict
  // rather than the stage it was waiting in.
  runFinished = true;

  // Every question the last scan saw must end with a status.
  //
  // The results map is built from `plan.actions`, so a field the planner never
  // produced an action for — a control revealed on the final pass, or one a
  // scan/plan failure cut short — would simply be absent. Absent is
  // indistinguishable from "was not on the page", and that is how a run that
  // settled two of twenty-seven fields could still look finished. A field with
  // no record is recorded here as needing the user, which makes the gap
  // visible instead of invisible.
  for (const field of lastFields) {
    if (resultsByField.has(field.id)) continue;
    resultsByField.set(
      field.id,
      autofillFieldResultSchema.parse({
        fieldId: field.id,
        question: field.question || field.label,
        ...(field.canonicalKey ? { canonicalQuestion: field.canonicalKey } : {}),
        action: 'manual_review',
        attemptedAction: 'manual_review',
        source: 'none',
        confidence: 0,
        sensitive: false,
        verification: field.required ? 'not_attempted' : 'optional_left_blank',
        ...(field.required ? { reviewReason: 'missing_information' as const } : {}),
        reviewed: false,
        reason: field.required
          ? 'The run ended before this question was reached. Check it yourself before submitting.'
          : 'Optional, and the run ended before it was reached.',
      }),
    );
    selectorsByField.set(field.id, field.selector);
  }

  // The page's marks, redrawn one last time from the final statuses.
  //
  // Whatever stopped the loop: a run that ended early still leaves the page
  // marked with what it did and did not manage. Every field is sent, verified
  // ones included, because the content script draws exactly what it is given —
  // a field omitted here would keep the mark an earlier pass gave it.
  const outstanding = toOutcomes(buildDiagnostics(lastFields, lastPlan)).filter(
    (outcome) => !isSettledStatus(outcome.status),
  );
  await annotate(settings.scrollToFirstReviewField && terminal === null && outstanding.length > 0);

  if (terminal?.code === 'AUTOFILL_CANCELLED') {
    emit('cancelled', 'Cancelled');
    return report('cancelled', terminal);
  }
  if (terminal && outstanding.length === 0 && resultsByField.size === 0) {
    emit('failed', 'Autofill failed');
    return report('failed', terminal);
  }
  if (terminal) warnings.push(terminal.message);

  // Where each field was lost, in one line. This is what turns "twenty-six
  // fields said 'needs information'" into a diagnosis: a missing profile value,
  // a missing mapping, a rejected action and a refused write are four different
  // problems that used to look identical from outside.
  if (lastPlan && lastFields.length > 0) {
    console.info(
      '[agent] autofill coverage',
      describeCoverage(
        buildCoverage(
          lastFields,
          lastPlan,
          new Set(
            [...resultsByField.values()]
              .filter((result) => result.verification === 'verified')
              .map((result) => result.fieldId),
          ),
        ),
      ),
    );
  }

  // The one line that answers "did the executor run, and on how much?".
  // Counts and durations only — no field values, no credentials, no prompts.
  console.info('[agent] autofill stages', {
    runId,
    passes: iterations,
    totalMs: Date.now() - startedAtMs,
    stages: timings.map(
      (entry) => `${entry.stage}#${entry.pass}:${entry.durationMs}ms/${entry.count}`,
    ),
    planned: [...resultsByField.values()].length,
    executed: [...resultsByField.values()].filter(
      (result) => result.verification === 'verified' || result.verification === 'failed',
    ).length,
    verified: [...resultsByField.values()].filter((result) => result.verification === 'verified')
      .length,
  });

  // COMPLETED is a claim about every field on the form, so it is decided by the
  // final statuses rather than by how many review flags happen to be set. A run
  // holding one unsettled field is `completed_with_review`, and the schema
  // refuses the alternative.
  const status = outstanding.length > 0 ? 'completed_with_review' : 'completed';
  emit(
    status === 'completed' ? 'completed' : 'completed_with_review',
    'Autofill complete. Review highlighted fields and submit manually.',
  );
  const finished = report(status, terminal ?? undefined);

  // A run may not complete holding a stage marker.
  //
  // `report()` resolves every pending marker into a truthful outcome before it
  // returns, so this can only fire if a future change adds a path around that.
  // It is an assertion rather than a repair on purpose: silently fixing it here
  // would hide the bug, and the last time a stage was rendered as a verdict it
  // produced eighteen cards reading "is waiting on the page analysis" beside a
  // summary claiming nothing needed confirmation.
  const stillPending = pendingResults(finished.results);
  if (stillPending.length > 0) {
    throw new Error(
      `Autofill completed with ${stillPending.length} field(s) still in a temporary state. ` +
        'A stage marker is not a final status.',
    );
  }

  const diagnostics = buildDiagnostics(lastFields, lastPlan);
  // The same claim, checked against the status model rather than against the
  // wording of a reason sentence. The line above catches a *prose* stage marker
  // that survived; this catches a field whose `runStatus` is still one of
  // PENDING_SCAN, PENDING_RESOLUTION, PENDING_EXECUTION or
  // PENDING_VERIFICATION. Two checks because they fail for different reasons:
  // the first is a rendering bug, this one is a state-machine bug.
  assertNoTemporaryStatuses(
    diagnostics.map((entry) => ({ fieldId: entry.fieldId, status: entry.runStatus })),
  );
  if (dependencies.onTrace) {
    dependencies.onTrace(
      buildRunTrace({
        runId,
        buildId: dependencies.buildId ?? 'unstamped',
        report: finished,
        fields: lastFields,
        diagnostics,
        plan: lastPlan,
        scan: lastScan,
        executorAttempted,
        timings,
        dependentRescans,
        analysisRan,
        scanStartedAt,
        scanCompletedAt,
        pendingAtCompletion: stillPending.length,
      }),
    );
  }
  return finished;
}

/**
 * Assembles the run trace from what the orchestrator actually observed.
 *
 * Deliberately derived rather than accumulated: a counter incremented at each
 * stage can drift from the results it claims to describe, and a trace that
 * disagrees with its own report is worse than no trace. Everything here is read
 * back off the finished report, the last scan, and the last plan.
 *
 * Counts and outcomes only. No values, no prompts, no personal information —
 * and `runTraceSchema` is strict, so a future caller cannot smuggle any in.
 */
function buildRunTrace(input: {
  runId: string;
  buildId: string;
  report: ApplicationAutofillReport;
  fields: readonly DetectedField[];
  /** The orchestrator's own per-field record. The trace reports it; it does not
   * re-derive it, so the trace and the report cannot disagree. */
  diagnostics: readonly FieldDiagnostic[];
  plan: DeterministicFillPlan | null;
  scan: ApplicationScanResult | null;
  executorAttempted: ReadonlySet<string>;
  timings: readonly StageTiming[];
  dependentRescans: number;
  analysisRan: boolean;
  scanStartedAt: string;
  scanCompletedAt: string;
  pendingAtCompletion: number;
}): RunTrace {
  // Copied from the orchestrator's own record, never re-derived. Re-deriving is
  // how a trace comes to disagree with the report it describes, and a trace that
  // disagrees with its own report is worse than no trace at all.
  const fieldTraces: FieldTrace[] = input.diagnostics.map((entry): FieldTrace => ({
    runId: entry.runId,
    buildId: entry.buildId,
    fieldId: entry.fieldId,
    frameId: entry.frameId,
    label: entry.label,
    ...(entry.section ? { section: entry.section } : {}),
    ...(entry.intent ? { intent: entry.intent } : {}),
    controlType: entry.controlType,
    required: entry.required,
    plannerSource: traceSource(entry.plannerSource),
    profileValueAvailable: entry.profileValueAvailable,
    ...(entry.plannedAction ? { plannedAction: entry.plannedAction } : {}),
    contractResult: entry.contractResult,
    executorAttempted: entry.executionAttempted,
    verification: entry.verification,
    finalStatus: entry.finalStatus,
    annotation: entry.annotation,
    ...(entry.failureCode ? { errorCode: entry.failureCode } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
  }));

  // Read straight off the report, which computed them from the same diagnostic
  // list. One arithmetic, one answer — the trace used to mix required-field
  // verdicts with per-result verification stages in one map, so it agreed with
  // neither the popup nor itself.
  const finalStatusCounts = input.report.finalStatusCounts;

  const aiResults = input.report.results.filter((result) => result.source === 'ai_suggestion');
  // What the deterministic pass could not settle is what the analysis was asked
  // about. Read off the plan, so it is the real question set rather than an
  // intention recorded before the plan was built.
  const unresolved = (input.plan?.actions ?? []).filter(
    (action) => action.action === 'missing_information' || action.action === 'manual_review',
  ).length;

  return runTraceSchema.parse({
    buildId: input.buildId,
    runId: input.runId,
    origin: traceOrigin(input.report.url),
    pageClassification: input.scan?.navigation?.kind ?? 'unknown',
    atsClassification: input.report.ats,
    scanStartedAt: input.scanStartedAt,
    scanCompletedAt: input.scanCompletedAt,
    rawControls: input.scan?.statistics.rawControls ?? 0,
    falseControlsRemoved: input.scan?.statistics.falseControlsRemoved ?? 0,
    duplicateControlsRemoved: input.scan?.statistics.duplicateControlsRemoved ?? 0,
    normalizedQuestions: input.fields.length,
    requiredQuestions: input.fields.filter((field) => field.required).length,
    deterministicPlanned: fieldTraces.filter(
      (field) => field.plannedAction !== undefined && field.plannerSource !== 'ai',
    ).length,
    deterministicAccepted: fieldTraces.filter(
      (field) => field.plannerSource !== 'ai' && field.contractResult !== 'rejected',
    ).length,
    deterministicExecuted: fieldTraces.filter(
      (field) => field.plannerSource !== 'ai' && field.executorAttempted,
    ).length,
    deterministicVerified: fieldTraces.filter(
      (field) =>
        field.plannerSource !== 'ai' &&
        (field.finalStatus === 'FILLED_VERIFIED' || field.finalStatus === 'SKIPPED_ALREADY_VALID'),
    ).length,
    questionsSentToAi: input.analysisRan ? unresolved : 0,
    // One batched request per stable page, and none at all when the
    // deterministic pass settled everything. The memo inside `buildPlan` is
    // what makes this one rather than one per pass.
    aiRequests: input.analysisRan && unresolved > 0 ? 1 : 0,
    aiActionsReturned: aiResults.length,
    aiActionsAccepted: aiResults.filter((result) => result.verification !== 'not_attempted').length,
    aiActionsExecuted: aiResults.filter((result) => input.executorAttempted.has(result.fieldId))
      .length,
    aiActionsVerified: aiResults.filter((result) => result.verification === 'verified').length,
    dependentFieldsRescanned: input.dependentRescans,
    requiredFieldsRemaining: input.report.requiredFields.filter(
      (verdict) => verdict.outcome !== 'FILLED_VERIFIED',
    ).length,
    finalStatusCounts,
    pendingAtCompletion: input.pendingAtCompletion,
    stages: input.timings.map((entry) => ({
      stage: entry.stage,
      pass: entry.pass,
      durationMs: entry.durationMs,
      count: entry.count,
    })),
    fields: fieldTraces,
    totalDurationMs: input.report.totalDurationMs,
  });
}

/** Collapses the many `source` values onto the trace's coarser vocabulary. */
function traceSource(source: string | undefined): FieldTrace['plannerSource'] {
  switch (source) {
    case 'profile':
      return 'deterministic';
    case 'approved_answer':
      return 'approved_answer';
    case 'document':
      return 'document';
    case 'ai_suggestion':
      return 'ai';
    default:
      return 'none';
  }
}
