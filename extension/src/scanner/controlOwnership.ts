/**
 * Finds the logical choice control that owns a DOM node.
 *
 * SuccessFactors commonly renders one question as a composite: an input used
 * for display/search plus a sibling or ancestor trigger that owns the list.
 * Classifying the input in isolation turns that one choice widget into a text
 * box. This module keeps the ownership judgement in one place so scanning,
 * observation, validation and execution all resolve the same control.
 */

const CHOICE_TRIGGER_SELECTOR = [
  '[role="combobox"]',
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="true"]',
  '[aria-expanded][aria-controls]',
  '[aria-expanded][aria-owns]',
  '.select__control',
  '[class*="react-select"]',
  '[class*="css-"][class*="-control"]',
].join(',');

const FIELD_BOUNDARY_SELECTOR = [
  '[data-automation-id*="formField"]',
  '[data-qa*="field"]',
  '.formField',
  '.field',
  '.form-field',
  '.application-question',
  '.application-field',
  '[role="group"]',
].join(',');

const SUCCESSFACTORS_CHOICE_AFFORDANCE =
  /(?:drop.?down|select|picker|combo|arrow.?down|down.?arrow|chevron.?down|navigation-down|value.?help)/i;
const CALENDAR_AFFORDANCE = /(?:calendar|date.?picker|date.?select)/i;

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function scopeOf(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root : element.ownerDocument;
}

function byId(element: Element, id: string): HTMLElement | null {
  const scope = scopeOf(element);
  const local = scope.getElementById(id);
  if (local instanceof HTMLElement) return local;
  const fallback = element.ownerDocument.getElementById(id);
  return fallback instanceof HTMLElement ? fallback : null;
}

function isSuccessFactorsDocument(document: Document): boolean {
  let hostname = '';
  try {
    hostname = document.location.hostname;
  } catch {
    // A fixture without a navigable location can still carry the adapter's DOM
    // marker, which is the same fallback used by adapter detection.
  }
  return (
    /(^|\.)(successfactors|sapsf)\.(com|eu)$/i.test(hostname) ||
    document.querySelector(
      '[class*="successFactors"], [id*="successFactors"], #careerSiteApplication',
    ) !== null
  );
}

function controlledOptionPopup(element: HTMLElement): boolean {
  const ids = clean(
    `${element.getAttribute('aria-controls') ?? ''} ${element.getAttribute('aria-owns') ?? ''}`,
  )
    .split(' ')
    .filter(Boolean);
  return ids.some((id) => {
    const popup = byId(element, id);
    if (!popup) return false;
    const role = popup.getAttribute('role');
    return (
      role === 'listbox' ||
      role === 'menu' ||
      popup.matches('select,datalist') ||
      popup.querySelector('[role="option"],[role^="menuitem"],option') !== null
    );
  });
}

function reactSelectShape(element: HTMLElement): boolean {
  // A class on an input is styling, not ownership. Live ATS text boxes inherit
  // these classes; the actual React-select root is a non-input container.
  if (element instanceof HTMLInputElement) return false;
  const classes = typeof element.className === 'string' ? element.className : '';
  return (
    element.matches('.select__control, [class*="react-select"]') ||
    /(^|\s)css-[a-z0-9]+-control(\s|$)/i.test(classes)
  );
}

/** Positive evidence that this node itself is a choice surface/trigger. */
export function hasDirectChoiceSemantics(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) return true;

  const popup = clean(element.getAttribute('aria-haspopup')).toLowerCase();
  if (popup === 'listbox' || popup === 'menu') return true;
  // ARIA 1.0 used `true` for a menu popup. It is admitted only when the active
  // adapter's own SuccessFactors evidence is present; elsewhere it is too
  // ambiguous to distinguish a menu from generic page chrome.
  if (popup === 'true' && isSuccessFactorsDocument(element.ownerDocument)) return true;
  if (controlledOptionPopup(element)) return true;
  if (reactSelectShape(element)) return true;

  const autocomplete = clean(element.getAttribute('aria-autocomplete')).toLowerCase();
  if (autocomplete === 'list' || autocomplete === 'both') return true;

  // `role=combobox` alone is authoritative on a non-input trigger. Some ATSes
  // incorrectly put it on every text input, so an editable input still needs
  // list/autocomplete evidence before it stops being a text box.
  const role = clean(element.getAttribute('role')).toLowerCase();
  if (!(element instanceof HTMLInputElement) && (role === 'combobox' || role === 'listbox')) {
    return true;
  }
  return false;
}

