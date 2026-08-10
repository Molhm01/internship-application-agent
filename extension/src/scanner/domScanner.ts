import {
  EXTENSION_OWNED_SELECTOR,
  FILLABLE_FIELD_TYPES,
  OPTION_FIELD_TYPES,
  contextualQuestionLabel,
  detectedFieldSchema,
  matchCanonicalQuestion,
  normalizeLabel,
  questionIdentity,
  sectionForQuestion,
  type CanonicalQuestion,
  sectionFromHeading,
  type DetectedField,
  type FieldOption,
  type FieldSection,
  type FieldType,
  type RequiredSource,
  type SemanticType,
} from '@internship-agent/shared';
import { elementById, readSelectedText, scopeOf } from './optionDiscovery.js';

/**
 * An element's id-bound partner, looked for in the tree it actually lives in.
 *
 * `ownerDocument.getElementById` was used everywhere below, and inside an open
 * shadow root it can never succeed: ids are scoped per tree, so a shadow-rooted
 * control's `aria-labelledby`, its `label[for]`, and the listbox it names in
 * `aria-controls` are all invisible from the document. The control was then
 * unlabelled, which is how a perfectly ordinary combobox inside a web component
 * was dropped from the scan entirely — never filled, never failed, simply
 * absent from the report while sitting unanswered on the page.
 */
function relatedById(element: HTMLElement, id: string): HTMLElement | null {
  return elementById(scopeOf(element), id);
}

export interface DomScanResult {
  fields: DetectedField[];
  warnings: string[];
  /**
   * What the scan discarded, and why, in counts only.
   *
   * "Twenty-seven fields detected" was never enough to diagnose anything: it
   * could not distinguish a page with twenty-seven questions from one with
   * twenty questions, four section headings, and three controls counted twice.
   * The three numbers below are what separate those, and they are the first
   * three lines of the run trace.
   */
  census: ScanCensus;
}

export interface ScanCensus {
  /** Every element matching the control selector, before any filtering. */
  rawControls: number;
  /** Controls rejected as not being questions — extension UI, headings, navigation. */
  falseControlsRemoved: number;
  /** Distinct controls that collapsed onto a question already recorded. */
  duplicateControlsRemoved: number;
}

/**
 * Every control a person can answer through, not only the ones HTML calls
 * inputs. ATS forms routinely render a dropdown as a `button` that owns a
 * popover, and React Select renders one as a `div` with no ARIA role at all.
 * Anything omitted here is invisible to the whole pipeline, so this list is the
 * single widest gate in the product.
 */
const CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  // ARIA widget roles.
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="radiogroup"]',
  '[role="switch"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  // A button that opens a list of choices is a dropdown, whatever it is built
  // from. `aria-haspopup` and `aria-expanded` are how such a control announces
  // itself to assistive technology, so they are how we find it too.
  'button[aria-haspopup="listbox"]',
  'button[aria-haspopup="menu"]',
  'button[aria-haspopup="dialog"][aria-expanded]',
  'button[aria-expanded][aria-controls]',
  // React Select and its many forks. The root carries the accessible name; the
  // inner input is a search box, not the question.
  '.select__control',
  '[class*="-control"][class*="css-"]',
  '[class*="react-select"] [class*="control"]',
].join(',');

/** Roles whose element is a container for other controls, not a control. */
const CONTAINER_ROLES = new Set(['radiogroup']);

/**
 * Input types that are never a question.
 *
 * `password` used to be here, which is why a Taleo sign-in page reported one
 * field: the username was found and the password was discarded, so the page
 * could not even be recognized as a login. A password is scanned like any other
 * control; what protects it is that only the credential vault can fill it.
 */
const IGNORED_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);
const APPLICATION_HINT =
  /\b(apply|application|candidate|education|experience|resume|cover|name|email|phone|address|school|degree|work|eligib|sponsor|gender|veteran|disabil)/i;
const SEARCH_HINT = /\b(search|site search|navigation|newsletter|promo|coupon)\b/i;

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function safeStyle(element: Element): CSSStyleDeclaration | null {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
  } catch {
    return null;
  }
}

function isInput(element: Element): element is HTMLInputElement {
  return element.tagName === 'INPUT';
}

function isTextArea(element: Element): element is HTMLTextAreaElement {
  return element.tagName === 'TEXTAREA';
}

function isSelect(element: Element): element is HTMLSelectElement {
  return element.tagName === 'SELECT';
}

/**
 * A file input the page hides on purpose and drives from a styled button.
 *
 * This is the standard upload control on every ATS worth naming: the real
 * `<input type="file">` is `display:none`, and a button calls `.click()` on it.
 * Treating it as invisible meant the scanner reported no upload field at all on
 * a page that plainly showed two, so the run attached nothing and truthfully
 * said it had nothing to attach.
 *
 * Narrow on purpose. A hidden *file* input is a control the user is expected to
 * populate through some other affordance; a hidden text input is a form's own
 * bookkeeping and is still ignored. `type="hidden"` is not a file input and is
 * excluded before this is ever consulted.
 */
function isButtonDrivenFileInput(element: HTMLElement): boolean {
  return isInput(element) && element.type.toLowerCase() === 'file' && !element.disabled;
}

