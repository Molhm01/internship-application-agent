import {
  discoveredOptionSetSchema,
  type ControlType,
  type DetectedField,
  type DiscoveredOption,
  type DiscoveredOptionSet,
  type MenuDetectionStrategy,
  type OptionCandidateStrategy,
} from '@internship-agent/shared';
import {
  findStructuralMenu,
  forgetMenu,
  isStructuralMenu,
  rememberedMenu,
  structuralOptionItems,
  watchForMenu,
} from './structuralMenu.js';

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
 * The tree an element's ids and portals actually live in.
 *
 * For a control in the main document this is the document, and everything below
 * behaves exactly as it always did. For one inside an open shadow root it is
 * that root — and the distinction is not academic: ids are scoped per tree, so
 * `document.getElementById` cannot see the listbox a shadow-rooted combobox
 * names in its own `aria-controls`. Looking there returned null, the control was
 * reported as never having opened, and the widget was working perfectly.
 */
export function scopeOf(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root : element.ownerDocument;
}

/**
 * An element by id, looked for in its own tree first and then the document.
 *
 * Both, because a shadow-rooted control may still name a listbox its page
 * mounted outside the shadow root — a portal is a portal wherever the trigger
 * lives.
 */
export function elementById(scope: Document | ShadowRoot, id: string): HTMLElement | null {
  const local = scope.getElementById(id);
  if (local instanceof HTMLElement) return local;
  const fallback = document.getElementById(id);
  return fallback instanceof HTMLElement ? fallback : null;
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
 * What a control currently *displays* as its answer.
 *
 * A `<select>` holds a value; a custom widget holds nothing at all — the answer
 * exists only as the text its trigger renders. That is what the executor
 * verifies a selection against, and it is also the only way the *scanner* can
 * tell whether a custom control has been answered yet. Without it a conditional
 * child hanging off a custom parent could never be activated, so "If other,
 * enter School" beside a filled custom School dropdown was unfillable when Other
 * was chosen and wore an orange "Information needed" badge when it was not.
 *
 * The order is defensive, and the trigger's own text is read before the whole
 * container's: a container holding an *open* menu reads as every option
 * concatenated, which "contains" whatever label is being looked for regardless
 * of what was chosen — a verification that cannot fail, which is the most
 * dangerous kind.
 */
export function readSelectedText(root: HTMLElement): string {
  if (root instanceof HTMLSelectElement) {
    const selected = root.selectedOptions[0];
    return (selected?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  const trigger = resolveTrigger(root);
  if (trigger instanceof HTMLInputElement && trigger.value) return trigger.value.trim();

  // `aria-activedescendant` means two different things depending on whether the
  // menu is open, and only one of them is an answer. While the list is closed it
  // is the widget's record of what was chosen. While the list is *open* it is the
  // keyboard cursor — the row under the highlight, which nobody has committed to.
  //
  // Reading the cursor as the answer is a verification that cannot fail: walking
  // the highlight onto "New Jersey" would report New Jersey as selected on a
  // control that had accepted nothing, which is the most dangerous possible
  // outcome here. So it is trusted only once the control says it is closed.
  const active = trigger.getAttribute('aria-activedescendant');
  if (active && !reportsExpanded(trigger)) {
    const option = elementById(scopeOf(trigger), active);
    if (option?.textContent) return option.textContent.replace(/\s+/g, ' ').trim();
  }
  const display = root.querySelector<HTMLElement>(
    '[data-selected-label],[class*="singleValue"],[class*="single-value"]',
  );
  if (display?.textContent) return display.textContent.replace(/\s+/g, ' ').trim();

  const chosen = root.querySelector<HTMLElement>('[aria-selected="true"],[data-selected="true"]');
  if (chosen?.textContent) return chosen.textContent.replace(/\s+/g, ' ').trim();

  const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (hidden?.value) return hidden.value.trim();

  if (findListbox(trigger) === null) {
    // The container's text, minus any option list living inside it.
    //
    // `findListbox` only reports a menu that is *visible*, but a menu that is
    // merely hidden still contributes its every label to `textContent`. Reading
    // that produced a string containing all fifty states, which "includes"
    // whichever one was being verified — so a control that had accepted nothing
    // confirmed any answer asked of it. Excluding the list is what makes this
    // fallback capable of returning nothing, which is the honest answer for a
    // custom control that has not been answered.
    return textWithoutOptionList(root);
  }
  // The menu is still open, so the container's text is the menu's. Report the
  // trigger's own text instead of a list of everything on offer.
  return (trigger.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * An element's visible text with its option list left out.
 *
 * Used as the last resort for "what does this control display", where including
 * the menu's own contents makes the reading useless: every label is in there, so
 * any answer appears to be present.
 */
function textWithoutOptionList(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(OPTION_CONTAINER_SELECTOR)) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
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
  // A menu this trigger was already opened onto, before anything is re-derived.
  //
  // Not an optimisation: a role-less menu is *only* recognisable at the moment
  // it appears, and every later step — enumerating, re-finding the element to
  // click, verifying — asks for the popup again. Without this, the second ask
  // returned nothing and the selection failed on a menu that was still open.
  const remembered = rememberedMenu(trigger);
  if (remembered && isVisible(remembered)) return remembered;

  const scope = scopeOf(trigger);
  const controls = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns') ?? '';
  const declared = controls.split(/\s+/).filter(Boolean);
  for (const id of declared) {
    const byId = elementById(scope, id);
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
      const byId = elementById(scope, id);
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
    const option = elementById(scope, activeDescendant);
    const owner = option?.closest<HTMLElement>('[role="listbox"]');
    if (owner && isVisible(owner)) return owner;
  }

  // Same container next: a list rendered inline beside its own trigger.
  const local = trigger
    .closest('div,fieldset,section,form')
    ?.querySelector<HTMLElement>(OPTION_CONTAINER_SELECTOR);
  if (local && isVisible(local)) return local;

  // The trigger's own tree first, then the document — a shadow-rooted control
  // may render its menu inside the shadow root or portal it out to the page, and
  // both are the same widget from the applicant's side.
  const portals = [
    ...new Set([
      ...Array.from(scope.querySelectorAll<HTMLElement>(OPTION_CONTAINER_SELECTOR)),
      ...Array.from(document.querySelectorAll<HTMLElement>(OPTION_CONTAINER_SELECTOR)),
    ]),
  ].filter((candidate) => isVisible(candidate) && readOptions(candidate).length > 0);
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
export async function enumerateAllOptions(
  container: HTMLElement,
  /** Filled with how many reads this took, for the trace. Optional out-param. */
  observed?: { scrollIterations: number },
): Promise<DiscoveredOption[]> {
  if (observed) observed.scrollIterations = 1;
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
      if (observed) observed.scrollIterations += 1;
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
  const find = (): HTMLElement | null => optionItemsIn(container).find(matches) ?? null;

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

/**
 * The elements inside an open menu that behave as one choice.
 *
 * The ARIA roles first, always. A container this code found by watching what a
 * click changed — and only such a container — falls back to conservative
 * structural candidates, because that is the family of menus that has no roles
 * to read. Everything downstream (enumeration, scrolling to a virtualized row,
 * finding the element to click, walking the keyboard highlight) goes through
 * here, so the two kinds of menu are driven by exactly the same machinery.
 */
export function optionItemsIn(container: HTMLElement): HTMLElement[] {
  const byRole = Array.from(container.querySelectorAll<HTMLElement>(OPTION_ITEM_SELECTOR));
  if (byRole.length > 0) return byRole;
  return isStructuralMenu(container) ? structuralOptionItems(container) : [];
}

/** Reads the selectable entries of an open popup, whatever role it uses. */
export function readOptions(listbox: HTMLElement): DiscoveredOption[] {
  return optionItemsIn(listbox)
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
 * The queries to try in a searchable control, longest first.
 *
 * A saved value and a form's own label are rarely the same string, and a
 * searchable list renders only what the query matches — so typing the whole
 * saved value into a control that spells the same place differently renders
 * *nothing*, and an empty list is indistinguishable from a control that never
 * opened. That is exactly what happened to "Location (City)": the query was
 * "Clifton, New Jersey, United States", the form's entry reads "Clifton, NJ,
 * United States", and the field was reported as `OPEN_FAILED` over a widget
 * that works perfectly for anyone who types "Clifton".
 *
 * So the query is shortened rather than given up on: the whole value, then the
 * part before the first comma, then its longest word. Each is a prefix of what
 * was saved — nothing is invented, nothing is broadened to a different fact,
 * and choosing among whatever the shorter query returns is still the matcher's
 * job, which is what keeps Clifton, Colorado from being selected.
 */
export function searchQueriesFor(text: string): string[] {
  const whole = text.trim();
  if (whole.length === 0) return [];
  const head = (whole.split(',')[0] ?? '').trim();
  const longestWord = [...head.split(/\s+/)].sort((a, b) => b.length - a.length)[0] ?? '';
  const queries = [whole, head, longestWord]
    .map((query) => query.trim())
    .filter((query) => query.length >= 2);
  return [...new Set(queries)];
}

/**
 * Types each progressively shorter query until the list renders something.
 *
 * Bounded by the three queries above and by `typeSearch`'s own wait, so a
 * control that answers nothing costs a little over a second rather than a
 * retry loop.
 */
export async function typeSearchNarrowing(
  trigger: HTMLElement,
  text: string,
): Promise<HTMLElement | null> {
  for (const query of searchQueriesFor(text)) {
    await typeSearch(trigger, query);
    const opened = openPopupWithOptions(trigger);
    if (opened) return opened;
  }
  return null;
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
 * What the open sequence observed, for the trace.
 *
 * An out-parameter rather than a return value so every existing caller is
 * unchanged: a caller that does not want diagnostics passes nothing, and this
 * function behaves exactly as it did.
 */
export interface OpenDiagnostics {
  openAttempted: boolean;
  ariaExpandedAfter: string;
  menuDetection: MenuDetectionStrategy;
  optionCandidates: OptionCandidateStrategy;
}

/** How a located menu was recognised, named after the fact. */
function describeMenu(trigger: HTMLElement, container: HTMLElement): MenuDetectionStrategy {
  const declared = (
    trigger.getAttribute('aria-controls') ??
    trigger.getAttribute('aria-owns') ??
    ''
  )
    .split(/\s+/)
    .filter(Boolean);
  if (container.id && declared.includes(container.id)) return 'aria_controls';
  if (container.matches('[role="listbox"],[role="menu"]')) return 'aria_role_container';
  if (container.matches('[data-portal-menu],[data-dropdown-menu]')) return 'portal_attribute';
  if (isStructuralMenu(container)) return 'mutation_fallback';
  return 'aria_role_container';
}

function record(
  into: OpenDiagnostics | undefined,
  trigger: HTMLElement,
  container: HTMLElement | null,
): void {
  if (!into) return;
  into.ariaExpandedAfter = trigger.getAttribute('aria-expanded') ?? '';
  if (!container) return;
  into.menuDetection = describeMenu(trigger, container);
  into.optionCandidates = container.querySelector(OPTION_ITEM_SELECTOR)
    ? 'aria_option_role'
    : structuralOptionItems(container).length > 0
      ? 'structural_candidates'
      : 'none';
}

/**
 * Opens a control that hides its options until asked, and waits for the options
 * themselves rather than for the container.
 *
 * The declared routes are tried first and are unchanged. What is new is the last
 * one: if nothing the control *says* about itself leads to a menu, the elements
 * the press actually changed are examined, and a container that appeared because
 * of the click — near the trigger, holding repeated entries — is accepted as the
 * menu. That is the whole of the repair for the widgets that ship no roles at
 * all, and it is scoped to that one container. See `structuralMenu.ts`.
 */
export async function openControl(
  trigger: HTMLElement,
  searchText?: string,
  diagnostics?: OpenDiagnostics,
): Promise<HTMLElement | null> {
  const already = openPopupWithOptions(trigger);
  if (already && reportsExpanded(trigger)) {
    record(diagnostics, trigger, already);
    return already;
  }

  const autocomplete =
    trigger instanceof HTMLInputElement &&
    ['list', 'both'].includes(trigger.getAttribute('aria-autocomplete') ?? '');

  // A true autocomplete renders nothing until it has a query, so clicking it can
  // never open anything — typing is the only way in.
  if (autocomplete && searchText) {
    trigger.focus();
    const typed = await typeSearchNarrowing(trigger, searchText);
    if (typed) {
      record(diagnostics, trigger, typed);
      return typed;
    }
  }

  // The watch starts *before* the press, which is the only moment at which a
  // role-less menu is distinguishable from the rest of the page: afterwards it
  // is just another div. A control that opens through a declared route never
  // consults this, and the observer is disconnected either way.
  const watch = watchForMenu(scopeOf(trigger));
  if (diagnostics) diagnostics.openAttempted = true;
  trigger.focus();
  pressPointer(trigger);
  // Waits for a list with entries in it, so a menu mounted empty and filled a
  // frame later is read after it has been filled rather than before.
  const clicked = await waitFor(() => openPopupWithOptions(trigger), OPEN_WAIT_MS);
  if (clicked) {
    watch.settle();
    record(diagnostics, trigger, clicked);
    return clicked;
  }

  // Some implementations open only on keyboard interaction.
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
  const keyed = await waitFor(() => openPopupWithOptions(trigger), FALLBACK_WAIT_MS);
  if (keyed) {
    watch.settle();
    record(diagnostics, trigger, keyed);
    return keyed;
  }

  if (searchText && trigger instanceof HTMLInputElement) {
    const typed = await typeSearchNarrowing(trigger, searchText);
    if (typed) {
      watch.settle();
      record(diagnostics, trigger, typed);
      return typed;
    }
  }

  // Nothing the control declares led anywhere. What did the click actually do?
  const structural = findStructuralMenu(trigger, watch.settle());
  if (structural.container) {
    record(diagnostics, trigger, structural.container);
    return structural.container;
  }

  // Last: a container that opened and is still empty. Reported as an open
  // control with no choices, which is a different repair from one that never
  // opened, and the caller distinguishes them.
  //
  // Found by id even when it is invisible, because an empty list *is* invisible
  // — it has no rows to give it a height — and refusing it here reported every
  // control that opened onto nothing as one that had never opened at all.
  const visible = findListbox(trigger);
  if (visible) {
    record(diagnostics, trigger, visible);
    return visible;
  }
  const scope = scopeOf(trigger);
  for (const id of (
    trigger.getAttribute('aria-controls') ??
    trigger.getAttribute('aria-owns') ??
    ''
  )
    .split(/\s+/)
    .filter(Boolean)) {
    const declared = elementById(scope, id);
    if (declared) {
      record(diagnostics, trigger, declared);
      return declared;
    }
  }
  record(diagnostics, trigger, null);
  return null;
}

/**
 * A keypress the widget's own handlers will see, in the order a browser sends one.
 *
 * Separate from `pressPointer` because a menu that ignores synthetic pointer
 * events is precisely the case this exists for: some widgets commit a choice
 * only from `keydown`, and a clicked option on those left the control showing
 * nothing while the executor reported the click as done.
 */
export function pressKey(target: HTMLElement, key: string): void {
  const init = { key, bubbles: true, composed: true, cancelable: true } as const;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * The option a keyboard-driven menu is currently highlighting.
 *
 * `aria-activedescendant` first, because it is the only signal that is *about*
 * the highlight — the others are conventions. `aria-selected` is consulted last
 * and reluctantly: on many widgets it marks the committed choice rather than the
 * cursor, so trusting it first would read a walk as finished before it started.
 */
export function activeOption(trigger: HTMLElement, container: HTMLElement): HTMLElement | null {
  const id = trigger.getAttribute('aria-activedescendant');
  if (id) {
    const byId = elementById(scopeOf(container), id) ?? elementById(scopeOf(trigger), id);
    if (byId) return byId;
  }
  return container.querySelector<HTMLElement>(
    '[data-active="true"],[data-highlighted="true"],[aria-current="true"],[role="option"][aria-selected="true"]',
  );
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
  // Forgotten first. A role-less menu is remembered so the steps after opening
  // can find it again; keeping that memory past a close would let the *next*
  // pass over this control read a stale, detached container as an open menu.
  forgetMenu(trigger);
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
