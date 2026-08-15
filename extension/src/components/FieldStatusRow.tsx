import type { ReactNode } from 'react';
import { Icon } from './Icon.js';
import { FIELD_STATUS_PRESENTATION, type FieldDisplayStatus } from './fieldStatus.js';

/**
 * One control on the employer's page, and where the agent got to with it.
 *
 * The row is built so that attempted and verified cannot be confused:
 *
 *   ◌  State / Province        Selecting New Jersey…
 *   ✓✓ State / Province        New Jersey · Verified
 *
 * The first has a working glyph, a running tone, an ellipsis and no value line.
 * The second has the double tick, the verified tone, the value the page kept,
 * and the word. Nothing in the first can render as the second, because the
 * value line is only ever passed for a settled field.
 */

export interface FieldStatusRowProps {
  /** The employer's own wording for the control. Never a normalized key. */
  label: string;
  status: FieldDisplayStatus;
  /**
   * What the page now holds, for a settled field. Deliberately absent while the
   * agent is still working: printing an intended value beside a spinner is how
   * "trying" comes to look like "done".
   */
  value?: string;
  /** Why this field is where it is. One sentence, the agent's own reason. */
  reason?: string;
  section?: string;
  required?: boolean;
  /** Scrolls to and marks the control on the page. */
  onFocus?: () => void;
  children?: ReactNode;
}

export function FieldStatusRow({
  label,
  status,
  value,
  reason,
  section,
  required = false,
  onFocus,
  children,
}: FieldStatusRowProps): JSX.Element {
  const presentation = FIELD_STATUS_PRESENTATION[status];
  const settled = !presentation.active;

  return (
    <li className={`fieldrow fieldrow--${presentation.tone}`} data-status={status}>
      <span className="fieldrow__glyph" aria-hidden="true">
        <Icon
          name={presentation.icon}
          size={13}
          className={presentation.icon === 'spinner' ? 'spinner-glyph' : undefined}
        />
      </span>

      <span className="fieldrow__body">
        <span className="fieldrow__head">
          {onFocus ? (
            <button type="button" className="fieldrow__label link-button" onClick={onFocus}>
              {label || 'Unlabelled question'}
            </button>
          ) : (
            <span className="fieldrow__label">{label || 'Unlabelled question'}</span>
          )}
          {required ? <span className="fieldrow__required">Required</span> : null}
        </span>

        {section ? <span className="fieldrow__section">{section}</span> : null}

        {/*
          The value and the verification word are one unit. A value without
          "Verified" beside it would be a claim about the page that nothing
          checked, so they are printed together or not at all.
        */}
        {settled && value ? (
          <span className="fieldrow__value">
            {value}
            {status === 'VERIFIED' ? <span className="fieldrow__verified">Verified</span> : null}
          </span>
        ) : null}

        {!settled ? (
          <span className="fieldrow__activity">
            {reason ?? presentation.label}
            <span className="fieldrow__ellipsis" aria-hidden="true" />
          </span>
        ) : reason ? (
          <span className="fieldrow__reason">{reason}</span>
        ) : null}

        {children}
      </span>

      <span className="fieldrow__status">
        <span className="fieldrow__status-word">{presentation.label}</span>
        <span className="sr-only">{presentation.announcement}</span>
      </span>
    </li>
  );
}

/** A titled group of field rows — the page's own section headings. */
export function FieldStatusGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="fieldgroup">
      <h3 className="fieldgroup__title">
        {title}
        {count === undefined ? null : <span className="fieldgroup__count">{count}</span>}
      </h3>
      <ul className="fieldgroup__list">{children}</ul>
    </section>
  );
}
