import { matchOption, normalizeOptionText, type FieldOption } from '@internship-agent/shared';

/**
 * Deterministic driver for custom (non-`<select>`) comboboxes — the pattern
 * Greenhouse, Lever, and Ashby use for country, location, and demographic
 * questions.
 *
 * Everything here is browser code. The model never supplies a selector, an
 * index, or a command; it supplies a value, and this module decides whether an
 * option on the page exactly matches it.
 */

export interface ComboboxOutcome {
  ok: boolean;
  /** Text the control displayed after selection, read back from the DOM. */
  observedValue?: string;
  matchedLabel?: string;
  reason: string;
  /** Options actually discovered on the page, for honest reporting. */
  discoveredOptions: FieldOption[];
}

const OPEN_WAIT_MS = 1500;
const RERENDER_WAIT_MS = 700;
const POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(produce: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

function isVisible(element: Element): boolean {
  const node = element as HTMLElement;
  if (!node.isConnected) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Finds the control that actually receives interaction. A combobox is often a
 * wrapper whose inner `input[role=combobox]` or `button[aria-haspopup]` is the
 * real trigger.
 */
export function resolveTrigger(root: HTMLElement): HTMLElement {
  if (root.matches('input,button,[role="combobox"]')) return root;
  const inner = root.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], button[aria-haspopup], input:not([type="hidden"]), button',
  );
  return inner ?? root;
}

/**
 * Locates the popup listbox. Tries the ARIA relationship first, then a
 * portal-mounted listbox elsewhere in the document — React libraries frequently
 * render the popup at `document.body`, far from the trigger.
 */
export function findListbox(trigger: HTMLElement): HTMLElement | null {
  const controls = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns') ?? '';
  for (const id of controls.split(/\s+/).filter(Boolean)) {
    const byId = document.getElementById(id);
    if (byId && isVisible(byId)) return byId;
  }

  const activeDescendant = trigger.getAttribute('aria-activedescendant');
  if (activeDescendant) {
    const option = document.getElementById(activeDescendant);
    const owner = option?.closest<HTMLElement>('[role="listbox"]');
    if (owner && isVisible(owner)) return owner;
  }

  // Same container first — a portal listbox is the fallback, not the default.
  const local = trigger
    .closest('div,fieldset,section,form')
    ?.querySelector<HTMLElement>('[role="listbox"]');
  if (local && isVisible(local)) return local;

  const portals = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
    (candidate) => isVisible(candidate),
  );
  return portals.length === 1 ? (portals[0] ?? null) : null;
}

export function readOptions(listbox: HTMLElement): FieldOption[] {
  return Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'))
    .filter(isVisible)
    .map((element) => ({
      label: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      value:
        element.getAttribute('data-value') ??
        element.getAttribute('value') ??
        (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((option) => option.label.length > 0);
}

async function openCombobox(trigger: HTMLElement): Promise<HTMLElement | null> {
  const already = findListbox(trigger);
  if (already && trigger.getAttribute('aria-expanded') === 'true') return already;

  trigger.focus();
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  trigger.click();

  const listbox = await waitFor(() => findListbox(trigger), OPEN_WAIT_MS);
  if (listbox) return listbox;

  // Some implementations only open on keyboard interaction.
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  return waitFor(() => findListbox(trigger), OPEN_WAIT_MS);
}

/**
 * Types into a searchable combobox to load remote or filtered options. Uses the
 * native value setter so React's controlled inputs observe the change.
 */
async function typeSearch(trigger: HTMLElement, text: string): Promise<void> {
  if (!(trigger instanceof HTMLInputElement)) return;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!descriptor?.set) return;
  descriptor.set.call(trigger, text);
  trigger.dispatchEvent(new Event('input', { bubbles: true }));
  trigger.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(RERENDER_WAIT_MS);
}

function closePopup(trigger: HTMLElement): void {
  // Escape is the accessible close path and never activates anything.
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (trigger instanceof HTMLElement) trigger.blur();
}

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
}

/**
 * Opens the combobox, reads the options actually on the page, matches the
 * proposed value against them, selects the one exact hit, and verifies what the
 * control displays afterwards.
 *
 * Refuses to act on an ambiguous or absent match rather than picking by index or
 * partial text.
 */
export async function selectComboboxOption(input: SelectComboboxInput): Promise<ComboboxOutcome> {
  const { root, proposedValue } = input;

  if (!isVisible(root)) {
    return { ok: false, reason: 'The combobox is not visible on the page.', discoveredOptions: [] };
  }
  if (root.getAttribute('aria-disabled') === 'true' || root.matches(':disabled')) {
    return { ok: false, reason: 'The combobox is disabled.', discoveredOptions: [] };
  }

  const trigger = resolveTrigger(root);
  let listbox = await openCombobox(trigger);
  if (!listbox) {
    return {
      ok: false,
      reason: 'The option list did not open, so no options could be read.',
      discoveredOptions: [],
    };
  }

  let discovered = readOptions(listbox);

  // A searchable combobox may render nothing until it receives input, and may
  // hide the wanted entry behind a filter.
  const needsSearch =
    discovered.length === 0 ||
    !discovered.some(
      (option) => normalizeOptionText(option.label) === normalizeOptionText(proposedValue),
    );
  if (needsSearch && trigger instanceof HTMLInputElement) {
    await typeSearch(trigger, proposedValue);
    listbox = findListbox(trigger) ?? listbox;
    const filtered = readOptions(listbox);
    if (filtered.length > 0) discovered = filtered;
  }

  if (discovered.length === 0) {
    closePopup(trigger);
    return {
      ok: false,
      reason: 'The option list opened but contained no options.',
      discoveredOptions: [],
    };
  }

  const match = matchOption(proposedValue, discovered, {
    allowRegionSuffix: input.allowRegionSuffix ?? false,
  });
  if (!match.matched || !match.option) {
    closePopup(trigger);
    return { ok: false, reason: match.reason, discoveredOptions: discovered };
  }

  const wantedLabel = match.option.label;
  const target = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (element) =>
      normalizeOptionText((element.textContent ?? '').trim()) === normalizeOptionText(wantedLabel),
  );
  if (!target) {
    closePopup(trigger);
    return {
      ok: false,
      reason: `The matched option "${wantedLabel}" was no longer in the list.`,
      discoveredOptions: discovered,
    };
  }

  // Scrolling is a convenience for virtualized lists; its absence must never
  // abort a selection that is otherwise valid.
  target.scrollIntoView?.({ block: 'nearest' });
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  target.click();

  await sleep(RERENDER_WAIT_MS);

  // Re-read from the live DOM: the control has usually re-rendered by now, so a
  // stale reference would verify nothing.
  const liveRoot = root.isConnected ? root : null;
  if (!liveRoot) {
    return {
      ok: false,
      reason: 'The combobox was removed from the page after selection.',
      discoveredOptions: discovered,
    };
  }

  const liveTrigger = resolveTrigger(liveRoot);
  const observed = readDisplayedValue(liveRoot, liveTrigger);
  closePopup(liveTrigger);

  const verified = normalizeOptionText(observed).includes(normalizeOptionText(wantedLabel));
  return {
    ok: verified,
    observedValue: observed,
    matchedLabel: wantedLabel,
    reason: verified
      ? `Selected "${wantedLabel}" and the control now displays it.`
      : `Clicked "${wantedLabel}" but the control displays "${observed}".`,
    discoveredOptions: discovered,
  };
}
