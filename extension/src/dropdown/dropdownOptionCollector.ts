import {
  collectedOptionSchema,
  normalizeOptionText,
  realChoices,
  type CollectedOption,
  type FieldOption,
  type MenuDetectionStrategy,
  type OptionCandidateStrategy,
} from '@internship-agent/shared';
import {
  closeControl,
  enumerateAllOptions,
  findListbox,
  openControl,
  readOptions,
  resolveTrigger,
  waitFor,
  type OpenDiagnostics,
} from '../scanner/optionDiscovery.js';

/**
 * Reading *every* choice a control offers, at the moment it is asked.
 *
 * This is the step the old path skipped, and skipping it is what produced the
 * signature failure: the plan carried the option list the *scan* saw, matched
 * against that, and then asserted the chosen `value` still existed. Any control
 * whose choices changed in between — a State list rebuilt after Country, an
 * Education Country list populated by script, a School list that does not exist
 * until it is opened — failed over a page that was working correctly.
 *
 * So nothing is remembered. The control is opened now, its list is read now,
 * and the answer is matched against what is actually on offer. A scan snapshot
 * is a planning hint and is never the thing selection is decided against.
 *
 * ## Completeness, not visibility
 *
 * "Read the options" means all of them. A long menu is either scrollable (every
 * option is in the DOM, most below the fold) or virtualized (only the visible
 * rows exist as elements at all). Reading what happened to be rendered reported
 * `OPTION_NOT_FOUND` for an answer that was three screens down — and then fell
 * through to the form's "Other" box with the right answer in hand.
 */

/** How long a menu that mounts empty is given to fill itself. */
const SETTLE_WAIT_MS = 750;

export interface CollectedOptions {
  /** Every distinct choice found, placeholders included. */
  all: readonly CollectedOption[];
  /** The choices that are real answers — prompts and separators removed. */
  choices: readonly CollectedOption[];
  /** True when the control had to be physically opened to see them. */
  opened: boolean;
  /** True when the list itself was scrolled to reach entries below the fold. */
  scrolled: boolean;
  /** The open menu, when there is one, so the executor can click inside it. */
  container: HTMLElement | null;
  /**
   * How the control behaved while being opened, for the trace.
   *
   * Observed here rather than reconstructed later: "the list did not open" is
   * the same sentence whether the trigger was never found, whether nothing
   * responded to the press, or whether a menu appeared that this code could not
   * recognise — and a live employer failure cannot be diagnosed without knowing
   * which of the three it was.
   */
  openAttempted: boolean;
  ariaExpandedAfter: string;
  menuDetection: MenuDetectionStrategy;
  optionCandidates: OptionCandidateStrategy;
  /** How many reads the enumeration needed. One means nothing was scrolled. */
  scrollIterations: number;
}

function toCollected(option: FieldOption, index: number): CollectedOption {
  return collectedOptionSchema.parse({
    // Position within *this* reading, for correlating a trace with a log. It is
    // never sent anywhere that could select by it: choosing an option by index
    // is precisely how a re-ordered list gets the wrong answer.
    optionId: `option-${index}`,
    displayedText: option.label.slice(0, 600),
    value: option.value.slice(0, 600),
    disabled: option.disabled ?? false,
    selected: option.selected ?? false,
    normalizedText: normalizeOptionText(option.label).slice(0, 600),
  });
}

function fromNative(select: HTMLSelectElement): FieldOption[] {
  return Array.from(select.options).map((option) => ({
    label: (option.textContent ?? option.label ?? '').replace(/\s+/g, ' ').trim(),
    value: option.value,
    ...(option.disabled || (option.parentElement as HTMLOptGroupElement | null)?.disabled
      ? { disabled: true }
      : {}),
    ...(option.selected ? { selected: true } : {}),
  }));
}

function asFieldOptions(
  options: readonly { label: string; value: string; disabled: boolean; selected: boolean }[],
): FieldOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.disabled ? { disabled: true } : {}),
    ...(option.selected ? { selected: true } : {}),
  }));
}

