import {
  normalizeOptionText,
  type CollectedOption,
  type DropdownFailureCode,
} from '@internship-agent/shared';
import {
  activeOption,
  optionItemsIn,
  pressKey,
  pressPointer,
  resolveTrigger,
  revealOption,
} from '../scanner/optionDiscovery.js';
import {
  verifyDisplayedSelection,
  verifyNativeSelection,
  type Verification,
} from './dropdownVerifier.js';

/**
 * Making the selection actually happen.
 *
 * Three ways of operating a control, tried in the order a person would: set a
 * `<select>` directly, click the option element, walk to it with the keyboard.
 * The third is not a formality — a widget that commits only from its own
 * `keydown` handler swallows a pointer sequence entirely, and at the point of
 * failure that is indistinguishable from a lost click. Rather than guess which
 * it was, the engine simply tries the other way of driving the same control
 * before it reports anything.
 *
 * Every path ends in verification against observed control state. None of them
 * reports success because an interaction was dispatched.
 */

/** Between arrow presses, so an async highlight has settled before it is read. */
const KEY_SETTLE_MS = 16;

/**
 * A ceiling on the arrow-key walk, independent of what the list claims.
 *
 * Bounded twice — by the choices on offer and by this — because neither alone
 * is enough: a virtualized list under-reports its rendered rows, and a widget
 * that never moves its highlight would otherwise be pressed at forever.
 */
const MAX_KEYBOARD_STEPS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Execution {
  selected: boolean;
  verification: Verification;
  failureCode?: DropdownFailureCode;
  reason: string;
}

function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  // The prototype setter rather than the property, so a framework that has
  // installed its own accessor still sees the change it is listening for.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (!descriptor?.set) throw new Error('The native value setter is unavailable.');
  descriptor.set.call(select, value);
}

/**
 * Drives a `<select>`.
 *
 * "Already correct" is a success rather than a rewrite. Re-selecting the value
 * a control already holds fires `change`, and a page that rebuilds its
 * dependent list on that event discards the answer chosen moments earlier —
 * which is how filling Country a second time wiped out State.
 */
export function executeNative(select: HTMLSelectElement, option: CollectedOption): Execution {
  const target = Array.from(select.options).find(
    (candidate) =>
      !candidate.disabled &&
      (candidate.value === option.value ||
        normalizeOptionText(candidate.textContent ?? '') === option.normalizedText),
  );
  if (!target) {
    return {
      selected: false,
      verification: { verified: false, observed: '', reason: '' },
      failureCode: 'OPTION_DISABLED',
      reason: `"${option.displayedText}" is on the list and cannot be chosen.`,
    };
  }

  if (select.value !== target.value) {
    select.focus();
    setNativeSelectValue(select, target.value);
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    select.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: true }));
  }

  const verification = verifyNativeSelection(select, target);
  return {
    selected: true,
    verification,
    ...(verification.verified ? {} : { failureCode: 'SELECTION_NOT_ACCEPTED' as const }),
    reason: verification.reason,
  };
}

/** Finds a matched option's live element by its own text, never by position. */
function optionElementFor(
  container: HTMLElement,
  option: CollectedOption,
): HTMLElement | undefined {
  // `optionItemsIn`, not a raw role query: a menu found by watching what the
  // click changed has no roles to query, and the element to press has to be
  // found by exactly the same rule that listed it in the first place.
  const items = optionItemsIn(container);
  return (
    items.find(
      (element) => Boolean(option.value) && element.getAttribute('data-value') === option.value,
    ) ??
    items.find(
      (element) => normalizeOptionText(element.textContent ?? '') === option.normalizedText,
    )
  );
}

/**
 * Walks to an option with the keyboard and commits it.
 *
 * The highlight is *read* after each press rather than counted towards, because
 * a list that wraps, skips disabled rows, or starts partway down does not move
 * one option per press — and pressing a fixed number of times is exactly how a
 * keyboard fallback selects the wrong answer.
 */
