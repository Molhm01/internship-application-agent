import { useEffect, useState } from 'react';
import type {
  AnswerGenerationRecord,
  DeterministicFillAction,
  FillExecutionResult,
  RegenerationMode,
} from '@internship-agent/shared';
import { sendMessage } from '../messaging/messages.js';
import { answerText } from '../answers/generatedActions.js';

const REGENERATION_OPTIONS: ReadonlyArray<{ value: RegenerationMode; label: string }> = [
  { value: 'default', label: 'Regenerate' },
  { value: 'shorter', label: 'Make shorter' },
  { value: 'longer', label: 'Make longer' },
  { value: 'more_technical', label: 'More technical' },
  { value: 'more_direct', label: 'More direct' },
  { value: 'more_personal', label: 'More personal' },
  { value: 'more_formal', label: 'More formal' },
  { value: 'more_conversational', label: 'More conversational' },
  { value: 'emphasize_project', label: 'Emphasize project' },
  { value: 'emphasize_experience', label: 'Emphasize experience' },
  { value: 'emphasize_leadership', label: 'Emphasize leadership' },
];

type CardMessage =
  | {
      type: 'UPDATE_GENERATED_ANSWER';
      generationId: string;
      operation: 'edit' | 'reset' | 'leave_blank';
      answer?: string;
    }
  | { type: 'APPROVE_GENERATED_ANSWER'; generationId: string }
  | { type: 'REJECT_GENERATED_ANSWER'; generationId: string }
  | { type: 'REGENERATE_GENERATED_ANSWER'; generationId: string; mode: RegenerationMode }
  | { type: 'ADD_ANSWER_EVIDENCE'; generationId: string; text: string }
  | {
      type: 'SAVE_AS_APPROVED_ANSWER';
      generationId: string;
      scope: 'general' | 'company' | 'job';
    }
  | { type: 'CLEAR_GENERATED_ANSWER'; generationId: string };

