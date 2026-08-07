import {
  discoveredOptionSetSchema,
  type ControlType,
  type DetectedField,
  type DiscoveredOption,
  type DiscoveredOptionSet,
} from '@internship-agent/shared';

/**
 * Reads the choices a control actually offers, from the live page.
 *
 * The scanner can only see the static DOM, where a custom combobox has no
 * options until it is opened. Everything here runs at resolution time: it opens
 * the control if it must, reads what appeared, and closes it again when nothing
 * was selected — so a read-only inspection leaves the page as it found it.
 *
 * This is browser code throughout. No model supplies a selector, an index, or an
 * instruction; it receives the labels this module found and nothing else.
 */

/**
 * How long each way of opening a control is given.
 *
 * The pointer press is the one that works, so it gets the budget a page that
 * fetches its list actually needs. The keyboard and typing fallbacks are for
 * widgets the press did not reach, and giving each of them the same 1.5s meant a
 * control that simply cannot be opened cost four and a half seconds — per
 * field, doubled by the retry. A form with six such controls spent half a minute
 * failing.
 */
const OPEN_WAIT_MS = 1200;
const FALLBACK_WAIT_MS = 400;
const POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(produce: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

export function isVisible(element: Element): boolean {
  const node = element as HTMLElement;
  if (!node.isConnected) return false;
  if (node.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Finds the element that actually receives interaction. A combobox is often a
 * wrapper whose inner `input[role=combobox]` or `button[aria-haspopup]` is the
 * real trigger.
 */
export function resolveTrigger(root: HTMLElement): HTMLElement {
  if (root.matches('input,button,select,[role="combobox"]')) return root;
  const inner = root.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], button[aria-haspopup], select, input:not([type="hidden"]), button',
  );
  return inner ?? root;
}

/**
 * Locates this control's popup listbox.
 *
 * Order matters for correctness, not just speed: the ARIA relationship is
 * checked first because it is the only evidence that ties a listbox to *this*
 * control. A portal-mounted listbox is accepted last, and only when exactly one
 * is open, so a dropdown left open elsewhere on the page is never mistaken for
 * this field's options.
 */
export function findListbox(trigger: HTMLElement): HTMLElement | null {
  const controls = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns') ?? '';
  const declared = controls.split(/\s+/).filter(Boolean);
  for (const id of declared) {
    const byId = document.getElementById(id);
    if (byId && isVisible(byId)) return byId;
  }
  // A `button[aria-haspopup]` names its menu the same way a combobox names its
  // listbox, and a menu of `role="menuitem"` entries is a dropdown by every
  // measure except the attribute it chose. Excluding it meant the whole
  // button-menu family — the pattern React select libraries render — reported
  // "the option list did not open" over a menu that was plainly open.
  const popupOwner = trigger.closest<HTMLElement>('[aria-controls],[aria-owns]');
  if (popupOwner && popupOwner !== trigger) {
    const owned = (
      popupOwner.getAttribute('aria-controls') ??
      popupOwner.getAttribute('aria-owns') ??
      ''
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const id of owned) {
      const byId = document.getElementById(id);
      if (byId && isVisible(byId)) return byId;
    }
  }
  // A control that names its own listbox has told us which element is its list.
  // If that element is absent, this control is closed — and a listbox left open
  // by a *different* field must never stand in for it. Accepting one meant a
  // question was answered from the previous question's choices.
  if (declared.length > 0) return null;

  const activeDescendant = trigger.getAttribute('aria-activedescendant');
  if (activeDescendant) {
    const option = document.getElementById(activeDescendant);
    const owner = option?.closest<HTMLElement>('[role="listbox"]');
    if (owner && isVisible(owner)) return owner;
  }

  // Same container next: a list rendered inline beside its own trigger.
  const local = trigger
    .closest('div,fieldset,section,form')
    ?.querySelector<HTMLElement>(OPTION_CONTAINER_SELECTOR);
  if (local && isVisible(local)) return local;

  const portals = Array.from(
    document.querySelectorAll<HTMLElement>(OPTION_CONTAINER_SELECTOR),
  ).filter((candidate) => isVisible(candidate) && readOptions(candidate).length > 0);
  // More than one open list is ambiguous evidence, so none of them is used: a
  // dropdown left open elsewhere on the page must never answer this question.
  return portals.length === 1 ? (portals[0] ?? null) : null;
}

function cleanLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** A stable-enough identifier for an option element, never its position. */
function fingerprintOf(element: HTMLElement, label: string): string {
  return element.id || element.getAttribute('data-value') || label;
}

/**
 * The elements that behave as a dropdown's popup, whatever they call themselves.
 *
 * `role="listbox"` is the ARIA answer; `role="menu"` is what a button-driven
 * custom select renders; `[data-portal-menu]` and `[data-dropdown-menu]` are the
 * hooks portal implementations put on the node they mount into `document.body`,
 * where no ancestor relationship to the trigger survives.
 */
export const OPTION_CONTAINER_SELECTOR =
  '[role="listbox"],[role="menu"],[data-portal-menu],[data-dropdown-menu]';

/**
 * The elements inside a popup that behave as one choice.
 *
 * `role="option"` alone missed every menu-based dropdown, so a React select
 * whose entries are `role="menuitem"` reported zero options and failed as
 * `NO_OPTIONS_FOUND` over a list the user could see.
 */
export const OPTION_ITEM_SELECTOR =
  '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/**
 * The scrollable element inside (or being) an open popup.
 *
 * A long menu is routinely not scrollable itself: the popup is a positioning
 * wrapper and the overflow lives on a child. Whichever element actually scrolls
 * is the one whose `scrollHeight` exceeds its `clientHeight`.
 */
function scrollableOf(container: HTMLElement): HTMLElement | null {
  const candidates = [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
  return (
    candidates.find(
      (candidate) =>
        candidate.scrollHeight > candidate.clientHeight + 4 && candidate.clientHeight > 0,
    ) ?? null
  );
}

/** How many times a long list may be scrolled while being read. */
const MAX_SCROLL_STEPS = 40;

/**
 * Every choice a control offers, including the ones below the fold.
 *
 * The reason this is not just `readOptions`: a long list is either *scrollable*
 * — every option is in the DOM and most are simply outside the visible box — or
 * *virtualized*, where only the visible rows exist as elements at all and the
 * rest are created as the list scrolls. The second kind is common on the
 * country and field-of-study controls that failed, and no amount of querying
 * finds an option the page has not built yet.
 *
 * So the list is read, scrolled, and read again until it stops producing new
 * entries or the step budget runs out — and the scroll position is put back
 * afterwards, because leaving a menu scrolled to the bottom changes what the
 * applicant sees if they open it themselves.
 *
 * Bounded twice over: by `MAX_SCROLL_STEPS`, and by "a step that revealed
 * nothing new ends it". A list that is already complete costs one read and no
 * scrolling at all.
 */
export async function enumerateAllOptions(container: HTMLElement): Promise<DiscoveredOption[]> {
  const collected = new Map<string, DiscoveredOption>();
  const absorb = (): number => {
    let added = 0;
    for (const option of readOptions(container)) {
      const key = `${option.label} ${option.value}`;
      if (collected.has(key)) continue;
      collected.set(key, option);
      added += 1;
    }
    return added;
  };

  absorb();
  const scroller = scrollableOf(container);
  if (!scroller) return [...collected.values()];

  const originalTop = scroller.scrollTop;
  try {
    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      const before = scroller.scrollTop;
      // A page at a time rather than to the bottom: a virtualized list only
      // renders what it passes, so jumping straight to the end would skip
      // everything in between — which is exactly the option being looked for.
      scroller.scrollTop = before + Math.max(scroller.clientHeight, 1);
      if (scroller.scrollTop === before) break;
      // Let a virtualized list render the rows it just scrolled into.
      await sleep(POLL_MS);
      const added = absorb();
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atBottom) {
        // One last read at the very bottom, then stop.
        absorb();
        break;
      }
      // A step that revealed nothing and moved nothing is the end of a list
      // whose height lied about it.
      if (added === 0 && scroller.scrollTop === before) break;
    }
  } finally {
    scroller.scrollTop = originalTop;
  }
  return [...collected.values()];
}

