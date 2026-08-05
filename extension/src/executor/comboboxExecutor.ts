import {
  matchLocationOption,
  matchOption,
  normalizeOptionText,
  type DetectedField,
  type DiscoveredOption,
  type DiscoveredOptionSet,
  type ErrorCode,
  type FieldOption,
  type LocationTarget,
} from '@internship-agent/shared';
import {
  closeControl,
  discoverLiveOptions,
  findListbox,
  isVisible,
  openControl,
  readOptions,
  resolveTrigger,
  selectableOptions,
  waitFor,
} from '../scanner/optionDiscovery.js';

/**
 * Deterministic driver for custom (non-`<select>`) comboboxes — the pattern
 * Greenhouse, Lever, and Ashby use for country, location, and demographic
 * questions.
 *
 * Everything here is browser code. The model never supplies a selector, an
 * index, or a command; it supplies a value, and this module decides whether an
 * option the page actually rendered corresponds to it.
 *
 * Selection is never by position. An option is found by matching its own label
 * against the intended answer, so a list that reorders between discovery and
 * selection cannot cause the wrong choice.
 */

// Re-exported so callers and tests have one place to reach the DOM primitives.
export { findListbox, readOptions, resolveTrigger } from '../scanner/optionDiscovery.js';

export interface ComboboxOutcome {
  ok: boolean;
  /** Text the control displayed after selection, read back from the DOM. */
  observedValue?: string;
  matchedLabel?: string;
  /** Every label selected, for a control that accepts more than one. */
  matchedLabels?: string[];
  reason: string;
  /** Names the stage that failed, so the report can be specific. */
  code?: ErrorCode;
  /** Options actually discovered on the page, for honest reporting. */
  discoveredOptions: DiscoveredOption[];
}

const RERENDER_WAIT_MS = 1500;

/** Text the control shows after selection, for verification. */
export function readDisplayedValue(root: HTMLElement, trigger: HTMLElement): string {
  if (trigger instanceof HTMLInputElement && trigger.value) return trigger.value.trim();

  const activeDescendant = trigger.getAttribute('aria-activedescendant');
  if (activeDescendant) {
    const selected = document.getElementById(activeDescendant);
    if (selected?.textContent) return selected.textContent.replace(/\s+/g, ' ').trim();
  }

  const chosen = root.querySelector<HTMLElement>('[aria-selected="true"], [data-selected="true"]');
  if (chosen?.textContent) return chosen.textContent.replace(/\s+/g, ' ').trim();

  const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (hidden?.value) return hidden.value.trim();

  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export interface SelectComboboxInput {
  /** The scanned element, re-queried by the caller immediately before this runs. */
  root: HTMLElement;
  /** The exact value the plan proposed. Never a pattern, never an index. */
  proposedValue: string;
  /** Label of the option the plan matched, when it had one. */
  matchedLabel?: string;
  allowRegionSuffix?: boolean;
  /**
   * Saved city, state, and country for a location control. When present, the
   * option is chosen on all three together rather than on the city alone.
   */
  locationTarget?: LocationTarget | undefined;
  /** What to type into a searchable control. Derived only from saved values. */
  searchText?: string | undefined;
  /** The scanned field, so discovery can classify the control correctly. */
  field?: DetectedField | undefined;
  /** Every value to select on a control that accepts more than one. */
  multipleValues?: readonly string[] | undefined;
}

function asFieldOptions(options: readonly DiscoveredOption[]): FieldOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.disabled ? { disabled: true } : {}),
    ...(option.selected ? { selected: true } : {}),
  }));
}

interface Choice {
  option?: FieldOption;
  reason: string;
  code?: ErrorCode;
}

/**
 * Picks the one option that the saved answer supports, from the options the
 * page actually rendered. Location controls are matched on city, state, and
 * country together; everything else on a literal or documented alias.
 */
function chooseOption(
  input: Pick<SelectComboboxInput, 'proposedValue' | 'locationTarget' | 'allowRegionSuffix'>,
  discovered: readonly FieldOption[],
): Choice {
  if (input.locationTarget?.city) {
    const located = matchLocationOption(input.locationTarget, discovered);
    if (located.matched && located.option) {
      return { option: located.option, reason: located.reason };
    }
    return {
      reason: located.reason,
      code: located.ambiguous ? 'LOCATION_AMBIGUOUS' : 'LOCATION_NOT_FOUND',
    };
  }
  const match = matchOption(input.proposedValue, discovered, {
    allowRegionSuffix: input.allowRegionSuffix ?? false,
  });
  if (match.matched && match.option) return { option: match.option, reason: match.reason };
  return {
    reason: match.reason,
    code: match.ambiguous ? 'AMBIGUOUS_OPTION_MATCH' : 'NO_OPTION_MATCH',
  };
}

/** Finds the live element for a matched option by its own label, never by index. */
function optionElementFor(listbox: HTMLElement, label: string): HTMLElement | undefined {
  const wanted = normalizeOptionText(label);
  return Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (element) => normalizeOptionText((element.textContent ?? '').trim()) === wanted,
  );
}

function activate(target: HTMLElement): void {
  // Scrolling is a convenience for virtualized lists; its absence must never
  // abort a selection that is otherwise valid.
  target.scrollIntoView?.({ block: 'nearest' });
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  target.click();
}

/**
 * Opens the combobox, reads the options actually on the page, matches the
 * proposed value against them, selects the one exact hit, and verifies what the
 * control displays afterwards.
 *
 * Refuses to act on an ambiguous or absent match rather than picking by index or
 * partial text, and reports the stage it stopped at.
 */
