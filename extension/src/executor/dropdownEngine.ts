import {
  dropdownExecutionResultSchema,
  matchDropdownOption,
  normalizeOptionText,
  realChoices,
  type DropdownExecutionResult,
  type DropdownFailureCode,
  type DropdownKind,
  type DropdownMatchMethod,
  type FieldOption,
  type LocationTarget,
} from '@internship-agent/shared';
import {
  closeControl,
  findListbox,
  isVisible,
  enumerateAllOptions,
  openControl,
  OPTION_ITEM_SELECTOR,
  pressPointer,
  readOptions,
  resolveTrigger,
  revealOption,
  typeSearch,
  waitFor,
} from '../scanner/optionDiscovery.js';

/**
 * One engine for every dropdown on every page.
 *
 * ## Why this exists
 *
 * There used to be two option paths. A custom combobox went through
 * `comboboxExecutor`, which opened the control and read the choices it was
 * *currently* offering. Everything the scanner called a `<select>` went through
 * `applyValue`, which matched against the option snapshot the **scanner** took —
 * and then asserted that snapshot's `value` still existed. Any control whose
 * choices changed between the scan and the fill therefore failed: a State list
 * the page rebuilds after Country is chosen, an Education Country list populated
 * by script after load, a School list that only exists once the control is
 * opened. All three reported "Autofill failed" over a page that was working
 * correctly, and the answer had been known the whole time.
 *
 * So: options are read from the live control at the moment of the attempt,
 * always, for every widget shape. The scan snapshot is a hint for planning and
 * is never the thing selection is matched against.
 *
 * ## What this is not
 *
 * It is not an answer resolver. It receives `desiredSemanticValue` — a fact
 * somebody else established — and its only judgement is which of the options the
 * page rendered corresponds to it. It cannot decide a personal fact, and a
 * question with no known answer never reaches it: that is `ANSWER_UNKNOWN`, and
 * the caller reports it as the user's to answer rather than as a failure.
 *
 * Nothing here accepts a selector, a script, or an index from anywhere outside
 * the browser. The model supplies a value; the DOM supplies the elements.
 */

/** Custom widgets get a second attempt; the whole engine is bounded by this. */
const VERIFY_WAIT_MS = 1500;
const SETTLE_WAIT_MS = 750;

export interface DropdownExecutionInput {
  /** The scanned field's id, for the result record only. */
  fieldId: string;
  /** The control, re-queried by the caller immediately before this runs. */
  root: HTMLElement;
  /** The answer to select. Never a pattern, never a position. */
  desiredSemanticValue: string;
  /**
   * Other wordings of the *same saved record*, tried in order after the first.
   *
   * Not synonyms and not guesses: a restatement of one fact for a form that
   * asks for it in a different taxonomy. An education record supplies its
   * degree ("Bachelor's Degree") and the kind of institution that implies
   * ("College/University"), because one employer's "Education Type" list names
   * programmes and the next one's names places.
   */
  alternativeValues?: readonly string[] | undefined;
  /** The canonical intent, so place-like questions may match a region suffix. */
  canonicalQuestion?: string | undefined;
  /** What to type into a searchable control. Derived only from saved values. */
  searchText?: string | undefined;
  /** Permits choosing the form's own "Other" entry. Off unless asked for. */
  allowOtherFallback?: boolean | undefined;
  /**
   * Saved city, state, and country for a location control, so the engine
   * rejects the same wrong regions the planner would have rejected.
   */
  locationTarget?: LocationTarget | undefined;
  /** The scanner's field type, used only as a classification hint. */
  fieldTypeHint?: string | undefined;
  /**
   * True when this control's choices are produced by another field. Changes
   * only how an empty list is *reported*, never how it is driven.
   */
  dependsOnAnotherField?: boolean | undefined;
}

/**
 * Decides what the control actually is.
 *
 * From the element, not from what it calls itself: a `role="combobox"` on an
 * `<input>` is filtered by typing and a `role="combobox"` on a `<div>` is
 * clicked, and driving one like the other leaves a query in a box with nothing
 * selected.
 */