export function isVisibleControl(element: HTMLElement): boolean {
  if (element.hidden || element.closest('[hidden], [aria-hidden="true"], template')) return false;
  if (isInput(element) && element.type.toLowerCase() === 'hidden') return false;
  // Checked before the style rules below, and only for file inputs.
  if (isButtonDrivenFileInput(element)) return true;
  const style = safeStyle(element);
  if (
    style &&
    (style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') === 0)
  ) {
    return false;
  }
  return true;
}

function isHoneypot(element: HTMLElement): boolean {
  const descriptor = [
    element.id,
    element.getAttribute('name'),
    element.getAttribute('class'),
    element.getAttribute('autocomplete'),
    element.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ');
  if (/\b(honeypot|honey-pot|trap|bot-field|website-url-confirm|fax-number)\b/i.test(descriptor)) {
    return true;
  }
  const style = element.getAttribute('style') ?? '';
  return /left\s*:\s*-\d{3,}px|top\s*:\s*-\d{3,}px/i.test(style);
}

/**
 * True when this element belongs to the extension rather than to the employer.
 *
 * Checked against the whole ancestor chain, and across shadow boundaries, so
 * one mark on the outermost node covers everything the extension renders. This
 * is what stops "Enable AI Autofill" — a control the extension itself put on
 * the page — from being reported as an application question.
 */
export function isExtensionOwned(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.closest(EXTENSION_OWNED_SELECTOR)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/**
 * True when a `button[aria-expanded][aria-controls]` really opens a list of
 * choices, rather than merely expanding a section.
 *
 * The two are indistinguishable by ARIA attributes alone, and treating every
 * disclosure as a dropdown is how iCIMS's accordion header "Addresses (1)*
 * required." became an application question — twice. A control is a dropdown
 * only when the region it controls actually holds options.
 */
export function opensOptionList(element: HTMLElement): boolean {
  // `aria-haspopup` — of any kind, including `dialog` for a date picker — is
  // the element declaring itself a widget trigger. That declaration is enough;
  // it is the *absence* of one that leaves a bare `aria-expanded` ambiguous.
  if (element.hasAttribute('aria-haspopup')) return true;
  const controls = cleanText(element.getAttribute('aria-controls')).split(' ')[0];
  const region = controls ? relatedById(element, controls) : null;
  if (!region) return false;
  const role = region.getAttribute('role');
  if (role === 'listbox' || role === 'menu') return true;
  if (region.matches('select, datalist')) return true;
  // `[role="option"]` only — deliberately not a bare `option` element. An
  // accordion panel full of form controls contains plenty of `<option>` tags,
  // each belonging to a `<select>` inside it rather than to the button that
  // expanded the panel. Counting those is what turned "Addresses (1)" and
  // "Highest Level of Education" into questions of their own.
  return region.querySelector('[role="option"], [role="listbox"]') !== null;
}

/**
 * True when the element is a section heading, a validation summary, or another
 * piece of page furniture that happens to be focusable.
 *
 * A container is never a question. It becomes one only when it owns a real
 * supported control, and that control is reported instead of the container.
 */
function isPageFurniture(element: HTMLElement): boolean {
  if (element.tagName !== 'BUTTON' && element.getAttribute('role') !== 'button') return false;
  // `role="combobox"` is the element stating that it answers from a list of
  // choices, and no accordion header carries it. That statement stands on its
  // own, because the evidence `opensOptionList` looks for is exactly what a
  // lazily-mounted dropdown does not have yet: its `aria-controls` names a
  // listbox the page does not create until the control is opened. Such a
  // control was classified as a disclosure and dropped from the scan entirely
  // — the question never reached the planner, never reached the executor, and
  // was simply absent from the report while sitting unanswered on the page.
  const role = element.getAttribute('role');
  if (role === 'combobox' || role === 'listbox') return false;
  // A disclosure that opens no list is an accordion header. Its fields are
  // scanned in their own right once it is expanded.
  if (element.hasAttribute('aria-expanded') && !opensOptionList(element)) return true;
  return false;
}

/**
 * True when another control declares this element as its popup.
 *
 * Matched on the id, through `aria-controls` or `aria-owns`, because those are
 * exactly how a combobox tells assistive technology "that list belongs to me".
 * An element with no id cannot be referenced and is therefore never owned.
 */
function isOwnedPopup(element: HTMLElement): boolean {
  const id = element.id;
  if (!id) return false;
  const escaped = cssEscape(id);
  return (
    element.ownerDocument.querySelector(
      `[role="combobox"][aria-controls~="${escaped}"], [role="combobox"][aria-owns~="${escaped}"], [aria-haspopup="listbox"][aria-controls~="${escaped}"]`,
    ) !== null
  );
}

/** The root of a React Select-style widget, as its own generated classes name it. */
const REACT_SELECT_ROOT_SELECTOR =
  '.select__control, [class*="react-select"], [class*="css-"][class*="-control"]';

function shouldIgnore(element: HTMLElement): boolean {
  // Before every other test: an element the extension put on the page is not
  // part of the employer's form, however control-like it looks.
  if (isExtensionOwned(element)) return true;
  if (isPageFurniture(element)) return true;
  if (!isVisibleControl(element) || isHoneypot(element)) return true;
  // A radiogroup is the container for its radios; scanning both would report
  // the same question twice, once with no options.
  if (CONTAINER_ROLES.has(element.getAttribute('role') ?? '')) return true;
  // A listbox some combobox points at is that combobox's popup, not a second
  // question. Without this, a searchable Country control is reported twice —
  // once as the input the user types into and once as the list it opens — and
  // the run then tries to fill "Country" in two places, verifying neither.
  //
  // A listbox nobody points at is still a control in its own right, which is
  // why this is scoped to the reference rather than to the role.
  if (element.getAttribute('role') === 'listbox' && isOwnedPopup(element)) return true;
  // React Select's inner text input is the search box of a control this scan
  // already found. The control root carries the label and the options.
  //
  // Scoped to a strict *ancestor*, via `parentElement`. `closest` includes the
  // element itself, so an `<input type="text" class="select__control">` — a
  // plain text box that merely inherits a styling class, which is what an ATS
  // ships for "Legal First Name" — was dropped from the scan entirely. It was
  // not reported as unsupported or unmatched; it simply was not there, and the
  // user was told the field could not be filled.
  if (isInput(element) && element.parentElement?.closest(REACT_SELECT_ROOT_SELECTOR)) {
    return true;
  }
  // An input inside a combobox the scan already reports is that combobox's
  // editable part, not a second question.
  if (isInput(element)) {
    const owner = element.parentElement?.closest('[role="combobox"], [role="listbox"]');
    if (owner) return true;
  }
  if (
    isInput(element) &&
    (IGNORED_INPUT_TYPES.has(element.type.toLowerCase()) || element.disabled)
  ) {
    return true;
  }
  if ((isTextArea(element) || isSelect(element)) && element.disabled) {
    return true;
  }
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if (element.hasAttribute('readonly') && !isCustomCombobox(element)) return true;
  const descriptor = [
    element.id,
    element.getAttribute('name'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ');
  if (
    element.closest('nav, header, [role="navigation"], [role="search"]') &&
    SEARCH_HINT.test(descriptor) &&
    !APPLICATION_HINT.test(descriptor)
  ) {
    return true;
  }
  return SEARCH_HINT.test(descriptor) && !APPLICATION_HINT.test(descriptor);
}

function cssEscape(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function textByIds(element: HTMLElement, attribute: string): string {
  const ids = cleanText(element.getAttribute(attribute)).split(' ').filter(Boolean);
  return cleanText(
    ids
      .map((id) => relatedById(element, id)?.textContent)
      .filter(Boolean)
      .join(' '),
  );
}

interface LabelResult {
  label: string;
  signals: string[];
}

/** Containers an ATS wraps one question in. */
const FIELD_CONTAINER_SELECTOR =
  '[data-automation-id*="formField"], [data-qa*="field"], .field, .form-field, .application-question, .application-field, .questions, .question, [role="group"], fieldset';

/**
 * The accessible name of a control, in the order a screen reader would resolve
 * it — with one deliberate departure: `placeholder` is consulted **last**.
 *
 * A placeholder is a hint, not a label. Treating it as the primary name is how
 * "e.g. Jane" ends up being matched as the question, so it is only used when
 * nothing else named the control at all.
 */
export function extractAccessibleLabel(element: HTMLElement): LabelResult {
  const id = element.id;
  if (id) {
    const explicit = element.ownerDocument.querySelector<HTMLLabelElement>(
      `label[for="${cssEscape(id)}"]`,
    );
    const label = cleanText(explicit?.textContent);
    if (label) return { label, signals: ['label_for'] };
  }

  const wrapped = element.closest('label');
  const wrappedText = cleanText(wrapped?.textContent);
  if (wrappedText) return { label: wrappedText, signals: ['wrapped_label'] };

  const aria = cleanText(element.getAttribute('aria-label'));
  if (aria) return { label: aria, signals: ['aria_label'] };

  const labelled = textByIds(element, 'aria-labelledby');
  if (labelled) return { label: labelled, signals: ['aria_labelledby'] };

  const legend = cleanText(
    element.closest('fieldset')?.querySelector(':scope > legend')?.textContent,
  );
  if (legend) return { label: legend, signals: ['fieldset_legend'] };

  const container = element.closest(FIELD_CONTAINER_SELECTOR);
  const containerLabel = cleanText(
    container?.querySelector(
      'label, legend, .label, .question, [data-automation-id*="label"], [class*="label"]',
    )?.textContent,
  );
  if (containerLabel) return { label: containerLabel, signals: ['container_label'] };

  // Walk backwards through siblings: many forms put the question in a bare
  // <p> or <div> immediately above the control.
  let previous: Element | null = element;
  for (let steps = 0; steps < 3 && (previous = previous.previousElementSibling); steps += 1) {
    const text = cleanText(previous.textContent);
    if (text && text.length <= 500) return { label: text, signals: ['preceding_sibling'] };
  }

  const heading = nearestHeading(element);
  if (heading) return { label: heading, signals: ['section_heading'] };

  const placeholder = cleanText(element.getAttribute('placeholder'));
  if (placeholder) return { label: placeholder, signals: ['placeholder'] };

  return {
    label: cleanText(element.getAttribute('name') ?? element.id),
    signals: ['unlabelled'],
  };
}

/** Text near the control that is not its label: hints, examples, limits. */
function nearbyDescription(element: HTMLElement): string {
  const container = element.closest(FIELD_CONTAINER_SELECTOR);
  if (!container) return '';
  const parts = Array.from(
    container.querySelectorAll<HTMLElement>(
      'p, small, .hint, .help, .helper, .description, [class*="hint"], [class*="help"], [class*="description"]',
    ),
  )
    .map((node) => cleanText(node.textContent))
    .filter((text) => text.length > 0 && text.length <= 600);
  return [...new Set(parts)].join(' ').slice(0, 1500);
}

/** Wording around a file input that says which document belongs in it. */
function uploadInstructions(element: HTMLElement): string {
  if (!(isInput(element) && element.type.toLowerCase() === 'file')) return '';
  const accept = cleanText(element.getAttribute('accept'));
  const container = element.closest(FIELD_CONTAINER_SELECTOR) ?? element.parentElement;
  const text = cleanText(container?.textContent).slice(0, 800);
  return [text, accept ? `accepts ${accept}` : ''].filter(Boolean).join(' — ');
}

/**
 * Where the control lives relative to the top document. An empty array means
 * the main document; entries name each nested frame or shadow host in order, so
 * the report can say *where* a field was found rather than only that it was.
 */
function locationPath(element: HTMLElement): { framePath: string[]; shadowPath: string[] } {
  const framePath: string[] = [];
  const shadowPath: string[] = [];

  let root: Node | null = element.getRootNode();
  let current: HTMLElement | null = element;
  while (root instanceof ShadowRoot) {
    const host = root.host;
    shadowPath.unshift(host.tagName.toLowerCase() + (host.id ? `#${host.id}` : ''));
    current = host as HTMLElement;
    root = current.getRootNode();
  }

  let view: Window | null = current?.ownerDocument.defaultView ?? null;
  while (view?.parent && view.parent !== view) {
    try {
      const frame: Element | null = view.frameElement;
      if (!frame) break;
      framePath.unshift(frame.getAttribute('src') ?? frame.tagName.toLowerCase());
      view = view.parent;
    } catch {
      framePath.unshift('cross-origin-frame');
      break;
    }
  }

  return { framePath, shadowPath };
}

/** True when the element is a custom dropdown built from something else. */
export function isCustomCombobox(element: HTMLElement): boolean {
  const role = element.getAttribute('role');
  if (role === 'combobox' || role === 'listbox') return true;
  if (element.matches('.select__control, [class*="react-select"] [class*="control"]')) return true;
  // A button is a dropdown only when it opens something holding choices. A bare
  // `aria-expanded` + `aria-controls` pair is just as often an accordion, and
  // reading one as a combobox invents a question out of a section heading.
  if (element.tagName === 'BUTTON' && opensOptionList(element)) return true;
  // Emotion-hashed React Select roots: `css-1abcde-control`.
  return /(^|\s)css-[a-z0-9]+-control(\s|$)/.test(element.className || '');
}

/**
 * The DOM types that are typed into, whatever the page says about them.
 *
 * This list is consulted *before* any ARIA role or CSS class, and that ordering
 * is the whole repair. `isCustomCombobox` used to run first, and a live ATS
 * renders its autocomplete as `<input type="text" role="combobox">` — so
 * "Legal First Name" was classified `combobox`, `ALLOWED_ACTIONS.combobox`
 * permits `select_option`, no contract violation was raised, and the executor
 * searched a list of choices that does not exist and reported
 * *"No option on the page matched 'Molhm'"* for a box you simply type into.
 */
const TYPED_INPUT_TYPES = new Set(['text', 'email', 'tel', 'number', 'url', 'search', '']);

/**
 * True when this element is written into rather than chosen from, judged from
 * the element itself.
 *
 * Two exceptions, both of which really are choice controls wearing an input's
 * clothes:
 *
 *  - a `readonly` input, which cannot be typed into at all, so calling it text
 *    would leave it permanently blank;
 *  - an input that answers from a list of choices, which it says in one of two
 *    ways: it owns a popup that exists now (`aria-haspopup`, or `aria-controls`
 *    pointing at a real listbox), or it declares `aria-autocomplete="list"`.
 *
 * The second half of that is not redundant. A searchable Location box renders no
 * listbox at all until it receives a query — the element `aria-controls` names
 * does not exist yet — and the same is true of a State control whose options
 * appear only once Country is chosen. `aria-autocomplete` is the platform's own
 * statement that this input's completions come from a list, and it is the only
 * evidence available before the user has typed.
 *
 * What is deliberately *not* enough is `role="combobox"` on its own, or a
 * React-Select-shaped class name. Those are what "Legal First Name" carries on a
 * live ATS, and taking them as evidence of a list is what sent a first name to
 * an option matcher that reported *"No option on the page matched 'Molhm'"*. The
 * question is not "does this announce itself as a combobox" but "is there a list
 * of choices to answer from" — which is precisely the condition under which
 * option matching can succeed.
 */
export function isTypedTextControl(element: HTMLElement): boolean {
  if (isTextArea(element)) return !element.readOnly;
  if (!isInput(element)) return false;
  if (element.readOnly) return false;
  if (!TYPED_INPUT_TYPES.has(element.type.toLowerCase())) return false;
  return !answersFromList(element);
}

/** True when this input takes its answer from a list rather than from typing. */
export function answersFromList(element: HTMLElement): boolean {
  const autocomplete = element.getAttribute('aria-autocomplete');
  if (autocomplete === 'list' || autocomplete === 'both') return true;
  return opensOptionList(element);
}

function inferType(element: HTMLElement, grouped = false): FieldType {
  if (isSelect(element)) return element.multiple ? 'multi_select' : 'select';
  // Before every role and class test. The DOM node's own type is the ground
  // truth about how a control is answered; ARIA describes how it is announced.
  if (isTypedTextControl(element)) {
    if (isTextArea(element)) return 'textarea';
    switch ((element as HTMLInputElement).type.toLowerCase()) {
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'number':
        return 'number';
      case 'url':
        return 'url';
      // `text`, `search`, and a missing `type` are all a plain text box.
      default:
        return 'text';
    }
  }
  if (isTextArea(element)) return 'textarea';
  if (element.isContentEditable) return 'contenteditable';
  if (element.getAttribute('role') === 'radiogroup') return 'radio';
  if (element.getAttribute('role') === 'switch') return 'checkbox';
  if (element.getAttribute('role') === 'textbox') return 'text';
  if (element.getAttribute('role') === 'spinbutton') return 'number';
  if (isCustomCombobox(element)) {
    return element.getAttribute('aria-multiselectable') === 'true' ? 'multi_select' : 'combobox';
  }
  if (!isInput(element)) return 'unknown';
  switch (element.type.toLowerCase()) {
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    // Reported as its own type rather than collapsed into `date`. A month
    // control rejects a full ISO date, so the planner has to know which shape
    // to produce; collapsing them wrote "2027-05-01" into a box that only
    // accepts "2027-05" and the browser silently discarded it.
    case 'month':
      return 'month';
    case 'url':
      return 'url';
    case 'password':
      return 'password';
    case 'file':
      return 'file';
    case 'radio':
      return 'radio';
    case 'checkbox':
      return grouped ? 'multi_select' : 'checkbox';
    case 'text':
    case '':
      return 'text';
    default:
      return 'unknown';
  }
}

function selectedValue(
  element: HTMLElement,
  fieldType: FieldType,
): string | string[] | boolean | undefined {
  if (fieldType === 'file') {
    const input = element as HTMLInputElement;
    return input.files ? Array.from(input.files, (file) => file.name) : [];
  }
  if (isSelect(element)) {
    return element.multiple
      ? Array.from(element.selectedOptions, (option) => option.value)
      : element.value;
  }
  if (isInput(element)) {
    if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
    return element.value;
  }
  if (isTextArea(element)) return element.value;
  if (element.isContentEditable) return cleanText(element.textContent);
  // A custom option control holds no value; its answer exists only as the text
  // it renders. Reading it is what lets a conditional child see that its custom
  // parent has been answered — and reading nothing is what left "If other,
  // enter School" unfillable beside a School combobox showing "Other School".
  //
  // Only for controls that are answered by *choosing*: everything else has
  // already returned above, and treating an arbitrary element's text as its
  // value would report a paragraph of page copy as somebody's answer.
  if (OPTION_FIELD_TYPES.includes(fieldType)) {
    const displayed = cleanText(readSelectedText(element));
    return displayed.length > 0 ? displayed : undefined;
  }
  return undefined;
}

function optionsFor(elements: HTMLElement[], fieldType: FieldType): FieldOption[] | undefined {
  const first = elements[0];
  if (!first) return undefined;
  // Only a control that is *answered by choosing* may carry options.
  //
  // Without this gate the custom-dropdown search below ran for every control,
  // including plain text inputs — and its last resort looks for
  // `[class*="menu"]` among the control's siblings, which on a real ATS page
  // matches a navigation menu. A "First Name" box therefore came back with an
  // option list it had no business having, the planner matched the saved name
  // against those options, and the executor reported "No option on the page
  // matched Molhm" for a field you type into.
  if (!OPTION_FIELD_TYPES.includes(fieldType)) return undefined;
  if (isSelect(first)) {
    return Array.from(first.options, (option) => ({
      label: cleanText(option.textContent),
      value: option.value,
      ...(option.selected ? { selected: true } : {}),
    }));
  }
  if (fieldType === 'radio' || fieldType === 'multi_select') {
    // Only real inputs carry group options. A custom multi-select combobox is a
    // single button whose choices live in a listbox it has not opened yet;
    // treating it as an input invented one option labelled with the question
    // itself, which then looked like a complete option list to the planner.
    const inputs = elements.filter(
      (element): element is HTMLInputElement =>
        element instanceof HTMLInputElement &&
        (element.type === 'radio' || element.type === 'checkbox'),
    );
    if (inputs.length === 0) return undefined;
    return inputs.map((input) => {
      const label = extractAccessibleLabel(input).label || input.value;
      return { label, value: input.value, ...(input.checked ? { selected: true } : {}) };
    });
  }
  // A single checkbox is answered by ticking it, not by picking from a list.
  if (fieldType === 'checkbox') return undefined;
  // A custom dropdown announces its list through `aria-controls` or
  // `aria-owns`, or renders it as a descendant. Each is tried; the first that
  // yields real options wins. When none does, the options genuinely are not on
  // the page yet and the executor reads them at fill time.
  const readOptions = (list: Element | null | undefined): FieldOption[] | undefined => {
    if (!list) return undefined;
    const found = Array.from(list.querySelectorAll<HTMLElement>('[role="option"], option'))
      .map((option) => ({
        label: cleanText(option.textContent),
        value:
          option.getAttribute('data-value') ??
          option.getAttribute('value') ??
          cleanText(option.textContent),
        ...(option.getAttribute('aria-selected') === 'true' || option.matches(':checked')
          ? { selected: true }
          : {}),
        ...(option.getAttribute('aria-disabled') === 'true' || option.hasAttribute('disabled')
          ? { disabled: true }
          : {}),
      }))
      .filter((option) => option.label.length > 0);
    return found.length ? found : undefined;
  };

  const byId = (attribute: string): Element | null => {
    const value = cleanText(first.getAttribute(attribute)).split(' ')[0];
    return value ? relatedById(first, value) : null;
  };

  return (
    readOptions(byId('aria-controls')) ??
    readOptions(byId('aria-owns')) ??
    readOptions(first.querySelector('[role="listbox"]')) ??
    // React Select renders its menu as a sibling of the control inside the
    // shared container, so the popover is found from the parent, not the root.
    readOptions(first.parentElement?.querySelector('[class*="menu"], [role="listbox"]'))
  );
}

/**
 * Class names ATSs use to mark a required control.
 *
 * Taleo in particular renders the asterisk as a separate styled span outside
 * the label text, so a purely textual check misses it and the field silently
 * becomes optional — which is how required fields ended up ignored.
 */
const REQUIRED_CLASS = /\b(required|mandatory|is-required|reqfield|asterisk)\b/i;

/**
 * A required marker in a label's own words.
 *
 * Deliberately much narrower than the wording this replaced, which also read
 * "information needed", "manual response required", "please complete" and
 * "cannot be blank". Every one of those is a *validation message*, and a
 * validation message near a control says the page rejected something, not that
 * this control is mandatory. Reading them as a requirement is how a validation
 * summary listing two missing fields made every control beside it required.
 */
const REQUIRED_MARKER_TEXT = /\*|\brequired\b|\bmandatory\b/i;

/** Nodes that carry a page's complaint rather than a control's own caption. */
const VALIDATION_NODE_SELECTOR =
  '[role="alert"], [role="status"], .error, .validation, .validation-summary, [class*="error"], [class*="validation"], [data-automation-id*="error"]';

/** Attributes an ATS uses to declare a control mandatory. */
const ATS_REQUIRED_ATTRIBUTES = ['data-required', 'data-is-required', 'data-mandatory'] as const;

/** Containers an employer wraps a single question in. */
const FIELD_WRAPPER_SELECTOR =
  'label, .field, .form-field, .iCIMS_InfoField, [data-automation-id*="formField"], [data-qa*="field"], [class*="fieldEntry"], [class*="_fieldEntry"]';

/**
 * The innermost employer container that holds this control (or this group) and
 * nothing else answerable.
 *
 * Exclusivity is the whole point. A container holding several questions cannot
 * say which of them an asterisk belongs to, and assuming it belongs to all of
 * them is precisely how "Middle Name" became required because "First Name *"
 * sat beside it inside the same fieldset.
 */
function exclusiveContainer(elements: readonly HTMLElement[]): HTMLElement | null {
  const first = elements[0];
  if (!first) return null;
  const selector = `${FIELD_WRAPPER_SELECTOR}, fieldset, [role="radiogroup"], [role="group"]`;
  let container = first.closest<HTMLElement>(selector);
  // Climb until the container holds the *whole* group. Each option of a radio
  // group is wrapped in its own `<label>`, so the innermost wrapper holds one
  // option and could never see the legend that asks the question.
  while (container && !elements.every((element) => container?.contains(element))) {
    container = container.parentElement?.closest<HTMLElement>(selector) ?? null;
  }
  if (!container || isExtensionOwned(container)) return null;
  const others = Array.from(container.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
    (candidate) => !elements.includes(candidate) && !shouldIgnore(candidate),
  );
  return others.length === 0 ? container : null;
}

/** True when this element itself declares a requirement in vendor metadata. */
function hasAtsRequiredMetadata(element: Element): boolean {
  for (const attribute of ATS_REQUIRED_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value !== null && value !== 'false') return true;
  }
  if (/required/i.test(element.getAttribute('data-automation-id') ?? '')) return true;
  const className =
    typeof element.className === 'string'
      ? element.className
      : (element.getAttribute('class') ?? '');
  return REQUIRED_CLASS.test(className);
}

/**
 * A label node's own text, with validation messages and any nested control
 * stripped out.
 *
 * A wrapping `<label>` around a radio group contains every option's words, and
 * a field container often contains the page's complaint about the field. Neither
 * is the caption, and neither may contribute an asterisk.
 */
function captionText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const noise of clone.querySelectorAll(`${VALIDATION_NODE_SELECTOR}, ${CONTROL_SELECTOR}`)) {
    noise.remove();
  }
  return cleanText(clone.textContent);
}

/** True when a caption node carries a required marker of any kind. */
function hasRequiredMarker(node: Element): boolean {
  if (
    node.querySelector(
      '[class*="asterisk"], [class*="required-indicator"], abbr[title*="required" i]',
    )
  ) {
    return true;
  }
  return REQUIRED_MARKER_TEXT.test(captionText(node));
}

/**
 * The caption nodes bound to this exact control — and to no other.
 *
 * `label[for]`, a wrapping `<label>`, and `aria-labelledby` are bindings the
 * platform itself resolves, so a marker in one of them is unambiguously about
 * this control. The exclusive container's own caption is included because that
 * is where an ATS puts the asterisk when it renders it outside the `<label>`.
 * Nothing else is consulted: not a heading, not a sibling field, not the rest of
 * a shared fieldset.
 */
function associatedCaptions(
  elements: readonly HTMLElement[],
  container: HTMLElement | null,
): Element[] {
  const nodes = new Set<Element>();
  for (const element of elements) {
    if (element.id) {
      const explicit = scopeOf(element).querySelector(`label[for="${cssEscape(element.id)}"]`);
      if (explicit) nodes.add(explicit);
    }
    const wrapped = element.closest('label');
    if (wrapped) nodes.add(wrapped);
    for (const id of cleanText(element.getAttribute('aria-labelledby'))
      .split(' ')
      .filter(Boolean)) {
      const target = relatedById(element, id);
      if (target) nodes.add(target);
    }
  }
  if (container) {
    if (container.matches('fieldset')) {
      const legend = container.querySelector(':scope > legend');
      if (legend) nodes.add(legend);
    } else {
      for (const caption of container.querySelectorAll(
        'label, legend, .label, .question, [class*="label"]',
      )) {
        nodes.add(caption);
      }
    }
  }
  return [...nodes].filter((node) => !isExtensionOwned(node));
}

export interface RequiredEvidence {
  required: boolean;
  source: RequiredSource;
}

/**
 * Whether this control (or group) is required, and on what evidence.
 *
 * Strictly ordered, strongest first, and every step is scoped to the control
 * itself or to a structure that provably contains nothing else. What is
 * deliberately absent: `aria-invalid` (a rejection, not a requirement), section
 * heading text, sibling fields, and validation messages.
 */
export function requiredEvidence(elements: readonly HTMLElement[]): RequiredEvidence {
  const grouped = elements.length > 1;
  const groupSource: RequiredSource = grouped ? 'group_requirement' : 'associated_visual_marker';

  // 1 & 2 — the native property, then the bare attribute for controls that are
  // not form elements and therefore have no property to read.
  for (const element of elements) {
    if ((isInput(element) || isTextArea(element) || isSelect(element)) && element.required) {
      return { required: true, source: 'native_required' };
    }
    if (element.hasAttribute('required')) {
      return { required: true, source: 'native_required' };
    }
  }

  // 3 — the accessibility declaration.
  for (const element of elements) {
    if (element.getAttribute('aria-required') === 'true') {
      return { required: true, source: 'aria_required' };
    }
  }

  // 4 — vendor metadata on the control itself.
  for (const element of elements) {
    if (hasAtsRequiredMetadata(element)) return { required: true, source: 'ats_metadata' };
  }

  const container = exclusiveContainer(elements);

  // 5 — a requirement attached to the actual group, never to a shared ancestor.
  if (container) {
    if (container.getAttribute('aria-required') === 'true') {
      return { required: true, source: grouped ? 'group_requirement' : 'aria_required' };
    }
    if (hasAtsRequiredMetadata(container)) {
      return { required: true, source: grouped ? 'group_requirement' : 'ats_metadata' };
    }
  }

  // 6 — a visible marker inside a caption bound to this exact control.
  for (const caption of associatedCaptions(elements, container)) {
    if (hasRequiredMarker(caption)) return { required: true, source: groupSource };
  }

  return { required: false, source: 'none' };
}

/** Elements an employer uses to head a section. Legends are handled separately. */
const HEADING_SELECTOR =
  'h1, h2, h3, h4, h5, h6, [role="heading"], .section-title, [class*="sectionTitle"], [data-automation-id*="sectionTitle"], [data-automation-id*="sectionHeader"]';

/** Employer-owned structures that own the controls inside them. */
const SECTION_CONTAINER_SELECTOR =
  'fieldset, section, [role="region"], [role="group"], [role="radiogroup"], [data-automation-id*="section" i]';

/**
 * The last heading inside a node, or the node's own text when it *is* a
 * heading.
 *
 * Legends are excluded deliberately: a legend belongs to its own fieldset and to
 * nothing after it, so borrowing one for the next control down the page names a
 * section that ended.
 */
function headingWithin(node: Element): string {
  if (isExtensionOwned(node)) return '';
  if (node.matches(HEADING_SELECTOR)) return cleanText(node.textContent);
  const found = node.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const candidate = found[index];
    if (!candidate || isExtensionOwned(candidate)) continue;
    const text = cleanText(candidate.textContent);
    if (text) return text;
  }
  return '';
}

/**
 * The section heading that actually governs this control.
 *
 * The previous implementation asked each ancestor for *any* direct-child
 * heading, via `querySelector`, which returns the first in document order
 * regardless of where the control sits. On a form whose direct children include
 * `<h2>Professional Experience</h2>` and `<h2>Education</h2>`, every control not
 * wrapped in a fieldset — the whole Phones block, the whole Addresses block, and
 * all of Education — came back headed "Professional Experience". That is the
 * root cause of the section-context failures: "Type" under Phones never saw a
 * phone heading, so it never became `phone_type`, and the two "Type" controls on
 * the page were indistinguishable.
 *
 * Resolution order, each step naming the *nearest* employer-owned structure:
 *
 *  1. the control's own fieldset legend;
 *  2. the accessible name of the nearest section container — which is how an
 *     ATS accordion says "these controls belong to the panel that header opened"
 *     (`role="region"` + `aria-labelledby`), and the only way to reach an
 *     accordion header that is a `<button>` rather than an `<h*>`;
 *  3. the nearest heading *preceding* the control, walking outward through
 *     earlier siblings at each level.
 *
 * Extension-owned nodes can never supply a heading at any step.
 */
function nearestHeading(element: HTMLElement): string {
  const fieldsetLegend = cleanText(
    element.closest('fieldset')?.querySelector(':scope > legend')?.textContent,
  );
  if (fieldsetLegend) return fieldsetLegend;

  const section = element.closest<HTMLElement>(SECTION_CONTAINER_SELECTOR);
  if (section && !isExtensionOwned(section)) {
    const labelled = textByIds(section, 'aria-labelledby');
    if (labelled) return labelled;
    const aria = cleanText(section.getAttribute('aria-label'));
    if (aria) return aria;
  }

  let node: Element | null = element;
  const body = element.ownerDocument.body;
  while (node && node !== body) {
    for (
      let sibling: Element | null = node.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      const text = headingWithin(sibling);
      if (text) return text;
    }
    node = node.parentElement;
  }
  return '';
}

function semanticFromCanonical(
  canonical: ReturnType<typeof matchCanonicalQuestion>['question'],
): SemanticType | undefined {
  const direct: Partial<Record<typeof canonical, SemanticType>> = {
    first_name: 'first_name',
    middle_name: 'middle_name',
    last_name: 'last_name',
    preferred_name: 'preferred_name',
    email: 'email',
    phone: 'phone',
    city: 'city',
    state: 'state',
    postal_code: 'postal_code',
    country: 'country',
    linkedin: 'linkedin',
    github: 'github',
    portfolio: 'portfolio',
    website: 'website',
    school: 'school',
    degree: 'degree',
    major: 'major',
    gpa: 'gpa',
    graduation_date: 'graduation_date',
    resume: 'resume',
    cover_letter: 'cover_letter',
    work_authorization: 'work_authorization',
    sponsorship_required: 'sponsorship',
  };
  if (canonical in direct) return direct[canonical];
  if (
    [
      'address_line1',
      'address_line2',
      'full_name',
      'pronouns',
      'gender',
      'race_ethnicity',
      'veteran_status',
      'disability_status',
      'sexual_orientation',
    ].includes(canonical)
  ) {
    return canonical.startsWith('address') ? 'address' : 'demographic';
  }
  return canonical === 'unknown' ? undefined : 'other';
}

/**
 * A stable CSS path for a control, preferring whatever the page already names it
 * by. Exported because the dropdown scanner records one per control for its own
 * diagnostics — it is never sent to the worker and never used to reach a control
 * the frame did not itself volunteer.
 */
export function selectorFor(element: HTMLElement): string {
  if (element.id) return `#${cssEscape(element.id)}`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  const automation = element.getAttribute('data-automation-id');
  if (automation) {
    return `${element.tagName.toLowerCase()}[data-automation-id="${cssEscape(automation)}"]`;
  }
  const parent = element.parentElement;
  if (!parent) return element.tagName.toLowerCase();
  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  return `${selectorFor(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${
    siblings.indexOf(element) + 1
  })`;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `field-${(hash >>> 0).toString(36)}`;
}

function helpAndValidation(element: HTMLElement): {
  helpText?: string;
  validationText?: string;
} {
  const described = textByIds(element, 'aria-describedby');
  const container = element.closest('.field, .form-field, [data-automation-id*="formField"]');
  const helper = cleanText(
    container?.querySelector('.help, .hint, .helper, [data-automation-id*="help"]')?.textContent,
  );
  const error = cleanText(
    container?.querySelector('.error, .validation, [role="alert"], [data-automation-id*="error"]')
      ?.textContent,
  );
  return {
    ...(described || helper ? { helpText: described || helper } : {}),
    ...(error ? { validationText: error } : {}),
  };
}

/**
 * The question text for a group of radios or checkboxes.
 *
 * Tried in order: the fieldset legend, the radiogroup's own accessible name,
 * and the field container's label. Each option's own `<label>` is deliberately
 * excluded — an option label is an answer, not the question.
 */
function groupQuestionLabel(first: HTMLElement): LabelResult | null {
  const legend = cleanText(
    first.closest('fieldset')?.querySelector(':scope > legend')?.textContent,
  );
  if (legend) return { label: legend, signals: ['fieldset_legend'] };

  const container = first.closest(FIELD_CONTAINER_SELECTOR);
  // A label in the container that does not wrap an option is the container's
  // own caption — the question a person actually reads. It is preferred over a
  // group `aria-label`, which is usually a terse screen-reader abbreviation
  // ("Work eligibility") of a much more specific visible question.
  const candidate = Array.from(
    container?.querySelectorAll<HTMLElement>('label, legend, .label, .question') ?? [],
  ).find((node) => !node.contains(first));
  const text = cleanText(candidate?.textContent);
  if (text) return { label: text, signals: ['container_label'] };

  const group = first.closest('[role="radiogroup"], [role="group"]');
  if (group) {
    const aria = cleanText(group.getAttribute('aria-label'));
    if (aria) return { label: aria, signals: ['aria_label'] };
    const labelled = textByIds(group as HTMLElement, 'aria-labelledby');
    if (labelled) return { label: labelled, signals: ['aria_labelledby'] };
  }

  return null;
}

function fieldFromElements(elements: HTMLElement[], pageId: string): DetectedField | null {
  const first = elements[0];
  if (!first) return null;
  const grouped = elements.length > 1;
  const type = inferType(first, grouped);
  // The question a radio or checkbox group asks is the group's label, never the
  // label of its first option. "Yes" is an answer; it is not the question.
  const groupLabel = grouped ? groupQuestionLabel(first) : null;
  const accessible = groupLabel ?? extractAccessibleLabel(first);
  const label = accessible.label;
  const normalizedLabel = normalizeLabel(label);
  const heading = nearestHeading(first);
  // A one-word label under a repeating block ("Type" under "Phones (1)") is not
  // a question on its own. The heading supplies the missing half *before*
  // canonical matching, so "Type" resolves to phone_type rather than to nothing
  // — and so the two "Type" controls on the page stop being indistinguishable.
  const contextualLabel = contextualQuestionLabel(label, heading);
  const match = matchCanonicalQuestion(contextualLabel);
  const headingSection = sectionFromHeading(heading);
  const section: FieldSection =
    headingSection ?? (match.question === 'unknown' ? 'other' : sectionForQuestion(match.question));
  const sourceSignals = [...accessible.signals];
  if (headingSection) sourceSignals.push('section_heading');
  if (match.question !== 'unknown') sourceSignals.push('canonical_rule');
  const warnings: string[] = [];
  if (!label) warnings.push('No accessible label was detected.');
  const confidence = Math.min(
    1,
    (label ? 0.55 : 0.15) +
      (accessible.signals[0] === 'label_for' || accessible.signals[0] === 'aria_label'
        ? 0.2
        : 0.1) +
      (match.question !== 'unknown' ? 0.2 : 0) +
      (type !== 'unknown' ? 0.05 : 0),
  );
  if (confidence < 0.5) warnings.push('Low-confidence field detection.');
  const selector = selectorFor(first);
  const { framePath, shadowPath } = locationPath(first);
  const value =
    grouped && (type === 'radio' || type === 'multi_select')
      ? elements
          .filter((element) => (element as HTMLInputElement).checked)
          .map((element) => (element as HTMLInputElement).value)
      : selectedValue(first, type);
  const { helpText, validationText } = helpAndValidation(first);
  const required = requiredEvidence(elements);

  return detectedFieldSchema.parse({
    id: stableId(`${pageId}|${selector}|${normalizedLabel}`),
    pageId,
    label,
    normalizedLabel,
    ...(match.question !== 'unknown' ? { canonicalKey: match.question } : {}),
    question: label,
    fieldType: type,
    ...(semanticFromCanonical(match.question)
      ? { semanticType: semanticFromCanonical(match.question) }
      : {}),
    selector,
    required: required.required,
    requiredSource: required.source,
    visible: true,
    disabled: false,
    ...(value !== undefined ? { currentValue: value } : {}),
    ...(optionsFor(elements, type) ? { options: optionsFor(elements, type) } : {}),
    section,
    ...(cleanText(first.getAttribute('placeholder'))
      ? { placeholder: cleanText(first.getAttribute('placeholder')) }
      : {}),
    ...(first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement
      ? {
          ...(first.minLength >= 0 ? { minLength: first.minLength } : {}),
          ...(first.maxLength >= 0 ? { maxLength: first.maxLength } : {}),
        }
      : {}),
    // The control's stated format. Carried as text so a date formatter can tell
    // a control that wants a day from one that does not, instead of guessing.
    ...(cleanText(first.getAttribute('pattern'))
      ? { pattern: cleanText(first.getAttribute('pattern')) }
      : {}),
    ...(cleanText(first.getAttribute('min')) ? { min: cleanText(first.getAttribute('min')) } : {}),
    ...(cleanText(first.getAttribute('max')) ? { max: cleanText(first.getAttribute('max')) } : {}),
    ...(helpText ? { helpText } : {}),
    ...(validationText ? { validationText } : {}),
    confidence,
    sourceSignals,
    warnings,
    metadata: {
      tagName: first.tagName.toLowerCase(),
      frameUrl: first.ownerDocument.location?.href,
      groupedControls: elements.length,
      // The radio/checkbox group this question is answered through, so the
      // executor addresses the group rather than one member of it, and so two
      // groups sharing a caption stay two questions.
      ...(grouped && first.getAttribute('name') ? { groupName: first.getAttribute('name') } : {}),
      readOnly: true,
      // Context the resolver and the model both read. Recorded here rather than
      // folded into the label so the label stays the question the page asked.
      ...(first.getAttribute('name') ? { name: first.getAttribute('name') } : {}),
      ...(first.id ? { elementId: first.id } : {}),
      ...(first.getAttribute('autocomplete')
        ? { autocomplete: first.getAttribute('autocomplete') }
        : {}),
      ...(first.getAttribute('role') ? { role: first.getAttribute('role') } : {}),
      ...(heading ? { sectionHeading: heading } : {}),
      // The question as it reads once its section is folded in. Kept beside the
      // label rather than replacing it, so the user still sees the words the
      // page used while everything downstream reads the unambiguous version.
      ...(contextualLabel !== label ? { contextualLabel } : {}),
      ...(nearbyDescription(first) ? { nearbyText: nearbyDescription(first) } : {}),
      ...(uploadInstructions(first) ? { uploadInstructions: uploadInstructions(first) } : {}),
      ...(framePath.length ? { framePath } : {}),
      ...(shadowPath.length ? { shadowPath } : {}),
    },
  });
}

function collectRoots(document: Document, warnings: string[]): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  const seen = new Set<Document | ShadowRoot>(roots);
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    if (!root) continue;
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      // The extension's own overlay is a shadow host too. Descending into it
      // would scan the agent's UI as though it were the employer's form.
      if (element.closest(EXTENSION_OWNED_SELECTOR)) continue;
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
      try {
        const frameDocument = frame.contentDocument;
        if (frameDocument && !seen.has(frameDocument)) {
          seen.add(frameDocument);
          roots.push(frameDocument);
        } else if (frame.src) {
          warnings.push(`IFRAME_INACCESSIBLE: ${frame.src}`);
        }
      } catch {
        warnings.push(`IFRAME_INACCESSIBLE: ${frame.src || 'embedded frame'}`);
      }
    }
  }
  return roots;
}

