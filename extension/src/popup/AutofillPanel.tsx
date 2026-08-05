import {
  PAGE_KIND_LABELS,
  PORTAL_ROUTE_LABELS,
  REVIEW_BADGES,
  type ApplicationAutofillReport,
  type NavigationState,
  type PortalRouteIntent,
  type PortalRouteResponse,
  type Profile,
} from '@internship-agent/shared';
import type { AutofillState } from './useAutofillState.js';
import type { AutofillRunPhaseState } from '../storage/runState.js';

/**
 * What each run state says while it is happening.
 *
 * Named for what the agent is doing to *this* page, not for an internal phase,
 * so a long stage is legible as a long stage rather than as a stall.
 */
/** The states in which a run is still working, and Cancel means something. */
const ACTIVE_RUN_STATES: readonly AutofillRunPhaseState[] = [
  'SCANNING',
  'NORMALIZING',
  'RESOLVING_DETERMINISTIC',
  'EXECUTING_DETERMINISTIC',
  'VERIFYING_DETERMINISTIC',
  'ANALYZING_AI',
  'EXECUTING_AI',
  'VERIFYING_AI',
  'RESCANNING_DEPENDENCIES',
];

/**
 * Elapsed time, in the shape a person reads.
 *
 * Under a minute stays in seconds; past that, minutes and seconds — because
 * "94s" is exactly the number someone has to stop and divide.
 */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

const RUN_STATE_LABELS: Record<AutofillRunPhaseState, string> = {
  IDLE: 'Ready',
  SCANNING: 'Scanning page…',
  NORMALIZING: 'Reading the questions…',
  RESOLVING_DETERMINISTIC: 'Matching saved profile…',
  // The saved answers are written and confirmed before anything is asked of the
  // model, so these two run in the first seconds and the AI states after them.
  EXECUTING_DETERMINISTIC: 'Filling saved answers…',
  VERIFYING_DETERMINISTIC: 'Verifying saved answers…',
  ANALYZING_AI: 'Analyzing custom questions…',
  EXECUTING_AI: 'Filling analyzed answers…',
  VERIFYING_AI: 'Verifying analyzed answers…',
  RESCANNING_DEPENDENCIES: 'Reading choices the page just produced…',
  WAITING_FOR_USER: 'Waiting for your answers',
  COMPLETED: 'Autofill complete',
  FAILED: 'Autofill failed',
  CANCELLED: 'Autofill cancelled',
};

/**
 * The application panel: which job is loaded, what a run is doing, and what it
 * left for the user.
 *
 * Deliberately absent: raw profile JSON, model prompts, and internal ids. The
 * user sees questions in the page's own words and nothing about how the answer
 * was reached beyond the reason sentence.
 */

interface AutofillPanelProps {
  state: AutofillState;
  /** False when the tab is not an application page we can act on. */
  eligible: boolean;
  fieldsDetected: number | null;
  /** What kind of page this is and where it leads, when the scan knew. */
  navigation?: NavigationState;
  /** What the saved strategy says to do about this portal's routes. */
  route?: PortalRouteResponse | null;
  /** True while a route is being taken. */
  followingRoute?: boolean;
  onFollowRoute?: () => void;
  /** One sentence about the AI agent, or null while it is still unknown. */
  agentStatus: string | null;
  /** Shows the diagnostic surfaces. Off for anyone applying for a job. */
  developerMode?: boolean;
}

/**
 * The routes off a sign-in or choose-how-to-apply page.
 *
 * The agent takes the route the user's saved strategy names, and says which one
 * and why. It stops and asks only when the strategy is "ask every time", when no
 * strategy is saved, or when the page offers nothing the strategy can act on —
 * and it never asks its way past a CAPTCHA or a verification code, which are
 * reported as needing the person rather than as a choice.
 */
/**
 * Which profile sections arrived, by name and count.
 *
 * Counts only. Nothing here can render an employer, a school, or a phone
 * number — the point is to tell the user *that* their work history came across
 * without repeating it back to them on an employer's page.
 */
export function describeProfileSections(profile: Profile): string {
  const sections: Array<[string, number]> = [
    ['education', profile.education.length],
    ['experience', profile.experience.length],
    ['projects', profile.projects.length],
    ['skills', profile.skills.technical.length + profile.skills.programmingLanguages.length],
  ];
  const present = sections.filter(([, count]) => count > 0);
  return present.length === 0
    ? 'contact details only'
    : present.map(([name, count]) => `${count} ${name}`).join(', ');
}

