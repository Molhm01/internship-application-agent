import {
  DEFAULT_ERROR_GUIDANCE,
  contractViolation,
  fillExecutionResultSchema,
  normalizeOptionText,
  type AgentError,
  type DeterministicFillAction,
  type DetectedField,
  type FillExecutionResult,
  type DocumentContentResponse,
  toDropdownTrace,
  type DropdownFailureCode,
} from '@internship-agent/shared';
import {
  allDocumentRoots,
  fieldFingerprintMatches,
  findScannedElement,
  verifyDomAction,
} from '../verifier/domVerifier.js';
import { executeDropdownWithRetry } from './dropdownEngine.js';
import { answersFromList } from '../scanner/domScanner.js';

/**
 * The engine's stage names, in the error vocabulary the report speaks.
 *
 * Deliberately one-to-one. Collapsing several stages onto one code is how every
 * dropdown outcome became "Autofill failed" — the mapping is the place that
 * damage would reappear, so it is written out rather than defaulted.
 */
const DROPDOWN_ERROR_CODES: Record<DropdownFailureCode, AgentError['code']> = {
  CONTROL_NOT_FOUND: 'CONTROL_NOT_FOUND',
  CONTROL_DISABLED: 'CONTROL_DISABLED',
  OPEN_FAILED: 'DROPDOWN_OPEN_FAILED',
  OPTION_CONTAINER_NOT_FOUND: 'LISTBOX_NOT_FOUND',
  NO_OPTIONS_FOUND: 'DROPDOWN_NO_OPTIONS_FOUND',
  OPTION_NOT_FOUND: 'OPTION_NOT_FOUND',
  AMBIGUOUS_OPTION_MATCH: 'AMBIGUOUS_OPTION_MATCH',
  NO_SEMANTIC_OPTION_MATCH: 'NO_SEMANTIC_OPTION_MATCH',
  OPTION_DISABLED: 'OPTION_DISABLED',
  OPTION_CLICK_FAILED: 'OPTION_CLICK_FAILED',
  SELECTION_NOT_ACCEPTED: 'SELECTION_NOT_ACCEPTED',
  VERIFICATION_FAILED: 'OPTION_VALUE_NOT_VERIFIED',
  DEPENDENT_CONTROL_NOT_REFRESHED: 'DEPENDENT_CONTROL_NOT_REFRESHED',
  ANSWER_UNKNOWN: 'ANSWER_UNKNOWN',
};

/**
 * Failures that mean "nobody could have filled this yet", as opposed to "the
 * page refused a known answer".
 *
 * The distinction is the whole point of the split between answer resolution and
 * dropdown execution: a State control the page has not repopulated, and a
 * question whose answer nothing saved holds, are the user's to settle. Marking
 * them red said the agent had tried and been beaten, which was untrue and sent
 * people looking for a bug in the extension.
 */
const NOT_AN_EXECUTION_FAILURE: readonly DropdownFailureCode[] = [
  'ANSWER_UNKNOWN',
  'DEPENDENT_CONTROL_NOT_REFRESHED',
];

/**
 * Actions the dropdown engine owns.
 *
 * `choose_radio` is not one of them: a radio group's choices are all in the DOM
 * already, there is nothing to open, and the group executor below drives it
 * correctly. Routing it here would be complexity with no failure behind it.
 */
function isOptionAction(action: string): boolean {
  return (
    action === 'select_option' ||
    action === 'select_suggested_option' ||
    action === 'select_resolved_option'
  );
}

/**
 * Questions where the form's own "Other" entry is the *true* answer when the
 * saved value is not listed, rather than a way to get something selected.
 *
 * Deliberately short. On Country, "Other" is a lie; on Area of Study it is what
 * an applicant would honestly pick for a subject the form does not enumerate,
 * and the free-text box beside it carries the real answer. Everything absent
 * from this list reports `OPTION_NOT_FOUND` and stays the user's to settle.
 */
function allowsOtherFallback(canonical: string | undefined): boolean {
  return (
    canonical === 'field_of_study' ||
    canonical === 'area_of_study' ||
    canonical === 'major' ||
    canonical === 'school' ||
    canonical === 'institution' ||
    canonical === 'how_did_you_hear'
  );
}