async function selectByKeyboard(
  trigger: HTMLElement,
  container: HTMLElement,
  option: CollectedOption,
  choiceCount: number,
): Promise<boolean> {
  const matches = (element: HTMLElement): boolean =>
    (Boolean(option.value) && element.getAttribute('data-value') === option.value) ||
    normalizeOptionText(element.textContent ?? '') === option.normalizedText;

  trigger.focus();
  const budget = Math.min(MAX_KEYBOARD_STEPS, Math.max(choiceCount, 1) + 1);
  const seen = new Set<string>();
  for (let step = 0; step < budget; step += 1) {
    const active = activeOption(trigger, container);
    if (active && matches(active)) {
      pressKey(trigger, 'Enter');
      return true;
    }
    if (active) {
      // A highlight back on a row already walked past means the list has
      // wrapped, and the answer is not on it.
      const mark = active.id || active.getAttribute('data-value') || (active.textContent ?? '');
      if (seen.has(mark)) return false;
      seen.add(mark);
    }
    pressKey(trigger, 'ArrowDown');
    await sleep(KEY_SETTLE_MS);
  }
  return false;
}

/**
 * Drives a custom widget: click the option, and if the control does not take
 * it, walk to the same option with the keyboard.
 *
 * The menu is re-found rather than reused between the two attempts, because a
 * widget that half-processed a click may have remounted it — and clicking
 * inside a detached container silently does nothing at all.
 */
export async function executeCustom(
  root: HTMLElement,
  container: HTMLElement,
  option: CollectedOption,
  choiceCount: number,
): Promise<Execution> {
  const trigger = resolveTrigger(root);

  // Scrolled back into existence if it has to be: enumeration restores the
  // list's scroll position, so on a virtualized menu the option just matched is
  // no longer a rendered element.
  const target =
    optionElementFor(container, option) ??
    (await revealOption(
      container,
      (element) =>
        (Boolean(option.value) && element.getAttribute('data-value') === option.value) ||
        normalizeOptionText(element.textContent ?? '') === option.normalizedText,
    )) ??
    undefined;

  if (target?.getAttribute('aria-disabled') === 'true' || target?.hasAttribute('disabled')) {
    return {
      selected: false,
      verification: { verified: false, observed: '', reason: '' },
      failureCode: 'OPTION_DISABLED',
      reason: `"${option.displayedText}" is on the list and cannot be chosen.`,
    };
  }

  if (target) {
    // Scrolling is a convenience for a virtualized list; its absence must never
    // abort a selection that is otherwise valid.
    target.scrollIntoView?.({ block: 'nearest' });
    pressPointer(target);
    const clicked = await verifyDisplayedSelection(root, option);
    if (clicked.verified) {
      return { selected: true, verification: clicked, reason: clicked.reason };
    }
  }

  // The click landed and the control still does not show the answer — the
  // signature of a widget that commits only from its own key handler. Or the
  // option was offered a moment ago and is no longer an element to click, which
  // the keyboard can still reach because the widget renders the row it
  // highlights.
  const walked = await selectByKeyboard(trigger, container, option, choiceCount);
  if (walked) {
    const settled = await verifyDisplayedSelection(root, option);
    if (settled.verified) {
      return { selected: true, verification: settled, reason: settled.reason };
    }
    return {
      selected: true,
      verification: settled,
      failureCode:
        settled.observed.trim().length === 0 ? 'SELECTION_NOT_ACCEPTED' : 'VERIFICATION_FAILED',
      reason: settled.reason,
    };
  }

  if (!target) {
    return {
      selected: false,
      verification: { verified: false, observed: '', reason: '' },
      failureCode: 'OPTION_CLICK_FAILED',
      reason: `"${option.displayedText}" was on the list and was gone before it could be chosen.`,
    };
  }
  const final = await verifyDisplayedSelection(root, option);
  return {
    selected: true,
    verification: final,
    failureCode:
      final.observed.trim().length === 0 ? 'SELECTION_NOT_ACCEPTED' : 'VERIFICATION_FAILED',
    reason: final.reason,
  };
}
