import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface StatusRowProps {
  label: string;
  value: ReactNode;
  tone?: StatusTone;
  /** Extra explanation shown under the row. Used to keep failures actionable. */
  detail?: ReactNode;
}

export function StatusRow({ label, value, tone = 'idle', detail }: StatusRowProps): JSX.Element {
  return (
    // `data-row` gives tests a stable hook; matching on visible text is brittle
    // because one row's explanation can mention another row's label.
    <div className="status-row" data-row={label}>
      <div className="status-row__main">
        <span className="status-row__label">{label}</span>
        <span className={`status-row__value status-row__value--${tone}`}>
          <span aria-hidden="true" className={`dot dot--${tone}`} />
          {value}
        </span>
      </div>
      {detail ? <p className="status-row__detail">{detail}</p> : null}
    </div>
  );
}