/**
 * Scrolls a virtualized list until the wanted option is rendered, and returns it.
 *
 * Enumeration puts the scroll position back where it found it, which is the
 * right thing to do for a read — and it means that on a virtualized list the
 * option that was just *matched* no longer exists as an element. Clicking it
 * then failed with `OPTION_CLICK_FAILED` over a list that had offered it a
 * moment earlier.
 *
 * So the match is re-found by scrolling to it. Bounded by the same step budget
 * as enumeration, and it gives up rather than scrolling forever.
 */
export async function revealOption(
  container: HTMLElement,
  matches: (element: HTMLElement) => boolean,
): Promise<HTMLElement | null> {
  const find = (): HTMLElement | null =>
    Array.from(container.querySelectorAll<HTMLElement>(OPTION_ITEM_SELECTOR)).find(matches) ?? null;

  const already = find();
  if (already) return already;

  const scroller = scrollableOf(container);
  if (!scroller) return null;

  const originalTop = scroller.scrollTop;
  scroller.scrollTop = 0;
  for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
    const found = find();
    if (found) return found;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(scroller.clientHeight, 1);
    if (scroller.scrollTop === before) break;
    await sleep(POLL_MS);
  }
  const last = find();
  if (!last) scroller.scrollTop = originalTop;
  return last;
}