/**
 * How many real choices a field offers, ignoring placeholders.
 *
 * Used to break a tie between two detections of the same question: the one that
 * actually read the page's choices is the more useful record of it.
 */
function informationScore(field: DetectedField): number {
  return (field.options?.length ?? 0) * 10 + field.confidence;
}

/**
 * The invariant that no normalized field may come from the extension's own DOM.
 *
 * `shouldIgnore` already refuses every extension-owned element, so reaching this
 * means a filter was bypassed — a new UI surface that forgot the marker, or a
 * control the extension moved into the page. Both are defects that would publish
 * the agent's own affordances as employer questions ("Enable AI Autofill" was
 * reported as an application question exactly this way), so the field is dropped
 * and the scan says so rather than quietly shipping it.
 */
export function extensionOwnedViolation(elements: readonly HTMLElement[]): boolean {
  return elements.some((element) => isExtensionOwned(element));
}

/**
 * The invariant that one DOM control produces at most one normalized field.
 *
 * Throws rather than warns. Two fields addressing one control means the run will
 * write it twice and verify neither, and reporting both as answered is a lie the
 * rest of the pipeline has no way to detect.
 */
function claimControls(
  owners: Map<HTMLElement, string>,
  elements: readonly HTMLElement[],
  fieldId: string,
): void {
  for (const element of elements) {
    const existing = owners.get(element);
    if (existing !== undefined) {
      throw new Error(
        `Scanner produced two fields for one control: ${existing} and ${fieldId} both address <${element.tagName.toLowerCase()}>.`,
      );
    }
    owners.set(element, fieldId);
  }
}