export function classifyDropdown(root: HTMLElement): DropdownKind {
  if (root instanceof HTMLSelectElement) {
    return root.multiple ? 'native_multi_select' : 'native_select';
  }
  if (root instanceof HTMLInputElement) {
    if (root.type === 'radio') return 'radio_group';
    if (root.type === 'checkbox') return 'checkbox_group';
  }

  const trigger = resolveTrigger(root);
  if (trigger instanceof HTMLSelectElement) {
    return trigger.multiple ? 'native_multi_select' : 'native_select';
  }
  if (trigger instanceof HTMLInputElement && trigger.type !== 'hidden') {
    const autocomplete = trigger.getAttribute('aria-autocomplete');
    if (autocomplete === 'list' || autocomplete === 'both') return 'searchable_combobox';
    if (trigger.getAttribute('role') === 'combobox') return 'searchable_combobox';
  }
  if (trigger.getAttribute('role') === 'combobox' || root.getAttribute('role') === 'combobox') {
    return 'aria_combobox';
  }
  const haspopup =
    trigger.getAttribute('aria-haspopup') ?? root.getAttribute('aria-haspopup') ?? null;
  if (haspopup === 'menu' || haspopup === 'true' || haspopup === 'listbox') {
    return haspopup === 'menu' ? 'button_menu' : 'aria_combobox';
  }
  if (root.getAttribute('role') === 'listbox') return 'listbox';
  if (trigger instanceof HTMLButtonElement) return 'button_menu';
  return 'unknown';
}

/**
 * Matches the desired answer, then each documented alternative in turn.
 *
 * One question can be worded as two different taxonomies by two different
 * employers, and only the page can say which it is using. "Education Type" is
 * the case that forced this: one form lists *institutions* (High School,
 * College/University, Trade School) and the next lists *degree programs*
 * (Associate, Bachelor's Degree Program (or equivalent), Master's). A single
 * proposed value answers one of them and matches nothing at all on the other —
 * which is exactly what left the live control at "No Selection" while the right
 * option sat in the open menu.
 *
 * So the resolver supplies both readings of the same saved record, most
 * specific first, and the *page's own list* decides which one it is asking for.
 * Nothing is invented: every candidate is a restatement of the same record, and
 * the first that matches an offered option wins.
 */
function matchWithAlternatives(
  input: DropdownExecutionInput,
  options: readonly FieldOption[],
): ReturnType<typeof matchDropdownOption> {
  const candidates = [input.desiredSemanticValue, ...(input.alternativeValues ?? [])].filter(
    (value) => value.trim().length > 0,
  );
  let firstOutcome: ReturnType<typeof matchDropdownOption> | null = null;
  for (const candidate of candidates) {
    const outcome = matchDropdownOption({
      desiredSemanticValue: candidate,
      options,
      canonicalQuestion: input.canonicalQuestion,
      // The "Other" escape hatch is tried only after every real reading of the
      // record has failed, so a form that does list the answer is never sent to
      // Other because the first wording missed.
      allowOtherFallback: false,
      locationTarget: input.locationTarget,
    });
    if (outcome.option) return outcome;
    firstOutcome ??= outcome;
    // An ambiguous list is a decision for the user, not a reason to try another
    // wording and pick something else.
    if (outcome.ambiguous) return outcome;
  }
  if (input.allowOtherFallback) {
    const withOther = matchDropdownOption({
      desiredSemanticValue: input.desiredSemanticValue,
      options,
      canonicalQuestion: input.canonicalQuestion,
      allowOtherFallback: true,
      locationTarget: input.locationTarget,
    });
    if (withOther.option) return withOther;
  }
  return (
    firstOutcome ?? {
      method: 'none' as const,
      ambiguous: false,
      reason: 'No value was proposed for this control.',
    }
  );
}

/** Native options, read from the control as it stands now. */
function liveNativeOptions(select: HTMLSelectElement): FieldOption[] {
  return Array.from(select.options).map((option) => ({
    label: (option.textContent ?? option.label ?? '').replace(/\s+/g, ' ').trim(),
    value: option.value,
    ...(option.disabled || (option.parentElement as HTMLOptGroupElement | null)?.disabled
      ? { disabled: true }
      : {}),
    ...(option.selected ? { selected: true } : {}),
  }));
}

function asFieldOptions(
  options: readonly { label: string; value: string; disabled: boolean; selected: boolean }[],
): FieldOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.disabled ? { disabled: true } : {}),
    ...(option.selected ? { selected: true } : {}),
  }));
}

