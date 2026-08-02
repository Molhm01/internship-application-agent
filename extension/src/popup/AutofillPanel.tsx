import { REVIEW_BADGES, type ApplicationAutofillReport } from '@internship-agent/shared';
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
}: AutofillPanelProps): JSX.Element {
  const { bundle, loadingBundle, running, progress, phaseLabel, report, error } = state;

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
          </ul>
        </div>
      ) : (
        <p className="autofill__ready">
          No application loaded from Internship Pilot. Autofill still works from your saved profile
          on any application page.
        </p>
      )}

      {fieldsDetected !== null ? (
        <p className="autofill__analysis">
          Page analysis: {fieldsDetected} {fieldsDetected === 1 ? 'question' : 'questions'} found.
        </p>
      ) : null}

      {running ? (
        <div className="scan-progress" aria-live="polite">
          <strong>{phaseLabel ?? 'Preparing…'}</strong>
          <progress
            max={progress?.fieldsTotal || 1}
            value={progress?.fieldsCompleted ?? 0}
          />
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
        disabled={!eligible || running}
        onClick={() => void state.run()}
      >
        {running ? 'Autofilling…' : 'Autofill Application'}
      </button>
    </section>
  );
}
