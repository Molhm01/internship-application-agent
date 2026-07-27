import { useEffect, useMemo, useState } from 'react';
import {
  fillProgressMessageSchema,
  answerGenerationProgressMessageSchema,
  settingsUpdatedMessageSchema,
  classifyQuestionDeterministically,
  type AgentError,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type FillProgress,
  type FillRunReport,
  type FillUiState,
  type AnswerGenerationStore,
  type AnswerGenerationState,
} from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';
import { GeneratedAnswerCard } from './GeneratedAnswerCard.js';
import { generationStatistics } from '../answers/generatedActions.js';

type Filter = 'all' | 'ready' | 'review' | 'skipped' | 'unsupported' | 'sensitive';

function openScan(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
}

function shownValue(action: DeterministicFillAction): string {
  if (action.action === 'upload_file') return action.documentName ?? 'Selected document';
  if (action.proposedValue === undefined) return 'No proposed value';
  if (Array.isArray(action.proposedValue)) return action.proposedValue.join(', ');
  return String(action.proposedValue);
}

function filterMatches(action: DeterministicFillAction, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ready') {
    return (
      action.confidence >= 0.8 &&
      !action.requiresReview &&
      !['skip', 'manual_review', 'unsupported'].includes(action.action)
    );
  }
  if (filter === 'review') return action.requiresReview || action.action === 'manual_review';
  if (filter === 'skipped') return action.action === 'skip';
  if (filter === 'unsupported') return action.action === 'unsupported';
  return action.sensitive;
}

