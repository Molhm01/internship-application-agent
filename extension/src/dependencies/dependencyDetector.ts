import { ABSENT_FINGERPRINT, type ControlFingerprint } from '@internship-agent/shared';
import { allDocumentRoots } from '../verifier/domVerifier.js';

/**
 * Reading what a control looks like right now, so a change to it can be
 * *observed* rather than assumed.
 *
 * The previous code had no notion of this. It waited for a dependent select to
 * "offer a real choice", which cannot distinguish a list the page rebuilt from
 * one that happened to have a usable option in it all along — and it could say
 * nothing at all about a control that was disabled, or that was not in the DOM
 * yet. A fingerprint answers all three with one comparison.
 *
 * Nothing here writes, focuses, or opens anything. A page that is only
 * fingerprinted must look, to the applicant, exactly as it did before.
 */

/** The element a selector names, in any of this frame's roots. */
export function findControl(document: Document, selector: string): HTMLElement | null {
  if (!selector) return null;
  for (const root of allDocumentRoots(document)) {
    try {
      const found = root.querySelector<HTMLElement>(selector);
      if (found) return found;
    } catch {
      // A selector the browser will not parse names nothing. Not an error: the
      // control is reported absent, which is the truthful reading.
    }
  }
  return null;
}

/**
 * An order-sensitive digest of an option list.
 *
 * Order-sensitive on purpose: a page that replaces "Alabama…Wyoming" with
 * "Alberta…Quebec" keeps the count on some pairs of countries, and a
 * set-insensitive digest would call that no change. Cheap and non-cryptographic
 * — this compares a list against itself moments later, and nothing depends on
 * it being hard to forge.
 */
export function hashOptions(entries: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    for (let index = 0; index < entry.length; index += 1) {
      hash ^= entry.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** One entry a control offers, as the fingerprint needs to see it. */
interface OptionEntry {
  value: string;
  label: string;
}

/**
 * True for an entry that is the control's own prompt rather than a choice.
 *
 * An empty value is the decisive signal — that is what a native placeholder
 * has, whatever it is worded — and the wordings below catch the custom controls
 * that give their prompt a value anyway.
 */
function isPromptOption(entry: OptionEntry): boolean {
  if (entry.value === '') return true;
  const text = entry.label.trim().toLowerCase();
  if (text.length === 0) return true;
  return (
    /^(please\s+)?(select|choose|pick)\b/.test(text) ||
    text === '--' ||
    text === 'n/a' ||
    text === 'no selection' ||
    text === 'none selected'
  );
}

/** The options a control currently offers, without opening anything. */
function optionsOf(element: HTMLElement): OptionEntry[] {
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options).map((option) => ({
      value: option.value,
      label: option.label || option.text,
    }));
  }
  // A custom listbox that is already rendered. Never opened to look: opening is
  // an interaction, and the Dropdown Engine is what interacts.
  const owned = element.getAttribute('aria-controls');
  if (owned) {
    const list = element.ownerDocument.getElementById(owned);
    if (list) {
      return Array.from(list.querySelectorAll('[role="option"]')).map((option) => {
        const label = option.textContent?.trim() ?? '';
        return { value: option.getAttribute('data-value') ?? label, label };
      });
    }
  }
  if (element instanceof HTMLInputElement && element.type === 'radio' && element.name) {
    const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(element.name) : element.name;
    return Array.from(
      element.ownerDocument.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${escaped}"]`,
      ),
    ).map((radio) => ({ value: radio.value, label: radio.value }));
  }
  return [];
}

function isDisabled(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  if (
    element instanceof HTMLSelectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.disabled;
  }
  return false;
}

/**
 * What this control looks like right now.
 *
 * A control that is not on the page is a legitimate fingerprint rather than an
 * error: `CONTROL_APPEAR` dependencies begin from exactly that state, and the
 * change being waited for is `present` going true.
 */
export function fingerprintControl(document: Document, selector: string): ControlFingerprint {
  const element = findControl(document, selector);
  if (!element) return { ...ABSENT_FINGERPRINT };
  const entries = optionsOf(element);
  return {
    present: true,
    disabled: isDisabled(element),
    optionCount: entries.length,
    usableOptionCount: entries.filter((entry) => !isPromptOption(entry)).length,
    optionsHash: hashOptions(entries.map((entry) => `${entry.value} ${entry.label}`)),
    ariaExpanded: element.getAttribute('aria-expanded') ?? '',
    ariaDisabled: element.getAttribute('aria-disabled') ?? '',
  };
}

/**
 * The narrowest element worth watching for a change to this control.
 *
 * A dependent control is routinely *replaced* rather than mutated, so observing
 * the control itself would miss its own replacement — the observer would be
 * attached to an element no longer in the document. The parent is the smallest
 * subtree that survives that, and watching a subtree rather than
 * `document.documentElement` is what keeps a form with three hundred controls
 * from waking this up on every unrelated re-render.
 */
export function watchTargetFor(document: Document, selector: string): HTMLElement {
  const element = findControl(document, selector);
  const closest = element?.closest<HTMLElement>(
    'fieldset,[role="group"],.field,.form-field,section,form',
  );
  return closest ?? element?.parentElement ?? document.body ?? document.documentElement;
}