/** Reads the selectable entries of an open popup, whatever role it uses. */
export function readOptions(listbox: HTMLElement): DiscoveredOption[] {
  return Array.from(listbox.querySelectorAll<HTMLElement>(OPTION_ITEM_SELECTOR))
    .filter(isVisible)
    .map((element) => {
      const label = cleanLabel(element.textContent);
      return {
        label,
        value: element.getAttribute('data-value') ?? element.getAttribute('value') ?? label,
        disabled:
          element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'),
        selected:
          element.getAttribute('aria-selected') === 'true' ||
          element.getAttribute('aria-checked') === 'true' ||
          element.getAttribute('data-selected') === 'true',
        elementFingerprint: fingerprintOf(element, label),
      };
    })
    .filter((option) => option.label.length > 0);
}

function readNativeSelect(select: HTMLSelectElement): DiscoveredOption[] {
  return Array.from(select.options)
    .map((option) => {
      const label = cleanLabel(option.textContent);
      return {
        label,
        value: option.value,
        // A native option is not laid out, so `isVisible` cannot judge it; the
        // element's own flags are the only honest signal.
        disabled:
          option.disabled || option.parentElement instanceof HTMLOptGroupElement
            ? option.disabled || (option.parentElement as HTMLOptGroupElement).disabled
            : option.disabled,
        selected: option.selected,
        elementFingerprint: option.value || label,
      };
    })
    .filter((option) => option.label.length > 0 || option.value.length > 0);
}

function readGroupInputs(elements: readonly HTMLInputElement[]): DiscoveredOption[] {
  return elements
    .filter((input) => isVisible(input) || input.type === 'radio')
    .map((input) => {
      const explicit = input.labels?.[0]?.textContent;
      const label =
        cleanLabel(explicit) || cleanLabel(input.getAttribute('aria-label')) || input.value;
      return {
        label,
        value: input.value,
        disabled: input.disabled,
        selected: input.checked,
        elementFingerprint: input.id || input.value,
      };
    });
}

/**
 * Removes options that are the same choice rendered twice. Keeps the first,
 * because a list's own order is the user's order.
 */
