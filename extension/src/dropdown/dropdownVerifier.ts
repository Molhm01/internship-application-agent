import { normalizeOptionText, type CollectedOption } from '@internship-agent/shared';
import { readSelectedText, waitFor } from '../scanner/optionDiscovery.js';

/**
 * Whether the control actually holds the answer now.
 *
 * A function returning without throwing is not evidence a field was filled, and
 * an option having been clicked is not evidence it was chosen. Both were treated
 * as proof at some point in this project's history, and both produced runs that
 * reported success over a form the applicant then had to fill by hand.
 *
 * So verification reads the control's own state, and only the control's own
 * state. For a `<select>` that means three independent facts agreeing —
 * `value`, `selectedIndex`, and the element in `selectedOptions` — because a
 * page that swaps its option list mid-write can leave `value` looking right
 * while the selection points somewhere else. For a custom widget it means the
 * text the control now displays, waited for rather than sampled once, since a
 * React control commits its label on the render after the click.
 */

/** How long a custom control is given to display what was chosen. */
const VERIFY_WAIT_MS = 1500;

export interface Verification {
  verified: boolean;
  /** What the control displays now, for the report to quote. */
  observed: string;
  reason: string;
}

/**
 * A `<select>`, checked against three facts rather than one.
 *
 * Deliberately strict about the option *element*: comparing `value` alone
 * passes on a list holding two options with the same value, which is exactly
 * what a page rebuilding its regions produces mid-update.
 */
export function verifyNativeSelection(
  select: HTMLSelectElement,
  target: HTMLOptionElement,
): Verification {
  const observed = readSelectedText(select);
  const verified =
    select.value === target.value &&
    select.selectedIndex === target.index &&
    select.selectedOptions[0] === target;
  return {
    verified,
    observed,
    reason: verified
      ? `The control now shows "${observed}".`
      : `The control was set to "${target.textContent?.trim() ?? target.value}" and reports "${observed}".`,
  };
}

/**
 * A custom widget, checked against what it displays.
 *
 * `includes` rather than equality, and that is not laxity: a trigger routinely
 * renders more than the option's own text — "New Jersey ✕" with its clear
 * button, "United States of America (US)" with the code appended. Requiring
 * equality failed controls that were displaying exactly the right answer.
 *
 * The waiting is the other half. Sampling once immediately after a click reads
 * the frame *before* the framework has rendered its new state, which reported
 * `SELECTION_NOT_ACCEPTED` over a selection that landed a few milliseconds
 * later.
 */
export async function verifyDisplayedSelection(
  root: HTMLElement,
  option: CollectedOption,
): Promise<Verification> {
  const wanted = normalizeOptionText(option.displayedText);
  const shown = await waitFor(() => {
    if (!root.isConnected) return null;
    const text = readSelectedText(root);
    return normalizeOptionText(text).includes(wanted) ? text : null;
  }, VERIFY_WAIT_MS);

  if (shown !== null) {
    return { verified: true, observed: shown, reason: `The control now shows "${shown}".` };
  }
  if (!root.isConnected) {
    return {
      verified: false,
      observed: '',
      reason: 'The control was removed from the page after the option was chosen.',
    };
  }
  const settled = readSelectedText(root);
  return {
    verified: false,
    observed: settled,
    reason:
      settled.trim().length === 0
        ? `"${option.displayedText}" was chosen and the control still shows nothing.`
        : `"${option.displayedText}" was chosen and the control shows "${settled}".`,
  };
}

/**
 * Whether a control already displays the intended answer.
 *
 * Checked before anything is opened, because a control that is already correct
 * must not be rewritten: selecting a country that is already selected fires
 * `change`, and a page that rebuilds its region list on that event throws away
 * the state chosen moments earlier. It is also simply the truth — a form the
 * applicant part-filled themselves is not work for this engine.
 */
export function alreadyDisplays(root: HTMLElement, wording: string): boolean {
  const wanted = normalizeOptionText(wording);
  if (wanted.length === 0) return false;
  const shown = normalizeOptionText(readSelectedText(root));
  if (shown.length === 0) return false;
  return shown === wanted || shown.includes(wanted);
}
