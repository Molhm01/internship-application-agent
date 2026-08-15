import { useState } from 'react';
import type { AgentPendingQuestion } from '@internship-agent/shared';
import { Icon } from './Icon.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * The questions the agent stopped to ask.
 *
 * This screen carries the product's central claim, so its tone is deliberate:
 * **an unanswered question is not an error.** The agent filled everything it
 * could establish from the saved profile, reached a fact nobody had recorded,
 * and refused to invent one. That refusal is the feature. Rendering it in the
 * failure colour — which is what a generic "3 problems" banner would do — would
 * teach the user that the safest thing the agent does is a malfunction.
 *
 * So: the pending tone, a question-mark glyph, the agent's own reason for
 * asking, and a count that reads as a queue to work through rather than a
 * defect list.
 *
 * ## What answering actually does
 *
 * There is no channel that injects an answer into a loop already in flight, and
 * this component does not pretend otherwise. An answer is saved to the approved
 * answers library — the same library the pipeline searches before it asks the
 * model anything — and the agent is then run again over the page, where it
 * finds the answer waiting. The button says "Save and continue" because that is
 * what happens.
 */

export type AnswerScope = 'general' | 'company';

export interface QuestionAnswer {
  question: AgentPendingQuestion;
  value: string;
  scope: AnswerScope;
}

export interface QuestionQueueProps {
  questions: readonly AgentPendingQuestion[];
  /** The employer, for the "this employer only" scope. */
  company?: string;
  /** Saves the answers and re-runs the agent. */
  onSubmit: (answers: readonly QuestionAnswer[]) => void | Promise<void>;
  submitting?: boolean;
  /** True while the agent is mid-run, which makes continuing meaningless. */
  disabled?: boolean;
}

/** Sensitive categories the agent may never infer, matched on the question's own words. */
const SENSITIVE_HINTS = [
  'race',
  'ethnic',
  'gender',
  'disabilit',
  'veteran',
  'religio',
  'sexual orientation',
  'criminal',
  'medical',
];

/**
 * Whether a question falls in a category the agent may never infer.
 *
 * Exported because the answer the applicant gives has to be *stored* as
 * sensitive too: an answer saved without that flag would be reusable by a
 * later run without review, which is exactly the inference this refuses.
 */
export function looksSensitive(question: AgentPendingQuestion): boolean {
  const text = `${question.question} ${question.label}`.toLowerCase();
  return SENSITIVE_HINTS.some((hint) => text.includes(hint));
}

/**
 * Why the agent could not answer, in a sentence the applicant can act on.
 *
 * Derived from the outcome the loop recorded rather than written per question,
 * so a new outcome cannot silently arrive with no explanation attached.
 */
function reasonFor(question: AgentPendingQuestion): string {
  if (looksSensitive(question)) {
    return 'This is a sensitive question. The agent never infers these — only an answer you have explicitly given may be used.';
  }
  switch (question.outcome) {
    case 'BLOCKED_EXECUTION':
      return 'The agent holds an answer for this one and the page would not accept it.';
    case 'BLOCKED_DATA_MISSING':
      return 'Your saved profile does not hold this fact, and the agent will not guess at one.';
    case 'USER_REVIEW_REQUIRED':
      return 'The agent answered this one and wants you to confirm it before you submit.';
    default:
      return 'Your saved profile does not hold this fact, and the agent will not guess at one.';
  }
}

/** Yes/no questions get buttons; everything else gets a text box. */
function isYesNo(question: AgentPendingQuestion): boolean {
  const text = question.question.toLowerCase();
  return (
    text.startsWith('are you') ||
    text.startsWith('do you') ||
    text.startsWith('have you') ||
    text.startsWith('will you') ||
    text.startsWith('is ') ||
    text.includes('yes or no')
  );
}

