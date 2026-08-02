import {
  PAGE_KIND_LABELS,
  REVIEW_BADGES,
  type ApplicationAutofillReport,
  type NavigationState,
} from '@internship-agent/shared';
import type { AutofillState } from './useAutofillState.js';

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
  /** One sentence about the AI agent, or null while it is still unknown. */
  agentStatus: string | null;
}

/**
 * The routes off a sign-in or choose-how-to-apply page.
 *
 * These are shown, never taken. Creating an employer account and applying as a
 * guest have permanently different consequences for the user, so the agent
 * offers both and picks neither.
 */
function RouteChoices({ navigation }: { navigation: NavigationState }): JSX.Element | null {
  const routes = navigation.actions.filter(
    (action) =>
      action.intent === 'login' ||
      action.intent === 'create_account' ||
      action.intent === 'apply_as_guest',
  );
  if (routes.length === 0) return null;
  return (
    <div className="autofill__routes">
      <p className="autofill__analysis">This page is asking how you want to apply:</p>
      <ul className="autofill__documents">
        {routes.map((route) => (
          <li key={`${route.intent}-${route.selector}`}>{route.label}</li>
        ))}
      </ul>
      <p className="autofill__never-submits">
        Choose one yourself. The agent does not pick between creating an account and applying as a
        guest.
      </p>
    </div>
  );
}

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
        <li key={result.fieldId}>
          <button type="button" className="link-button" onClick={() => onFocus(result.fieldId)}>
            {result.question || 'Unlabelled question'}
          </button>
          <span className="review-list__badge">{REVIEW_BADGES[result.reviewReason!]}</span>
          {result.reason ? <span className="review-list__reason">{result.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function AutofillPanel({
  state,
  eligible,
  fieldsDetected,
  navigation,
  agentStatus,
}: AutofillPanelProps): JSX.Element {
  const { bundle, loadingBundle, running, progress, phaseLabel, report, error } = state;
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
              {bundle.resume ? ` (${bundle.resume.filename})` : ' not loaded'}
            </li>
            <li>
              {bundle.coverLetter ? '✓' : '—'} Cover letter
              {bundle.coverLetter ? ` (${bundle.coverLetter.filename})` : ' not loaded'}
            </li>
            <li>
              {bundle.profile ? '✓ Profile synchronized' : '— Profile not included in this bundle'}
            </li>
          </ul>
        </div>
      ) : (
        <p className="autofill__ready">
          No application loaded from Internship Pilot. Autofill still works from your saved profile
          on any application page.
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

      {navigation ? <RouteChoices navigation={navigation} /> : null}

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

      {running ? (
        <div className="scan-progress" aria-live="polite">
          <strong>{phaseLabel ?? 'Preparing…'}</strong>
          <progress max={progress?.fieldsTotal || 1} value={progress?.fieldsCompleted ?? 0} />
          <button type="button" onClick={() => void state.cancel()}>
            Cancel
          </button>
        </div>
      ) : null}

      {error && !running ? (
        <section className="result result--bad" role="alert">
          <strong>{error.code}</strong> {error.message}
          <span className="status-row__action">{error.suggestedAction}</span>
        </section>
      ) : null}

      {report && !running ? (
        <section className="result" role="status">
          <p>
            Filled: {report.fieldsVerified} · Uploaded: {report.documentsAttached} · Needs review:{' '}
            {report.uncertainSuggestions + report.manualBlockers} · Unable to fill:{' '}
            {report.failedFields}
          </p>
          <p className="autofill__never-submits">
            The final Submit button was never clicked. Review the application and submit it
            yourself.
          </p>
          <ReviewList report={report} onFocus={(fieldId) => void state.focusField(fieldId)} />
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
        disabled={!eligible || running || !fillable}
        onClick={() => void state.run()}
      >
        {running
          ? 'Autofilling…'
          : fillable
            ? 'Autofill Application'
            : 'Nothing to autofill on this page'}
      </button>

      {/* The full field-by-field view. The popup shows what needs attention;
          this is for someone who wants to see every question and its source. */}
      <button
        type="button"
        className="link-button"
        onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') })}
      >
        Review every detected field
      </button>
    </section>
  );
}