function dateShapedInput(element: HTMLInputElement): boolean {
  const type = element.type.toLowerCase();
  if (type === 'date' || type === 'month' || type === 'week' || type === 'datetime-local') {
    return true;
  }
  if (type !== 'text' && type !== 'tel' && type !== '') return false;
  const description = [
    element.placeholder,
    element.getAttribute('title'),
    element.getAttribute('aria-label'),
    element.getAttribute('data-format'),
    element.getAttribute('data-date-format'),
    element.getAttribute('pattern'),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    /m{1,2}\s*[-/]\s*d{1,2}\s*[-/]\s*y{2,4}/i.test(description) ||
    /y{4}\s*[-/]\s*m{1,2}(?:\s*[-/]\s*d{1,2})?/i.test(description) ||
    /\\d\{2\}.*\\d\{2\}.*\\d\{4\}/.test(description)
  );
}

function labelIdsForInput(input: HTMLInputElement): Set<string> {
  const ids = new Set(clean(input.getAttribute('aria-labelledby')).split(' ').filter(Boolean));
  if (input.id) {
    const escaped = input.id.replace(/["\\]/g, '\\$&');
    const label = input.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${escaped}"]`);
    if (label?.id) ids.add(label.id);
  }
  return ids;
}

function sharesAccessibleLabel(input: HTMLInputElement, trigger: HTMLElement): boolean {
  const inputIds = labelIdsForInput(input);
  if (inputIds.size === 0) return false;
  return clean(trigger.getAttribute('aria-labelledby'))
    .split(' ')
    .some((id) => inputIds.has(id));
}

function hasOwnAccessibleLabel(element: HTMLElement): boolean {
  if (clean(element.getAttribute('aria-label')).length > 0) return true;
  if (clean(element.getAttribute('aria-labelledby')).length > 0) return true;
  if (!element.id) return false;
  const escaped = element.id.replace(/["\\]/g, '\\$&');
  return element.ownerDocument.querySelector(`label[for="${escaped}"]`) !== null;
}

function choiceAffordanceText(element: HTMLElement): string {
  return clean(
    [
      element.id,
      element.className,
      element.getAttribute('role'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-testid'),
      element.getAttribute('data-automation-id'),
      element.getAttribute('data-icon'),
      ...Array.from(element.querySelectorAll<HTMLElement>('svg, [class], [data-icon]'))
        .slice(0, 8)
        .flatMap((node) => [
          typeof node.className === 'string' ? node.className : '',
          node.getAttribute('aria-label'),
          node.getAttribute('data-icon'),
        ]),
    ]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  );
}

/**
 * SuccessFactors' legacy picker has no ARIA relationship on the arrow itself.
 * Its semantics are instead expressed by one text/display input and one
 * dropdown affordance in the same form-field container. This deliberately
 * requires the SuccessFactors adapter marker and a dropdown-named affordance;
 * a generic input with a nearby button is not choice evidence.
 */
function isSuccessFactorsCompositeTrigger(
  input: HTMLInputElement,
  candidate: HTMLElement,
  container: HTMLElement,
): boolean {
  if (!isSuccessFactorsDocument(input.ownerDocument)) return false;
  if (dateShapedInput(input)) return false;
  if (!['', 'text', 'search'].includes(input.type.toLowerCase())) return false;
  const hint = choiceAffordanceText(candidate);
  if (CALENDAR_AFFORDANCE.test(hint)) return false;
  const answerInputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'),
  );
  if (answerInputs.length !== 1 || answerInputs[0] !== input) return false;
  if (hasDirectChoiceSemantics(candidate)) return true;
  if (!(candidate instanceof HTMLButtonElement) && candidate.getAttribute('role') !== 'button') {
    return false;
  }
  if (!SUCCESSFACTORS_CHOICE_AFFORDANCE.test(hint)) return false;
  const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'));
  return buttons.length === 1;
}

function associatedNativeSelect(input: HTMLInputElement): HTMLSelectElement | null {
  let container: HTMLElement | null = input.parentElement;
  for (let depth = 0; container && depth < 4; depth += 1) {
    if (container.matches('form,fieldset,body')) break;
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'));
    const answerInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'),
    );
    if (selects.length === 1 && answerInputs.length === 1 && answerInputs[0] === input) {
      const select = selects[0];
      if (
        select &&
        (sharesAccessibleLabel(input, select) ||
          !hasOwnAccessibleLabel(select) ||
          !isVisibleElement(select))
      ) {
        return select;
      }
    }
    if (container.matches(FIELD_BOUNDARY_SELECTOR)) break;
    container = container.parentElement;
  }
  return null;
}

function isVisibleElement(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = element.getAttribute('style') ?? '';
  return !/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

/** Smallest structural wrapper the scanner treats as one logical form field. */
export function logicalFieldContainerFor(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement;
  const nearest = element.parentElement ?? element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.matches('form,fieldset,body')) break;
    if (current.matches(FIELD_BOUNDARY_SELECTOR)) return current;
    current = current.parentElement;
  }
  return nearest;
}

function associatedTrigger(input: HTMLInputElement): HTMLElement | null {
  let container: HTMLElement | null = input.parentElement;
  for (let depth = 0; container && depth < 4; depth += 1) {
    if (container.matches('form,fieldset,body')) break;
    const candidates = Array.from(
      container.querySelectorAll<HTMLElement>(`${CHOICE_TRIGGER_SELECTOR}, button, [role="button"]`),
    ).filter(
      (candidate) =>
        candidate !== input &&
        (hasDirectChoiceSemantics(candidate) ||
          isSuccessFactorsCompositeTrigger(input, candidate, container!)),
    );
    const unique = [...new Set(candidates)];
    if (unique.length === 1 && unique[0]) {
      const trigger = unique[0];
      const answerInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'),
      );
      // Either the platform explicitly binds both pieces to the same label, or
      // the smallest composite contains one *unlabelled* display/search input
      // and one choice trigger. Requiring the input to be unlabelled in the
      // structural fallback is important: a phone widget can contain a country
      // code combobox beside a separately-labelled phone-number input. Those
      // are two logical fields even though they share a visual wrapper.
      if (
        sharesAccessibleLabel(input, trigger) ||
        (answerInputs.length === 1 &&
          answerInputs[0] === input &&
          (!hasOwnAccessibleLabel(input) ||
            isSuccessFactorsCompositeTrigger(input, trigger, container)))
      ) {
        return trigger;
      }
    }
    if (container.matches(FIELD_BOUNDARY_SELECTOR)) break;
    container = container.parentElement;
  }
  return null;
}

export interface ChoiceOwnership {
  /** The outer logical control that must be opened and selected from. */
  owner: HTMLElement;
  /** A genuine query input, when the widget explicitly identifies one. */
  searchInput: HTMLInputElement | null;
}

/** The choice widget owning this node, or null when it is an ordinary control. */
export function choiceOwnershipOf(element: HTMLElement): ChoiceOwnership | null {
  // Calendar/date evidence wins before any nearby popup affordance. A calendar
  // button may be part of the same composite, but it does not make the date box
  // a dropdown of arbitrary choices.
  if (element instanceof HTMLInputElement && dateShapedInput(element)) return null;

  let owner: HTMLElement | null = hasDirectChoiceSemantics(element) ? element : null;
  if (!owner && element instanceof HTMLInputElement) owner = associatedNativeSelect(element);
  if (!owner && !(element instanceof HTMLInputElement)) {
    let container: HTMLElement | null = element.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1) {
      if (container.matches('form,fieldset,body')) break;
      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'),
      );
      if (
        inputs.length === 1 &&
        inputs[0] &&
        isSuccessFactorsCompositeTrigger(inputs[0], element, container)
      ) {
        owner = element;
        break;
      }
      if (container.matches(FIELD_BOUNDARY_SELECTOR)) break;
      container = container.parentElement;
    }
  }
  if (!owner) {
    let ancestor = element.parentElement;
    while (ancestor && !ancestor.matches('form,fieldset,body')) {
      if (hasDirectChoiceSemantics(ancestor)) {
        owner = ancestor;
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  if (!owner && element instanceof HTMLInputElement) owner = associatedTrigger(element);
  if (!owner) return null;

  const explicitSearch = (candidate: HTMLInputElement): boolean => {
    const autocomplete = clean(candidate.getAttribute('aria-autocomplete')).toLowerCase();
    return (
      candidate.type.toLowerCase() === 'search' ||
      autocomplete === 'list' ||
      autocomplete === 'both'
    );
  };
  const searchInput =
    element instanceof HTMLInputElement && explicitSearch(element)
      ? element
      : (Array.from(owner.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')).find(
          explicitSearch,
        ) ?? null);
  return { owner, searchInput };
}

/** The node the scanner/executor should treat as the field itself. */
export function logicalControlOwner(element: HTMLElement): HTMLElement {
  return choiceOwnershipOf(element)?.owner ?? element;
}
