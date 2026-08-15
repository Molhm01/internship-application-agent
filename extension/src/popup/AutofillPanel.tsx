import {
  FINAL_FIELD_STATUSES,
  PAGE_KIND_LABELS,
  PORTAL_ROUTE_LABELS,
  isSettledStatus,
  type AgentProgress,
  type ApplicationAutofillReport,
  type FinalFieldStatus,
  type NavigationState,
  type PortalRouteIntent,
  type PortalRouteResponse,
  type Profile,
} from '@internship-agent/shared';
import { AgentRun } from './AgentRun.js';
import { FieldStatusRow } from '../components/FieldStatusRow.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/Icon.js';
import { displayStatusFor, type FieldDisplayStatus } from '../components/fieldStatus.js';
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
  PROCESSING_DROPDOWNS: 'Processing dropdown menus…',
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
  /** The agent loop's own live progress, when a run is broadcasting it. */
  agentProgress?: AgentProgress | null;
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
      <section className="callout callout--bad" role="alert">
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
        <button
          type="button"
          className="primary btn--block"
          disabled={following}
          onClick={onFollow}
        >
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
 * Driven by each field's *final status*, not by a review flag. The two used to
 * be different things computed in different modules: a flag set before the
 * executor ran could survive a successful fill, so a question that was answered
 * and confirmed still produced a card asking the user to answer it. A field
 * whose status is settled cannot appear here, because "settled" and "not on this
 * list" are now the same statement.
 *
 * One row per unresolved question, in the page's own words, so dealing with it
 * takes a click rather than a trip through the form.
 */
function ReviewList({
  report,
  onFocus,
}: {
  report: ApplicationAutofillReport;
  onFocus: (fieldId: string) => void;
}): JSX.Element | null {
  const outstanding = report.fieldOutcomes.filter((outcome) => !isSettledStatus(outcome.status));
  if (outstanding.length === 0) return null;
  return (
    <>
      <p className="autofill__analysis">
        {outstanding.length === 1
          ? 'One field still needs you:'
          : `${outstanding.length} fields still need you:`}
      </p>
      <ul className="fieldgroup__list">
        {outstanding.map((outcome) => {
          // The annotation is the run's own reading of *why* a field is
          // outstanding, and it outranks the status for one case only: a
          // sensitive decision is the applicant's to make rather than a fact
          // the agent failed to find.
          const status: FieldDisplayStatus =
            outcome.annotation === 'sensitive_decision'
              ? 'SENSITIVE'
              : displayStatusFor(outcome.status);
          return (
            <FieldStatusRow
              key={outcome.fieldId}
              label={outcome.label || 'Unlabelled question'}
              status={status}
              required={outcome.required}
              {...(outcome.reason ? { reason: outcome.reason } : {})}
              onFocus={() => onFocus(outcome.fieldId)}
            />
          );
        })}
      </ul>
    </>
  );
}

/**
 * The eight numbers the popup prints, counted from the run's final field
 * records and from nothing else.
 *
 * `detected` is the length of the list; the six statuses partition it; `total`
 * is their sum and exists so the render can *prove* they add up rather than
 * assert it in a comment. Exported so the popup-summary tests count the same
 * way the popup does — a test that re-implements the arithmetic proves only
 * that two implementations agree.
 */
export function summarize(
  report: ApplicationAutofillReport | null,
): Record<FinalFieldStatus, number> & { detected: number; total: number } {
  const counts = Object.fromEntries(FINAL_FIELD_STATUSES.map((status) => [status, 0])) as Record<
    FinalFieldStatus,
    number
  >;
  for (const outcome of report?.fieldOutcomes ?? []) counts[outcome.status] += 1;
  return {
    ...counts,
    detected: report?.fieldOutcomes.length ?? 0,
    total: FINAL_FIELD_STATUSES.reduce((sum, status) => sum + counts[status], 0),
  };
}

/**
 * One line of the run summary.
 *
 * The label and the number stay inside a single element on purpose. Splitting
 * them into two would let the layout separate a number from the thing it
 * counts, and it would break the reading of the line as the one sentence it is
 * — "Filled and verified: 12" is a claim, not a label and a figure that happen
 * to sit on the same row. The tone is carried by a dot, which is an element and
 * therefore adds nothing to the text.
 */
