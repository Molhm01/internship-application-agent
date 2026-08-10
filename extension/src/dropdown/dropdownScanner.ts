import {
  dropdownDescriptorSchema,
  type DropdownDependencyState,
  type DropdownDescriptor,
  type DropdownKind,
} from '@internship-agent/shared';
import {
  answersFromList,
  extractAccessibleLabel,
  isCustomCombobox,
  isExtensionOwned,
  isTypedTextControl,
  isVisibleControl,
  opensOptionList,
  selectorFor,
} from '../scanner/domScanner.js';
import { classifyDropdown } from '../executor/dropdownEngine.js';
import { readSelectedText, resolveTrigger } from '../scanner/optionDiscovery.js';

/**
 * Finding every option control on a page, without asking the planner first.
 *
 * This is the reason the Dropdown Autofill Engine exists as its own pass. The
 * ordinary pipeline sees a dropdown only if the scan classified it as one *and*
 * the planner produced an action for it, and a control that falls out at either
 * step does not come back as a failure — it comes back as nothing at all, which
 * is how a run could report success over six untouched menus.
 *
 * So discovery starts from the document. Everything that answers from a list is
 * a candidate, whatever the scan thought of it, and the only things excluded are
 * the ones that would be actively wrong to drive: the extension's own UI, a
 * control that is not on screen, and anything that is genuinely typed into.
 *
 * ## The handle
 *
 * Each control gets a `dropdownId` minted here and kept in a frame-local
 * registry. The worker never learns a selector, and a directive coming back can
 * only name an id this frame issued moments earlier — so the return path cannot
 * be used to reach a control this frame did not volunteer. That is the same
 * shape the document-upload path uses, for the same reason.
 */

/** The controls this frame has offered, by the handle it issued for each. */
const REGISTRY = new Map<string, ScannedDropdown>();

/** Where the walk starts, and what it steps into. */
const CANDIDATE_SELECTOR = [
  'select',
  '[role="combobox"]',
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="true"]',
  // React-Select and the emotion-hashed variants of it that live ATSes ship.
  '.select__control',
  '[class*="react-select"] [class*="control"]',
  // A button that opens something holding choices. Filtered hard below —
  // `opensOptionList` is what stops an accordion header becoming a question.
  'button[aria-expanded]',
].join(', ');

/**
 * Every document to walk: this one, plus the open shadow roots inside it.
 *
 * A closed shadow root is genuinely unreachable and is not treated as a
 * failure — nothing can drive it, including the applicant's own screen reader.
 * Frames are *not* descended into here: each frame runs its own copy of this
 * pass, so that a control is always discovered and driven by the same document.
 */
function scopesOf(root: Document | ShadowRoot): Array<Document | ShadowRoot> {
  const scopes: Array<Document | ShadowRoot> = [root];
  const queue = [...root.querySelectorAll<HTMLElement>('*')];
  for (const element of queue) {
    const shadow = element.shadowRoot;
    if (!shadow) continue;
    scopes.push(shadow);
    queue.push(...shadow.querySelectorAll<HTMLElement>('*'));
  }
  return scopes;
}

/**
 * Whether this element answers from a list of choices.
 *
 * Deliberately the same tests the scanner uses rather than a second opinion:
 * a control this pass calls a dropdown and the scanner calls a text box would
 * be driven two different ways on the same page. `isTypedTextControl` runs
 * first for the reason it does everywhere — a live ATS renders "Legal First
 * Name" as `input[role=combobox]`, and opening a menu over it is how a name
 * ends up matched against a list of countries.
 */
/**
 * True when this element is some other control's popup rather than a control.
 *
 * A searchable combobox renders its results into a `[role="listbox"]` sitting
 * beside it in the markup, and that list is not a question — it is the answer
 * surface of the question next to it. Discovering it as a control of its own
 * invented an "Education" dropdown out of the section heading above it, opened
 * a list that by definition has nothing in it until somebody types, and spent
 * two and a half seconds proving so.
 *
 * Two signals, either of which settles it: something points at this element as
 * the popup it owns, or it is an empty list. An empty listbox is never a
 * question the applicant could answer, and one that fills later fills because
 * it belongs to a control that was driven.
 */
