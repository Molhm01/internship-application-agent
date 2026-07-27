import {
  FILLABLE_FIELD_TYPES,
  detectedFieldSchema,
  matchCanonicalQuestion,
  normalizeLabel,
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
}

const CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="combobox"]',
  '[contenteditable="true"]',
].join(',');

const IGNORED_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image', 'password']);
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

function shouldIgnore(element: HTMLElement): boolean {
  if (!isVisibleControl(element) || isHoneypot(element)) return true;
  if (
    isInput(element) &&
    (IGNORED_INPUT_TYPES.has(element.type.toLowerCase()) || element.disabled)
  ) {
    return true;
  }
  if ((isTextArea(element) || isSelect(element)) && element.disabled) {
    return true;
  }
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

export function extractAccessibleLabel(element: HTMLElement): LabelResult {
  const signals: string[] = [];
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

  const placeholder = cleanText(element.getAttribute('placeholder'));
  if (placeholder) return { label: placeholder, signals: ['placeholder'] };

  const legend = cleanText(
    element.closest('fieldset')?.querySelector(':scope > legend')?.textContent,
  );
  if (legend) return { label: legend, signals: ['fieldset_legend'] };

  const previous = cleanText(element.previousElementSibling?.textContent);
  if (previous && previous.length <= 500) return { label: previous, signals: ['nearby_text'] };

  const container = element.closest(
    '[data-automation-id*="formField"], .field, .form-field, .application-question, .questions, [role="group"]',
  );
  const candidate = cleanText(
    container?.querySelector('label, .label, .question, [data-automation-id*="label"]')
      ?.textContent,
  );
  if (candidate) return { label: candidate, signals: ['nearby_text'] };

  signals.push('unlabelled');
  return { label: cleanText(element.getAttribute('name') ?? element.id), signals };
}

function inferType(element: HTMLElement, grouped = false): FieldType {
  if (isTextArea(element)) return 'textarea';
  if (isSelect(element)) return element.multiple ? 'multi_select' : 'select';
  if (element.isContentEditable) return 'contenteditable';
  if (element.getAttribute('role') === 'combobox') {
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
    case 'month':
      return 'date';
    case 'url':
      return 'url';
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
  if (isSelect(first)) {
    return Array.from(first.options, (option) => ({
      label: cleanText(option.textContent),
      value: option.value,
      ...(option.selected ? { selected: true } : {}),
    }));
  }
  if (fieldType === 'radio' || fieldType === 'multi_select') {
    return elements.map((element) => {
      const input = element as HTMLInputElement;
      const label = extractAccessibleLabel(input).label || input.value;
      return { label, value: input.value, ...(input.checked ? { selected: true } : {}) };
    });
  }
  const controls = first.getAttribute('aria-controls');
  const list = controls ? first.ownerDocument.getElementById(controls) : null;
  if (list) {
    const found = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (option) => ({
        label: cleanText(option.textContent),
        value: option.getAttribute('data-value') ?? cleanText(option.textContent),
        ...(option.getAttribute('aria-selected') === 'true' ? { selected: true } : {}),
      }),
    );
    return found.length ? found : undefined;
  }
  return undefined;
}

function isRequired(element: HTMLElement, label: string): boolean {
  if ((isInput(element) || isTextArea(element) || isSelect(element)) && element.required) {
    return true;
  }
  if (element.getAttribute('aria-required') === 'true') return true;
  const containerText = cleanText(
    element.closest('label, fieldset, .field, .form-field, [data-automation-id*="formField"]')
      ?.textContent,
  );
  return /(^|\s)\*(\s|$)|\brequired\b/i.test(`${label} ${containerText}`);
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

function fieldFromElements(elements: HTMLElement[], pageId: string): DetectedField | null {
  const first = elements[0];
  if (!first) return null;
  const grouped = elements.length > 1;
  const type = inferType(first, grouped);
  const groupLegend = grouped
    ? cleanText(first.closest('fieldset')?.querySelector(':scope > legend')?.textContent)
    : '';
  const accessible = groupLegend
    ? { label: groupLegend, signals: ['fieldset_legend'] }
    : extractAccessibleLabel(first);
  const label = accessible.label;
  const normalizedLabel = normalizeLabel(label);
  const match = matchCanonicalQuestion(label);
  const heading = nearestHeading(first);
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

function scanOnce(document: Document, pageId: string): DomScanResult {
  const warnings: string[] = [];
  const roots = collectRoots(document, warnings);
  const fields: DetectedField[] = [];
  const seenElements = new WeakSet<HTMLElement>();
  const dedupe = new Set<string>();

  for (const root of roots) {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
      (element) => !shouldIgnore(element),
    );
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
      if (!field) continue;
      const logicalKey = `${field.selector}|${field.normalizedLabel}|${field.fieldType}`;
      if (dedupe.has(logicalKey)) continue;
      dedupe.add(logicalKey);
      fields.push(field);
    }
  }

  if (fields.length === 0) warnings.push('No eligible application fields were found.');
  if (fields.some((field) => field.sourceSignals.includes('unlabelled'))) {
    warnings.push('One or more controls have no accessible label.');
  }
  return { fields, warnings };
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

export async function scanDom(
  document: Document,
  pageId: string,
  signal: AbortSignal,
): Promise<DomScanResult> {
  const first = scanOnce(document, pageId);
  const changed = await waitForDomSettled(document, signal);
  if (!changed) return first;
  const next = scanOnce(document, pageId);
  return {
    fields: next.fields,
    warnings: [
      ...new Set([...first.warnings, 'Dynamic fields changed during the scan.', ...next.warnings]),
    ],
  };
}

export function isSupportedField(field: DetectedField): boolean {
  return FILLABLE_FIELD_TYPES.includes(field.fieldType);
}