/**
 * The DOM types a browser lets a person type into.
 *
 * Kept here as well as in the scanner because the two must not be able to drift:
 * the scanner decides what a control *is*, and this decides what may be *done*
 * to it, and a repair applied to only one of them is how "No option on the page
 * matched 'Molhm'" came back the first time.
 */
const TYPED_INPUT_TYPES = new Set(['text', 'email', 'tel', 'number', 'url', 'search', '']);

function isTypedTextElement(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.readOnly) return false;
  if (!TYPED_INPUT_TYPES.has(element.type.toLowerCase())) return false;
  // A searchable Country or Location box is an editable input that genuinely
  // answers from a list, and typing into it leaves the widget's own state unset.
  // The discriminator is whether there is a list to answer from — not whether
  // the element calls itself a combobox.
  return !answersFromList(element);
}

/**
 * Why this action may not be performed on this element, or null when it may.
 *
 * Only the case that caused real damage is enforced: an option-selecting action
 * aimed at a control that is typed into. The reverse — typing into a `<select>`
 * — is already impossible, because `HTMLSelectElement` has no writable value
 * that accepts arbitrary text.
 */
function elementContractViolation(element: HTMLElement, action: string): string | null {
  const optionActions = new Set([
    'select_option',
    'select_suggested_option',
    'select_resolved_option',
  ]);
  if (!optionActions.has(action)) return null;
  if (!isTypedTextElement(element)) return null;
  const described =
    element instanceof HTMLInputElement ? `input[type="${element.type}"]` : 'textarea';
  return `This control is a ${described}, which is typed into rather than chosen from. "${action}" would search the page for an option list that does not exist, so the value was not written. This is a planning defect, not a missing option.`;
}

/**
 * Why this conditional control may not be written to, or null when it may.
 *
 * Reads the parent control out of the live document and compares what it is
 * *currently holding* against the value that activates this child. Nothing is
 * inferred from the plan: a plan that intends to choose "Other" has not chosen
 * it, and a page where the applicant cleared the answer between the scan and
 * the fill is a page where the child must stay empty.
 */
function conditionalGateViolation(document: Document, field: DetectedField): string | null {
  const dependency = field.dependsOn;
  if (!dependency) return null;
  const parent = field.metadata.dependsOnSelector;
  if (typeof parent !== 'string' || parent.length === 0) return null;

  const element = allDocumentRoots(document)
    .map((root) => root.querySelector<HTMLElement>(parent))
    .find((found): found is HTMLElement => found !== null);
  if (!element) {
    return `"${field.question}" only applies when the question above it is answered, and that question is no longer on the page.`;
  }

  const held: string[] = [];
  if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(element.selectedOptions)) {
      held.push(option.value, option.textContent ?? '');
    }
  } else if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      if (element.checked) held.push(element.value, 'yes');
    } else {
      held.push(element.value);
    }
  } else {
    held.push(element.textContent ?? '');
  }

  const wanted = dependency.value;
  const activated = held
    // The same normalizer the option matcher uses, so a page spelling its
    // escape hatch "Other/Not Listed" and storing it as `other_not_listed`
    // both reduce to the same words as the activation value "other".
    .map((value) => normalizeOptionText(value))
    .some((value) => value === wanted || value.startsWith(`${wanted} `));
  if (activated) return null;
  return `"${field.question}" applies only when the question above it is answered "${wanted}". It is not, so nothing was written here — a conditional answer is never stated on your behalf.`;
}

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
  // Option-selecting actions never reach here: `executeDomAction` routes every
  // one of them to the dropdown engine, which reads the choices the control is
  // offering *now* rather than the ones the scan recorded. This branch used to
  // hold a second, snapshot-based implementation, and it is the reason a State
  // control the page had rebuilt reported OPTION_NOT_FOUND for an option that
  // was sitting in the list. There is one implementation.
  if (isOptionAction(action.action)) throw new Error('UNSUPPORTED_CONTROL');
  if (action.action === 'choose_radio') {
    if (!(element instanceof HTMLInputElement) || !action.matchedOption) {
      throw new Error('UNSUPPORTED_CONTROL');
    }
    const target = findGroupInputs(document, element, 'radio').find(
      (radio) => radio.value === action.matchedOption?.value,
    );
    if (!target) throw new Error('OPTION_NOT_FOUND');
    if (target.checked) return;
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
  // Same reasoning as the option branch: a box already holding the intended
  // text is verified, not retyped. Retyping fires `input` and `change` at a
  // framework that may reformat, revalidate, or clear a dependent control.
  if (element.value === action.proposedValue) return;
  setNativeValue(element, action.proposedValue);
  dispatchValueEvents(element);
}