function QuestionCard({
  question,
  index,
  total,
  value,
  scope,
  company,
  onValue,
  onScope,
}: {
  question: AgentPendingQuestion;
  index: number;
  total: number;
  value: string;
  scope: AnswerScope;
  company?: string;
  onValue: (next: string) => void;
  onScope: (next: AnswerScope) => void;
}): JSX.Element {
  const sensitive = looksSensitive(question);
  const inputId = `question-${index}`;

  return (
    <article
      className={`question-card${sensitive ? ' question-card--sensitive' : ''} reveal`}
      aria-labelledby={`${inputId}-label`}
    >
      <header className="question-card__head">
        <span className="question-card__counter">
          {index + 1} of {total}
        </span>
        {question.section ? (
          <span className="question-card__section">{question.section}</span>
        ) : null}
        {sensitive ? (
          <StatusBadge
            tone="sensitive"
            label="Sensitive"
            icon="lock"
            announcement="Sensitive question. The agent never infers these."
          />
        ) : (
          <StatusBadge tone="pending" label="Needs you" icon="question" />
        )}
      </header>

      {/* The employer's own wording, verbatim. Rephrasing an application
          question would change what the applicant is agreeing to. */}
      <h3 className="question-card__question" id={`${inputId}-label`}>
        {question.question || question.label}
      </h3>

      <p className="question-card__reason">{reasonFor(question)}</p>

      {sensitive ? (
        <p className="question-card__privacy">
          <Icon name="shield" size={12} />
          Stored on this machine only, and never included in a diagnostic export.
        </p>
      ) : null}

      <div className="question-card__answer">
        {isYesNo(question) ? (
          <div className="question-card__choices" role="group" aria-labelledby={`${inputId}-label`}>
            {['No', 'Yes'].map((choice) => (
              <button
                key={choice}
                type="button"
                className={value === choice ? 'question-card__choice--picked' : ''}
                aria-pressed={value === choice}
                onClick={() => onValue(value === choice ? '' : choice)}
              >
                {choice}
              </button>
            ))}
            {sensitive ? (
              <button
                type="button"
                className={value === 'Prefer not to answer' ? 'question-card__choice--picked' : ''}
                aria-pressed={value === 'Prefer not to answer'}
                onClick={() =>
                  onValue(value === 'Prefer not to answer' ? '' : 'Prefer not to answer')
                }
              >
                Prefer not to answer
              </button>
            ) : null}
          </div>
        ) : (
          <div className="field">
            <label htmlFor={inputId}>Your answer</label>
            <input
              id={inputId}
              type="text"
              value={value}
              placeholder="Type the answer this employer should receive"
              onChange={(event) => onValue(event.target.value)}
            />
          </div>
        )}
      </div>

      <div className="question-card__scope">
        <span className="eyebrow">Use this answer for</span>
        <div className="question-card__scope-choices" role="group" aria-label="Answer scope">
          <label>
            <input
              type="radio"
              name={`${inputId}-scope`}
              checked={scope === 'general'}
              onChange={() => onScope('general')}
            />
            All future applications
          </label>
          <label>
            <input
              type="radio"
              name={`${inputId}-scope`}
              checked={scope === 'company'}
              onChange={() => onScope('company')}
            />
            {company ? `${company} only` : 'This employer only'}
          </label>
        </div>
      </div>
    </article>
  );
}

export function QuestionQueue({
  questions,
  company,
  onSubmit,
  submitting = false,
  disabled = false,
}: QuestionQueueProps): JSX.Element | null {
  const outstanding = questions.filter((question) => !question.answeredAt);
  const [values, setValues] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<Record<string, AnswerScope>>({});

  if (outstanding.length === 0) return null;

  const answered = outstanding.filter((question) => (values[question.logicalKey] ?? '').trim());

  return (
    <section className="question-queue" aria-labelledby="question-queue-title">
      <header className="question-queue__head">
        <div>
          <h2 id="question-queue-title">The agent needs your input</h2>
          {/*
            The framing sentence. It says what happened in the order it
            happened: the agent succeeded first, and then reached its limit.
          */}
          <p className="question-queue__lede">
            Everything the agent could establish from your saved profile is done.{' '}
            {outstanding.length === 1
              ? 'One question needs a fact it does not hold.'
              : `${outstanding.length} questions need facts it does not hold.`}
          </p>
        </div>
        <span className="question-queue__count" aria-hidden="true">
          {answered.length}/{outstanding.length}
        </span>
      </header>

      <div className="question-queue__list">
        {outstanding.map((question, index) => (
          <QuestionCard
            key={question.logicalKey}
            question={question}
            index={index}
            total={outstanding.length}
            value={values[question.logicalKey] ?? ''}
            scope={scopes[question.logicalKey] ?? 'general'}
            {...(company ? { company } : {})}
            onValue={(next) =>
              setValues((current) => ({ ...current, [question.logicalKey]: next }))
            }
            onScope={(next) =>
              setScopes((current) => ({ ...current, [question.logicalKey]: next }))
            }
          />
        ))}
      </div>

      <footer className="question-queue__foot">
        <p className="muted">
          Your answers are saved to your approved answers library, then the agent runs again over
          this page and picks them up.
        </p>
        <button
          type="button"
          className="primary btn--lg"
          disabled={disabled || submitting || answered.length === 0}
          onClick={() => {
            void onSubmit(
              answered.map((question) => ({
                question,
                value: (values[question.logicalKey] ?? '').trim(),
                scope: scopes[question.logicalKey] ?? 'general',
              })),
            );
          }}
        >
          {submitting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Saving your answers…
            </>
          ) : (
            <>
              Save {answered.length === 1 ? 'answer' : `${answered.length} answers`} and continue
              <Icon name="chevron-right" size={13} />
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
