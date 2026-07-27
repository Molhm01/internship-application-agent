import type { ReactNode } from 'react';

export interface FieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}

/** Label, control, hint, and inline error — the only field wrapper in the UI. */
export function Field({ id, label, hint, error, required, children }: FieldProps): JSX.Element {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="field__required"> (required)</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'tel' | 'url' | 'date' | 'number' | 'password';
  placeholder?: string;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  /** Multi-line answers (project descriptions, responsibilities). */
  multiline?: boolean;
  rows?: number;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  error,
  required,
  multiline,
  rows = 3,
}: TextFieldProps): JSX.Element {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

export interface SelectFieldProps<T extends string> {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: ReactNode;
  error?: string | undefined;
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  error,
}: SelectFieldProps<T>): JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface TriStateFieldProps {
  id: string;
  label: string;
  /** `undefined` means the user has not answered — never coerced to false. */
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  hint?: ReactNode;
}

/**
 * A yes/no question the user may legitimately not have answered. Collapsing
 * "unanswered" into "no" would fabricate an answer, so the unset state is
 * explicit and selectable.
 */
export function TriStateField({
  id,
  label,
  value,
  onChange,
  hint,
}: TriStateFieldProps): JSX.Element {
  const current = value === undefined ? 'unset' : value ? 'yes' : 'no';
  return (
    <Field id={id} label={label} hint={hint}>
      <select
        id={id}
        value={current}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === 'unset' ? undefined : next === 'yes');
        }}
      >
        <option value="unset">Not answered</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </Field>
  );
}

export interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
  hint,
}: CheckboxFieldProps): JSX.Element {
  return (
    <div className="field field--inline">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
