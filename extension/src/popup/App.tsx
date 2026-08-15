import { useCallback, useEffect, useState } from 'react';
import { ATS_DISPLAY_NAMES, RECONNECT_MESSAGE } from '@internship-agent/shared';
import { BUILD_ID, BUILD_INFO } from '../generated/buildInfo.js';
import { useBuildAgreement } from './useBuildAgreement.js';
import { StatusRow, type StatusTone } from './StatusRow.js';
import { usePopupState } from './usePopupState.js';
import { useAutofillState } from './useAutofillState.js';
import { useAgentProgress } from './useAgentProgress.js';
import { usePortalRoute } from './usePortalRoute.js';
import { AutofillPanel } from './AutofillPanel.js';
import { DocumentsPanel } from './DocumentsPanel.js';
import { useDocumentState } from './useDocumentState.js';
import { QuestionQueue, looksSensitive, type QuestionAnswer } from '../components/QuestionQueue.js';
import { Icon } from '../components/Icon.js';
import { sendMessage } from '../messaging/messages.js';

const NOT_YET = 'Not analyzed yet';

/**
 * The only thing a normal user is told when a scan fails recoverably.
 *
 * Deliberately one sentence with one instruction. The underlying error can be a
 * schema rejection whose message is a JSON dump of Zod issues; that belongs in
 * the console, not in the popup.
 */
const RECOVERABLE_SCAN_MESSAGE =
  'Application analysis failed. Reload the extension and page, then try again.';

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function FailureDetail({
  message,
  suggestedAction,
}: {
  message: string;
  suggestedAction: string;
}): JSX.Element {
  return (
    <>
      {message}
      <span className="status-row__action">{suggestedAction}</span>
    </>
  );
}

