import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * Empty, error and loading states.
 *
 * Grouped in one module because they are three answers to the same question —
 * "there is nothing useful to show here yet" — and keeping them together is
 * what stops one of them drifting into a bare sentence with no way forward.
 *
 * The rule for all three: never state a condition without stating what to do
 * about it. An empty list that only says it is empty has told the user nothing
 * they could not already see.
 */

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** One or two sentences. What this list is for, not an apology for being empty. */
  body?: ReactNode;
  /** The way forward. Every empty state has one. */
  action?: ReactNode;
}

export function EmptyState({ icon = 'layers', title, body, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__title">
        <Icon name={icon} size={13} /> {title}
      </span>
      {body ? <p className="empty-state__body">{body}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /** One plain sentence. Never a code, never a schema dump. */
  title: string;
  /** What actually happened, in the words of someone who is not debugging it. */
  body?: ReactNode;
  /** What to do next. Omitted only when there genuinely is nothing to try. */
  action?: ReactNode;
  /** The retry, when retrying is meaningful. */
  onRetry?: () => void;
  retryLabel?: string;
  /** The technical part, folded away. Codes, stack context, raw payloads. */
  detail?: ReactNode;
}

export function ErrorState({
  title,
  body,
  action,
  onRetry,
  retryLabel = 'Try again',
  detail,
}: ErrorStateProps): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <span className="error-state__title">
        <Icon name="alert" size={13} />
        {title}
      </span>
      {body ? <p className="error-state__body">{body}</p> : null}
      {action ? <p className="error-state__action">{action}</p> : null}
      {onRetry ? (
        <div>
          <button type="button" className="btn--sm" onClick={onRetry}>
            <Icon name="refresh" size={11} />
            {retryLabel}
          </button>
        </div>
      ) : null}
      {/*
        Behind a disclosure, deliberately. A recoverable failure's underlying
        message can be a validator dump listing every accepted value, and
        putting that in front of somebody who wanted to apply for a job reads as
        "your page is unsupported" when the truth is usually far smaller.
      */}
      {detail ? (
        <details className="error-state__detail">
          <summary>Technical detail</summary>
          {typeof detail === 'string' ? <pre>{detail}</pre> : detail}
        </details>
      ) : null}
    </div>
  );
}

/**
 * A worded loading state.
 *
 * There is no generic spinner in this product. "Loading…" over a five-second
 * model call and "Loading…" over a two-hundred-millisecond storage read are the
 * same sentence describing very different waits, and the difference is the only
 * thing the user wants. Every caller passes what it is actually waiting for.
 */
export function LoadingState({
  label,
  detail,
  indeterminate = true,
}: {
  label: string;
  detail?: string;
  indeterminate?: boolean;
}): JSX.Element {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-state__label">
        <span className="spinner" aria-hidden="true" />
        {label}
      </span>
      {detail ? <span className="loading-state__detail">{detail}</span> : null}
      {indeterminate ? (
        <div className="progress-track progress-track--indeterminate" aria-hidden="true">
          <div className="progress-fill" />
        </div>
      ) : null}
    </div>
  );
}

/** Placeholder geometry while real content is on its way. */
export function Skeleton({
  rows = 3,
  variant = 'text',
}: {
  rows?: number;
  variant?: 'text' | 'row';
}): JSX.Element {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`skeleton skeleton--${variant}`}
          // The last line of a paragraph is never full width. Faking that is the
          // difference between a placeholder and a grey box.
          style={variant === 'text' && index === rows - 1 ? { width: '62%' } : undefined}
        />
      ))}
    </div>
  );
}
