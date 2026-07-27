import { Field } from './Field.js';

export interface ListInputProps {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  hint?: string;
}

/**
 * Comma-separated entry for short string lists (skills, tags, target roles).
 *
 * The raw text is kept in the parent's array form rather than in local state, so
 * a trailing comma while typing does not produce a phantom empty entry on save.
 */
export function ListInput({
  id,
  label,
  values,
  onChange,
  placeholder,
  hint,
}: ListInputProps): JSX.Element {
  return (
    <Field id={id} label={label} hint={hint ?? 'Separate entries with commas.'}>
      <input
        id={id}
        type="text"
        value={values.join(', ')}
        placeholder={placeholder}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          )
        }
      />
    </Field>
  );
}

export interface LineListInputProps {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  rows?: number;
  hint?: string;
}

/** One entry per line, for longer text such as responsibilities or achievements. */
export function LineListInput({
  id,
  label,
  values,
  onChange,
  rows = 4,
  hint,
}: LineListInputProps): JSX.Element {
  return (
    <Field id={id} label={label} hint={hint ?? 'One entry per line.'}>
      <textarea
        id={id}
        rows={rows}
        value={values.join('\n')}
        onChange={(event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          )
        }
      />
    </Field>
  );
}