/**
 * Types a password into a password field.
 *
 * Separate from `applyValue` on purpose. The secret arrives as an argument, is
 * used once, and is never placed on the action, in the plan, in a report, or in
 * a log line — which is why the verification below checks only the *length* of
 * what the field ended up holding rather than comparing the value.
 */
export function applyPassword(element: HTMLElement, password: string): boolean {
  if (!(element instanceof HTMLInputElement) || element.type !== 'password') {
    throw new Error('UNSUPPORTED_CONTROL');
  }
  element.focus();
  setNativeValue(element, password);
  dispatchValueEvents(element);
  return element.value.length === password.length && element.value.length > 0;
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
  // The second half of the planner/executor contract. A plan that asks a text
  // box to pick an option is refused here rather than being attempted, because
  // attempting it produces "No option on the page matched Molhm" — a message
  // that tells the user nothing about what actually went wrong.
  const violation = contractViolation(field.fieldType, action.action);
  if (violation) {
    return failure(action, 'UNSUPPORTED_CONTROL', violation.reason, started);
  }
  // The second half of the conditional-child contract, checked against the live
  // page rather than against the plan.
  //
  // The planner is the first place this is enforced and this is the second, and
  // neither trusts the other — the same arrangement as the control-type
  // contract, and for the same reason. A plan is built from a scan taken some
  // time ago; the answer that activates a child can be cleared between the two,
  // by the applicant or by the page. Writing to the child then states something
  // nobody said. The live run typed the applicant's own name into "If yes,
  // provide the name and relationship of each relative" beside an unanswered
  // relatives question, and this is the check that makes that impossible.
  const gate = conditionalGateViolation(document, field);
  if (gate) {
    // `needs_review`, not `failed`. Nothing was attempted and nothing went
    // wrong: the question does not currently apply. Painting it red would say
    // the agent tried to answer it and the page refused, which is the opposite
    // of what happened.
    return fillExecutionResultSchema.parse({
      actionId: action.id,
      fieldId: field.id,
      status: 'needs_review',
      expectedValue: action.proposedValue,
      attempts: 0,
      durationMs: Math.round(performance.now() - started),
      error: {
        code: 'PARENT_ANSWER_REQUIRED',
        message: gate,
        fieldId: field.id,
        recoverable: true,
        suggestedAction: DEFAULT_ERROR_GUIDANCE.PARENT_ANSWER_REQUIRED,
        debugContext: {},
      },
    });
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
  // The contract again, this time against the element rather than the recorded
  // field type. `contractViolation` above can only be as right as the scan was,
  // and a scan that called an `<input type="text" role="combobox">` a combobox
  // passes it. This is the check that cannot be fooled by a role attribute: a
  // control the browser will let you type into is never answered by searching a
  // list of options.
  const elementViolation = elementContractViolation(element, action.action);
  if (elementViolation) {
    return failure(action, 'UNSUPPORTED_CONTROL', elementViolation, started);
  }
  // A file input the page hides on purpose and drives from a styled button is
  // the standard upload control on every ATS worth naming. It is populated
  // programmatically — `.files` is set, not typed into — so its visibility says
  // nothing about whether it can be filled, and refusing it here is what left
  // "Resume *" unattached on a page that plainly showed an upload button.
  //
  // Narrow deliberately: only file inputs, and only for an upload action.
  const hiddenUploadControl =
    action.action === 'upload_file' &&
    element instanceof HTMLInputElement &&
    element.type === 'file';
  if (!hiddenUploadControl && !isVisible(element)) {
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
      // Every option control, whatever its widget shape, goes through the one
      // engine: open → enumerate the choices it is offering *now* → match →
      // click → verify. Nothing here matches against the scan snapshot, which
      // is what a rebuilt State list and a lazily-populated Country list both
      // made stale.
      if (isOptionAction(action.action)) {
        const outcome = await executeDropdownWithRetry(
          {
            fieldId: field.id,
            root: currentElement,
            // The label, not the value: a `<select>` option's value is a machine
            // code, and the engine matches against what the page *displays* as
            // well as what it stores.
            desiredSemanticValue: String(
              action.matchedOption?.label ??
                action.matchedOption?.value ??
                action.proposedValue ??
                '',
            ),
            ...(field.canonicalKey ? { canonicalQuestion: field.canonicalKey } : {}),
            ...(action.matchHint?.searchText ? { searchText: action.matchHint.searchText } : {}),
            // Saved city/state/country, so a location list is matched on all
            // three together rather than on the city alone.
            ...(action.matchHint?.location ? { locationTarget: action.matchHint.location } : {}),
            ...(action.matchHint?.alternativeValues?.length
              ? { alternativeValues: action.matchHint.alternativeValues }
              : {}),
            allowOtherFallback: allowsOtherFallback(field.canonicalKey),
            fieldTypeHint: field.fieldType,
            dependsOnAnotherField: action.warnings.some((warning) =>
              /depends on|field it depends on/i.test(warning),
            ),
          },
          () => findScannedElement(document, field),
        );
        if (outcome.verified) {
          return fillExecutionResultSchema.parse({
            actionId: action.id,
            fieldId: field.id,
            status: 'verified',
            expectedValue: action.proposedValue,
            ...(outcome.observedValue ? { actualValue: outcome.observedValue } : {}),
            attempts,
            durationMs: Math.round(performance.now() - started),
            dropdown: toDropdownTrace(outcome),
          });
        }
        const code = outcome.failureCode ?? 'NO_OPTION_MATCH';
        // "Nobody knows the answer yet" and "the page refused a known answer"
        // are different outcomes and get different statuses. Only the second is
        // a failed execution.
        if (NOT_AN_EXECUTION_FAILURE.includes(code as DropdownFailureCode)) {
          return fillExecutionResultSchema.parse({
            actionId: action.id,
            fieldId: field.id,
            status: 'needs_review',
            expectedValue: action.proposedValue,
            attempts,
            durationMs: Math.round(performance.now() - started),
            dropdown: toDropdownTrace(outcome),
            error: {
              code: DROPDOWN_ERROR_CODES[code as DropdownFailureCode],
              message: outcome.reason,
              fieldId: field.id,
              recoverable: true,
              suggestedAction:
                DEFAULT_ERROR_GUIDANCE[DROPDOWN_ERROR_CODES[code as DropdownFailureCode]],
              debugContext: { dropdownKind: outcome.dropdownKind },
            },
          });
        }
        // The engine names the stage it stopped at, so the report can say "the
        // list never opened" rather than a generic option failure.
        return {
          ...failure(
            action,
            DROPDOWN_ERROR_CODES[code as DropdownFailureCode] ?? 'NO_OPTION_MATCH',
            outcome.reason,
            started,
            attempts,
          ),
          dropdown: toDropdownTrace(outcome),
        };
      }

      const uploadedFileName =
        action.action === 'upload_file'
          ? attachApprovedFile(currentElement, action, documentContents)
          : undefined;
      if (action.action !== 'upload_file') applyValue(document, currentElement, action);
      await waitForFramework();
      const verification = verifyDomAction(document, field, action);
      // For an upload, "the control holds a file" is not enough evidence: the
      // applicant may have attached one themselves, and a bundle carries two
      // documents that must not be swapped. The name the control reports has to
      // be the name of the file this action just wrote — compared here rather
      // than in the verifier, because only the executor knows what it attached
      // (a stored document's filename on disk is routinely not the display name
      // the plan carries).
      const attachedWrongFile =
        uploadedFileName !== undefined && verification.actualValue !== uploadedFileName;
      if (verification.verified && !attachedWrongFile) {
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
      // A control now holding a *different* file is not a transient failure to
      // retry past: something else owns that control, and writing over it again
      // would be the wrong move. Reported immediately, naming what happened.
      if (attachedWrongFile) {
        return failure(
          action,
          'UPLOAD_FAILED',
          `The upload control reports ${
            typeof verification.actualValue === 'string' && verification.actualValue
              ? `"${verification.actualValue}"`
              : 'no file'
          } rather than the document that was attached. Attach it yourself and check the form.`,
          started,
          attempts,
        );
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
