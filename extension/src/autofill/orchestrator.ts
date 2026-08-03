import {
  DEFAULT_ERROR_GUIDANCE,
  REVIEW_BADGES,
  applicationAutofillReportSchema,
  QuestionLedger,
  auditRequiredFields,
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
  type FillRunReport,
  type ReviewReason,
} from '@internship-agent/shared';
import { decideApproval, type ApprovalDecision } from './approvalPolicy.js';
import { isFinalSubmitControl } from '../scanner/adapters.js';

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
  loadSettings(): Promise<AutofillSettings>;
  /** Runs the existing scanner against the live page. */
  scan(): Promise<{ scan?: ApplicationScanResult; error?: AgentError }>;
  /** Runs the existing deterministic planner over the latest scan. */
  plan(scanId: string): Promise<{ plan?: DeterministicFillPlan; error?: AgentError }>;
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
  reason: ReviewReason;
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
  const scanIds: string[] = [];
  const warnings: string[] = [];
  const resultsByField = new Map<string, AutofillFieldResult>();
  /** How to find each field again when the marks are drawn. */
  const selectorsByField = new Map<string, string>();
  let iterations = 0;
  let url = '';
  let ats: ApplicationAutofillReport['ats'] = 'unknown';
  let terminal: AgentError | null = null;
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

  const report = (
    status: ApplicationAutofillReport['status'],
    error?: AgentError,
  ): ApplicationAutofillReport => {
    const results = [...resultsByField.values()];
    const reviewing = results.filter((result) => result.reviewReason && !result.reviewed);
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
      fieldsFound: results.length,
      fieldsCompleted: results.filter((result) => result.verification !== 'not_attempted').length,
      fieldsVerified: results.filter((result) => result.verification === 'verified').length,
      semanticMatches: results.filter(
        (result) =>
          result.action === 'select_resolved_option' ||
          result.action === 'select_suggested_option' ||
          result.action === 'select_option',
      ).length,
      generatedAnswers: results.filter((result) => result.action === 'fill_generated_text').length,
      exactProfileMatches: countSource(results, 'profile'),
      approvedAnswerMatches: countSource(results, 'approved_answer'),
      uncertainSuggestions: reviewing.filter((result) => result.reviewReason === 'ai_suggestion')
        .length,
      manualBlockers: reviewing.filter((result) => result.reviewReason === 'manual_required')
        .length,
      failedFields: reviewing.filter((result) => result.reviewReason === 'failed').length,
      skippedFields: results.filter((result) => result.action === 'skip').length,
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
    const scanned = await dependencies.scan();
    if (scanned.error || !scanned.scan) {
      terminal = scanned.error ?? agentError('SCAN_FAILED', 'The application could not be read.');
      break;
    }
    const scan = scanned.scan;
    scanIds.push(scan.id);
    url = scan.url;
    ats = scan.ats.id;

    const blocked = blockingCondition(scan);
    if (blocked) {
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

    lastFields = scan.fields;
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

    emit('discovering_options', 'Inspecting answer choices');
    emit('resolving', 'Matching profile information');
    const planned = await dependencies.plan(scan.id);
    if (planned.error || !planned.plan) {
      terminal =
        planned.error ?? agentError('RESOLUTION_FAILED', 'The saved answers could not be matched.');
      break;
    }
    let plan = planned.plan;

    if (dependencies.generate && settings.autoFillValidatedAiAnswers) {
      emit('generating', 'Generating written answers');
      const generated = await dependencies.generate(plan);
      if (generated.error) {
        // A failed generation is not a failed run: everything else still fills,
        // and the affected fields are highlighted below.
        warnings.push(`Written answers could not be generated: ${generated.error.message}`);
      } else {
        const refreshed = await dependencies.plan(scan.id);
        if (refreshed.plan) plan = refreshed.plan;
      }
    }

    emit('planning', 'Preparing answers');
    const decisions = new Map<string, ApprovalDecision>();
    const approvals = new Map<string, boolean>();
    for (const action of plan.actions) {
      const decision = decideApproval(action, settings, fieldsById.get(action.fieldId));
      decisions.set(action.id, decision);
      approvals.set(action.id, decision.approved);
    }

    // Only questions this run has not already settled.
    //
    // This used to read "approved and not yet verified", which never converges:
    // a field that is approved, written, and then fails verification is not
    // verified, forever. Every pass re-approved and re-executed the identical
    // failing set, learned nothing, and burned all five passes — the whole of
    // the MAX_ITERATIONS_REACHED report. The ledger answers "have I tried this
    // already, and has anything about it changed since?" using an identity that
    // survives a rerender, so a question is retried only when it is genuinely
    // different.
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
      if (approved.error) {
        terminal = approved.error;
        break;
      }
      if (dependencies.isCancelled()) {
        terminal = agentError('AUTOFILL_CANCELLED', 'Cancelled.');
        break;
      }
      emit('filling', 'Filling fields');
      const executed = await dependencies.execute();
      if (executed.error) {
        warnings.push(`Some fields could not be filled: ${executed.error.message}`);
      }
      run = executed.report;
      emit('verifying', 'Verifying answers');
    }

    for (const action of plan.actions) {
      const field = fieldsById.get(action.fieldId);
      const decision: ApprovalDecision = decisions.get(action.id) ?? {
        approved: false,
        reason: 'No decision was recorded for this action.',
      };
      const outcome = run?.results.find((result) => result.actionId === action.id);
      const executed = outcome
        ? { verified: outcome.status === 'verified', failed: outcome.status === 'failed' }
        : undefined;
      const previous = resultsByField.get(action.fieldId);
      // Never downgrade a field that already verified in an earlier iteration.
      if (previous?.verification === 'verified' && !executed) continue;

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
              : 'not_attempted',
          ...(reviewReasonFor(action, decision, executed)
            ? { reviewReason: reviewReasonFor(action, decision, executed) }
            : {}),
          reviewed: false,
          ...(outcome?.error?.code ? { failureCode: outcome.error.code } : {}),
          // The executor's own words when it failed, the policy's when it
          // declined to act, and the planner's otherwise.
          reason: outcome?.error?.message ?? (decision.approved ? action.reason : decision.reason),
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

    // Convergence, not a fill count. The pass ends when this page has stopped
    // producing questions nobody has looked at yet — which is the condition the
    // loop is actually waiting for, and the one the old check never expressed.
    const revealed = ledger.unseen(scan.fields);
    for (const field of revealed) ledger.observe(field);
    const attempted = newlyApproved.length > 0;
    if (!attempted && revealed.length === 0) break;

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

  // Highlighting runs whatever stopped the loop: a run that ended early still
  // leaves the page marked up with what it did and did not manage.
  const needingReview = [...resultsByField.values()].filter(
    (result) => result.reviewReason && !result.reviewed,
  );
  if (needingReview.length > 0) {
    const requests: HighlightPlan[] = needingReview.flatMap((result) => {
      const selector = selectorsByField.get(result.fieldId);
      const reason = result.reviewReason;
      // Without a selector there is no element to mark. The field stays in the
      // report rather than being silently dropped.
      if (!selector || !reason) return [];
      return [
        {
          fieldId: result.fieldId,
          selector,
          reason,
          badge: REVIEW_BADGES[reason],
          question: result.question,
        },
      ];
    });
    const highlighted = await dependencies.highlight(
      requests,
      settings.scrollToFirstReviewField && terminal === null,
    );
    if (highlighted.error) warnings.push(highlighted.error.message);
  }

  if (terminal?.code === 'AUTOFILL_CANCELLED') {
    emit('cancelled', 'Cancelled');
    return report('cancelled', terminal);
  }
  if (terminal && needingReview.length === 0 && resultsByField.size === 0) {
    emit('failed', 'Autofill failed');
    return report('failed', terminal);
  }
  if (terminal) warnings.push(terminal.message);

  const status = needingReview.length > 0 ? 'completed_with_review' : 'completed';
  emit(
    status === 'completed' ? 'completed' : 'completed_with_review',
    'Autofill complete. Review highlighted fields and submit manually.',
  );
  return report(status, terminal ?? undefined);
}