function Stat({
  label,
  value,
  tone = 'idle',
}: {
  label: string;
  value: number | string;
  tone?: 'verified' | 'pending' | 'danger' | 'idle';
}): JSX.Element {
  return (
    <li className={`runstat runstat--${tone}`}>
      <span className={`dot dot--${tone}`} aria-hidden="true" />
      <span className="runstat__line">
        {label}: {value}
      </span>
    </li>
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
  agentProgress = null,
  developerMode = false,
}: AutofillPanelProps): JSX.Element {
  const { bundle, loadingBundle, progress, report, error } = state;
  // One source of truth for "is something happening": the run state. Cancel,
  // the progress bar, the timer and the primary button all read it, so the
  // invalid combination the user saw cannot be constructed.
  const active = ACTIVE_RUN_STATES.includes(state.runState);
  // The summary, counted here from the run's own field records.
  //
  // Deliberately not read off the report's pre-computed counters, and never off
  // planner output: the numbers a person reads must be a tally of the list
  // printed under them, computed in the same render from the same array. The
  // counters that produced "Could not fill: 0" above eighteen unanswered
  // questions were each derived somewhere else, from a different subset.
  const summary = summarize(report);
  // A page that is asking for credentials or that has ended the application is
  // not one to fill: the button would do nothing useful and implying otherwise
  // is worse than saying so.
  const fillable =
    !navigation ||
    navigation.kind === 'application_form' ||
    navigation.kind === 'account_creation' ||
    navigation.kind === 'unknown';
  const outstanding =
    summary.USER_CONFIRMATION_REQUIRED + summary.FAILED_EXECUTION + summary.BLOCKED;

  return (
    <section aria-label="Application" className="panel agent">
      {/*
        The identity strip. The employer and the role, when a bundle names them,
        because a panel that says "Application" over an unnamed form is exactly
        as informative as no panel at all.
      */}
      <header className="agent__head">
        <div className="agent__identity">
          <span className="eyebrow">Application agent</span>
          {loadingBundle ? (
            <p className="agent__title muted">Checking for a loaded application…</p>
          ) : bundle ? (
            <h2 className="agent__title">
              Ready for {bundle.company} — {bundle.jobTitle}
            </h2>
          ) : (
            <h2 className="agent__title">Saved profile</h2>
          )}
        </div>
        <StatusBadge
          tone={
            active
              ? 'running'
              : state.runState === 'FAILED'
                ? 'danger'
                : state.runState === 'COMPLETED'
                  ? 'verified'
                  : 'idle'
          }
          label={
            active
              ? 'Running'
              : state.runState === 'FAILED'
                ? 'Failed'
                : state.runState === 'COMPLETED'
                  ? 'Complete'
                  : 'Idle'
          }
          icon={active ? 'spinner' : state.runState === 'COMPLETED' ? 'check-double' : 'circle'}
          live={active}
        />
      </header>

      {!loadingBundle && bundle ? (
        <div className="autofill__ready">
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
      ) : null}

      {!loadingBundle && !bundle ? (
        <p className="autofill__ready">
          No application loaded from Internship Pilot, so no tailored résumé or cover letter is
          available here. Autofill still works from your saved profile on any application page.
        </p>
      ) : null}

      {/*
        The page facts, in one strip rather than as four separate sentences: the
        kind of page, what the scan found on it, and what the AI can do here.
      */}
      <div className="agent__meta">
        {navigation ? (
          <p className="autofill__analysis">Page: {PAGE_KIND_LABELS[navigation.kind]}</p>
        ) : null}

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

        {agentStatus ? <p className="autofill__analysis">{agentStatus}</p> : null}
      </div>

      {navigation?.blockedReason ? (
        <section className="callout callout--bad" role="alert">
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

      {/*
        Driven by the run state, not by a separate `running` flag. The two used
        to be able to disagree — an adopted run left `running` true while the
        state stayed IDLE, which is how a live Cancel button ended up beside a
        button reading "Ready", a frozen 2/27 bar and 0s elapsed.
      */}
      {active ? (
        <AgentRun
          runState={state.runState}
          progress={agentProgress}
          fieldsDetected={fieldsDetected}
          {...(progress?.fieldsCompleted === undefined
            ? {}
            : { fieldsCompleted: progress.fieldsCompleted })}
          {...(progress?.fieldsTotal === undefined ? {} : { fieldsTotal: progress.fieldsTotal })}
          phaseLabel={RUN_STATE_LABELS[state.runState]}
          elapsed={`${formatElapsed(state.elapsedMs)} elapsed`}
          onCancel={() => void state.cancel()}
        />
      ) : null}

      {error && !active ? (
        <section className="error-state" role="alert">
          <p className="error-state__title">{RUN_STATE_LABELS.FAILED}</p>
          <p className="error-state__body">{error.message}</p>
          <p className="error-state__action">{error.suggestedAction}</p>
          <p className="error-state__detail mono">{error.code}</p>
        </section>
      ) : null}

      {report && !active ? (
        <section className="runreport" role="status">
          {/*
            The verdict, said once and in the product's own words. "Ready for
            review" is a claim about every field on the page, so it is only made
            when nothing is outstanding; anything else says how much is left.
          */}
          <div className="runreport__verdict">
            <span className="eyebrow">
              {outstanding === 0 ? 'Application ready for review' : 'Run finished'}
            </span>
            <p className="runreport__headline">
              {outstanding === 0
                ? 'Every question the agent could reach is answered and confirmed against the page.'
                : `${outstanding} ${outstanding === 1 ? 'question needs' : 'questions need'} you before this application is complete.`}
            </p>
          </div>
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
            The status lines — filled, already correct, optional, needs you,
            could not fill, blocked — partition the fields, so they sum to
            "Fields detected" by construction rather than by coincidence. Each
            is a tally of the same list. The lines that used to be here counted
            different subsets in different modules, and no arrangement of them
            ever summed to the number printed above them. "Documents uploaded"
            is a separate dimension: an upload that verified is also counted as
            filled.
          */}
          <ul className="autofill__summary">
            <Stat label="Detected" value={summary.detected} />
            <Stat label="Filled and verified" value={summary.FILLED_VERIFIED} tone="verified" />
            <Stat label="Optional blank" value={summary.OPTIONAL_LEFT_BLANK} tone="idle" />
            <Stat
              label="Needs your answer"
              value={summary.USER_CONFIRMATION_REQUIRED}
              tone="pending"
            />
            <Stat label="Failed" value={summary.FAILED_EXECUTION} tone="danger" />
            <Stat label="Blocked" value={summary.BLOCKED} tone="danger" />
            <Stat label="Already valid" value={summary.SKIPPED_ALREADY_VALID} />
            <Stat label="Elapsed time" value={formatElapsed(report.totalDurationMs)} />
            {/*
              Not part of the partition: an upload that verified is already
              counted under "Filled and verified". It is here because "did my
              résumé actually go in?" is the one question the six statuses
              cannot answer on their own.
            */}
            <Stat label="Documents uploaded" value={report.documentsAttached} />
          </ul>
          {/*
            Shown, not hidden. A summary whose parts do not add up is the
            failure this whole model exists to end, so if it ever happens again
            the popup says so rather than letting the user work it out.
          */}
          {summary.total !== summary.detected ? (
            <p className="callout callout--bad" role="alert">
              This summary does not add up: {summary.total} field results against {summary.detected}{' '}
              detected. Export the run trace from Settings → Diagnostics.
            </p>
          ) : null}
          <p className="autofill__never-submits agent__pledge">
            <Icon name="shield" size={12} aria-hidden="true" />
            The final Submit button was never clicked. Review the application and submit it
            yourself.
          </p>
          <ReviewList report={report} onFocus={(fieldId) => void state.focusField(fieldId)} />
          {report.fieldOutcomes.length > 0 ? (
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
        className="primary btn--lg btn--block"
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