function ActionCard({
  action,
  busy,
  onApprove,
  onOverride,
  onReset,
  onSkip,
}: {
  action: DeterministicFillAction;
  busy: boolean;
  onApprove: (approved: boolean) => void;
  onOverride: (value: string) => void;
  onReset: () => void;
  onSkip: () => void;
}): JSX.Element {
  const [override, setOverride] = useState(shownValue(action));
  useEffect(() => setOverride(shownValue(action)), [action]);
  const actionable = !['skip', 'manual_review', 'unsupported'].includes(action.action);
  return (
    <article className={`plan-card${action.sensitive ? ' plan-card--sensitive' : ''}`}>
      <header>
        <div>
          <h3>{action.question || 'Unlabelled field'}</h3>
          <p>
            {action.fieldType} · {action.action}
          </p>
        </div>
        <label className="approval">
          <input
            type="checkbox"
            checked={action.approved}
            disabled={busy || !actionable || action.confidence < 0.8}
            onChange={(event) => onApprove(event.target.checked)}
          />
          Approved
        </label>
      </header>
      <dl>
        <div>
          <dt>Source</dt>
          <dd>{action.source}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{action.sourceReference ?? 'None'}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{Math.round(action.confidence * 100)}% (fixed deterministic band)</dd>
        </div>
        <div>
          <dt>Sensitive</dt>
          <dd>{action.sensitive ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>{action.requiresReview ? 'Required' : 'Not required'}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{action.reason}</dd>
        </div>
      </dl>
      {action.matchedOption ? (
        <p>
          Exact option: <strong>{action.matchedOption.label}</strong>{' '}
          <code>{action.matchedOption.value}</code>
        </p>
      ) : null}
      {action.action === 'upload_file' ? (
        <p>
          Proposed document: <strong>{action.documentName}</strong>. The file is fetched locally
          only after you approve this action.
        </p>
      ) : (
        <label className="override">
          Proposed value / override
          <input
            value={override}
            disabled={busy || action.action === 'unsupported'}
            onChange={(event) => setOverride(event.target.value)}
          />
        </label>
      )}
      <div className="card-actions">
        {action.action !== 'upload_file' ? (
          <>
            <button type="button" disabled={busy} onClick={() => onOverride(override)}>
              Save override
            </button>
            <button
              type="button"
              disabled={busy || action.source !== 'user_override'}
              onClick={onReset}
            >
              Reset override
            </button>
          </>
        ) : null}
        <button type="button" disabled={busy || action.action === 'skip'} onClick={onSkip}>
          Skip
        </button>
      </div>
      {action.warnings.length ? (
        <ul className="warnings">
          {action.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function App(): JSX.Element {
  const [plan, setPlan] = useState<DeterministicFillPlan | null>(null);
  const [report, setReport] = useState<FillRunReport | null>(null);
  const [state, setState] = useState<FillUiState>('idle');
  const [error, setError] = useState<AgentError | null>(null);
  const [progress, setProgress] = useState<FillProgress | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [answers, setAnswers] = useState<AnswerGenerationStore | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerStatus, setAnswerStatus] = useState<{
    state: AnswerGenerationState;
    completed: number;
    total: number;
    message: string;
  } | null>(null);

  const load = async (): Promise<void> => {
    const [response, generated] = await Promise.all([
      sendMessage({ type: 'GET_FILL_PLAN' }),
      sendMessage({ type: 'GET_GENERATED_ANSWERS' }),
    ]);
    setPlan(response.plan);
    setReport(response.report);
    setError(response.error ?? null);
    setState(response.plan ? 'ready_for_review' : response.error ? 'failed' : 'idle');
    if ('store' in generated) setAnswers(generated.store);
  };

  useEffect(() => {
    void load();
    const listener = (message: unknown): void => {
      const settingsUpdate = settingsUpdatedMessageSchema.safeParse(message);
      if (settingsUpdate.success) {
        if (settingsUpdate.data.aiGenerationEnabled) {
          setError((current) => (current?.code === 'AI_DISABLED' ? null : current));
          setAnswerStatus(null);
        }
      }
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'FILL_PLAN_UPDATED'
      ) {
        void load();
      }
      const parsed = fillProgressMessageSchema.safeParse(message);
      if (parsed.success) setProgress(parsed.data.progress);
      const answerProgress = answerGenerationProgressMessageSchema.safeParse(message);
      if (answerProgress.success) {
        setAnswerStatus({
          state: answerProgress.data.state,
          completed: answerProgress.data.completed,
          total: answerProgress.data.total,
          message: answerProgress.data.message,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener?.(listener);
  }, []);

  const build = async (): Promise<void> => {
    setState('planning');
    setError(null);
    const response = await sendMessage({ type: 'BUILD_DETERMINISTIC_PLAN' });
    if ('plan' in response) {
      setPlan(response.plan);
      setReport(null);
      setState('ready_for_review');
    } else {
      setError(response.error);
      setState('failed');
    }
  };

  const mutate = async (
    message:
      | {
          type: 'UPDATE_FILL_ACTION';
          actionId: string;
          operation: 'override' | 'reset' | 'skip';
          value?: string | string[] | boolean;
        }
      | { type: 'APPROVE_FILL_ACTION'; actionId: string; approved: boolean }
      | { type: 'APPROVE_SAFE_ACTIONS' },
  ): Promise<void> => {
    setError(null);
    const previousPlan = plan;
    if (message.type === 'APPROVE_FILL_ACTION') {
      setPlan((current) =>
        current
          ? {
              ...current,
              actions: current.actions.map((action) =>
                action.id === message.actionId ? { ...action, approved: message.approved } : action,
              ),
            }
          : current,
      );
    }
    const response = await sendMessage(message);
    if ('plan' in response) setPlan(response.plan);
    else {
      setError(response.error);
      setPlan(previousPlan);
    }
  };

  const execute = async (): Promise<void> => {
    if (!plan) return;
    setState('filling');
    setError(null);
    setProgress(null);
    const response = await sendMessage({ type: 'EXECUTE_APPROVED_ACTIONS', targetUrl: plan.url });
    if (response.type === 'FILL_COMPLETE') {
      setReport(response.report);
      setState(
        response.report.status === 'completed_with_errors'
          ? 'completed_with_errors'
          : response.report.status === 'cancelled'
            ? 'cancelled'
            : 'completed',
      );
    } else {
      setError(response.error);
      setState(response.error.code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed');
    }
  };

  const cancel = async (): Promise<void> => {
    await sendMessage({
      type: 'FILL_CANCEL',
      ...(progress?.runId ? { runId: progress.runId } : {}),
      ...(plan?.url ? { targetUrl: plan.url } : {}),
    });
    setState('cancelled');
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (plan?.actions ?? []).filter(
      (action) =>
        filterMatches(action, filter) &&
        (!query ||
          `${action.question} ${action.sourceReference ?? ''} ${action.action}`
            .toLowerCase()
            .includes(query)),
    );
  }, [plan, search, filter]);

  const customActions = useMemo(
    () =>
      (plan?.actions ?? []).filter(
        (action) =>
          !action.sensitive &&
          ['text', 'textarea', 'contenteditable'].includes(action.fieldType) &&
          ['manual_review', 'skip'].includes(action.action) &&
          /\b(why|describe|explain|discuss|tell us|tell me|share|how|what|provide|achievements?|projects?|leadership|teamwork|goals?|anything else)\b/i.test(
            action.question,
          ) &&
          !(answers?.records ?? []).some((record) => record.fieldId === action.fieldId),
      ),
    [answers, plan],
  );

  const generateOne = async (fieldId: string): Promise<void> => {
    setAnswerBusy(true);
    setError(null);
    const response = await sendMessage({ type: 'GENERATE_CUSTOM_ANSWER', fieldId });
    if ('error' in response && response.error) setError(response.error);
    await load();
    setAnswerBusy(false);
  };

  const generateAll = async (): Promise<void> => {
    setAnswerBusy(true);
    setError(null);
    const response = await sendMessage({ type: 'GENERATE_ALL_CUSTOM_ANSWERS' });
    if ('error' in response && response.error) setError(response.error);
    await load();
    setAnswerBusy(false);
  };

  const cancelAnswers = async (): Promise<void> => {
    await sendMessage({ type: 'CANCEL_ANSWER_GENERATION' });
    setAnswerBusy(false);
    setAnswerStatus((current) =>
      current ? { ...current, state: 'cancelled', message: 'Generation cancelled.' } : current,
    );
  };

  const busy = state === 'planning' || state === 'filling' || answerBusy;
  const approved = plan?.actions.filter((action) => action.approved).length ?? 0;
  const answerCounts = generationStatistics(answers, customActions.length);
  return (
    <main className="fill-shell">
      <header className="fill-header">
        <div>
          <p className="eyebrow">Milestone 3 · deterministic profile autofill</p>
          <h1>Fill Plan Review</h1>
          <p>{plan?.url ?? 'Build a plan from the latest completed scan.'}</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={openScan}>
            Return to Scan Results
          </button>
          <button type="button" onClick={() => void build()} disabled={busy}>
            {state === 'planning' ? 'Building plan…' : plan ? 'Rebuild Plan' : 'Build Fill Plan'}
          </button>
          <button
            type="button"
            onClick={() => void mutate({ type: 'APPROVE_SAFE_ACTIONS' })}
            disabled={!plan || busy}
          >
            Approve All Safe
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void execute()}
            disabled={!plan || approved === 0 || busy}
          >
            {state === 'filling' ? 'Filling…' : `Fill Approved Fields (${approved})`}
          </button>
          {state === 'filling' ? (
            <button type="button" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
        </div>
      </header>
      {progress && state === 'filling' ? (
        <section className="progress" aria-live="polite">
          <strong>{progress.message}</strong>
          <progress max={progress.total || 1} value={progress.completed} />
        </section>
      ) : null}
      <section className="ai-warning" role="note">
        <strong>Review all AI-generated answers before filling.</strong> Generation runs locally
        through Ollama and uses only displayed evidence. The extension will never submit the
        application.
      </section>
      {answerStatus ? (
        <section className="progress" aria-live="polite">
          <strong>{answerStatus.message}</strong>
          <progress max={answerStatus.total || 1} value={answerStatus.completed} />
          <span>
            {answerStatus.completed}/{answerStatus.total} · {answerStatus.state}
          </span>
          {answerBusy ? (
            <button type="button" onClick={() => void cancelAnswers()}>
              Cancel generation
            </button>
          ) : null}
        </section>
      ) : null}
      {error ? (
        <section className="result result--bad" role="alert">
          <strong>{error.code}</strong> {error.message} {error.suggestedAction}
          <button type="button" onClick={() => void load()}>
            Return to Review
          </button>
        </section>
      ) : null}
      {plan ? (
        <>
          <section className="summary" aria-label="Fill plan summary">
            {Object.entries(plan.statistics).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <strong>{value}</strong>
              </div>
            ))}
            <div>
              <span>approved</span>
              <strong>{approved}</strong>
            </div>
          </section>
          <section className="answer-review" aria-label="AI answer review">
            <div className="answer-review__header">
              <div>
                <h2>Custom written answers</h2>
                <p>
                  {answerCounts.generated} generated · {answerCounts.failed} failed ·{' '}
                  {answerCounts.needsInput} needs input · {answerCounts.prohibited} prohibited ·{' '}
                  {answerCounts.generating} generating · {answerCounts.eligibleNotRequested}{' '}
                  eligible and not requested
                </p>
              </div>
              <button
                type="button"
                disabled={busy || customActions.length === 0}
                onClick={() => void generateAll()}
              >
                Generate all eligible answers
              </button>
            </div>
            {customActions.map((action) => (
              <article className="answer-card answer-card--eligible" key={action.id}>
                <h3>{action.question}</h3>
                <p>
                  AI eligible: Yes · Classification:{' '}
                  {classifyQuestionDeterministically(action.question).classification}
                </p>
                <p>
                  Generation status: Not generated · Approval status: Not approved · Validation
                  status: Not run · Included in active fill plan: Yes
                </p>
                <p>Execution status: Not generated</p>
                <p>
                  {action.fieldType} · unresolved custom response · generated answers are never
                  pre-approved
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void generateOne(action.fieldId)}
                >
                  Generate Answer
                </button>
              </article>
            ))}
            {(answers?.records ?? []).map((record) => (
              <GeneratedAnswerCard
                key={record.id}
                record={record}
                planAction={plan.actions.find((action) => action.generationId === record.id)}
                executionResult={report?.results.find(
                  (result) =>
                    plan.actions.find((action) => action.id === result.actionId)?.generationId ===
                    record.id,
                )}
                busy={busy}
                onChanged={load}
                onError={(message) =>
                  setError({
                    code: 'INTERNAL_ERROR',
                    message,
                    recoverable: true,
                    suggestedAction: 'Review the answer state and retry.',
                    debugContext: {},
                  })
                }
              />
            ))}
          </section>
          <section className="filters">
            <label>
              Search
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              Status
              <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                <option value="all">All actions</option>
                <option value="ready">Ready</option>
                <option value="review">Review</option>
                <option value="skipped">Skipped</option>
                <option value="unsupported">Unsupported</option>
                <option value="sensitive">Sensitive</option>
              </select>
            </label>
          </section>
          <p>
            {filtered.length} of {plan.actions.length} actions shown.
          </p>
          <section className="plan-list">
            {filtered.map((action) => (
              <ActionCard
                key={action.id}
                action={action}
                busy={busy}
                onApprove={(value) =>
                  void mutate({
                    type: 'APPROVE_FILL_ACTION',
                    actionId: action.id,
                    approved: value,
                  })
                }
                onOverride={(value) =>
                  void mutate({
                    type: 'UPDATE_FILL_ACTION',
                    actionId: action.id,
                    operation: 'override',
                    value:
                      action.fieldType === 'checkbox'
                        ? /^(true|yes)$/i.test(value.trim())
                          ? true
                          : /^(false|no)$/i.test(value.trim())
                            ? false
                            : value
                        : action.fieldType === 'multi_select'
                          ? value
                              .split(',')
                              .map((entry) => entry.trim())
                              .filter(Boolean)
                          : value,
                  })
                }
                onReset={() =>
                  void mutate({
                    type: 'UPDATE_FILL_ACTION',
                    actionId: action.id,
                    operation: 'reset',
                  })
                }
                onSkip={() =>
                  void mutate({
                    type: 'UPDATE_FILL_ACTION',
                    actionId: action.id,
                    operation: 'skip',
                  })
                }
              />
            ))}
          </section>
        </>
      ) : (
        <section className="empty">
          <h2>No fill plan is stored</h2>
          <p>Analyze the current application first, then build a deterministic plan.</p>
        </section>
      )}
      {report ? (
        <section className="report" aria-label="Fill run report">
          <h2>Fill Run Report</h2>
          <p className={report.failedActions ? 'result result--bad' : 'result'}>
            {report.verifiedActions} verified · {report.failedActions} failed ·{' '}
            {report.reviewActions} review · {report.skippedActions} skipped ·{' '}
            {report.unsupportedActions} unsupported
          </p>
          <ul>
            {report.results.map((result) => (
              <li key={result.actionId}>
                <strong>{result.status}</strong> · {result.fieldId}
                {result.error ? ` · ${result.error.code}: ${result.error.message}` : ''}
              </li>
            ))}
          </ul>
          <p>
            <strong>
              {plan?.actions.some(
                (action) => action.action === 'fill_generated_text' && action.approved,
              )
                ? 'AI-generated answers were inserted. Review every answer and continue manually.'
                : 'Review the application and continue manually.'}
            </strong>
          </p>
          {report.failedActions ? (
            <button type="button" onClick={() => void execute()} disabled={busy || approved === 0}>
              Retry Approved Actions
            </button>
          ) : null}
        </section>
      ) : null}
      <footer>
        No files are uploaded. No Next, Continue, or Submit control is ever activated.
      </footer>
    </main>
  );
}