export function App(): JSX.Element {
  const { status, tab, loading, refresh, scanState, scan, progress, scanError, cancel } =
    usePopupState();
  const autofill = useAutofillState(tab.url);
  // The agent loop's own broadcasts. Read-only: subscribing to a message the
  // loop already sends is the whole integration, and nothing here can change
  // what a run does.
  const agentProgress = useAgentProgress();
  // Deliberately not conditioned on a bundle, a scan, or a route. The user's own
  // documents are available on any application page, including one reached
  // through a redirect that no bundle can be matched to.
  const documents = useDocumentState(tab.url ?? undefined);
  // Asked before anything is offered. The worker performs the same comparison
  // against the content script when a run is accepted; between them the three
  // components are covered, and neither can reach a different verdict because
  // both call `compareBuilds`.
  const buildAgreement = useBuildAgreement();
  const [savingAnswers, setSavingAnswers] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  // Development detail goes to the console only, and carries no field values —
  // a scan holds whatever the user typed, which can be a password.
  useEffect(() => {
    if (!scanError) return;
    console.warn('[agent] scan failed', {
      code: scanError.code,
      build: BUILD_INFO.commit,
      builtAt: BUILD_INFO.builtAt,
      sourceRoot: BUILD_INFO.sourceRoot,
      ...(scanError.debugContext ?? {}),
    });
  }, [scanError]);
  // The route decision is made in the background worker, which owns both the
  // saved strategy and the scan those routes came from. The popup asks what the
  // decision is and renders it; it does not re-derive it, because two copies of
  // this rule would eventually disagree about whether an account gets created.
  //
  // Re-asked whenever the scan changes, so a route hop re-evaluates the page it
  // landed on rather than the one it left.
  const portal = usePortalRoute(tab.url, scan?.id ?? null, refresh);
  const routeOffered =
    portal.route !== null && !('error' in portal.route) && portal.route.decision !== 'none';
  // What the AI can actually do right now, said plainly. An unreachable agent
  // is reported as such rather than as a bare error code.
  const agentStatus = loading
    ? null
    : !status?.health
      ? 'AI agent unavailable. Deterministic autofill still works from your saved profile.'
      : status.health.ollama.state === 'connected'
        ? 'AI agent connected.'
        : 'AI agent unavailable: the local model is not answering. Deterministic autofill still works.';
  const serverConnected = Boolean(status?.health);
  const health = status?.health;
  const ollama = health?.ollama;
  const ollamaConnected = ollama?.state === 'connected';
  const serverTone: StatusTone = loading ? 'idle' : serverConnected ? 'ok' : 'bad';
  const ollamaTone: StatusTone = loading
    ? 'idle'
    : !serverConnected
      ? 'idle'
      : ollamaConnected
        ? 'ok'
        : 'bad';
  const serverDetail =
    !loading && status?.error ? (
      <FailureDetail
        message={status.error.message}
        suggestedAction={status.error.suggestedAction}
      />
    ) : null;
  const ollamaDetail =
    !loading && serverConnected && ollama?.error ? (
      <FailureDetail
        message={ollama.error.message}
        suggestedAction={ollama.error.suggestedAction}
      />
    ) : null;
  const modelValue = !serverConnected
    ? 'Unknown'
    : !ollama?.selectedModel
      ? 'Not configured'
      : ollamaConnected && ollama.selectedModelInstalled === false
        ? `${ollama.selectedModel} (not installed)`
        : ollama.selectedModel;
  const modelTone: StatusTone = !serverConnected
    ? 'idle'
    : ollamaConnected && ollama?.selectedModelInstalled === false
      ? 'warn'
      : ollamaConnected
        ? 'ok'
        : 'idle';
  const profile: { tone: StatusTone; value: string; detail: string | null } = !serverConnected
    ? { tone: 'idle', value: 'Unknown', detail: null }
    : !status?.tokenConfigured
      ? {
          tone: 'warn',
          value: 'Token required',
          detail: 'Paste the agent server token in settings before reading your saved profile.',
        }
      : !health?.profileLoaded
        ? {
            tone: 'warn',
            value: 'Not created',
            detail: 'Open settings and fill in at least your name and contact details.',
          }
        : health.profileCompleteness
          ? {
              tone: health.profileCompleteness.percent === 100 ? 'ok' : 'warn',
              value: `${health.profileCompleteness.percent}% complete`,
              detail: (() => {
                const missing = health.profileCompleteness.sections.filter(
                  (section) => section.required && !section.complete,
                );
                return missing.length
                  ? `Still needed: ${missing.map((section) => section.label).join(', ')}.`
                  : `All ${health.profileCompleteness.totalRequiredSections} required sections are filled in.`;
              })(),
            }
          : {
              tone: 'warn',
              value: 'Saved, unreadable',
              detail:
                'A profile exists but could not be read against the current schema. Open settings to see which sections need re-entering.',
            };
  const resume: { tone: StatusTone; value: string; detail: string | null } = !serverConnected
    ? { tone: 'idle', value: 'Unknown', detail: null }
    : !status?.tokenConfigured
      ? { tone: 'warn', value: 'Token required', detail: null }
      : status.selectedResume
        ? {
            tone: 'ok',
            value: status.selectedResume.name,
            detail:
              status.selectedResume.reason === 'user_selected'
                ? 'Chosen explicitly for the next application.'
                : 'Your default resume.',
          }
        : status.selectedResume === null
          ? {
              tone: 'warn',
              value: 'None registered',
              detail: 'Add a resume in settings.',
            }
          : { tone: 'warn', value: 'Unknown', detail: 'The document list could not be read.' };
  const currentScan = scan?.url === tab.url ? scan : null;
  const eligible = Boolean(tab.url?.startsWith('http') && tab.contentScriptReachable);
  const applicationFormDetected = Boolean(currentScan && currentScan.statistics.total > 0);
  // A page the extension cannot talk to has told us nothing about itself. Saying
  // "no supported application form detected" there is a diagnosis we have not
  // earned, and it sent people to reinstall the extension when a refresh was
  // the whole fix.
  const disconnected = Boolean(tab.url?.startsWith('http')) && !tab.contentScriptReachable;

  /**
   * Saves the applicant's answers, then runs the agent again over this page.
   *
   * There is no channel that injects an answer into a loop already in flight,
   * and this deliberately does not pretend otherwise: the answers go to the
   * approved answers library — which the pipeline searches before it asks the
   * model anything — and the run is started again, where it finds them waiting.
   *
   * Nothing here decides that an answer is safe to reuse. `autoFillAllowed` is
   * true only for an answer the applicant typed for a question the agent asked,
   * which is the definition of an explicitly given answer; a question that
   * looks sensitive is stored for review rather than for automatic use.
   */
  const submitAnswers = useCallback(
    async (answers: readonly QuestionAnswer[]): Promise<void> => {
      setSavingAnswers(true);
      setAnswerError(null);
      try {
        for (const entry of answers) {
          // A sensitive answer is stored as sensitive. The applicant gave it
          // explicitly, so it may be used — but it is flagged for review on
          // every future application rather than reused silently, which is the
          // difference between an explicit policy and an inference.
          const sensitive = looksSensitive(entry.question);
          const result = await sendMessage({
            type: 'ANSWER_CREATE',
            answer: {
              canonicalQuestion: entry.question.question || entry.question.label,
              aliases: entry.question.label ? [entry.question.label] : [],
              answerType: 'text',
              answer: entry.value,
              category: entry.question.section || 'application',
              approved: true,
              autoFillAllowed: true,
              sensitive,
              tailoringAllowed: false,
              requiresReview: sensitive,
              ...(entry.scope === 'company' && autofill.bundle?.company
                ? { scope: 'company' as const, scopeReference: autofill.bundle.company }
                : { scope: 'general' as const }),
            },
          });
          if (result.error) {
            setAnswerError(result.error.message);
            return;
          }
        }
        await autofill.run();
      } finally {
        setSavingAnswers(false);
      }
    },
    [autofill],
  );

  return (
    <main className="popup">
      <header className="popup__header">
        <div className="popup__brand">
          <span className="popup__mark" aria-hidden="true">
            <Icon name="activity" size={13} />
          </span>
          <h1>Internship Application Agent</h1>
        </div>
        <button className="btn--ghost btn--sm" onClick={refresh} disabled={loading} type="button">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </header>
      <section aria-label="Connection status" className="panel">
        <p className="eyebrow">System</p>
        <StatusRow
          label="Agent Server"
          tone={serverTone}
          value={loading ? 'Checking…' : serverConnected ? 'Connected' : 'Disconnected'}
          detail={
            serverDetail ??
            (serverConnected ? `${status?.serverUrl} · ${status?.latencyMs}ms` : null)
          }
        />
        <StatusRow
          label="Ollama"
          tone={ollamaTone}
          value={
            loading
              ? 'Checking…'
              : !serverConnected
                ? 'Unknown — server unreachable'
                : ollamaConnected
                  ? 'Connected'
                  : 'Disconnected'
          }
          detail={
            ollamaDetail ??
            (ollamaConnected
              ? `${ollama?.baseUrl} · ${ollama?.modelCount ?? 0} ${
                  ollama?.modelCount === 1 ? 'model' : 'models'
                } installed`
              : null)
          }
        />
        <StatusRow label="Model" tone={modelTone} value={modelValue} />
        <StatusRow
          label="Profile"
          tone={profile.tone}
          value={profile.value}
          detail={profile.detail}
        />
      </section>
      <section aria-label="Current page" className="panel">
        <p className="eyebrow">Page</p>
        <StatusRow
          label="Current Site"
          tone={tab.domain ? 'ok' : 'idle'}
          value={tab.domain ?? 'No page detected'}
          detail={
            tab.domain && !tab.contentScriptReachable
              ? // One sentence, and the same one the worker uses. The old text
                // blamed "the content script", which is not a thing the person
                // reading it has any way to act on.
                RECONNECT_MESSAGE
              : tab.reconnected
                ? 'Reconnected to this page after the extension was reloaded.'
                : null
          }
        />
        <StatusRow
          label="ATS"
          tone={currentScan ? 'ok' : 'idle'}
          // The scan's answer when there is one, the page's own detection
          // otherwise. The second is what keeps the vendor visible when a scan
          // fails, which is when knowing it matters most.
          value={currentScan?.ats.displayName ?? tab.ats?.displayName ?? ATS_DISPLAY_NAMES.unknown}
          detail={currentScan?.ats.detectionReason ?? tab.ats?.reason ?? null}
        />
        <StatusRow
          label="Fields Detected"
          tone={currentScan ? 'ok' : 'idle'}
          value={currentScan ? currentScan.statistics.total : NOT_YET}
        />
        <StatusRow
          label="Selected Resume"
          tone={resume.tone}
          value={resume.value}
          detail={resume.detail}
        />
      </section>
      {scanState === 'scanning' ? (
        <section className="panel scan-progress" aria-live="polite">
          <strong>{progress?.message ?? 'Starting read-only scan…'}</strong>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress?.percent ?? 5}
          >
            <div className="progress-fill" style={{ width: `${progress?.percent ?? 5}%` }} />
          </div>
          <button type="button" className="btn--sm" onClick={() => void cancel()}>
            Cancel scan
          </button>
        </section>
      ) : null}
      {scanError ? (
        <section className="callout callout--bad" role="alert">
          {/*
            A recoverable scan failure says one thing and nothing else. The
            error's own `message` can be a schema rejection, and rendering that
            put a raw Zod dump — including the validator's accepted-value list —
            in front of somebody who wanted to apply for a job. The list read as
            "your page is unsupported" when the truth was "this build is stale".
            The code and the details stay in the console for development.
          */}
          {RECOVERABLE_SCAN_MESSAGE}
        </section>
      ) : null}
      {/*
        Nothing below this is offered while the bundles disagree. A
        mixed-version run does not fail honestly — it fails somewhere downstream
        with a message about a value, which is how a browser came to run a build
        two commits behind a green test suite.
      */}
      {buildAgreement && !buildAgreement.agreed ? (
        <section aria-label="Application" className="panel callout callout--bad" role="alert">
          <p>{buildAgreement.message}</p>
        </section>
      ) : disconnected ? (
        <section aria-label="Application" className="panel">
          <p role="alert">{RECONNECT_MESSAGE}</p>
        </section>
      ) : applicationFormDetected || autofill.bundle || routeOffered ? (
        <AutofillPanel
          state={autofill}
          eligible={eligible}
          fieldsDetected={currentScan?.statistics.total ?? null}
          {...(currentScan?.navigation ? { navigation: currentScan.navigation } : {})}
          route={portal.route}
          followingRoute={portal.following}
          onFollowRoute={() => void portal.follow()}
          agentStatus={agentStatus}
          agentProgress={agentProgress}
        />
      ) : scanState === 'scanning' || loading ? (
        <section aria-label="Application" className="panel">
          <button type="button" className="primary btn--block" disabled>
            Detecting application form…
          </button>
        </section>
      ) : (
        <section aria-label="Application" className="panel">
          <p className="empty-state__body">No supported application form detected on this page</p>
        </section>
      )}
      {/*
        The questions the run stopped to ask, rendered from the loop's own
        pending queue. An unanswered factual question is not an error and is not
        drawn as one — it is the agent refusing to invent a fact, which is the
        behaviour this product is built on.
      */}
      {agentProgress && agentProgress.pendingQuestions.length > 0 ? (
        <section aria-label="Agent questions" className="panel">
          {answerError ? (
            <p className="callout callout--bad" role="alert">
              {answerError}
            </p>
          ) : null}
          <QuestionQueue
            questions={agentProgress.pendingQuestions}
            {...(autofill.bundle?.company ? { company: autofill.bundle.company } : {})}
            onSubmit={submitAnswers}
            submitting={savingAnswers}
            disabled={autofill.running}
          />
        </section>
      ) : null}
      {/*
        Always rendered, above the bundle-dependent panel. Whether an
        application bundle could be matched to this page has nothing to do with
        whether the user has a résumé, and letting the bundle's absence hide the
        documents is what made a redirect look like data loss.
      */}
      <DocumentsPanel state={documents} eligible={eligible} />
      <section aria-label="Actions" className="popup__actions">
        <button type="button" className="btn--block" onClick={openSettings}>
          Open Settings
        </button>
      </section>
      <footer className="popup__footer">
        {/*
          The old line — "only explicitly approved deterministic actions can
          change fields" — described a workflow where the user approved each
          action first. What is actually true now, and what matters, is that the
          model decides the answer while the deterministic executor is the only
          thing that touches the page.
        */}
        <p>AI decides the answer; the deterministic executor is what changes a field.</p>
        <p className="popup__pledge">
          <Icon name="shield" size={11} aria-hidden="true" />
          This agent never submits an application.
        </p>
        {/*
          Which build this actually is. A stale unpacked extension loaded from a
          sibling copy of the repository is otherwise indistinguishable from a
          current one, and that is exactly how a validator came to disagree with
          the scanner that feeds it.
        */}
        <p className="popup__build" title={BUILD_INFO.sourceRoot}>
          Build {BUILD_ID} · {new Date(BUILD_INFO.builtAt).toLocaleString()}
        </p>
        <p className="popup__build popup__build--path">{BUILD_INFO.sourceRoot}</p>
      </footer>
    </main>
  );
}