/** A verified selection, with the evidence that verified it. */
interface Selected {
  ok: true;
  method: DropdownMatchMethod;
  label: string;
  observed: string;
  optionCount: number;
}

/** An attempt that stopped, and the stage it stopped at. */
interface Stopped {
  code: DropdownFailureCode;
  reason: string;
  optionCount?: number;
  executionAttempted?: boolean;
  matchMethod?: DropdownMatchMethod;
  matchedOptionText?: string;
  observedValue?: string;
}

/** What the control displays now, for verification. */
export function readSelectedText(root: HTMLElement): string {
  if (root instanceof HTMLSelectElement) {
    const selected = root.selectedOptions[0];
    return (selected?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  const trigger = resolveTrigger(root);
  if (trigger instanceof HTMLInputElement && trigger.value) return trigger.value.trim();

  const active = trigger.getAttribute('aria-activedescendant');
  if (active) {
    const option = root.ownerDocument.getElementById(active);
    if (option?.textContent) return option.textContent.replace(/\s+/g, ' ').trim();
  }
  // The trigger's own rendered text, before the whole container's: a container
  // holding an open menu reads as every option concatenated, which "contains"
  // the wanted label whatever was chosen, and that is a verification that
  // cannot fail — the most dangerous kind.
  const display = root.querySelector<HTMLElement>(
    '[data-selected-label],[class*="singleValue"],[class*="single-value"]',
  );
  if (display?.textContent) return display.textContent.replace(/\s+/g, ' ').trim();

  const chosen = root.querySelector<HTMLElement>('[aria-selected="true"],[data-selected="true"]');
  if (chosen?.textContent) return chosen.textContent.replace(/\s+/g, ' ').trim();

  const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (hidden?.value) return hidden.value.trim();

  if (findListbox(trigger) === null) {
    return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  // The menu is still open, so the container's text is the menu's. Report the
  // trigger's own text instead of a list of everything on offer.
  return (trigger.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Finds the live element for a matched option by its own label, never by index. */
function optionElementFor(container: HTMLElement, option: FieldOption): HTMLElement | undefined {
  const wanted = normalizeOptionText(option.label);
  const items = Array.from(container.querySelectorAll<HTMLElement>(OPTION_ITEM_SELECTOR));
  return (
    items.find((element) => element.getAttribute('data-value') === option.value && option.value) ??
    items.find((element) => normalizeOptionText(element.textContent ?? '') === wanted)
  );
}

function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (!descriptor?.set) throw new Error('Native value setter is unavailable.');
  descriptor.set.call(select, value);
}

/**
 * Drives a `<select>`.
 *
 * The options are re-read here rather than taken from the plan, which is the
 * whole repair: a State control the page rebuilt after Country was chosen holds
 * a completely different option list from the one the scan recorded, and the
 * old list's `value` no longer exists.
 *
 * Synchronous throughout, and that is the point: a `<select>` has its choices in
 * the DOM already, there is nothing to open and nothing to wait for, and the
 * whole path is the sub-millisecond one. The caller awaits it alongside the
 * custom path so the two have one shape.
 */
function executeNativeSelect(
  select: HTMLSelectElement,
  input: DropdownExecutionInput,
): Stopped | Selected {
  if (select.disabled) {
    return { code: 'CONTROL_DISABLED', reason: 'The control is disabled.' };
  }
  const live = liveNativeOptions(select);
  const choices = realChoices(live);
  if (choices.length === 0) {
    return {
      code: input.dependsOnAnotherField ? 'DEPENDENT_CONTROL_NOT_REFRESHED' : 'NO_OPTIONS_FOUND',
      reason: input.dependsOnAnotherField
        ? 'The control still offers nothing but a prompt, so the field it depends on has not populated it yet.'
        : 'The control offers no selectable choices.',
      optionCount: live.length,
    };
  }

  const match = matchWithAlternatives(input, live);
  if (!match.option) {
    return {
      code: match.ambiguous
        ? 'AMBIGUOUS_OPTION_MATCH'
        : match.method === 'semantic'
          ? 'NO_SEMANTIC_OPTION_MATCH'
          : 'OPTION_NOT_FOUND',
      reason: match.reason,
      optionCount: choices.length,
    };
  }

  const target = Array.from(select.options).find(
    (option) => option.value === match.option?.value && !option.disabled,
  );
  if (!target) {
    return {
      code: 'OPTION_DISABLED',
      reason: `"${match.option.label}" is on the list and cannot be chosen.`,
      optionCount: choices.length,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
    };
  }

  // Already correct is a success, not a rewrite. Selecting a country that is
  // already selected fires `change`, and a page that rebuilds its region list on
  // that event throws away the state chosen moments earlier.
  if (select.value !== target.value) {
    select.focus();
    setNativeSelectValue(select, target.value);
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    select.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: true }));
  }

  // Verified against the control's own state, not against the fact that a
  // setter ran without throwing.
  const accepted =
    select.value === target.value &&
    select.selectedIndex === target.index &&
    select.selectedOptions[0] === target;
  if (!accepted) {
    return {
      code: 'SELECTION_NOT_ACCEPTED',
      reason: `The control was set to "${match.option.label}" and reports "${readSelectedText(select)}".`,
      optionCount: choices.length,
      executionAttempted: true,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
      observedValue: readSelectedText(select),
    };
  }
  return {
    ok: true,
    method: match.method,
    label: match.option.label,
    observed: readSelectedText(select),
    optionCount: choices.length,
  };
}

/**
 * Drives everything that is not a `<select>`: ARIA comboboxes, button menus,
 * searchable comboboxes, portal-rendered menus, and lazily-populated lists.
 *
 * The order is fixed and each step is observed rather than assumed: open, wait
 * for the list to hold entries, enumerate *those* entries, match, click the real
 * element, wait for the control to show it, close.
 */
async function executeCustomDropdown(
  root: HTMLElement,
  input: DropdownExecutionInput,
): Promise<Stopped | Selected> {
  const trigger = resolveTrigger(root);
  if (root.getAttribute('aria-disabled') === 'true' || trigger.matches(':disabled')) {
    return { code: 'CONTROL_DISABLED', reason: 'The control is disabled.' };
  }

  // A searchable control is filtered by what is typed into it, so the query has
  // to be text a *label* could contain. The matched label first and the answer
  // second — never an option `value`, which is routinely a machine code: a
  // Country control whose "United States of America" entry has `value="US"` was
  // sent "US" as its query, filtered itself down to nothing, and left the box
  // holding "US" with no country chosen.
  const searchText = input.searchText ?? input.desiredSemanticValue;

  const container = await openControl(trigger, searchText);
  if (!container) {
    return {
      code: 'OPEN_FAILED',
      reason: 'The control did not open for a click, a keypress, or typing.',
    };
  }

  // The *complete* list, not the part of it that happens to be on screen.
  //
  // A long country or field-of-study menu is either scrollable — every option
  // is in the DOM, most of them outside the visible box — or virtualized, where
  // only the visible rows exist as elements at all. Reading what was rendered at
  // the moment the menu opened reported `OPTION_NOT_FOUND` for "Electrical
  // Engineering" because it sat below the fold, and the field then fell through
  // to the "Other" box with the answer in hand.
  let live = await enumerateAllOptions(container);
  if (live.length === 0) {
    // A menu that mounts empty and fills asynchronously. Waited for once, then
    // reported honestly — never guessed at.
    const filled = await waitFor(() => {
      const current = findListbox(trigger) ?? container;
      return readOptions(current).length > 0 ? current : null;
    }, SETTLE_WAIT_MS);
    if (filled) live = await enumerateAllOptions(filled);
  }
  if (live.length === 0) {
    closeControl(trigger);
    return {
      code: input.dependsOnAnotherField ? 'DEPENDENT_CONTROL_NOT_REFRESHED' : 'NO_OPTIONS_FOUND',
      reason: input.dependsOnAnotherField
        ? 'The list opened empty, so the field it depends on has not populated it yet.'
        : 'The list opened and contained no choices.',
      optionCount: 0,
    };
  }

  let offered = asFieldOptions(live);
  let match = matchWithAlternatives(input, offered);

  // A searchable control that did not offer the answer is asked for it.
  //
  // Some lists never render everything, however far they are scrolled: they
  // fetch on a query and show a truncated set until they get one. Typing is the
  // only way to reach the rest, and it is done only when the control declares
  // itself searchable — typing into a control that is not leaves a query in a
  // box and nothing selected, which is its own live failure.
  if (!match.option && !match.ambiguous && trigger instanceof HTMLInputElement) {
    for (const candidate of [input.desiredSemanticValue, ...(input.alternativeValues ?? [])]) {
      if (candidate.trim().length === 0) continue;
      await typeSearch(trigger, candidate);
      const filtered = findListbox(trigger);
      if (!filtered) continue;
      const refreshed = await enumerateAllOptions(filtered);
      if (refreshed.length === 0) continue;
      const retry = matchWithAlternatives(
        { ...input, desiredSemanticValue: candidate },
        asFieldOptions(refreshed),
      );
      if (retry.option) {
        live = refreshed;
        offered = asFieldOptions(refreshed);
        match = retry;
        break;
      }
    }
  }

  const choices = realChoices(offered);
  if (!match.option) {
    closeControl(trigger);
    return {
      code: match.ambiguous
        ? 'AMBIGUOUS_OPTION_MATCH'
        : match.method === 'semantic'
          ? 'NO_SEMANTIC_OPTION_MATCH'
          : 'OPTION_NOT_FOUND',
      reason: match.reason,
      optionCount: choices.length,
    };
  }

  const current = findListbox(trigger) ?? container;
  // Scrolled back into existence if it has to be. Enumeration restores the
  // list's scroll position, so on a virtualized menu the option that was just
  // matched is no longer a rendered element — and clicking it failed over a
  // list that had offered it a moment earlier.
  const wantedLabel = normalizeOptionText(match.option.label);
  const wantedValue = match.option.value;
  const target =
    optionElementFor(current, match.option) ??
    (await revealOption(
      current,
      (element) =>
        (Boolean(wantedValue) && element.getAttribute('data-value') === wantedValue) ||
        normalizeOptionText(element.textContent ?? '') === wantedLabel,
    )) ??
    undefined;
  if (!target) {
    closeControl(trigger);
    return {
      code: 'OPTION_CLICK_FAILED',
      reason: `"${match.option.label}" was on the list and was gone before it could be clicked.`,
      optionCount: choices.length,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
    };
  }
  if (target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) {
    closeControl(trigger);
    return {
      code: 'OPTION_DISABLED',
      reason: `"${match.option.label}" is on the list and cannot be chosen.`,
      optionCount: choices.length,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
    };
  }

  // Scrolling is a convenience for a virtualized list; its absence must never
  // abort a selection that is otherwise valid.
  target.scrollIntoView?.({ block: 'nearest' });
  pressPointer(target);

  const wanted = normalizeOptionText(match.option.label);
  const observed =
    (await waitFor(() => {
      if (!root.isConnected) return null;
      const text = readSelectedText(root);
      return normalizeOptionText(text).includes(wanted) ? text : null;
    }, VERIFY_WAIT_MS)) ?? (root.isConnected ? readSelectedText(root) : null);

  if (observed === null) {
    return {
      code: 'CONTROL_NOT_FOUND',
      reason: 'The control was removed from the page after the option was clicked.',
      optionCount: choices.length,
      executionAttempted: true,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
    };
  }

  closeControl(resolveTrigger(root));

  if (!normalizeOptionText(observed).includes(wanted)) {
    return {
      code: observed.trim().length === 0 ? 'SELECTION_NOT_ACCEPTED' : 'VERIFICATION_FAILED',
      reason:
        observed.trim().length === 0
          ? `"${match.option.label}" was clicked and the control still shows nothing.`
          : `"${match.option.label}" was clicked and the control shows "${observed}".`,
      optionCount: choices.length,
      executionAttempted: true,
      matchMethod: match.method,
      matchedOptionText: match.option.label,
      observedValue: observed,
    };
  }
  return {
    ok: true,
    method: match.method,
    label: match.option.label,
    observed,
    optionCount: choices.length,
  };
}

/**
 * Open, enumerate, match, select, verify — once, for any dropdown.
 *
 * Always returns a result. A failure is a named stage, never an exception and
 * never a bare false, so one dropdown that cannot be driven says exactly what
 * stopped it and the fields after it still run.
 */
export async function executeDropdown(
  input: DropdownExecutionInput,
): Promise<DropdownExecutionResult> {
  const started = performance.now();
  const kind = classifyDropdown(input.root);

  const finish = (patch: Partial<DropdownExecutionResult>): DropdownExecutionResult =>
    dropdownExecutionResultSchema.parse({
      fieldId: input.fieldId,
      dropdownKind: kind,
      desiredSemanticValue: input.desiredSemanticValue,
      optionCount: 0,
      matchMethod: 'none',
      executionAttempted: false,
      verified: false,
      reason: 'The dropdown attempt produced no outcome.',
      durationMs: Math.round(performance.now() - started),
      ...patch,
    });

  if (input.desiredSemanticValue.trim().length === 0) {
    return finish({
      failureCode: 'ANSWER_UNKNOWN',
      reason: 'Nothing saved answers this question, so no option was chosen.',
    });
  }
  if (!input.root.isConnected) {
    return finish({
      failureCode: 'CONTROL_NOT_FOUND',
      reason: 'The scanned control is no longer on the page.',
    });
  }
  if (!isVisible(input.root) && !(input.root instanceof HTMLSelectElement)) {
    return finish({
      failureCode: 'CONTROL_NOT_FOUND',
      reason: 'The control is not visible on the page.',
    });
  }

  let outcome: Awaited<ReturnType<typeof executeCustomDropdown>>;
  try {
    const native =
      input.root instanceof HTMLSelectElement
        ? input.root
        : resolveTrigger(input.root) instanceof HTMLSelectElement
          ? (resolveTrigger(input.root) as HTMLSelectElement)
          : null;
    outcome = native
      ? executeNativeSelect(native, input)
      : await executeCustomDropdown(input.root, input);
  } catch (cause) {
    // A widget that throws mid-interaction is left closed, so the field after
    // it is not driving a page with a menu still over it.
    try {
      closeControl(resolveTrigger(input.root));
    } catch {
      // Closing is best-effort; the reported failure is the one that matters.
    }
    return finish({
      failureCode: 'OPTION_CLICK_FAILED',
      executionAttempted: true,
      reason: `The control threw while being driven: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }

  if ('ok' in outcome) {
    return finish({
      optionCount: outcome.optionCount,
      matchMethod: outcome.method,
      matchedOptionText: outcome.label,
      executionAttempted: true,
      verified: true,
      observedValue: outcome.observed,
      reason: `Selected "${outcome.label}" and the control now shows it.`,
    });
  }

  return finish({
    failureCode: outcome.code,
    reason: outcome.reason,
    ...(outcome.optionCount === undefined ? {} : { optionCount: outcome.optionCount }),
    ...(outcome.executionAttempted === undefined
      ? {}
      : { executionAttempted: outcome.executionAttempted }),
    ...(outcome.matchMethod === undefined ? {} : { matchMethod: outcome.matchMethod }),
    ...(outcome.matchedOptionText === undefined
      ? {}
      : { matchedOptionText: outcome.matchedOptionText }),
    ...(outcome.observedValue === undefined ? {} : { observedValue: outcome.observedValue }),
  });
}

/**
 * The engine, with one bounded retry for the widget shapes that earn it.
 *
 * A native select is deterministic: if it did not take the value the first time,
 * it will not take it the second, and retrying only fires another `change` at a
 * page that may rebuild a dependent control. A custom widget genuinely can lose
 * a click to an animation, so it gets exactly one more attempt, and only for the
 * failures a retry could plausibly fix.
 */
const RETRYABLE: readonly DropdownFailureCode[] = [
  'OPEN_FAILED',
  'OPTION_CONTAINER_NOT_FOUND',
  'OPTION_CLICK_FAILED',
  'SELECTION_NOT_ACCEPTED',
  'VERIFICATION_FAILED',
];

export async function executeDropdownWithRetry(
  input: DropdownExecutionInput,
  reResolve?: () => HTMLElement | null,
): Promise<DropdownExecutionResult> {
  const first = await executeDropdown(input);
  if (first.verified || first.dropdownKind === 'native_select') return first;
  if (!first.failureCode || !RETRYABLE.includes(first.failureCode)) return first;

  // Re-resolved rather than reused: a framework that rerenders on close
  // replaces the element, and clicking the detached one silently does nothing.
  const root = reResolve?.() ?? (input.root.isConnected ? input.root : null);
  if (!root) return first;
  const second = await executeDropdown({ ...input, root });
  return second.verified ? second : { ...second, durationMs: first.durationMs + second.durationMs };
}