function deduplicate(options: readonly DiscoveredOption[]): DiscoveredOption[] {
  const seen = new Set<string>();
  const unique: DiscoveredOption[] = [];
  for (const option of options) {
    const key = `${option.label} ${option.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(option);
  }
  return unique;
}

/** What the field's scanned type means for how its options must be read. */
export function controlTypeFor(field: DetectedField, element: HTMLElement): ControlType {
  if (element instanceof HTMLSelectElement) {
    return element.multiple ? 'multi_select' : 'native_select';
  }
  if (field.fieldType === 'radio') return 'radio_group';
  // A `multi_select` is either a group of checkbox inputs or a custom
  // multi-select combobox. Only the input group carries its choices in the DOM;
  // the combobox has to be opened, and classifying it as a group meant its list
  // was never opened at all.
  if (field.fieldType === 'multi_select') {
    return element instanceof HTMLInputElement ? 'checkbox_group' : 'multi_select';
  }
  if (field.fieldType === 'select') return 'native_select';
  const trigger = resolveTrigger(element);
  if (
    trigger instanceof HTMLInputElement &&
    (trigger.getAttribute('aria-autocomplete') === 'list' ||
      trigger.getAttribute('aria-autocomplete') === 'both')
  ) {
    return 'autocomplete';
  }
  if (element.getAttribute('role') === 'listbox') return 'listbox';
  return 'combobox';
}

/**
 * Types into a searchable control. Uses the native value setter so a
 * React-controlled input observes the change rather than silently reverting.
 */
export async function typeSearch(trigger: HTMLElement, text: string): Promise<void> {
  if (!(trigger instanceof HTMLInputElement)) return;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!descriptor?.set) return;
  descriptor.set.call(trigger, text);
  trigger.dispatchEvent(new Event('input', { bubbles: true }));
  trigger.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => {
    const listbox = findListbox(trigger);
    return listbox && readOptions(listbox).length > 0 ? listbox : null;
  }, FALLBACK_WAIT_MS);
}

/**
 * A realistic pointer press, in the order a browser sends one.
 *
 * `element.click()` alone opens nothing on the libraries that matter: a React
 * select opens on `mousedown`, and several close again on the `click` that
 * follows unless the pointer events preceded it. Sending the whole sequence is
 * the difference between a menu that opens and a field reported as
 * `OPEN_FAILED` over a control that works perfectly for a human.
 */
export function pressPointer(target: HTMLElement): void {
  const options = { bubbles: true, composed: true, cancelable: true } as const;
  target.dispatchEvent(pointerEvent('pointerdown', options));
  target.dispatchEvent(new MouseEvent('mousedown', options));
  target.dispatchEvent(pointerEvent('pointerup', options));
  target.dispatchEvent(new MouseEvent('mouseup', options));
  target.click();
}

/**
 * A pointer event where the runtime has `PointerEvent`, and a mouse event where
 * it does not.
 *
 * Not a test convenience: `PointerEvent` is absent from more embedded and
 * headless environments than one would hope, and a missing constructor threw
 * *inside* the open sequence — so the whole custom-dropdown family reported
 * "the option was gone before it could be clicked" about pages that had never
 * been touched. A widget listening for pointer events is served correctly where
 * they exist, and no widget is worse off where they do not.
 */
function pointerEvent(type: string, options: MouseEventInit): Event {
  const constructor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  return constructor ? new constructor(type, options) : new MouseEvent(type, options);
}

/**
 * True once the control itself says it is open.
 *
 * Checked alongside the popup search because a lazily-rendered menu exists for a
 * frame or two before it holds anything, and enumerating it in that window is
 * how "the option list opened but contained no choices" was reported about
 * lists that were about to arrive.
 */
function reportsExpanded(trigger: HTMLElement): boolean {
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  const owner = trigger.closest<HTMLElement>('[aria-expanded]');
  return owner?.getAttribute('aria-expanded') === 'true';
}

/** A popup for this trigger that actually holds choices. */
function openPopupWithOptions(trigger: HTMLElement): HTMLElement | null {
  const listbox = findListbox(trigger);
  if (!listbox) return null;
  return readOptions(listbox).length > 0 ? listbox : null;
}

/**
 * Opens a control that hides its options until asked, and waits for the options
 * themselves rather than for the container.
 */
export async function openControl(
  trigger: HTMLElement,
  searchText?: string,
): Promise<HTMLElement | null> {
  const already = openPopupWithOptions(trigger);
  if (already && reportsExpanded(trigger)) return already;

  const autocomplete =
    trigger instanceof HTMLInputElement &&
    ['list', 'both'].includes(trigger.getAttribute('aria-autocomplete') ?? '');

  // A true autocomplete renders nothing until it has a query, so clicking it can
  // never open anything — typing is the only way in.
  if (autocomplete && searchText) {
    trigger.focus();
    await typeSearch(trigger, searchText);
    const typed = openPopupWithOptions(trigger);
    if (typed) return typed;
  }

  trigger.focus();
  pressPointer(trigger);
  // Waits for a list with entries in it, so a menu mounted empty and filled a
  // frame later is read after it has been filled rather than before.
  const clicked = await waitFor(() => openPopupWithOptions(trigger), OPEN_WAIT_MS);
  if (clicked) return clicked;

  // Some implementations open only on keyboard interaction.
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
  const keyed = await waitFor(() => openPopupWithOptions(trigger), FALLBACK_WAIT_MS);
  if (keyed) return keyed;

  if (searchText && trigger instanceof HTMLInputElement) {
    await typeSearch(trigger, searchText);
    const typed = openPopupWithOptions(trigger);
    if (typed) return typed;
  }
  // Last: a container that opened and is still empty. Reported as an open
  // control with no choices, which is a different repair from one that never
  // opened, and the caller distinguishes them.
  return findListbox(trigger);
}

/**
 * Closes a popup without activating anything. Escape is the accessible path.
 *
 * The second press matters: one dropdown left open swallows the pointer press
 * that would have opened the next one, so a single failure used to take every
 * field below it down with it. Closing is therefore attempted, then checked,
 * then attempted a second way — and never by clicking an option.
 */
export function closeControl(trigger: HTMLElement): void {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  if (findListbox(trigger) && reportsExpanded(trigger)) {
    // A menu that ignores Escape closes on an outside press, which is what a
    // person would do next.
    const outside = { bubbles: true, composed: true, cancelable: true } as const;
    document.body.dispatchEvent(pointerEvent('pointerdown', outside));
    document.body.dispatchEvent(new MouseEvent('mousedown', outside));
  }
  trigger.blur();
}

export interface DiscoveryContext {
  /** Every element the scanner associated with this field, for grouped inputs. */
  groupElements?: readonly HTMLElement[];
  /** Search text for an autocomplete. Derived only from saved values. */
  searchText?: string;
  /** Leave an opened control open, because a selection is about to be made. */
  keepOpen?: boolean;
}

/**
 * Reads every choice this control currently offers.
 *
 * Opens the control only when its options cannot exist otherwise, and closes it
 * again unless the caller is about to select something. Disabled and hidden
 * options are reported but marked, never silently dropped, so a control that
 * offers nothing selectable is distinguishable from one that offers nothing.
 */
export async function discoverLiveOptions(
  field: DetectedField,
  element: HTMLElement,
  context: DiscoveryContext = {},
): Promise<DiscoveredOptionSet> {
  const controlType = controlTypeFor(field, element);
  const warnings: string[] = [];

  const build = (
    options: DiscoveredOption[],
    opened: boolean,
    listboxId?: string,
  ): DiscoveredOptionSet =>
    discoveredOptionSetSchema.parse({
      fieldId: field.id,
      controlType,
      options: deduplicate(options),
      opened,
      ...(listboxId ? { listboxId } : {}),
      warnings,
    });

  if (!isVisible(element) && controlType !== 'radio_group' && controlType !== 'checkbox_group') {
    warnings.push('The control is not visible, so its options could not be read.');
    return build([], false);
  }

  // A native select carries its options in the DOM already. Opening it is
  // neither possible nor necessary.
  if (element instanceof HTMLSelectElement) {
    return build(readNativeSelect(element), false);
  }

  if (
    controlType === 'radio_group' ||
    (controlType === 'checkbox_group' && element instanceof HTMLInputElement)
  ) {
    const inputs = (context.groupElements ?? [element]).filter(
      (candidate): candidate is HTMLInputElement => candidate instanceof HTMLInputElement,
    );
    if (inputs.length === 0) {
      warnings.push('No radio or checkbox inputs were found for this question.');
      return build([], false);
    }
    return build(readGroupInputs(inputs), false);
  }

  const trigger = resolveTrigger(element);
  const alreadyOpen = findListbox(trigger);
  const listbox = alreadyOpen ?? (await openControl(trigger, context.searchText));

  if (!listbox) {
    warnings.push('The option list did not open, so no choices could be read.');
    return build([], false);
  }

  const options = readOptions(listbox);
  const opened = alreadyOpen === null;
  if (options.length === 0) {
    warnings.push('The option list opened but contained no choices.');
  }
  // Discovery is a read. Unless a selection follows immediately, the control is
  // returned to the state it was found in.
  if (opened && !context.keepOpen) closeControl(trigger);

  return build(options, opened && Boolean(context.keepOpen), listbox.id || undefined);
}

/** The choices a user could actually pick: visible, enabled, and real. */
export function selectableOptions(set: DiscoveredOptionSet): DiscoveredOption[] {
  return set.options.filter((option) => !option.disabled);
}
