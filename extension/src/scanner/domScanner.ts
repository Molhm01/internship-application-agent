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
  sectionFromHeading,
  type DetectedField,
  type FieldOption,
  type FieldSection,
  type FieldType,
  type SemanticType,
} from '@internship-agent/shared';

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

export function isVisibleControl(element: HTMLElement): boolean {
  if (element.hidden || element.closest('[hidden], [aria-hidden="true"], template')) return false;
  if (isInput(element) && element.type.toLowerCase() === 'hidden') return false;
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
function opensOptionList(element: HTMLElement): boolean {
  // `aria-haspopup` — of any kind, including `dialog` for a date picker — is
  // the element declaring itself a widget trigger. That declaration is enough;
  // it is the *absence* of one that leaves a bare `aria-expanded` ambiguous.
  if (element.hasAttribute('aria-haspopup')) return true;
  const controls = cleanText(element.getAttribute('aria-controls')).split(' ')[0];
  const region = controls ? element.ownerDocument.getElementById(controls) : null;
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
  // A disclosure that opens no list is an accordion header. Its fields are
  // scanned in their own right once it is expanded.
  if (element.hasAttribute('aria-expanded') && !opensOptionList(element)) return true;
  return false;
}

function shouldIgnore(element: HTMLElement): boolean {
  // Before every other test: an element the extension put on the page is not
  // part of the employer's form, however control-like it looks.
  if (isExtensionOwned(element)) return true;
  if (isPageFurniture(element)) return true;
  if (!isVisibleControl(element) || isHoneypot(element)) return true;
  // A radiogroup is the container for its radios; scanning both would report
  // the same question twice, once with no options.
  if (CONTAINER_ROLES.has(element.getAttribute('role') ?? '')) return true;
  // React Select's inner text input is the search box of a control this scan
  // already found. The control root carries the label and the options.
  if (
    isInput(element) &&
    element.closest('.select__control, [class*="react-select"], [class*="css-"][class*="-control"]')
  ) {
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
      .map((id) => element.ownerDocument.getElementById(id)?.textContent)
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

function inferType(element: HTMLElement, grouped = false): FieldType {
  if (isTextArea(element)) return 'textarea';
  if (isSelect(element)) return element.multiple ? 'multi_select' : 'select';
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
    return value ? first.ownerDocument.getElementById(value) : null;
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
 * Validation wording that means "this one is still needed".
 *
 * Taleo says "Information needed" and "Manual response required" rather than
 * marking the input, so these are read as a requirement in their own right.
 */
const REQUIRED_TEXT =
  /(^|\s)\*(\s|$)|\brequired\b|\bmandatory\b|\bthis field is needed\b|\binformation needed\b|\bmanual response required\b|\bplease (complete|answer|provide)\b|\bcannot be (blank|empty)\b|\bmust be (completed|answered|provided)\b/i;

/**
 * Containers that wrap exactly one question.
 *
 * `fieldset` is deliberately absent. A fieldset groups several questions, so
 * reading its text for an asterisk marks every field in the group required as
 * soon as one of them is — on the iCIMS fixture that made "Middle Name"
 * required because "First Name *" sits beside it. A legend's *own* asterisk is
 * still honoured below; what is excluded is the rest of the group's text.
 */
const REQUIRED_CONTAINER_SELECTOR =
  'label, .field, .form-field, .iCIMS_InfoField, [data-automation-id*="formField"], [data-qa*="field"], [class*="required"], [class*="mandatory"]';

function isRequired(element: HTMLElement, label: string): boolean {
  if ((isInput(element) || isTextArea(element) || isSelect(element)) && element.required) {
    return true;
  }
  if (element.getAttribute('aria-required') === 'true') return true;
  // An invalid control is one the page has already refused to accept.
  if (element.getAttribute('aria-invalid') === 'true') return true;

  const container = element.closest(REQUIRED_CONTAINER_SELECTOR);
  // The legend of the enclosing group, read on its own. "Required information"
  // as a legend applies to every field under it, which is a real pattern; the
  // rest of the group's text is not.
  const legend = element.closest('fieldset')?.querySelector(':scope > legend') ?? null;

  // A required marker on the control, its own container, or that legend.
  for (const candidate of [element, container, legend]) {
    if (!candidate) continue;
    const className =
      typeof candidate.className === 'string'
        ? candidate.className
        : candidate.getAttribute('class');
    if (className && REQUIRED_CLASS.test(className)) return true;
    if (candidate.querySelector('[class*="asterisk"], [class*="required-indicator"]')) return true;
  }

  const containerText = cleanText(container?.textContent);
  const legendText = cleanText(legend?.textContent);
  return REQUIRED_TEXT.test(`${label} ${containerText} ${legendText}`);
}

function nearestHeading(element: HTMLElement): string {
  const fieldsetLegend = cleanText(
    element.closest('fieldset')?.querySelector(':scope > legend')?.textContent,
  );
  if (fieldsetLegend) return fieldsetLegend;

  let current: Element | null = element.parentElement;
  while (current && current !== element.ownerDocument.body) {
    const heading = current.querySelector<HTMLElement>(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"], :scope > .section-title, :scope > [data-automation-id*="sectionTitle"]',
    );
    const value = cleanText(heading?.textContent);
    if (value) return value;
    current = current.parentElement;
  }

  let previous: Element | null = element;
  while ((previous = previous.previousElementSibling)) {
    if (/^H[1-6]$/.test(previous.tagName) || previous.getAttribute('role') === 'heading') {
      return cleanText(previous.textContent);
    }
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

function selectorFor(element: HTMLElement): string {
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
    required: elements.some((element) => isRequired(element, label)),
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
    ...(helpText ? { helpText } : {}),
    ...(validationText ? { validationText } : {}),
    confidence,
    sourceSignals,
    warnings,
    metadata: {
      tagName: first.tagName.toLowerCase(),
      frameUrl: first.ownerDocument.location?.href,
      groupedControls: elements.length,
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
      const field = fieldFromElements(elements, pageId);
      // A group that produced no field was matched by the selector but is not a
      // question — a heading, a container, a control with nothing answerable.
      if (!field) {
        census.falseControlsRemoved += elements.length;
        continue;
      }
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

  if (fields.length === 0) warnings.push('No eligible application fields were found.');
  if (fields.some((field) => field.sourceSignals.includes('unlabelled'))) {
    warnings.push('One or more controls have no accessible label.');
  }
  return { fields, warnings, census };
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