/**
 * One synchronous pass over the page.
 *
 * Exported because counting how many blocks a repeating section is showing has
 * to happen *between* two DOM mutations, and the asynchronous `scanDom` waits
 * for the page to settle first — so by the time it answered, the question had
 * moved on. A caller polling for a newly added block needs the answer now.
 */
export function scanDomOnce(document: Document, pageId: string): DomScanResult {
  return scanOnce(document, pageId);
}

/**
 * How many blocks of a repeating section the page is currently showing.
 *
 * Counted by the same rule that numbers them: the Nth "Company Name" belongs to
 * the Nth employer, so the highest record index any of this section's questions
 * carries, plus one, is the block count. Synchronous, because it is polled
 * while an Add button's effect is being waited for.
 */
export function countRepeatedBlocks(
  document: Document,
  section: 'experience' | 'education' | 'projects',
  pageId = 'repeat-count',
): number {
  const { fields } = scanOnce(document, pageId);
  let highest = -1;
  let seen = false;
  for (const field of fields) {
    if (!field.canonicalKey) continue;
    if (sectionForQuestion(field.canonicalKey) !== section) continue;
    seen = true;
    highest = Math.max(highest, field.recordIndex ?? 0);
  }
  return seen ? highest + 1 : 0;
}

function scanOnce(document: Document, pageId: string): DomScanResult {
  const warnings: string[] = [];
  const roots = collectRoots(document, warnings);
  const fields: DetectedField[] = [];
  const seenElements = new WeakSet<HTMLElement>();
  /**
   * One entry per question, keyed by an identity built from what the employer's
   * markup names it — `name`, element id, canonical key, frame path — rather
   * than by the label alone.
   *
   * Keyed this way because the old key was `selector|label|type`, which cannot
   * tell that an accordion header and the select it expands are one question:
   * their selectors differ, so both survived and "Highest Level of Education"
   * was reported twice. It also could not tell two genuinely different
   * questions apart when they shared a label, which the identity can.
   */
  const byIdentity = new Map<string, DetectedField>();
  /** Which field claimed each control, so no control can be claimed twice. */
  const controlOwners = new Map<HTMLElement, string>();
  const census: ScanCensus = {
    rawControls: 0,
    falseControlsRemoved: 0,
    duplicateControlsRemoved: 0,
  };

  for (const root of roots) {
    const matched = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
    const candidates = matched.filter((element) => !shouldIgnore(element));
    census.rawControls += matched.length;
    census.falseControlsRemoved += matched.length - candidates.length;
    const groups = new Map<string, HTMLElement[]>();

    for (const candidate of candidates) {
      if (seenElements.has(candidate)) continue;
      if (
        isInput(candidate) &&
        (candidate.type === 'radio' || candidate.type === 'checkbox') &&
        candidate.name
      ) {
        const key = `${candidate.type}:${candidate.name}`;
        const group = candidates.filter(
          (other) =>
            isInput(other) && other.type === candidate.type && other.name === candidate.name,
        );
        groups.set(key, group);
        for (const item of group) seenElements.add(item);
      } else {
        groups.set(selectorFor(candidate), [candidate]);
        seenElements.add(candidate);
      }
    }

    for (const elements of groups.values()) {
      // Asserted here rather than trusted from `shouldIgnore`, so a future
      // extension surface that forgets the marker fails loudly instead of being
      // published as an employer question.
      if (extensionOwnedViolation(elements)) {
        census.falseControlsRemoved += elements.length;
        warnings.push('EXTENSION_OWNED_CONTROL_REJECTED: agent UI reached the field scan.');
        continue;
      }
      const field = fieldFromElements(elements, pageId);
      // A group that produced no field was matched by the selector but is not a
      // question — a heading, a container, a control with nothing answerable.
      if (!field) {
        census.falseControlsRemoved += elements.length;
        continue;
      }
      claimControls(controlOwners, elements, field.id);
      const key = questionIdentity(field);
      const existing = byIdentity.get(key);
      if (existing) census.duplicateControlsRemoved += 1;
      // The richer detection wins. Keeping the first would discard the version
      // that read the page's real choices whenever the poorer one was found
      // earlier in document order.
      if (!existing || informationScore(field) > informationScore(existing)) {
        byIdentity.set(key, field);
      }
    }
  }

  fields.push(...byIdentity.values());
  markEmbeddedPhoneCodeControls(fields, controlOwners);
  // Children first: a conditional child must already be marked as one before
  // the records are numbered, because it must not consume a slot.
  markConditionalChildren(fields);
  markRepeatedRecords(document, fields);

  if (fields.length === 0) warnings.push('No eligible application fields were found.');
  if (fields.some((field) => field.sourceSignals.includes('unlabelled'))) {
    warnings.push('One or more controls have no accessible label.');
  }
  return { fields, warnings, census };
}

