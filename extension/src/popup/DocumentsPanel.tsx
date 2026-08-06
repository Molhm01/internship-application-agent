import type { DocumentAttachmentOutcome, StoredLatestDocument } from '@internship-agent/shared';
import { StatusRow } from './StatusRow.js';
import type { DocumentState } from './useDocumentState.js';

/**
 * The Documents section and the document-only command.
 *
 * Independent of the application bundle by design. The bundle is matched to a
 * page by URL and disappears the moment an employer link redirects through a job
 * board; the résumé and cover letter the user generated are theirs either way,
 * and this panel offers them on any application page.
 *
 * Everything below the button is read straight off the run report. There is no
 * value here that is inferred, defaulted, or rounded up — "attached" and
 * "verified" are separate lines because they are separate facts.
 */

const SOURCE_LABELS = {
  tailored: { resume: 'Tailored résumé', cover_letter: 'Tailored cover letter' },
  default: { resume: 'Default résumé', cover_letter: 'Default cover letter' },
} as const;

function receivedLabel(document: StoredLatestDocument): string {
  return new Date(document.receivedAt).toLocaleString();
}

function DocumentRow({
  label,
  document,
}: {
  label: string;
  document: StoredLatestDocument | null;
}): JSX.Element {
  return (
    <StatusRow
      label={label}
      tone={document ? 'ok' : 'warn'}
      value={document ? document.filename : 'Not available'}
      detail={
        document
          ? `Received ${receivedLabel(document)} · ${
              SOURCE_LABELS[document.source][document.documentType]
            }`
          : 'Generate it on Internship Pilot, then press Refresh Documents.'
      }
    />
  );
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function OutcomeRows({
  outcome,
  label,
}: {
  outcome: DocumentAttachmentOutcome;
  label: string;
}): JSX.Element {
  return (
    <>
      <StatusRow
        label={`${label} field found`}
        tone={outcome.fieldFound ? 'ok' : 'warn'}
        value={yesNo(outcome.fieldFound)}
      />
      <StatusRow
        label={`${label} attached`}
        tone={outcome.attached ? 'ok' : 'warn'}
        value={yesNo(outcome.attached)}
      />
      <StatusRow
        label={`${label} filename`}
        tone={outcome.filename ? 'ok' : 'idle'}
        value={outcome.filename ?? '—'}
        detail={outcome.source ? SOURCE_LABELS[outcome.source][outcome.documentType] : null}
      />
      {/*
        Never folded into "attached". A widget that takes a File and silently
        drops it would otherwise be reported as an upload that happened.
      */}
      <StatusRow
        label={`${label} verified`}
        tone={outcome.verified ? 'ok' : outcome.attached ? 'bad' : 'idle'}
        value={yesNo(outcome.verified)}
        detail={outcome.message}
      />
    </>
  );
}

export function DocumentsPanel({
  state,
  eligible,
}: {
  state: DocumentState;
  eligible: boolean;
}): JSX.Element {
  const { documents, report, attachError } = state;
  const hasAny = Boolean(documents.resume ?? documents.coverLetter);

  return (
    <section aria-label="Documents" className="panel documents">
      <header className="documents__header">
        <h2>Documents</h2>
        <button
          className="link-button"
          type="button"
          onClick={() => void state.refresh()}
          disabled={state.syncing}
        >
          {state.syncing ? 'Refreshing…' : 'Refresh Documents'}
        </button>
      </header>

      <DocumentRow label="Latest tailored résumé" document={documents.resume} />
      <DocumentRow label="Latest tailored cover letter" document={documents.coverLetter} />

      {state.syncError ? (
        <p className="documents__error" role="alert">
          {state.syncError.message}
          <span className="status-row__action">{state.syncError.suggestedAction}</span>
        </p>
      ) : null}

      <button
        className="primary"
        type="button"
        onClick={() => void state.attach()}
        disabled={!eligible || !hasAny || state.attaching}
      >
        {state.attaching ? 'Attaching…' : 'Attach Resume and Cover Letter'}
      </button>
      {!hasAny ? (
        <p className="documents__hint">
          No documents are stored yet, so there is nothing to attach. Generate them on Internship
          Pilot.
        </p>
      ) : null}

      {attachError ? (
        <p className="documents__error" role="alert">
          {attachError.message}
          <span className="status-row__action">{attachError.suggestedAction}</span>
        </p>
      ) : null}

      {report ? (
        <div className="documents__result" aria-label="Attachment result">
          <OutcomeRows label="Résumé" outcome={report.resume} />
          <OutcomeRows label="Cover letter" outcome={report.coverLetter} />
          <StatusRow
            label="Elapsed"
            tone="idle"
            value={`${(report.elapsedMs / 1000).toFixed(1)}s`}
          />
        </div>
      ) : null}

      <p className="autofill__never-submits">Attaching a document never submits the application.</p>
    </section>
  );
}