function RouteChoices({
  route,
  following,
  onFollow,
}: {
  route: PortalRouteResponse;
  following: boolean;
  onFollow: () => void;
}): JSX.Element | null {
  if ('error' in route) return null;
  if (route.decision === 'none') return null;

  if (route.decision === 'blocked') {
    return (
      <section className="result result--bad" role="alert">
        {route.reason}
      </section>
    );
  }

  if (route.decision === 'act') {
    return (
      <div className="autofill__routes">
        <p className="autofill__analysis">
          {route.takenIntent
            ? `${PORTAL_ROUTE_LABELS[route.takenIntent]}: ${route.reason}`
            : route.reason}
        </p>
        <button type="button" className="primary" disabled={following} onClick={onFollow}>
          {following ? 'Continuing…' : 'Continue on this page'}
        </button>
      </div>
    );
  }

  return (
    <div className="autofill__routes">
      <p className="autofill__analysis">This page is asking how you want to apply:</p>
      <ul className="autofill__documents">
        {(route.options ?? []).map((option) => (
          <li key={`${option.intent}-${option.selector}`}>
            <strong>
              {PORTAL_ROUTE_LABELS[option.intent as PortalRouteIntent] ?? option.label}
            </strong>
            {option.label &&
            option.label !== PORTAL_ROUTE_LABELS[option.intent as PortalRouteIntent]
              ? ` — the page calls this “${option.label}”`
              : null}
          </li>
        ))}
      </ul>
      <p className="autofill__never-submits">{route.reason}</p>
    </div>
  );
}

/**
 * The fields still waiting on the user, and only those.
 *
 * One card per unresolved question, with the question in the page's own words
 * and the options the page actually offers, so answering it takes a click
 * rather than a trip to the form. A field that filled and verified never
 * appears here — the point is that 26 detected fields produce a list of the two
 * or three nobody could answer safely, not a list of 26.
 */