/** The diagnostics of a control nothing was opened on. */
const NO_OPEN: Pick<
  CollectedOptions,
  'openAttempted' | 'ariaExpandedAfter' | 'menuDetection' | 'optionCandidates' | 'scrollIterations'
> = {
  openAttempted: false,
  ariaExpandedAfter: '',
  menuDetection: 'none',
  optionCandidates: 'none',
  scrollIterations: 0,
};

function describe(
  options: readonly FieldOption[],
  opened: boolean,
  scrolled: boolean,
  container: HTMLElement | null,
  observed: Partial<CollectedOptions> = {},
): CollectedOptions {
  const all = options.map(toCollected);
  const realSet = new Set(realChoices(options).map((option) => normalizeOptionText(option.label)));
  return {
    all,
    choices: all.filter((option) => realSet.has(option.normalizedText)),
    opened,
    scrolled,
    container,
    ...NO_OPEN,
    ...observed,
  };
}

/**
 * A `<select>`'s choices, read from the control as it stands now.
 *
 * Nothing is opened: a native select has its options in the DOM already, and
 * clicking one open would put a browser-drawn list over the page for no reason.
 * `opened` is reported true because the equivalent thing — its list being
 * readable — is true, and a caller comparing the two widget families needs the
 * same word to mean the same thing.
 */
export function collectNativeOptions(select: HTMLSelectElement): CollectedOptions {
  return describe(fromNative(select), true, false, null, {
    // A `<select>` carries its own list; there is no menu to detect and no
    // opening to attempt. Reported as its own shape rather than as a failure.
    menuDetection: 'aria_role_container',
    optionCandidates: 'aria_option_role',
    ariaExpandedAfter: '',
    scrollIterations: 1,
  });
}

/**
 * A custom control's choices, by actually opening it.
 *
 * Leaves the menu open on purpose. The executor clicks an element inside it
 * moments later, and closing it here would mean opening it a second time —
 * during which a framework may rebuild the list, which is the exact race this
 * engine exists to stop losing.
 *
 * `searchText` is offered to controls that filter as they are typed into. It is
 * derived from a saved answer and never from an option's `value`: a Country
 * control whose "United States of America" entry has `value="US"` was once sent
 * "US" as its query, filtered itself to nothing, and left the box holding "US"
 * with no country chosen.
 */
export async function collectCustomOptions(
  root: HTMLElement,
  searchText?: string,
): Promise<CollectedOptions> {
  const trigger = resolveTrigger(root);
  const opening: OpenDiagnostics = {
    openAttempted: false,
    ariaExpandedAfter: '',
    menuDetection: 'none',
    optionCandidates: 'none',
  };
  const container = await openControl(trigger, searchText, opening);
  if (!container) return describe([], false, false, null, opening);

  // What is rendered before any scrolling. The difference between this and the
  // full read is the evidence that scrolling was needed — reported rather than
  // assumed, so "the long list was scrolled" is an observation.
  const rendered = readOptions(container).length;
  const scrolling = { scrollIterations: 0 };
  let live = await enumerateAllOptions(container, scrolling);

  if (live.length === 0) {
    // A menu that mounts empty and fills asynchronously. Waited for once, then
    // reported honestly rather than guessed at.
    const filled = await waitFor(() => {
      const current = findListbox(trigger) ?? container;
      return readOptions(current).length > 0 ? current : null;
    }, SETTLE_WAIT_MS);
    if (filled) live = await enumerateAllOptions(filled, scrolling);
  }

  return describe(
    asFieldOptions(live),
    true,
    live.length > rendered,
    findListbox(trigger) ?? container,
    { ...opening, ...scrolling },
  );
}

/** Closes a control this module opened, best-effort. */
export function releaseControl(root: HTMLElement): void {
  try {
    closeControl(resolveTrigger(root));
  } catch {
    // A widget that throws on close has already told us what we needed; the
    // outcome being reported matters more than the menu being tidy.
  }
}