/**
 * The question a block of each kind cannot be without, most reliable first.
 *
 * An employer block always names the employer; an education block always names
 * the school. When a form omits the first, the next is tried — a work-history
 * block with only a job title is still a block.
 */
const ANCHOR_QUESTIONS: Record<
  'experience' | 'education' | 'projects',
  readonly CanonicalQuestion[]
> = {
  experience: ['employer', 'job_title', 'employment_start_date'],
  education: ['school', 'education_type', 'degree', 'major'],
  projects: ['project_name', 'project_description'],
};

/** The element a selector names, in any of this document's roots. */
function findBySelector(document: Document, selector: string): HTMLElement | null {
  for (const root of collectRoots(document, [])) {
    try {
      const found = root.querySelector<HTMLElement>(selector);
      if (found) return found;
    } catch {
      // A selector the browser will not parse names nothing. Not an error here:
      // the field simply gets no record index and is answered as a single block.
    }
  }
  return null;
}

/**
 * The element that holds this anchor and no other anchor of the same kind.
 *
 * Walks up from the control while the ancestor still contains exactly one
 * anchor, and stops at the last one that does — which is the repeated block,
 * whatever tag the vendor wrapped it in.
 */
function blockContainerFor(
  document: Document,
  anchorElement: HTMLElement,
  anchorElements: readonly HTMLElement[],
): HTMLElement | null {
  let best: HTMLElement | null = null;
  let current: HTMLElement | null = anchorElement.parentElement;
  while (current && current !== document.body) {
    const holder = current;
    const held = anchorElements.filter((element) => holder.contains(element)).length;
    if (held !== 1) break;
    best = holder;
    current = holder.parentElement;
  }
  return best;
}

