import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_ERROR_GUIDANCE,
  type AgentError,
  type AnswerType,
  type ApprovedAnswer,
  type ApprovedAnswerInput,
} from '@internship-agent/shared';
import { sendMessage } from '../../messaging/messages.js';
import { CheckboxField, SelectField, TextField } from '../components/Field.js';
import { ListInput } from '../components/ListInput.js';

const ANSWER_TYPES: ReadonlyArray<{ value: AnswerType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'single_select', label: 'Single select' },
  { value: 'multi_select', label: 'Multi select' },
  { value: 'date', label: 'Date' },
  { value: 'number', label: 'Number' },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; error: AgentError };

interface DraftAnswer extends Omit<ApprovedAnswerInput, 'answer'> {
  /** Held as text/array/boolean and converted on save based on `answerType`. */
  answerText: string;
  answerList: string[];
  answerBoolean: boolean;
}

/** Anything thrown that reaches the UI is shown, never swallowed. */
function unexpectedError(stage: string, cause: unknown): AgentError {
  return {
    code: 'INTERNAL_ERROR',
    message: `The settings page hit an unexpected error while ${stage}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.INTERNAL_ERROR,
    debugContext: { stage },
  };
}

function blankDraft(): DraftAnswer {
  return {
    canonicalQuestion: '',
    aliases: [],
    answerType: 'text',
    category: 'general',
    approved: true,
    autoFillAllowed: false,
    sensitive: false,
    tailoringAllowed: false,
    requiresReview: true,
    answerText: '',
    answerList: [],
    answerBoolean: false,
  };
}

function toDraft(answer: ApprovedAnswer): DraftAnswer {
  return {
    canonicalQuestion: answer.canonicalQuestion,
    aliases: answer.aliases,
    answerType: answer.answerType,
    category: answer.category,
    approved: answer.approved,
    autoFillAllowed: answer.autoFillAllowed,
    sensitive: answer.sensitive,
    tailoringAllowed: answer.tailoringAllowed,
    requiresReview: answer.requiresReview,
    answerText:
      typeof answer.answer === 'string'
        ? answer.answer
        : typeof answer.answer === 'number'
          ? String(answer.answer)
          : '',
    answerList: Array.isArray(answer.answer) ? answer.answer : [],
    answerBoolean: typeof answer.answer === 'boolean' ? answer.answer : false,
  };
}

function toInput(draft: DraftAnswer): ApprovedAnswerInput {
  const { answerText, answerList, answerBoolean, ...rest } = draft;
  const answer =
    draft.answerType === 'boolean'
      ? answerBoolean
      : draft.answerType === 'multi_select'
        ? answerList
        : draft.answerType === 'number'
          ? Number(answerText)
          : answerText;
  return { ...rest, answer };
}

function describeAnswer(answer: ApprovedAnswer): string {
  if (typeof answer.answer === 'boolean') return answer.answer ? 'Yes' : 'No';
  if (Array.isArray(answer.answer)) return answer.answer.join(', ');
  return String(answer.answer);
}

export function AnswersSection(): JSX.Element {
  const [answers, setAnswers] = useState<ApprovedAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AgentError | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftAnswer>(blankDraft);

  /** `finally` guarantees the list never stays on "Loading answers…". */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sendMessage({ type: 'ANSWERS_LIST' });
      if (result.data) {
        setAnswers(result.data.answers);
        setLoadError(null);
      } else {
        setLoadError(result.error ?? unexpectedError('listing answers', 'no result returned'));
      }
    } catch (cause) {
      setLoadError(unexpectedError('listing answers', cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = (change: Partial<DraftAnswer>): void => {
    setDraft((current) => ({ ...current, ...change }));
    setStatus({ kind: 'idle' });
  };

  const startNew = (): void => {
    setEditingId(null);
    setDraft(blankDraft());
    setStatus({ kind: 'idle' });
  };

  const startEdit = (answer: ApprovedAnswer): void => {
    setEditingId(answer.id);
    setDraft(toDraft(answer));
    setStatus({ kind: 'idle' });
  };

  const submit = (): void => {
    setStatus({ kind: 'busy', what: editingId ? 'Saving answer…' : 'Creating answer…' });
    void (async () => {
      const input = toInput(draft);
      const result = editingId
        ? await sendMessage({ type: 'ANSWER_UPDATE', id: editingId, answer: input })
        : await sendMessage({ type: 'ANSWER_CREATE', answer: input });

      if (result.data) {
        setStatus({
          kind: 'ok',
          message: editingId ? 'Answer updated.' : 'Answer added to the library.',
        });
        setEditingId(null);
        setDraft(blankDraft());
        await refresh();
      } else {
        setStatus({
          kind: 'error',
          error: result.error ?? unexpectedError('saving the answer', 'no result returned'),
        });
      }
    })().catch((cause: unknown) => {
      setStatus({ kind: 'error', error: unexpectedError('saving the answer', cause) });
    });
  };

  const remove = (answer: ApprovedAnswer): void => {
    setStatus({ kind: 'busy', what: 'Deleting answer…' });
    void (async () => {
      const result = await sendMessage({ type: 'ANSWER_DELETE', id: answer.id });
      if (result.data) {
        if (editingId === answer.id) startNew();
        setStatus({ kind: 'ok', message: 'Answer deleted.' });
        await refresh();
      } else {
        setStatus({
          kind: 'error',
          error: result.error ?? unexpectedError('deleting the answer', 'no result returned'),
        });
      }
    })().catch((cause: unknown) => {
      setStatus({ kind: 'error', error: unexpectedError('deleting the answer', cause) });
    });
  };

  return (
    <>
      <h2>Approved answers</h2>
      <p className="section-note">
        Reusable answers to questions that come up on every application. The agent searches this
        library before it ever asks the model to write something new.
      </p>

      {loading ? <p className="muted">Loading answers…</p> : null}
      {loadError ? (
        <p className="result result--bad" role="alert">
          {loadError.message} {loadError.suggestedAction}
        </p>
      ) : null}

      {!loading && !loadError && answers.length === 0 ? (
        <p className="entry-list__empty">No approved answers yet.</p>
      ) : null}

      {answers.length > 0 ? (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Category</th>
              <th>Flags</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {answers.map((answer) => (
              <tr key={answer.id}>
                <td>
                  <strong>{answer.canonicalQuestion}</strong>
                  {answer.aliases.length > 0 ? (
                    <>
                      <br />
                      <span className="muted">also matches: {answer.aliases.join('; ')}</span>
                    </>
                  ) : null}
                </td>
                <td>{describeAnswer(answer)}</td>
                <td>{answer.category}</td>
                <td>
                  {answer.approved ? <span className="badge badge--ok">approved</span> : null}
                  {answer.autoFillAllowed ? <span className="badge">auto-fill</span> : null}
                  {answer.sensitive ? <span className="badge badge--warn">sensitive</span> : null}
                  {answer.requiresReview ? <span className="badge">review</span> : null}
                  {answer.tailoringAllowed ? <span className="badge">tailorable</span> : null}
                </td>
                <td className="doc-table__actions">
                  <button type="button" onClick={() => startEdit(answer)}>
                    Edit
                  </button>
                  <button className="danger" type="button" onClick={() => remove(answer)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h3>{editingId ? 'Edit answer' : 'Add an answer'}</h3>
      <TextField
        id="canonicalQuestion"
        label="Canonical question"
        value={draft.canonicalQuestion}
        onChange={(canonicalQuestion) => patch({ canonicalQuestion })}
        placeholder="Are you legally authorized to work in the United States?"
        required
      />
      <ListInput
        id="aliases"
        label="Also matches"
        values={draft.aliases}
        onChange={(aliases) => patch({ aliases })}
        hint="Other wordings of the same question. Separate entries with commas."
      />
      <div className="grid grid--2">
        <SelectField<AnswerType>
          id="answerType"
          label="Answer type"
          value={draft.answerType}
          options={ANSWER_TYPES}
          onChange={(answerType) => patch({ answerType })}
        />
        <TextField
          id="category"
          label="Category"
          value={draft.category}
          onChange={(category) => patch({ category })}
          placeholder="eligibility, demographics, logistics"
        />
      </div>

      {draft.answerType === 'boolean' ? (
        <SelectField<'yes' | 'no'>
          id="answerBoolean"
          label="Answer"
          value={draft.answerBoolean ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          onChange={(value) => patch({ answerBoolean: value === 'yes' })}
        />
      ) : draft.answerType === 'multi_select' ? (
        <ListInput
          id="answerList"
          label="Answer"
          values={draft.answerList}
          onChange={(answerList) => patch({ answerList })}
        />
      ) : (
        <TextField
          id="answerText"
          label="Answer"
          multiline={draft.answerType === 'text'}
          type={
            draft.answerType === 'date' ? 'date' : draft.answerType === 'number' ? 'number' : 'text'
          }
          value={draft.answerText}
          onChange={(answerText) => patch({ answerText })}
        />
      )}

      <fieldset className="entry">
        <legend>Permissions</legend>
        <CheckboxField
          id="approved"
          label="Approved for use"
          checked={draft.approved}
          onChange={(approved) => patch({ approved })}
        />
        <CheckboxField
          id="autoFillAllowed"
          label="May be filled without asking me"
          checked={draft.autoFillAllowed}
          onChange={(autoFillAllowed) =>
            patch({
              autoFillAllowed,
              // A sensitive answer always keeps review on; the server rejects the
              // other combination, so the UI must not offer it.
              ...(autoFillAllowed && draft.sensitive ? { requiresReview: true } : {}),
              ...(autoFillAllowed ? { approved: true } : {}),
            })
          }
          hint="Requires the answer to be approved."
        />
        <CheckboxField
          id="sensitive"
          label="This is a sensitive question"
          checked={draft.sensitive}
          onChange={(sensitive) =>
            patch({ sensitive, ...(sensitive ? { requiresReview: true } : {}) })
          }
          hint="Race, gender, disability, veteran status, citizenship, salary, clearance, and similar."
        />
        <CheckboxField
          id="requiresReview"
          label="Always show me before filling"
          checked={draft.requiresReview}
          onChange={(requiresReview) => patch({ requiresReview })}
        />
        <CheckboxField
          id="tailoringAllowed"
          label="The model may reword this for a specific job"
          checked={draft.tailoringAllowed}
          onChange={(tailoringAllowed) => patch({ tailoringAllowed })}
        />
        {draft.sensitive ? (
          <p className="hint">
            Sensitive answers cannot be auto-filled without review. That combination is rejected by
            the server as well as here.
          </p>
        ) : null}
      </fieldset>

      <div className="options__buttons">
        <button
          className="primary"
          type="button"
          onClick={submit}
          disabled={status.kind === 'busy'}
        >
          {editingId ? 'Save answer' : 'Add answer'}
        </button>
        {editingId ? (
          <button type="button" onClick={startNew}>
            Cancel edit
          </button>
        ) : null}
      </div>

      {status.kind === 'busy' ? (
        <p className="result" role="status">
          {status.what}
        </p>
      ) : null}
      {status.kind === 'ok' ? (
        <p className="result result--ok" role="status">
          {status.message}
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <p className="result result--bad" role="alert">
          {status.error.message} {status.error.suggestedAction}
        </p>
      ) : null}
    </>
  );
}