export async function selectComboboxOption(input: SelectComboboxInput): Promise<ComboboxOutcome> {
  const { root } = input;

  if (!isVisible(root)) {
    return {
      ok: false,
      code: 'CONTROL_NOT_VISIBLE',
      reason: 'The combobox is not visible on the page.',
      discoveredOptions: [],
    };
  }
  if (root.getAttribute('aria-disabled') === 'true' || root.matches(':disabled')) {
    return {
      ok: false,
      code: 'CONTROL_DISABLED',
      reason: 'The combobox is disabled.',
      discoveredOptions: [],
    };
  }

  const trigger = resolveTrigger(root);
  // Search text is a saved value, never a pattern: a city the profile states,
  // the text the planner prepared, the label of the option that was matched,
  // or — last — the proposed answer itself.
  //
  // `matchedLabel` sits ahead of `proposedValue` because a resolved option
  // carries the page's *value*, which is routinely a machine code: a Country
  // control whose "United States of America" option has `value="US"` was being
  // sent the string "US" as its search query. No label contains it, the
  // searchable list filtered itself down to nothing, and the run left "US"
  // typed in the box with the menu open and no country chosen — which is
  // exactly what "Country is not selected" looked like on the live site.
  const searchText =
    input.locationTarget?.city ?? input.searchText ?? input.matchedLabel ?? input.proposedValue;

  const field = input.field;
  let discovered: DiscoveredOptionSet | null = null;
  if (field) {
    discovered = await discoverLiveOptions(field, root, { searchText, keepOpen: true });
  } else {
    // Without a scanned field there is nothing to classify the control by, so
    // open it directly and read whatever it reveals.
    await openControl(trigger, searchText);
  }

  let listbox = findListbox(trigger);
  if (!listbox) {
    return {
      ok: false,
      code: 'LISTBOX_NOT_FOUND',
      reason: 'The option list did not open, so no options could be read.',
      discoveredOptions: discovered ? discovered.options : [],
    };
  }

  let live = discovered ? selectableOptions(discovered) : readOptions(listbox);
  if (live.length === 0) {
    closeControl(trigger);
    return {
      ok: false,
      code: 'OPTIONS_NOT_DISCOVERED',
      reason: 'The option list opened but contained no selectable options.',
      discoveredOptions: discovered?.options ?? [],
    };
  }

  // A filtered list may hide the wanted entry behind the query already typed.
  if (
    chooseOption(input, asFieldOptions(live)).option === undefined &&
    trigger instanceof HTMLInputElement
  ) {
    const refreshed = findListbox(trigger);
    if (refreshed) {
      listbox = refreshed;
      const reread = readOptions(refreshed);
      if (reread.length > 0) live = reread.filter((option) => !option.disabled);
    }
  }

  const wanted = input.multipleValues?.length ? [...input.multipleValues] : [input.proposedValue];
  const selectedLabels: string[] = [];

  for (const value of wanted) {
    const choice = chooseOption(
      {
        proposedValue: value,
        ...(input.locationTarget ? { locationTarget: input.locationTarget } : {}),
        ...(input.allowRegionSuffix === undefined
          ? {}
          : { allowRegionSuffix: input.allowRegionSuffix }),
      },
      asFieldOptions(live),
    );
    if (!choice.option) {
      closeControl(trigger);
      return {
        ok: false,
        ...(choice.code ? { code: choice.code } : {}),
        reason: choice.reason,
        discoveredOptions: live,
      };
    }

    const target = optionElementFor(listbox, choice.option.label);
    if (!target) {
      closeControl(trigger);
      return {
        ok: false,
        code: 'OPTION_NOT_SELECTABLE',
        reason: `The matched option "${choice.option.label}" was no longer in the list.`,
        discoveredOptions: live,
      };
    }

    activate(target);
    selectedLabels.push(choice.option.label);

    // A multi-select usually keeps its list open; reopen it if it closed, so the
    // next value is matched against a live list rather than a stale reference.
    if (wanted.length > 1) {
      const stillOpen = findListbox(trigger);
      if (!stillOpen) break;
      listbox = stillOpen;
    }
  }

  const firstLabel = selectedLabels[0] ?? input.proposedValue;
  const expected = selectedLabels.map(normalizeOptionText);

  // Wait for the control to show the choice rather than for a fixed interval: a
  // fast page proceeds immediately, a slow one still gets its full budget.
  const observed =
    (await waitFor(() => {
      if (!root.isConnected) return null;
      const text = readDisplayedValue(root, resolveTrigger(root));
      const normalized = normalizeOptionText(text);
      return expected.every((label) => normalized.includes(label)) ? text : null;
    }, RERENDER_WAIT_MS)) ??
    (root.isConnected ? readDisplayedValue(root, resolveTrigger(root)) : null);

  if (observed === null) {
    return {
      ok: false,
      code: 'CONTROL_NOT_FOUND',
      reason: 'The combobox was removed from the page after selection.',
      discoveredOptions: live,
    };
  }

  closeControl(resolveTrigger(root));

  const normalizedObserved = normalizeOptionText(observed);
  const verified = expected.every((label) => normalizedObserved.includes(label));
  return {
    ok: verified,
    observedValue: observed,
    matchedLabel: firstLabel,
    matchedLabels: selectedLabels,
    ...(verified
      ? {}
      : {
          // The click landed but the page did not keep it. That is a different
          // failure from never having matched, and worth saying so.
          code:
            normalizedObserved.length === 0
              ? ('OPTION_SELECTION_REVERTED' as const)
              : ('OPTION_VALUE_NOT_VERIFIED' as const),
        }),
    reason: verified
      ? `Selected ${selectedLabels.map((label) => `"${label}"`).join(', ')} and the control now displays it.`
      : `Clicked "${firstLabel}" but the control displays "${observed}".`,
    discoveredOptions: live,
  };
}