/**
 * Numbers the controls of a repeating block, so the second Employer block is
 * answered from the second saved job rather than from the first one again.
 *
 * A block is found from its *anchor* — the one question a block of this kind
 * cannot be without: an employer for a job, a school for an education row, a
 * name for a project. Every field inside the element that holds the Nth anchor
 * belongs to the Nth record.
 *
 * This used to count raw occurrences instead, on the reasoning that the Nth
 * "Company Name" belongs to the Nth employer. It does — but the Nth *graduation
 * date* does not necessarily belong to the Nth school: a form that asks for one
 * graduation twice, once as a date picker and once as free text, was read as two
 * education records, and the second control was reported as a block the
 * applicant had no record for. Anchors are what tell a repeated block from a
 * repeated question.
 *
 * Restricted to the three sections that genuinely repeat. A page with two
 * "Email Address" controls is a page with a confirmation box, not a second
 * applicant, and numbering those would invent a record that does not exist.
 */
function markRepeatedRecords(document: Document, fields: DetectedField[]): void {
  for (const section of ['experience', 'education', 'projects'] as const) {
    const anchorKey = ANCHOR_QUESTIONS[section].find((candidate) =>
      fields.some((field) => field.canonicalKey === candidate && !field.dependsOn),
    );
    if (!anchorKey) continue;

    const anchors = fields.filter((field) => field.canonicalKey === anchorKey && !field.dependsOn);
    // One anchor is one block, and a page with one block needs no numbering at
    // all. This is also what keeps a form that asks the *same* question twice
    // in two formats — "Degree Completion Date" beside "Anticipated Degree
    // Completion Date" — from being read as two education records.
    if (anchors.length < 2) continue;

    const anchorElements = anchors
      .map((anchor) => findBySelector(document, anchor.selector))
      .filter((element): element is HTMLElement => element !== null);
    const blocks: HTMLElement[] = [];
    for (const anchor of anchors) {
      const element = findBySelector(document, anchor.selector);
      if (!element) continue;
      const block = blockContainerFor(document, element, anchorElements);
      if (block && !blocks.includes(block)) blocks.push(block);
    }
    if (blocks.length < 2) continue;

    for (const [index, field] of fields.entries()) {
      if (field.dependsOn) continue;
      if (!field.canonicalKey || sectionForQuestion(field.canonicalKey) !== section) continue;
      const element = findBySelector(document, field.selector);
      if (!element) continue;
      const blockIndex = blocks.findIndex((block) => block.contains(element));
      // Index 0 is left implicit: nothing downstream has to special-case a page
      // whose sections each hold one block.
      if (blockIndex <= 0) continue;
      fields[index] = detectedFieldSchema.parse({ ...field, recordIndex: blockIndex });
    }
  }

  // A conditional child belongs to the block its parent is in.
  //
  // It was skipped above so it could not *consume* a slot — "If other, enter
  // School" is the same question as the School dropdown, not a second school —
  // but it still has to be answered from the same record. Without this it fell
  // back to the first education row, so the second block's "If other" box was
  // filled with the first block's school.
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const [index, field] of fields.entries()) {
    if (!field.dependsOn || field.recordIndex !== undefined) continue;
    const parentIndex = byId.get(field.dependsOn.fieldId)?.recordIndex;
    if (parentIndex === undefined) continue;
    fields[index] = detectedFieldSchema.parse({ ...field, recordIndex: parentIndex });
  }
}

