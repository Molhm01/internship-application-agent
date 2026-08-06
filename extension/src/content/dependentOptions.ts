import { allDocumentRoots } from '../verifier/domVerifier.js';

/**
 * Waiting for a control whose choices another control produces.
 *
 * "State/Province" is empty — or offers a single "Select a country first"
 * prompt — until Country is chosen, and the page then repopulates it
 * asynchronously. The run used to bridge that with a fixed 350ms sleep between
 * passes, which is both too long for a page that repopulates instantly and far
 * too short for one that fetches its region list, and the second case is the
 * reported failure: State rescanned before its options existed, matched
 * nothing, and stayed blank.
 *
 * So the wait is bounded by an *observation* instead of by a clock. A
 * MutationObserver on each dependent control resolves the moment it offers a
 * real choice; the timeout only ever ends a wait that was never going to
 * finish, and no full-page rescan happens in between.
 *
 * Nothing here writes to the page. It reads option sets and returns which
 * controls populated.
 */

/** The ordinary ceiling. Long enough for a region list, short enough to feel instant. */
export const DEPENDENT_OPTIONS_TIMEOUT_MS = 2000;

/** True when an option is a prompt rather than something a person can pick. */
function isPlaceholderOption(label: string, value: string): boolean {
  const text = label.trim().toLowerCase();
  if (value === '' || text.length === 0) return true;
  return /^(please )?(select|choose)\b/.test(text) || text === '--' || text === 'n/a';
}

/** The control this selector names, in any of the frame's document roots. */
function findControl(document: Document, selector: string): HTMLElement | null {
  for (const root of allDocumentRoots(document)) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return null;
}

/**
 * True when this control now offers at least one real choice.
 *
 * Native selects and radio groups only, which is exactly the set the planner
 * recognizes as dependent: a custom combobox reveals its list on opening, and
 * opening one to look would be an interaction rather than an observation.
 */
export function offersRealChoice(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options).some(
      (option) => !isPlaceholderOption(option.label ?? option.text, option.value),
    );
  }
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    const name = element.name;
    if (!name) return true;
    const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(name) : name;
    return (
      element.ownerDocument.querySelectorAll(`input[type="radio"][name="${escaped}"]`).length > 0
    );
  }
  // A control shape this cannot observe is never reported as populated, so the
  // caller falls back to its bounded timeout rather than proceeding on a guess.
  return false;
}

export interface DependentOptionsOutcome {
  /** Selectors whose control offered a real choice before the deadline. */
  populated: string[];
  /** Selectors that were still empty when the wait ended. */
  pending: string[];
  /** Selectors naming a control that is not on this page at all. */
  missing: string[];
  waitedMs: number;
}

/**
 * Resolves once every named control offers a real choice, or at the deadline.
 *
 * Called with the selectors of the controls the planner reported as dependent,
 * immediately after the pass that answered what they depend on.
 */
export function awaitDependentOptions(
  document: Document,
  selectors: readonly string[],
  timeoutMs: number = DEPENDENT_OPTIONS_TIMEOUT_MS,
): Promise<DependentOptionsOutcome> {
  const started = Date.now();
  const missing: string[] = [];
  const watched = new Map<string, HTMLElement>();
  for (const selector of selectors) {
    const element = findControl(document, selector);
    if (element) watched.set(selector, element);
    else missing.push(selector);
  }

  const settle = (): DependentOptionsOutcome | null => {
    const populated: string[] = [];
    const pending: string[] = [];
    for (const [selector, element] of watched) {
      // Re-resolved each time: a framework that repopulates a select routinely
      // replaces the element rather than mutating it.
      const current = findControl(document, selector) ?? element;
      if (offersRealChoice(current)) populated.push(selector);
      else pending.push(selector);
    }
    if (pending.length > 0) return null;
    return { populated, pending, missing, waitedMs: Date.now() - started };
  };

  const immediate = settle();
  if (watched.size === 0 || immediate) {
    return Promise.resolve(
      immediate ?? { populated: [], pending: [], missing, waitedMs: Date.now() - started },
    );
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: DependentOptionsOutcome): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(outcome);
    };
    const check = (): void => {
      const outcome = settle();
      if (outcome) finish(outcome);
    };
    const observer = new MutationObserver(check);
    // The whole document, because the replacement select is a *new* element and
    // observing only the old one would miss it. Attributes are excluded: a
    // class change on a rerender is not a new option.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const timer = window.setTimeout(() => {
      const populated: string[] = [];
      const pending: string[] = [];
      for (const selector of watched.keys()) {
        const current = findControl(document, selector);
        if (current && offersRealChoice(current)) populated.push(selector);
        else pending.push(selector);
      }
      finish({ populated, pending, missing, waitedMs: Date.now() - started });
    }, timeoutMs);
  });
}
