import { dropdownDirectiveSchema, type DropdownRunResult } from '@internship-agent/shared';
import { runOneDropdown } from '../dropdown/dropdownEngine.js';
import { scanDropdowns } from '../dropdown/dropdownScanner.js';
import { dispatchValueEvents, setNativeValue } from '../executor/domExecutor.js';
import { findControl } from './dependencyDetector.js';

/**
 * Driving one dependent control, after its parent has landed.
 *
 * This module deliberately contains **no dropdown logic and no text logic**. It
 * re-registers the control against the current DOM and hands it to the two
 * executors the project already has:
 *
 *  - option controls go to `runOneDropdown`, which opens, enumerates, matches,
 *    selects and verifies;
 *  - text controls go through `setNativeValue` + `dispatchValueEvents`, the
 *    same prototype-setter write every other text field on the page gets.
 *
 * A second implementation of either is how two code paths come to disagree
 * about what a control holds, and it is explicitly out of scope.
 *
 * ## Why the re-registration matters
 *
 * `scanDropdowns` mints a fresh handle for every control in the document. The
 * old handle from the discovery pass points at the element as it was *before*
 * the parent was answered — and a page repopulating a dependent select
 * routinely replaces the element rather than mutating it, so the old handle
 * names a node no longer in the document and the old option list describes
 * choices that no longer exist. Rescanning here is what §5 means by "discard
 * the OLD State reference/options": the choices this engine matches against are
 * the ones the page produced *after* Country was verified, never the prompt it
 * replaced.
 */

export interface DriveInput {
  document: Document;
  /** Where the control is now. Re-resolved against the live DOM. */
  selector: string;
  canonicalQuestion: string;
  intendedAnswer: string;
  intendedAnswerSource: string;
  alternativeValues: readonly string[];
  searchText?: string;
  allowOtherFallback: boolean;
  requiresUserConfirmation: boolean;
  sensitive: boolean;
}

export interface DriveOutcome {
  executed: boolean;
  verified: boolean;
  /** The dropdown engine's own record, when an option control was driven. */
  result?: DropdownRunResult;
  reason: string;
}

/**
 * Re-registers this control and returns the fresh handle the Dropdown Engine
 * uses, or null when the control is no longer on the page.
 *
 * Matched by selector against the *current* registry rather than by the id from
 * an earlier pass, because ids are minted per scan and the point of scanning
 * again is that the earlier ones are stale.
 */
export function reregister(document: Document, selector: string): string | null {
  const target = findControl(document, selector);
  if (!target) return null;
  for (const scanned of scanDropdowns(document)) {
    if (scanned.element === target) return scanned.descriptor.dropdownId;
  }
  return null;
}

/** True for a control the Dropdown Engine should drive rather than a text box. */
export function isOptionControl(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) return true;
  const role = element.getAttribute('role');
  if (role === 'combobox' || role === 'listbox') return true;
  return element instanceof HTMLInputElement && element.type === 'radio';
}

/**
 * Drives the control, whatever kind it is, and always returns a record.
 *
 * "Always" is the contract, for the same reason it is the Dropdown Engine's: a
 * dependent control missing from the results is indistinguishable from one that
 * was never on the form, and that is how a half-filled page comes back looking
 * complete.
 */
export async function driveDependent(input: DriveInput): Promise<DriveOutcome> {
  const element = findControl(input.document, input.selector);
  if (!element) {
    return { executed: false, verified: false, reason: 'The control is no longer on the page.' };
  }

  if (!isOptionControl(element)) {
    return writeText(element, input.intendedAnswer);
  }

  const dropdownId = reregister(input.document, input.selector);
  if (dropdownId === null) {
    return { executed: false, verified: false, reason: 'The control could not be registered.' };
  }

  const result = await runOneDropdown(
    dropdownDirectiveSchema.parse({
      dropdownId,
      canonicalQuestion: input.canonicalQuestion,
      intendedAnswer: input.intendedAnswer,
      intendedAnswerSource: input.intendedAnswerSource,
      alternativeValues: [...input.alternativeValues].slice(0, 12),
      ...(input.searchText ? { searchText: input.searchText } : {}),
      allowOtherFallback: input.allowOtherFallback,
      requiresUserConfirmation: input.requiresUserConfirmation,
      sensitive: input.sensitive,
    }),
  );

  return {
    executed: result.selected,
    verified: result.verified,
    result,
    reason: result.reason,
  };
}

/**
 * Writes a conditional text child — "If other, enter School/Institution Name".
 *
 * Verified by reading the field back, because a function returning successfully
 * is not evidence a field was filled. A framework that rejects or reformats the
 * value leaves the box holding something else, and that is a failure rather
 * than a success with a different spelling.
 */
function writeText(element: HTMLElement, value: string): DriveOutcome {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return { executed: false, verified: false, reason: 'This control does not take typed text.' };
  }
  if (value.trim().length === 0) {
    return { executed: false, verified: false, reason: 'Nothing saved answers this question.' };
  }
  // Already correct. Rewriting fires `input` and `change` at a framework that
  // may revalidate or clear a neighbouring dependent control.
  if (element.value === value) {
    return { executed: false, verified: true, reason: 'The page already held this answer.' };
  }
  element.focus();
  setNativeValue(element, value);
  dispatchValueEvents(element);
  const verified = element.value === value;
  return {
    executed: true,
    verified,
    reason: verified
      ? 'Written and confirmed against what the field now holds.'
      : 'The value was written and the field shows something else.',
  };
}

/**
 * Clears a control the form has switched off, but only when the agent is what
 * put something in it.
 *
 * Never touches text the applicant typed. A not-applicable box holding their
 * own words is their business, and silently emptying it is destroying their
 * work to satisfy a status.
 */
export function clearIfAgentWrote(
  element: HTMLElement,
  agentWroteValue: string | undefined,
): boolean {
  if (agentWroteValue === undefined) return false;
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (element.value !== agentWroteValue) return false;
  setNativeValue(element, '');
  dispatchValueEvents(element);
  return element.value === '';
}
