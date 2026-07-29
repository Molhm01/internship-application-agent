import {
  DEFAULT_ERROR_GUIDANCE,
  allowsRegionSuffix,
  fillExecutionResultSchema,
  type AgentError,
  type DeterministicFillAction,
  type DetectedField,
  type FillExecutionResult,
  type DocumentContentResponse,
} from '@internship-agent/shared';
import {
  allDocumentRoots,
  fieldFingerprintMatches,
  findScannedElement,
  verifyDomAction,
} from '../verifier/domVerifier.js';
import { selectComboboxOption } from './comboboxExecutor.js';

function failure(
  action: DeterministicFillAction,
  code: AgentError['code'],
  message: string,
  started: number,
  attempts = 0,
): FillExecutionResult {
  return fillExecutionResultSchema.parse({
    actionId: action.id,
    fieldId: action.fieldId,
    status: code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed',
    expectedValue: action.proposedValue,
    attempts,
    durationMs: Math.round(performance.now() - started),
    error: {
      code,
      message,
      fieldId: action.fieldId,
      recoverable: !['FIELD_MISMATCH', 'ACTION_NOT_APPROVED'].includes(code),
      suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
      debugContext: {},
    },
  });
}

function isVisible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    !element.hidden &&
    element.getAttribute('aria-hidden') !== 'true' &&
    !(element instanceof HTMLInputElement && element.type === 'hidden') &&
    style?.display !== 'none' &&
    style?.visibility !== 'hidden'
  );
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (!descriptor?.set) throw new Error('Native value setter is unavailable.');
  descriptor.set.call(element, value);
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  if (!descriptor?.set) throw new Error('Native checked setter is unavailable.');
  descriptor.set.call(element, checked);
}

function dispatchValueEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  element.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: true }));
}

function findGroupInputs(
  document: Document,
  first: HTMLInputElement,
  type: 'radio' | 'checkbox',
): HTMLInputElement[] {
  const escapedName = globalThis.CSS?.escape
    ? globalThis.CSS.escape(first.name)
    : first.name.replace(/["\\]/g, '\\$&');
  const selector = first.name
    ? `input[type="${type}"][name="${escapedName}"]`
    : `input[type="${type}"]`;
  return allDocumentRoots(document).flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLInputElement>(selector)),
  );
}

function applyValue(
  document: Document,
  element: HTMLElement,
  action: DeterministicFillAction,
): void {
  element.focus();
  if (action.action === 'select_option') {
    if (!(element instanceof HTMLSelectElement) || !action.matchedOption) {
      throw new Error('UNSUPPORTED_CONTROL');
    }
    const exists = Array.from(element.options).some(
      (option) => option.value === action.matchedOption?.value,
    );
    if (!exists) throw new Error('OPTION_NOT_FOUND');
    setNativeValue(element, action.matchedOption.value);
    dispatchValueEvents(element);
    return;
  }
  if (action.action === 'choose_radio') {
    if (!(element instanceof HTMLInputElement) || !action.matchedOption) {
      throw new Error('UNSUPPORTED_CONTROL');
    }
    const target = findGroupInputs(document, element, 'radio').find(
      (radio) => radio.value === action.matchedOption?.value,
    );
    if (!target) throw new Error('OPTION_NOT_FOUND');
    setNativeChecked(target, true);
    dispatchValueEvents(target);
    return;
  }
  if (action.action === 'toggle_checkbox') {
    if (!(element instanceof HTMLInputElement)) throw new Error('UNSUPPORTED_CONTROL');
    if (Array.isArray(action.proposedValue)) {
      const selected = new Set(action.proposedValue);
      const group = findGroupInputs(document, element, 'checkbox');
      if (
        selected.size &&
        ![...selected].every((value) => group.some((item) => item.value === value))
      ) {
        throw new Error('OPTION_NOT_FOUND');
      }
      for (const checkbox of group) {
        const desired = selected.has(checkbox.value);
        if (checkbox.checked !== desired) {
          setNativeChecked(checkbox, desired);
          dispatchValueEvents(checkbox);
        }
      }
      return;
    }
    if (typeof action.proposedValue !== 'boolean') throw new Error('UNSUPPORTED_CONTROL');
    if (element.checked !== action.proposedValue) {
      setNativeChecked(element, action.proposedValue);
      dispatchValueEvents(element);
    }
    return;
  }
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) ||
    typeof action.proposedValue !== 'string'
  ) {
    throw new Error('UNSUPPORTED_CONTROL');
  }
  setNativeValue(element, action.proposedValue);
  dispatchValueEvents(element);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function attachApprovedFile(
  element: HTMLElement,
  action: DeterministicFillAction,
  contents: readonly DocumentContentResponse[],
): string {
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw new Error('UNSUPPORTED_CONTROL');
  }
  const content = contents.find((candidate) => candidate.id === action.documentId);
  if (!content) throw new Error('DOCUMENT_MISSING');
  const file = new File([decodeBase64(content.contentBase64)], content.fileName, {
    type: content.mimeType,
  });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  element.files = transfer.files;
  dispatchValueEvents(element);
  return file.name;
}