export function GeneratedAnswerCard({
  record,
  planAction,
  executionResult,
  busy,
  onChanged,
  onError,
}: {
  record: AnswerGenerationRecord;
  planAction?: DeterministicFillAction;
  executionResult?: FillExecutionResult;
  busy: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}): JSX.Element {
  const visibleAnswer = record.state === 'failed' ? '' : (answerText(record) ?? '');
  const [edit, setEdit] = useState(visibleAnswer);
  const [evidence, setEvidence] = useState('');
  const [mode, setMode] = useState<RegenerationMode>('default');
  useEffect(() => setEdit(visibleAnswer), [record, visibleAnswer]);

  const act = async (message: CardMessage): Promise<void> => {
    const result = await sendMessage(message);
    if ('error' in result && result.error) {
      onError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    await onChanged();
  };
  const refreshModels = async (): Promise<void> => {
    const result = await sendMessage({ type: 'OLLAMA_MODELS_LIST' });
    if (result.error) {
      onError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    await chrome.runtime.openOptionsPage();
  };

  const candidate = record.candidate;
  const validation = record.validation;
  const hasGeneratedAnswer =
    ['ready_for_review', 'approved', 'filled', 'verified'].includes(record.state) &&
    Boolean(answerText(record)?.trim());
  const executionStatus =
    record.state === 'failed' || record.state === 'cancelled'
      ? 'Not generated'
      : executionResult
        ? executionResult.status === 'verified'
          ? 'Filled and verified'
          : executionResult.status === 'failed'
            ? 'Failed'
            : executionResult.status
        : record.approved && planAction?.approved
          ? 'Approved, queued'
          : hasGeneratedAnswer
            ? 'Generated, not approved'
            : 'Not generated';
  return (
    <article className="answer-card">
      <header>
        <div>
          <h3>{record.question}</h3>
          <p>AI eligible: Yes · Classification: {record.classification}</p>
          <p>
            {record.classification} · <strong>{record.state}</strong>
          </p>
        </div>
        <span className={`badge ${record.approved ? 'badge--ok' : ''}`}>
          {record.approved ? 'Approved' : 'Review required'}
        </span>
      </header>
      {record.state === 'failed' && record.error ? (
        <section className="result result--bad" role="alert">
          <strong>Generation failed</strong>
          <p>
            Error code: <code>{record.error.code}</code>
          </p>
          <p>Message: {record.error.message}</p>
          <p>Suggested action: {record.error.suggestedAction}</p>
          <div className="card-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act({
                  type: 'REGENERATE_GENERATED_ANSWER',
                  generationId: record.id,
                  mode: 'default',
                })
              }
            >
              Retry Generation
            </button>
            <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
              Open AI settings
            </button>
            <button type="button" disabled={busy} onClick={() => void refreshModels()}>
              Refresh available models
            </button>
          </div>
        </section>
      ) : null}
      <dl>
        <div>
          <dt>Approval status</dt>
          <dd>{record.approved ? 'Approved by user' : 'Not approved'}</dd>
        </div>
        <div>
          <dt>Validation status</dt>
          <dd>{validation?.valid ? 'Passed' : validation ? 'Failed' : 'Not run'}</dd>
        </div>
        <div>
          <dt>Included in active fill plan</dt>
          <dd>
            {hasGeneratedAnswer && planAction?.action === 'fill_generated_text' ? 'Yes' : 'No'}
          </dd>
        </div>
        <div>
          <dt>Execution status</dt>
          <dd>{executionStatus}</dd>
        </div>
        <div>
          <dt>Limits</dt>
          <dd>
            {record.constraints.requestedExamples
              ? `${record.constraints.requestedExamples.minimum}–${record.constraints.requestedExamples.maximum} examples`
              : record.constraints.maxWords
                ? `${record.constraints.maxWords} words maximum`
                : record.constraints.maxCharacters
                  ? `${record.constraints.maxCharacters} characters maximum`
                  : 'No explicit limit detected'}
          </dd>
        </div>
        <div>
          <dt>Count</dt>
          <dd>
            {candidate?.wordCount ?? 0} words · {candidate?.characterCount ?? 0} characters
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{candidate?.confidence ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{record.model ?? 'Not called'}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {record.generationDurationMs !== undefined
              ? `${record.generationDurationMs} ms`
              : 'Not available'}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{record.source}</dd>
        </div>
      </dl>

      {candidate?.missingInformation.length ? (
        <section className="result result--bad">
          <strong>More information is needed</strong>
          <ul>
            {candidate.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <label>
        Generated answer / manual edit
        <textarea
          rows={8}
          value={edit}
          disabled={busy || record.state === 'prohibited'}
          maxLength={record.constraints.maxCharacters}
          onChange={(event) => setEdit(event.target.value)}
        />
      </label>
      <div className="card-actions">
        <button
          type="button"
          disabled={busy || !edit.trim()}
          onClick={() =>
            void act({
              type: 'UPDATE_GENERATED_ANSWER',
              generationId: record.id,
              operation: 'edit',
              answer: edit,
            })
          }
        >
          Save manual edit
        </button>
        <button
          type="button"
          disabled={busy || !record.originalCandidate}
          onClick={() =>
            void act({
              type: 'UPDATE_GENERATED_ANSWER',
              generationId: record.id,
              operation: 'reset',
            })
          }
        >
          Reset edits
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act({
              type: 'UPDATE_GENERATED_ANSWER',
              generationId: record.id,
              operation: 'leave_blank',
            })
          }
        >
          Leave blank
        </button>
      </div>

      <div className="card-actions">
        <select value={mode} onChange={(event) => setMode(event.target.value as RegenerationMode)}>
          {REGENERATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || record.state === 'prohibited' || record.state === 'failed'}
          onClick={() =>
            void act({ type: 'REGENERATE_GENERATED_ANSWER', generationId: record.id, mode })
          }
        >
          Apply regeneration
        </button>
        <button
          type="button"
          disabled={busy || !validation?.valid || !hasGeneratedAnswer}
          onClick={() => void act({ type: 'APPROVE_GENERATED_ANSWER', generationId: record.id })}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act({ type: 'REJECT_GENERATED_ANSWER', generationId: record.id })}
        >
          Reject
        </button>
      </div>

      <label>
        Add missing verified information
        <textarea
          rows={3}
          value={evidence}
          disabled={busy}
          onChange={(event) => setEvidence(event.target.value)}
          placeholder="Supply only facts you know are true."
        />
      </label>
      <button
        type="button"
        disabled={busy || !evidence.trim()}
        onClick={() => {
          void act({
            type: 'ADD_ANSWER_EVIDENCE',
            generationId: record.id,
            text: evidence.trim(),
          }).then(() => setEvidence(''));
        }}
      >
        Add evidence
      </button>

      <details>
        <summary>Evidence used ({record.contextEvidence.length})</summary>
        <ul>
          {record.contextEvidence.map((item) => (
            <li key={item.id}>
              <strong>{item.category}</strong> · {item.sourceReference}: {item.text}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Factual claims ({candidate?.factualClaims.length ?? 0})</summary>
        <ul>
          {candidate?.factualClaims.map((claim) => (
            <li key={`${claim.claim}-${claim.evidenceIds.join(',')}`}>
              {claim.claim} · evidence: {claim.evidenceIds.join(', ')}
            </li>
          ))}
        </ul>
      </details>
      {validation?.issues.length ? (
        <ul className="warnings">
          {validation.issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>
              {issue.code}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {[...record.warnings, ...(candidate?.warnings ?? [])].length ? (
        <ul className="warnings">
          {[...new Set([...record.warnings, ...(candidate?.warnings ?? [])])].map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <div className="card-actions">
        {(['general', 'company', 'job'] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            disabled={busy || !record.approved}
            onClick={() =>
              void act({
                type: 'SAVE_AS_APPROVED_ANSWER',
                generationId: record.id,
                scope,
              })
            }
          >
            Save for {scope} reuse
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act({ type: 'CLEAR_GENERATED_ANSWER', generationId: record.id })}
        >
          Clear
        </button>
      </div>
    </article>
  );
}