function ReviewList({
  report,
  onFocus,
}: {
  report: ApplicationAutofillReport;
  onFocus: (fieldId: string) => void;
}): JSX.Element | null {
  const needsReview = report.results.filter((result) => result.reviewReason && !result.reviewed);
  if (needsReview.length === 0) return null;
  return (
    <ul className="review-list">
      {needsReview.map((result) => (
        <li key={result.fieldId} className="review-list__card">
          <strong className="review-list__badge">{REVIEW_BADGES[result.reviewReason!]}</strong>
          <button type="button" className="link-button" onClick={() => onFocus(result.fieldId)}>
            {result.question || 'Unlabelled question'}
          </button>
          {result.reason ? <span className="review-list__reason">{result.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Required fields the run could not settle, named individually.
 *
 * `results` covers fields the planner produced an action for. A required field
 * the run never reached produces no action at all, so it would be absent from
 * that list entirely — which is the silent skip this is here to prevent.
 */
function OutstandingRequired({
  report,
  onFocus,
}: {
  report: ApplicationAutofillReport;
  onFocus: (fieldId: string) => void;
}): JSX.Element | null {
  const answered = new Set(report.results.map((result) => result.fieldId));
  const missed = report.requiredFields.filter(
    (verdict) => verdict.outcome !== 'FILLED_VERIFIED' && !answered.has(verdict.fieldId),
  );
  if (missed.length === 0) return null;
  return (
    <>
      <p className="autofill__analysis">
        {missed.length === 1
          ? 'One required field still needs an answer:'
          : `${missed.length} required fields still need an answer:`}
      </p>
      <ul className="review-list">
        {missed.map((verdict) => (
          <li key={verdict.fieldId} className="review-list__card">
            <strong className="review-list__badge">
              {verdict.outcome === 'BLOCKED_BY_CAPTCHA_OR_VERIFICATION'
                ? 'Blocked — needs you'
                : 'Required answer needed'}
            </strong>
            <button type="button" className="link-button" onClick={() => onFocus(verdict.fieldId)}>
              {verdict.label}
            </button>
            <span className="review-list__reason">{verdict.reason}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AutofillPanel({
  state,
  eligible,
  fieldsDetected,
  navigation,
  route,
  followingRoute = false,
  onFollowRoute,
  agentStatus,
  developerMode = false,
}: AutofillPanelProps): JSX.Element {
  const { bundle, loadingBundle, progress, report, error } = state;
  // One source of truth for "is something happening": the run state. Cancel,
  // the progress bar, the timer and the primary button all read it, so the
  // invalid combination the user saw cannot be constructed.
  const active = ACTIVE_RUN_STATES.includes(state.runState);
  /**
   * Everything left for the user, counted once across both sources.
   *
   * A required field that produced no action at all appears in the audit and
   * not in the results, and a reviewed suggestion appears in the results and
   * not in the audit. Counting either alone under-reports, which is how the
   * summary claimed nothing needed confirmation beside eighteen fields that
   * did.
   */
  const needsUser = report
    ? new Set([
        ...report.requiredFields
          .filter((verdict) => verdict.outcome === 'USER_CONFIRMATION_REQUIRED')
          .map((verdict) => verdict.fieldId),
        ...report.results
          .filter((result) => result.reviewReason && !result.reviewed)
          .map((result) => result.fieldId),
      ]).size
    : 0;
  // A page that is asking for credentials or that has ended the application is
  // not one to fill: the button would do nothing useful and implying otherwise
  // is worse than saying so.
  const fillable =
    !navigation ||
    navigation.kind === 'application_form' ||
    navigation.kind === 'account_creation' ||
    navigation.kind === 'unknown';

  return (
    <section aria-label="Application" className="panel">
      {loadingBundle ? (
        <p className="autofill__ready">Checking for a loaded application…</p>
      ) : bundle ? (
        <div className="autofill__ready">
          <strong>
            Ready for {bundle.company} — {bundle.jobTitle}
          </strong>
          <ul className="autofill__documents">
            <li>
              {bundle.resume ? '✓' : '—'} Tailored résumé
              {bundle.resume ? ` (${bundle.resume.filename})` : ' unavailable'}
            </li>
            <li>
              {bundle.coverLetter ? '✓' : '—'} Tailored cover letter
              {bundle.coverLetter ? ` (${bundle.coverLetter.filename})` : ' unavailable'}
            </li>
            {/*
              Which sections came across, by name and count only — never a
              value. "Profile synchronized" on its own was true of a bundle
              carrying nothing but a name and an email, which is exactly the
              state that made the extension look like it had lost the
              experience and education the user had already entered.
            */}
            <li>
              {bundle.profile
                ? `✓ Profile synchronized (${describeProfileSections(bundle.profile)})`
                : '— Profile not included in this bundle'}
            </li>
          </ul>
          {/*
            Said explicitly rather than left to be inferred from a dash. This run
            started on Internship Pilot for a named job, so the user has every
            reason to assume the tailored documents are what will be attached —
            and the default résumé is deliberately not substituted for them.
          */}
          {!bundle.resume || !bundle.coverLetter ? (
            <p className="autofill__never-submits">
              {!bundle.resume && !bundle.coverLetter
                ? 'No tailored documents came with this application.'
                : !bundle.resume
                  ? 'No tailored résumé came with this application.'
                  : 'No tailored cover letter came with this application.'}{' '}
              Your default documents will not be attached in their place — generate them on
              Internship Pilot, or attach a file yourself.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="autofill__ready">
          No application loaded from Internship Pilot, so no tailored résumé or cover letter is
          available here. Autofill still works from your saved profile on any application page.
        </p>
      )}

      {navigation ? (
        <p className="autofill__analysis">Page: {PAGE_KIND_LABELS[navigation.kind]}</p>
      ) : null}

      {navigation?.blockedReason ? (
        <section className="result result--bad" role="alert">
          {navigation.blockedReason}
        </section>
      ) : null}

      {route ? (
        <RouteChoices route={route} following={followingRoute} onFollow={() => onFollowRoute?.()} />
      ) : null}

      {navigation?.kind === 'final_submit' ? (
        <p className="autofill__never-submits">
          This is the final submission page. Review every answer and submit it yourself — the agent
          stops here.
        </p>
      ) : null}

      {agentStatus ? <p className="autofill__analysis">{agentStatus}</p> : null}

      {fieldsDetected !== null ? (
        <p className="autofill__analysis">
          Page analysis: {fieldsDetected} {fieldsDetected === 1 ? 'question' : 'questions'} found
          {navigation?.actions.length
            ? `, ${navigation.actions.length} navigation ${
                navigation.actions.length === 1 ? 'control' : 'controls'
              }`
            : ''}
          .
        </p>
      ) : null}

      {/*
        Driven by the run state, not by a separate `running` flag. The two used
        to be able to disagree — an adopted run left `running` true while the
        state stayed IDLE, which is how a live Cancel button ended up beside a
        button reading "Ready", a frozen 2/27 bar and 0s elapsed.
      */}
      {active ? (
        <div className="scan-progress" aria-live="polite">
          <strong>{RUN_STATE_LABELS[state.runState]}</strong>
          <span className="autofill__analysis">
            {formatElapsed(state.elapsedMs)} elapsed
            {progress?.fieldsTotal
              ? ` · ${progress.fieldsCompleted}/${progress.fieldsTotal} fields`
              : ''}
          </span>
          <progress max={progress?.fieldsTotal || 1} value={progress?.fieldsCompleted ?? 0} />
          <button type="button" onClick={() => void state.cancel()}>
            Cancel
          </button>
        </div>
      ) : null}

      {error && !active ? (
        <section className="result result--bad" role="alert">
          <strong>{error.code}</strong> {error.message}
          <span className="status-row__action">{error.suggestedAction}</span>
        </section>
      ) : null}

      {report && !active ? (
        <section className="result" role="status">
          {/*
            Warnings first. "Almost nothing could be answered from saved data"
            is the one sentence that explains a page of unanswered questions,
            and burying it under the counts made twenty-six identical cards
            look like twenty-six separate problems.
          */}
          {report.warnings.length > 0 ? (
            <p className="autofill__never-submits">{report.warnings[0]}</p>
          ) : null}
          {/*
            The five numbers the user actually wants after a run, named rather
            than abbreviated. "Needs confirmation" is the only one that asks
            anything of them, and the list below it holds exactly those fields —
            not all 26.
          */}
          <ul className="autofill__summary">
            <li>Fields detected: {report.fieldsFound}</li>
            <li>Automatically filled: {report.fieldsVerified}</li>
            <li>Documents uploaded: {report.documentsAttached}</li>
            {report.optionalLeftBlank > 0 ? (
              <li>Optional, left blank: {report.optionalLeftBlank}</li>
            ) : null}
            {/*
              Required fields the run could not settle, counted from the audit
              rather than from the results list. The two disagree whenever a
              required field produced no action at all — which is exactly when
              the summary used to read "Could not fill: 0" above a list of
              fields the user still had to answer.
            */}
            {/*
              Everything the run left for the user, counted once. The two lines
              this replaces could read "Needs confirmation: 0 / Could not fill:
              0" above a list of eighteen unanswered required fields, because
              each counted a different subset and neither counted the fields
              that produced no action at all.
            */}
            <li>Needs your answer: {needsUser}</li>
            <li>Could not fill: {report.failedFields}</li>
            <li>Total time: {formatElapsed(report.totalDurationMs)}</li>
          </ul>
          <p className="autofill__never-submits">
            The final Submit button was never clicked. Review the application and submit it
            yourself.
          </p>
          <ReviewList report={report} onFocus={(fieldId) => void state.focusField(fieldId)} />
          <OutstandingRequired
            report={report}
            onFocus={(fieldId) => void state.focusField(fieldId)}
          />
          {report.results.some((result) => result.reviewReason) ? (
            <button
              type="button"
              className="link-button"
              onClick={() => void state.clearHighlights()}
            >
              Clear page marks
            </button>
          ) : null}
        </section>
      ) : null}

      <button
        type="button"
        className="primary"
        disabled={!eligible || active || !fillable}
        onClick={() => void state.run()}
      >
        {active
          ? // Named rather than a spinner: a disabled button that says what it
            // is waiting on is the difference between "working" and "stuck".
            RUN_STATE_LABELS[state.runState]
          : !fillable
            ? 'Nothing to autofill on this page'
            : state.runState === 'FAILED'
              ? 'Try again'
              : report && report.failedFields > 0
                ? 'Retry failed fields'
                : 'Autofill Application'}
      </button>

      {/*
        The full field-by-field view, and deliberately a secondary link rather
        than a step. It read as something to do *before* autofill — 26 fields to
        approve one at a time — which is the opposite of one-button autofill.
        The popup surfaces what needs attention; this is for someone who wants
        to see every question and where its answer came from.
      */}
      {developerMode ? (
        <button
          type="button"
          className="link-button"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') })}
        >
          Preview detected fields
        </button>
      ) : null}
    </section>
  );
}
