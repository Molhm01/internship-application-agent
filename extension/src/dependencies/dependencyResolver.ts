import { normalizeOptionText } from '@internship-agent/shared';
import { findControl } from './dependencyDetector.js';

/**
 * Deciding whether a form is currently asking a question at all.
 *
 * Distinct from deciding the *answer*, which stays where it already lives — the
 * deterministic matcher and `resolveIntendedAnswer` in the worker. This module
 * answers only: given what the parent control is holding at this instant, does
 * the child apply, does it not apply, or is it too early to say?
 *
 * The distinction is the safety property, and it is the one the live run got
 * wrong in the worst possible way. The run typed the applicant's own name into
 * "If yes, provide the name, location and relationship of each relative"
 * because that label contains the word "name" — while the relatives question
 * above it had never been answered. The form then stated to the employer that
 * the applicant had a relative working there.
 *
 * So the gate reads the parent out of the *live document*, never from a plan.
 * A plan that intends to choose "Other" has not chosen it, and a page where the
 * applicant cleared an answer between the scan and the fill is a page where the
 * child must stay empty.
 */

export type Applicability =
  /** The parent holds the activating answer. The child is a real question. */
  | 'APPLIES'
  /** The parent holds some other answer. The child is not being asked. */
  | 'NOT_APPLICABLE'
  /** The parent holds nothing. Too early to say, and nothing may be written. */
  | 'PARENT_UNANSWERED';

/** Everything the parent control is currently holding, as text. */
export function readHeldValues(element: HTMLElement): string[] {
  const held: string[] = [];
  if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(element.selectedOptions)) {
      // A select sitting on its own prompt holds nothing. Without this, "Select
      // one…" reads as an answer and every conditional child on the page
      // becomes not-applicable before anything has been decided.
      if (option.value === '') continue;
      held.push(option.value, option.textContent ?? '');
    }
    return held;
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      if (element.checked) held.push(element.value, 'yes');
      return held;
    }
    if (element.value) held.push(element.value);
    return held;
  }
  if (element instanceof HTMLTextAreaElement) {
    if (element.value) held.push(element.value);
    return held;
  }
  // A custom control renders its answer as text. An unanswered one renders its
  // prompt, which `looksLikePrompt` below refuses.
  const text = (element.textContent ?? '').trim();
  if (text) held.push(text);
  return held;
}

/** True for a placeholder a control shows when nobody has answered it. */
function looksLikePrompt(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return true;
  return (
    /^(please\s+)?(select|choose|pick)\b/.test(text) ||
    text === '--' ||
    text === 'n/a' ||
    text === 'none selected' ||
    text === 'no selection'
  );
}

/**
 * Whether a conditional child is currently being asked.
 *
 * `requiredState` is the value named in the child's own label — the `yes` in
 * "If yes, …", the `other` in "If other, please specify". The page stated the
 * condition in words; this checks it against what the page currently holds.
 */
export function applicabilityOf(
  document: Document,
  parentSelector: string,
  requiredState: string,
): Applicability {
  const parent = findControl(document, parentSelector);
  // A parent that has left the page cannot switch anything on. Refusing is the
  // safe reading: writing to a child whose condition cannot be checked is
  // exactly the relatives failure.
  if (!parent) return 'PARENT_UNANSWERED';

  const held = readHeldValues(parent).filter((value) => !looksLikePrompt(value));
  if (held.length === 0) return 'PARENT_UNANSWERED';

  const wanted = normalizeOptionText(requiredState);
  const activated = held
    .map((value) => normalizeOptionText(value))
    // `startsWith` so a page spelling its escape hatch "Other/Not Listed"
    // activates a child whose label says "If other". Equality alone would leave
    // that child blank on a form that is asking it.
    .some((value) => value === wanted || value.startsWith(`${wanted} `));

  return activated ? 'APPLIES' : 'NOT_APPLICABLE';
}

/**
 * Whether a parent control has been settled at all, for a non-conditional edge.
 *
 * An OPTION_REFRESH parent does not have a required value — any answer
 * regenerates the child's list — so the only question is whether it holds one.
 */
export function parentIsAnswered(document: Document, parentSelector: string): boolean {
  const parent = findControl(document, parentSelector);
  if (!parent) return false;
  return readHeldValues(parent).some((value) => !looksLikePrompt(value));
}