/**
 * Wording that makes a control the child of the question above it.
 *
 * "If yes, …" and "If other, please specify" are the two the live forms use, and
 * both name their own activation value in the label. That is the whole signal:
 * the page is stating, in words, that this control applies only when the
 * previous question was answered a particular way.
 */
const CONDITIONAL_CHILD = /^if\s+(yes|no|other|another|none)\b/i;

/**
 * Links a conditional control to the question that switches it on.
 *
 * The parent is the nearest *preceding* control that offers choices, because
 * that is what "if yes" refers to — the question just asked. Nothing here reads
 * a value or fills anything; it records a relationship the planner and the
 * executor both refuse to act against.
 *
 * This is the repair for the worst thing the live run did: it typed the
 * applicant's own name into "If yes, provide the name, location and
 * relationship of each relative", because the label contains the word "name",
 * while the relatives question above it was never answered at all. The form
 * then stated to the employer that the applicant had a relative working there.
 */
function markConditionalChildren(fields: DetectedField[]): void {
  const offersChoices = (field: DetectedField): boolean =>
    field.fieldType === 'select' ||
    field.fieldType === 'radio' ||
    field.fieldType === 'combobox' ||
    field.fieldType === 'checkbox';

  for (const [index, field] of fields.entries()) {
    const match = CONDITIONAL_CHILD.exec(field.label.trim());
    if (!match?.[1]) continue;
    let parent: DetectedField | undefined;
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = fields[back];
      if (candidate && offersChoices(candidate)) {
        parent = candidate;
        break;
      }
    }
    // A conditional child with no question above it to depend on is left alone
    // rather than guessed at. It stays an ordinary field, and an ordinary field
    // with no saved answer is the user's.
    if (!parent) continue;
    fields[index] = detectedFieldSchema.parse({
      ...field,
      dependsOn: { fieldId: parent.id, value: match[1].toLowerCase() },
      // The parent's selector as well as its id, because the executor checks
      // this against the *live* page rather than against the scan: a field id
      // identifies a question, and only a selector finds the control.
      metadata: { ...field.metadata, dependsOnSelector: parent.selector },
    });
  }
}

