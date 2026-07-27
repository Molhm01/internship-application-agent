import {
  fillVerificationResultSchema,
  normalizeOptionText,
  normalizeLabel,
  type DeterministicFillAction,
  type DetectedField,
  type FillVerificationResult,
} from '@internship-agent/shared';

export function allDocumentRoots(document: Document): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  const seen = new Set<Document | ShadowRoot>(roots);
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    if (!root) continue;
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        roots.push(element.shadowRoot);
        seen.add(element.shadowRoot);
      }
    }
    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
      try {
        if (frame.contentDocument && !seen.has(frame.contentDocument)) {
          roots.push(frame.contentDocument);
          seen.add(frame.contentDocument);
        }
      } catch {
        // Cross-origin frames are intentionally inaccessible.
      }
    }
  }
  return roots;
}

export function findScannedElement(document: Document, field: DetectedField): HTMLElement | null {
  for (const root of allDocumentRoots(document)) {
    try {
      const found = root.querySelector<HTMLElement>(field.selector);
      if (found) return found;
    } catch {
      return null;
    }
  }
  return null;
}

export function fieldFingerprintMatches(element: HTMLElement, field: DetectedField): boolean {
  const scannedTag =
    typeof field.metadata['tagName'] === 'string' ? field.metadata['tagName'] : null;
  if (scannedTag && element.tagName.toLowerCase() !== scannedTag) return false;
  if (
    field.fieldType === 'email' ||
    field.fieldType === 'tel' ||
    field.fieldType === 'number' ||
    field.fieldType === 'date' ||
    field.fieldType === 'url'
  ) {
    if (!(element instanceof HTMLInputElement) || element.type !== field.fieldType) return false;
  }
  const grouped =
    typeof field.metadata['groupedControls'] === 'number' && field.metadata['groupedControls'] > 1;
  const groupLegend = grouped
    ? element.closest('fieldset')?.querySelector(':scope > legend')?.textContent
    : null;
  const candidateLabel = [
    groupLegend,
    element.getAttribute('aria-label'),
    ...(!groupLegend &&
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      ? Array.from(element.labels ?? []).map((label) => label.textContent)
      : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const normalizedCandidateLabel = normalizeLabel(candidateLabel);
  if (
    candidateLabel &&
    field.normalizedLabel &&
    !normalizedCandidateLabel.includes(field.normalizedLabel.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function selectedOption(select: HTMLSelectElement): { label: string; value: string } | undefined {
  const option = select.selectedOptions[0];
  return option ? { label: option.textContent?.trim() ?? '', value: option.value } : undefined;
}

function actualFor(
  document: Document,
  element: HTMLElement,
  field: DetectedField,
  action: DeterministicFillAction,
): string | string[] | boolean | undefined {
  if (element instanceof HTMLSelectElement) return selectedOption(element)?.value;
  if (field.fieldType === 'radio' && element instanceof HTMLInputElement) {
    const name = element.name;
    const escapedName = globalThis.CSS?.escape
      ? globalThis.CSS.escape(name)
      : name.replace(/["\\]/g, '\\$&');
    const group = allDocumentRoots(document).flatMap((root) =>
      Array.from(
        root.querySelectorAll<HTMLInputElement>(
          name ? `input[type="radio"][name="${escapedName}"]` : 'input[type="radio"]',
        ),
      ),
    );
    return group.find((radio) => radio.checked)?.value;
  }
  if (field.fieldType === 'multi_select' && element instanceof HTMLInputElement) {
    const name = element.name;
    const escapedName = globalThis.CSS?.escape
      ? globalThis.CSS.escape(name)
      : name.replace(/["\\]/g, '\\$&');
    return allDocumentRoots(document)
      .flatMap((root) =>
        Array.from(
          root.querySelectorAll<HTMLInputElement>(
            name ? `input[type="checkbox"][name="${escapedName}"]` : 'input[type="checkbox"]',
          ),
        ),
      )
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
  }
  if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value;
  }
  return action.proposedValue;
}

function sameValue(
  expected: string | string[] | boolean | undefined,
  actual: string | string[] | boolean | undefined,
): boolean {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return (
      expected.length === actual.length &&
      [...expected].sort().every((value, index) => value === [...actual].sort()[index])
    );
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    return normalizeOptionText(expected) === normalizeOptionText(actual);
  }
  return expected === actual;
}

export function verifyDomAction(
  document: Document,
  field: DetectedField,
  action: DeterministicFillAction,
): FillVerificationResult {
  const element = findScannedElement(document, field);
  if (!element) {
    return fillVerificationResultSchema.parse({
      fieldId: field.id,
      verified: false,
      expectedValue: action.proposedValue,
      method: 'not_verifiable',
      message: 'The scanned field no longer exists.',
    });
  }
  const actual = actualFor(document, element, field, action);
  const valid =
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) || element.validity.valid;
  const verified = sameValue(action.proposedValue, actual) && valid;
  const method =
    field.fieldType === 'select'
      ? 'selected_option'
      : field.fieldType === 'radio' ||
          field.fieldType === 'checkbox' ||
          field.fieldType === 'multi_select'
        ? 'checked_state'
        : valid
          ? 'input_value'
          : 'validation_state';
  return fillVerificationResultSchema.parse({
    fieldId: field.id,
    verified,
    expectedValue: action.proposedValue,
    ...(actual !== undefined ? { actualValue: actual } : {}),
    method,
    ...(!verified
      ? {
          message: valid
            ? 'The observed value did not match the approved value.'
            : 'The browser or page validation rejected the value.',
        }
      : {}),
  });
}