const waitForFramework = (): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, 40));

export async function executeDomAction(
  document: Document,
  field: DetectedField,
  action: DeterministicFillAction,
  signal: AbortSignal,
  documentContents: readonly DocumentContentResponse[] = [],
): Promise<FillExecutionResult> {
  const started = performance.now();
  const generated = action.action === 'fill_generated_text';
  if (!action.approved) {
    return failure(
      action,
      generated ? 'GENERATED_ACTION_NOT_APPROVED' : 'ACTION_NOT_APPROVED',
      'The action was not approved.',
      started,
    );
  }
  if (action.confidence < 0.8 && action.action !== 'fill_generated_text') {
    return failure(
      action,
      'ACTION_NOT_APPROVED',
      'Low-confidence actions cannot be executed.',
      started,
    );
  }
  if (
    action.action === 'fill_generated_text' &&
    (action.answerValidationPassed !== true || !action.requiresReview)
  ) {
    return failure(
      action,
      'GENERATED_ACTION_NOT_VALIDATED',
      'The generated answer did not pass validation and explicit review.',
      started,
    );
  }
  if (action.sensitive && action.requiresReview && !action.approved) {
    return failure(
      action,
      'SENSITIVE_REVIEW_REQUIRED',
      'The sensitive action requires explicit review.',
      started,
    );
  }
  const element = findScannedElement(document, field);
  if (!element)
    return failure(
      action,
      generated ? 'GENERATED_FIELD_NOT_FOUND' : 'FIELD_NOT_FOUND',
      'The scanned field was not found.',
      started,
    );
  if (!fieldFingerprintMatches(element, field)) {
    return failure(
      action,
      generated ? 'GENERATED_FIELD_CHANGED' : 'FIELD_MISMATCH',
      'The field fingerprint changed after scanning.',
      started,
    );
  }
  if (!isVisible(element)) {
    return failure(
      action,
      'FIELD_NOT_VISIBLE',
      'The scanned field is not currently visible.',
      started,
    );
  }
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement) &&
    element.disabled
  ) {
    return failure(action, 'FIELD_DISABLED', 'The scanned field is disabled.', started);
  }

  for (let attempts = 1; attempts <= 2; attempts += 1) {
    if (signal.aborted) {
      return failure(
        action,
        'EXECUTION_CANCELLED',
        'The fill run was cancelled.',
        started,
        attempts - 1,
      );
    }
    try {
      const currentElement = findScannedElement(document, field);
      if (!currentElement) {
        return failure(
          action,
          generated ? 'GENERATED_FIELD_NOT_FOUND' : 'FIELD_NOT_FOUND',
          'The scanned field disappeared after the page rerendered.',
          started,
          attempts,
        );
      }
      if (!fieldFingerprintMatches(currentElement, field)) {
        return failure(
          action,
          generated ? 'GENERATED_FIELD_CHANGED' : 'FIELD_MISMATCH',
          'The field fingerprint changed after the page rerendered.',
          started,
          attempts,
        );
      }
      // A custom combobox has its own open → read → match → click → verify
      // sequence, and verifies itself against what the control displays.
      if (
        action.action === 'select_suggested_option' ||
        action.action === 'select_resolved_option'
      ) {
        const outcome = await selectComboboxOption({
          root: currentElement,
          field,
          proposedValue: String(action.matchedOption?.value ?? action.proposedValue ?? ''),
          ...(action.matchedOption ? { matchedLabel: action.matchedOption.label } : {}),
          allowRegionSuffix: allowsRegionSuffix(field.canonicalKey),
          // Saved city/state/country, so the executor rejects the same wrong
          // regions the planner would have rejected.
          ...(action.matchHint?.location ? { locationTarget: action.matchHint.location } : {}),
          ...(action.matchHint?.searchText ? { searchText: action.matchHint.searchText } : {}),
        });
        if (outcome.ok) {
          return fillExecutionResultSchema.parse({
            actionId: action.id,
            fieldId: field.id,
            status: 'verified',
            expectedValue: action.proposedValue,
            ...(outcome.observedValue ? { actualValue: outcome.observedValue } : {}),
            attempts,
            durationMs: Math.round(performance.now() - started),
          });
        }
        if (attempts === 2) {
          // The executor names the stage it stopped at, so the report can say
          // "the list never opened" rather than a generic option failure.
          return failure(
            action,
            outcome.code ??
              (outcome.discoveredOptions.length === 0
                ? 'OPTIONS_NOT_DISCOVERED'
                : 'NO_OPTION_MATCH'),
            outcome.reason,
            started,
            attempts,
          );
        }
        continue;
      }

      const uploadedFileName =
        action.action === 'upload_file'
          ? attachApprovedFile(currentElement, action, documentContents)
          : undefined;
      if (action.action !== 'upload_file') applyValue(document, currentElement, action);
      await waitForFramework();
      const verification = verifyDomAction(document, field, action);
      if (verification.verified) {
        return fillExecutionResultSchema.parse({
          actionId: action.id,
          fieldId: field.id,
          status: 'verified',
          expectedValue: action.proposedValue,
          actualValue: verification.actualValue,
          ...(uploadedFileName ? { uploadedFileName } : {}),
          attempts,
          durationMs: Math.round(performance.now() - started),
        });
      }
      if (attempts === 2) {
        return failure(
          action,
          generated ? 'GENERATED_VALUE_NOT_VERIFIED' : 'VALUE_NOT_VERIFIED',
          verification.message ?? 'The value could not be verified.',
          started,
          attempts,
        );
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const baseCode =
        detail === 'OPTION_NOT_FOUND'
          ? 'OPTION_NOT_FOUND'
          : detail === 'DOCUMENT_MISSING'
            ? 'DOCUMENT_MISSING'
            : detail === 'UNSUPPORTED_CONTROL'
              ? 'UNSUPPORTED_CONTROL'
              : action.action === 'upload_file'
                ? 'UPLOAD_FAILED'
                : 'VALUE_NOT_VERIFIED';
      const code =
        generated && baseCode === 'UNSUPPORTED_CONTROL'
          ? 'UNSUPPORTED_GENERATED_FIELD'
          : generated && baseCode === 'VALUE_NOT_VERIFIED'
            ? 'GENERATED_VALUE_NOT_VERIFIED'
            : baseCode;
      if (
        attempts === 2 ||
        (code !== 'VALUE_NOT_VERIFIED' && code !== 'GENERATED_VALUE_NOT_VERIFIED')
      ) {
        return failure(action, code, `The field could not be filled: ${detail}`, started, attempts);
      }
    }
  }
  return failure(
    action,
    generated ? 'GENERATED_VALUE_NOT_VERIFIED' : 'VALUE_NOT_VERIFIED',
    'The field could not be verified.',
    started,
    2,
  );
}