/**
 * Records which phone country-code controls are part of the number's own widget.
 *
 * Two designs are indistinguishable from a field's own properties, and the
 * difference decides what goes in the number box:
 *
 *  - a *split* control, which the applicant answers separately — Greenhouse
 *    renders one as a `<button role="combobox">` in its own field block, whose
 *    choices appear only when it is opened, so a scan legitimately finds it
 *    with no options on it;
 *  - a *combined* widget, whose country chooser is drawn inside the number's
 *    control and cannot be answered on its own at all.
 *
 * Both are option controls with no scanned choices, so "has it any options?"
 * cannot tell them apart — and reading a split control as combined leaves the
 * dialling code off the application, while reading a combined one as split
 * strips "+1" from the number and puts it nowhere.
 *
 * What does tell them apart is where they sit, and that is observable only here,
 * with the elements in hand: the chooser and the number input are *siblings
 * inside one wrapper element*, which is what "rendered inside the number's own
 * control" means in markup. Deliberately that tight — a form or a fieldset also
 * contains both, and every split phone block in existence would match if the
 * search were allowed to walk that far up. Recorded as a fact about the page;
 * what to do about it is the planner's decision.
 */
function markEmbeddedPhoneCodeControls(
  fields: DetectedField[],
  controlOwners: Map<HTMLElement, string>,
): void {
  const elementsByField = new Map<string, HTMLElement[]>();
  for (const [element, fieldId] of controlOwners) {
    const owned = elementsByField.get(fieldId);
    if (owned) owned.push(element);
    else elementsByField.set(fieldId, [element]);
  }
  const numbers = fields
    .filter((field) => field.canonicalKey === 'phone')
    .flatMap((field) => elementsByField.get(field.id) ?? []);
  if (numbers.length === 0) return;

  for (const [index, field] of fields.entries()) {
    if (field.canonicalKey !== 'phone_country_code') continue;
    const embedded = (elementsByField.get(field.id) ?? []).some((element) => {
      if (numbers.some((number) => element.contains(number))) return true;
      const wrapper = element.parentElement;
      if (!wrapper || wrapper.matches('form, fieldset, section, body')) return false;
      return numbers.some((number) => wrapper.contains(number));
    });
    if (!embedded) continue;
    fields[index] = {
      ...field,
      metadata: { ...field.metadata, embeddedInPhoneControl: true },
    };
  }
}

async function waitForDomSettled(
  document: Document,
  signal: AbortSignal,
  quietMs = 120,
  maximumMs = 400,
): Promise<boolean> {
  if (signal.aborted) throw new DOMException('Scan cancelled', 'AbortError');
  return new Promise<boolean>((resolve, reject) => {
    let changed = false;
    let quietTimer: ReturnType<typeof setTimeout>;
    const maximumTimer = setTimeout(finish, maximumMs);
    const observer = new MutationObserver(() => {
      changed = true;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });

    function finish(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maximumTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(changed);
    }
    function onAbort(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maximumTimer);
      reject(new DOMException('Scan cancelled', 'AbortError'));
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    quietTimer = setTimeout(finish, quietMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The census of the most recent scan of each page.
 *
 * Kept here rather than returned through `AtsAdapter.scan`, whose contract is
 * `DetectedField[]` and is implemented by every vendor adapter. Widening that
 * signature would make eight adapters carry a diagnostic they have no part in
 * producing — they all reach these numbers through `scanDom`, which is the one
 * place the filtering and de-duplication actually happen.
 *
 * Keyed by page id so a stale entry can never be read as the current page's,
 * and bounded so a long-lived content script cannot grow it without limit.
 */
const CENSUS_BY_PAGE = new Map<string, ScanCensus>();
const CENSUS_LIMIT = 8;

function rememberCensus(pageId: string, census: ScanCensus): void {
  CENSUS_BY_PAGE.delete(pageId);
  CENSUS_BY_PAGE.set(pageId, census);
  while (CENSUS_BY_PAGE.size > CENSUS_LIMIT) {
    const oldest = CENSUS_BY_PAGE.keys().next().value;
    if (oldest === undefined) break;
    CENSUS_BY_PAGE.delete(oldest);
  }
}

/**
 * What the last scan of this page discarded, or zeroes if it has not been
 * scanned. Zeroes are honest here: nothing was discarded because nothing ran.
 */
export function censusForPage(pageId: string): ScanCensus {
  return (
    CENSUS_BY_PAGE.get(pageId) ?? {
      rawControls: 0,
      falseControlsRemoved: 0,
      duplicateControlsRemoved: 0,
    }
  );
}

export async function scanDom(
  document: Document,
  pageId: string,
  signal: AbortSignal,
): Promise<DomScanResult> {
  const first = scanOnce(document, pageId);
  const changed = await waitForDomSettled(document, signal);
  if (!changed) {
    rememberCensus(pageId, first.census);
    return first;
  }
  const next = scanOnce(document, pageId);
  rememberCensus(pageId, next.census);
  return {
    fields: next.fields,
    warnings: [
      ...new Set([...first.warnings, 'Dynamic fields changed during the scan.', ...next.warnings]),
    ],
    // The second census, because it describes the fields being returned. The
    // first one described a page that no longer exists.
    census: next.census,
  };
}

export function isSupportedField(field: DetectedField): boolean {
  return FILLABLE_FIELD_TYPES.includes(field.fieldType);
}

/**
 * Every control that could move the applicant somewhere: buttons, submit
 * inputs, and links.
 *
 * These are deliberately *not* returned as fields. A login button is not a
 * question, and counting it as one is how "New User" and "Apply as Guest" ended
 * up invisible while the page was reported as having a single field.
 */
export function collectNavigationControls(
  document: Document,
): Array<{ label: string; selector: string }> {
  const selector = [
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
  ].join(',');

  const seen = new Set<string>();
  const controls: Array<{ label: string; selector: string }> = [];
  for (const root of collectRoots(document, [])) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      // The agent's own buttons are not routes through the employer's site.
      if (isExtensionOwned(element)) continue;
      if (!isVisibleControl(element)) continue;
      const label = cleanText(
        element instanceof HTMLInputElement
          ? element.value || element.getAttribute('aria-label')
          : (element.textContent ?? element.getAttribute('aria-label')),
      ).slice(0, 200);
      if (!label) continue;
      const path = selectorFor(element);
      const key = `${label}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push({ label, selector: path });
    }
  }
  return controls;
}

/** How long the DOM must be quiet before a mutation-driven rescan is worth it. */
export const RESCAN_DEBOUNCE_MS = 400;
/** Never rescan more often than this, however busy the page is. */
export const RESCAN_MINIMUM_INTERVAL_MS = 1500;

export interface FormObserver {
  stop(): void;
}

/**
 * Calls back when the form has changed *and* then settled.
 *
 * Real applications mutate constantly — validation classes, focus rings,
 * analytics attributes. Reacting to each one would rescan forever, so this
 * filters to structural changes, debounces them, and enforces a floor between
 * callbacks. The caller stays responsible for bounding how many rescans it
 * actually performs.
 */
export function observeFormMutations(
  document: Document,
  onSettled: () => void,
  options: { debounceMs?: number; minimumIntervalMs?: number } = {},
): FormObserver {
  const debounceMs = options.debounceMs ?? RESCAN_DEBOUNCE_MS;
  const minimumIntervalMs = options.minimumIntervalMs ?? RESCAN_MINIMUM_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRun = 0;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastRun < minimumIntervalMs) {
      timer = setTimeout(fire, minimumIntervalMs - (now - lastRun));
      return;
    }
    lastRun = now;
    onSettled();
  };

  const observer = new MutationObserver((records) => {
    const structural = records.some(
      (record) =>
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches?.(CONTROL_SELECTOR) || node.querySelector?.(CONTROL_SELECTOR)),
        ),
    );
    if (!structural) return;
    clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  return {
    stop(): void {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
    },
  };
}
