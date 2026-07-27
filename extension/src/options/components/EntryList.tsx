import type { ReactNode } from 'react';

export interface EntryListProps<T extends { id: string }> {
  entries: T[];
  onChange: (entries: T[]) => void;
  /** Builds a blank entry. Must produce a unique id. */
  createEntry: () => T;
  addLabel: string;
  emptyMessage: string;
  /** Heading shown on the entry's card, e.g. the school name. */
  titleOf: (entry: T, index: number) => string;
  children: (entry: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
}

/**
 * Add/remove wrapper for a repeated profile section. Deliberately has no
 * "example" or prefilled entry: an empty section means the user has told us
 * nothing, and inventing a placeholder would be fabricating profile data.
 */
export function EntryList<T extends { id: string }>({
  entries,
  onChange,
  createEntry,
  addLabel,
  emptyMessage,
  titleOf,
  children,
}: EntryListProps<T>): JSX.Element {
  const update = (index: number, patch: Partial<T>): void => {
    onChange(
      entries.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    );
  };

  const remove = (index: number): void => {
    onChange(entries.filter((_entry, position) => position !== index));
  };

  return (
    <div className="entry-list">
      {entries.length === 0 ? <p className="entry-list__empty">{emptyMessage}</p> : null}

      {entries.map((entry, index) => (
        <fieldset className="entry" key={entry.id}>
          <legend>{titleOf(entry, index) || `Entry ${index + 1}`}</legend>
          {children(entry, (patch) => update(index, patch), index)}
          <button className="danger" type="button" onClick={() => remove(index)}>
            Remove
          </button>
        </fieldset>
      ))}

      <button type="button" onClick={() => onChange([...entries, createEntry()])}>
        {addLabel}
      </button>
    </div>
  );
}