function isSomeonesPopup(element: HTMLElement, scope: Document | ShadowRoot): boolean {
  const id = element.id;
  if (id) {
    const escaped = id.replace(/["\\]/g, '\\$&');
    const owner = scope.querySelector(
      `[aria-controls~="${escaped}"], [aria-owns~="${escaped}"], [aria-activedescendant="${escaped}"]`,
    );
    if (owner && owner !== element) return true;
  }
  return element.querySelector('[role="option"], option') === null;
}

function isDropdownLike(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) return true;
  if (isTypedTextControl(element)) return false;
  if (element.getAttribute('role') === 'listbox') {
    const root = element.getRootNode();
    const scope: Document | ShadowRoot = root instanceof ShadowRoot ? root : element.ownerDocument;
    if (isSomeonesPopup(element, scope)) return false;
  }
  if (element instanceof HTMLInputElement) {
    // A searchable combobox is an input, and the only ones that qualify are the
    // ones that say their completions come from a list.
    return element.type !== 'hidden' && answersFromList(element);
  }
  if (element instanceof HTMLButtonElement) return opensOptionList(element);
  return isCustomCombobox(element);
}

/**
 * The heading and legend a control sits under.
 *
 * "Country" means one thing under "Home Address" and another under "Education",
 * and a page that asks both renders the identical word twice. Without this the
 * second one is answered from the first one's facts.
 */
function sectionContextOf(element: HTMLElement): string {
  const parts: string[] = [];
  const legend = element.closest('fieldset')?.querySelector(':scope > legend')?.textContent;
  if (legend) parts.push(legend);
  let current: Element | null = element;
  let hops = 0;
  while (current && hops < 8) {
    const heading = current.parentElement?.querySelector(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [role="heading"]',
    );
    const text = heading?.textContent?.replace(/\s+/g, ' ').trim();
    if (text && !parts.includes(text)) parts.push(text);
    current = current.parentElement;
    hops += 1;
  }
  return parts.join(' › ').slice(0, 600);
}

/**
 * Which repeated block this control is in.
 *
 * Counted from the sibling blocks that hold a control with the same accessible
 * name: a page with three education sections renders three "Area of Study"
 * menus, and answering all three from the first education record is worse than
 * leaving two of them alone. Absent when the page has only one block, which is
 * the overwhelmingly common case.
 */
function recordIndexOf(element: HTMLElement, label: string, scope: Document | ShadowRoot): number {
  if (!label) return 0;
  const peers = Array.from(scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).filter(
    (candidate) =>
      isDropdownLike(candidate) && extractAccessibleLabel(candidate).label.trim() === label.trim(),
  );
  const index = peers.indexOf(element);
  return index < 0 ? 0 : index;
}

/**
 * Whether another control produces this one's choices, and whether it has yet.
 *
 * Read from the control's own state rather than from a table of known field
 * pairs: a control that is disabled, or that offers nothing but a prompt, while
 * its form has an answered control of a governing kind above it, is waiting on
 * that control. Getting this wrong is only ever a reporting mistake — a
 * `BLOCKED` that should have been `FAILED_EXECUTION` — because nothing here
 * changes how the control is driven.
 */
function dependencyStateOf(element: HTMLElement, kind: DropdownKind): DropdownDependencyState {
  const empty =
    element instanceof HTMLSelectElement
      ? element.options.length <= 1
      : kind !== 'native_select' && readSelectedText(element).trim().length === 0;
  const disabled = isDisabled(element);
  if (!empty && !disabled) return 'independent';
  // A control that is empty or switched off *and* names a governing control is
  // waiting; one that is merely empty may simply not have been opened yet.
  const governed =
    element.hasAttribute('data-depends-on') ||
    element.getAttribute('aria-disabled') === 'true' ||
    disabled;
  return governed ? 'awaiting_parent' : 'independent';
}

function isDisabled(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if (element instanceof HTMLSelectElement || element instanceof HTMLInputElement) {
    return element.disabled;
  }
  const trigger = resolveTrigger(element);
  return trigger.matches(':disabled') || trigger.getAttribute('aria-disabled') === 'true';
}

/**
 * A `<select>` reached through a wrapper must not also be offered as its
 * wrapper. Both would be driven, the second over the first's own answer.
 */
function isRedundant(element: HTMLElement, chosen: readonly HTMLElement[]): boolean {
  return chosen.some(
    (existing) =>
      existing !== element && (existing.contains(element) || resolveTrigger(existing) === element),
  );
}

export interface ScannedDropdown {
  descriptor: DropdownDescriptor;
  element: HTMLElement;
}

/**
 * Every option control in this document, described but not touched.
 *
 * Nothing here opens a menu, focuses a control, or writes anything. A page that
 * is only scanned must look, to the applicant, exactly as it did before — and a
 * discovery pass that opened nine menus to see what was in them would be
 * indistinguishable from the agent flailing.
 */
export function scanDropdowns(root: Document): readonly ScannedDropdown[] {
  const found: ScannedDropdown[] = [];
  const elements: HTMLElement[] = [];

  for (const scope of scopesOf(root)) {
    for (const candidate of scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
      if (isExtensionOwned(candidate)) continue;
      if (!isDropdownLike(candidate)) continue;
      // A `<select>` is exempt from the visibility test for the same reason the
      // executor exempts it: a styled form routinely hides the real control
      // behind its own trigger, and that control is still the thing to drive.
      if (!(candidate instanceof HTMLSelectElement) && !isVisibleControl(candidate)) continue;
      if (elements.includes(candidate)) continue;
      elements.push(candidate);
    }
  }

  for (const element of elements) {
    if (isRedundant(element, elements)) continue;
    const scope = element.getRootNode();
    const owner: Document | ShadowRoot =
      scope instanceof ShadowRoot ? scope : element.ownerDocument;
    const { label } = extractAccessibleLabel(element);
    const kind = classifyDropdown(element);
    const dropdownId = `dropdown-${crypto.randomUUID()}`;
    const recordIndex = recordIndexOf(element, label, owner);
    const scanned: ScannedDropdown = {
      element,
      descriptor: dropdownDescriptorSchema.parse({
        dropdownId,
        // Replaced by the worker, which is the only side that knows frame ids.
        frameId: 0,
        label: label.slice(0, 600),
        selector: selectorFor(element),
        sectionContext: sectionContextOf(element),
        required:
          element.getAttribute('aria-required') === 'true' ||
          (element instanceof HTMLSelectElement && element.required) ||
          /\*\s*$/.test(label.trim()),
        controlStrategy: kind,
        currentValue: readSelectedText(element).slice(0, 600),
        disabled: isDisabled(element),
        dependencyState: dependencyStateOf(element, kind),
        ...(recordIndex > 0 ? { recordIndex } : {}),
      }),
    };
    REGISTRY.set(dropdownId, scanned);
    found.push(scanned);
  }

  return found;
}

/** The control behind a handle, or nothing when it has left the page. */
export function dropdownById(dropdownId: string): HTMLElement | null {
  const entry = REGISTRY.get(dropdownId);
  if (!entry) return null;
  return entry.element.isConnected ? entry.element : null;
}

/**
 * What this frame said about a control when it offered it.
 *
 * Kept beside the element so a result can report the question and the widget
 * shape without the worker having to send them back down and without this frame
 * re-deriving them — two readings of the same label that could disagree is one
 * reading too many.
 */
export function descriptorById(dropdownId: string): DropdownDescriptor | null {
  return REGISTRY.get(dropdownId)?.descriptor ?? null;
}

/**
 * Forgets every handle issued so far.
 *
 * Called when a pass begins, so a stale id from a previous run against a page
 * that has since navigated cannot resolve to anything.
 */
export function resetDropdownRegistry(): void {
  REGISTRY.clear();
}
