import type { RepeaterKind } from '@internship-agent/shared';
import { extractAccessibleLabel } from '../scanner/domScanner.js';
import { isVisible } from '../scanner/optionDiscovery.js';

/**
 * Finding a repeating section, its blocks, and the Add control that grows it.
 *
 * The whole subsystem turns on one distinction the previous code could not make:
 * a section's *identity* lives in its heading, and its Add control lives inside
 * it. The live application's button reads exactly `+ Add`. Nothing about that
 * string says "Work Experience", so a search that demanded the section be named
 * in the control's own text found nothing and the button was never pressed —
 * while a search that accepted a bare "Add" anywhere on the page would press the
 * Education one and add a school to somebody's job history.
 *
 * Scoping fixes both. The heading names the section; the section's own subtree
 * is where its Add control has to be; a control outside that subtree is somebody
 * else's, whatever it is called.
 */

/** Headings a section announces itself with. */
const SECTION_HEADINGS: Record<RepeaterKind, RegExp> = {
  experience:
    /\b(work|professional|employment|previous)\s+(experience|history|employment)\b|\bwork\s+history\b|\bemployment\b|\bexperience\b/i,
  education:
    /\b(education(al)?\s+(background|history)?|academic\s+(history|background|experience)|schools?)\b|\beducation\b/i,
  projects: /\b(projects?|portfolio)\b/i,
};

/**
 * The one question a block of this kind cannot be without.
 *
 * A block is counted from its anchor, not from its container: containers are
 * whatever the vendor chose, and two vendors never choose the same thing. An
 * employer is an employer.
 */
const ANCHOR_LABELS: Record<RepeaterKind, RegExp> = {
  experience: /\b(company|employer|organi[sz]ation)\b/i,
  education: /\b(school|institution|university|college)\b/i,
  projects: /\bproject\s*(name|title)\b/i,
};

/**
 * Text that means "this control ends the application".
 *
 * Checked before anything is ever pressed, and checked on the control's own
 * text rather than on its section — the whole point of the Add search is that it
 * presses buttons, and it must be structurally incapable of pressing this one.
 */
const NEVER_PRESS =
  /\b(submit|apply now|finish|send application|continue|next|save and continue)\b/i;

const ADD_WORDS = /(^|\s)(\+|add|another|new)(\s|$)/i;

const HEADING_SELECTOR =
  'h1,h2,h3,h4,h5,h6,legend,caption,[role="heading"],.section-title,.section-header,[data-automation-id*="sectionTitle"]';

const ANCHOR_CONTROL_SELECTOR = 'input:not([type="hidden"]),select,textarea,[role="combobox"]';

const ADD_CONTROL_SELECTOR = 'button,[role="button"],a[href="#"],a[href=""],input[type="button"]';

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** The accessible text of a control, as a person reading the page would. */
export function controlText(element: HTMLElement): string {
  return cleanText(
    `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${
      element.getAttribute('title') ?? ''
    } ${element.getAttribute('value') ?? ''}`,
  );
}

function isUsable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element instanceof HTMLInputElement && element.disabled) return false;
  return isVisible(element);
}

/** A control that must never be pressed by this engine, whatever it is called. */
function isForbiddenControl(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement && element.type === 'submit') return true;
  if (element instanceof HTMLInputElement && element.type === 'submit') return true;
  return NEVER_PRESS.test(controlText(element));
}

/**
 * The element that holds one section's heading and its questions.
 *
 * Starts at the heading and walks up only as far as it has to: the first
 * ancestor that contains at least one of this section's anchor controls. Walking
 * further would swallow the next section, and one container holding both Work
 * Experience and Education is how an Education Add button gets pressed to make
 * room for a job.
 */
function containerForHeading(heading: HTMLElement, kind: RepeaterKind): HTMLElement | null {
  let current: HTMLElement | null = heading.parentElement;
  const body = heading.ownerDocument.body;
  while (current && current !== body) {
    if (anchorControlsWithin(current, kind).length > 0) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Every control in this subtree that is one of the section's anchor questions.
 *
 * Conditional children are excluded — "If other, enter School/Institution Name"
 * is the same question as the School dropdown, not a second school, and counting
 * it would report one education block as two.
 */
export function anchorControlsWithin(root: HTMLElement, kind: RepeaterKind): HTMLElement[] {
  const pattern = ANCHOR_LABELS[kind];
  return Array.from(root.querySelectorAll<HTMLElement>(ANCHOR_CONTROL_SELECTOR)).filter(
    (element) => {
      const label = extractAccessibleLabel(element).label;
      if (!label) return false;
      if (/^if\s+(yes|no|other|another|none)\b/i.test(label)) return false;
      return pattern.test(label);
    },
  );
}

export interface RepeaterSection {
  kind: RepeaterKind;
  /** The element holding this section's heading, blocks, and Add control. */
  container: HTMLElement;
  heading: string;
}

/**
 * The section of this kind, or null when the application has none.
 *
 * When a page carries two plausible headings — "Employment History" as a page
 * title and again as a fieldset legend — the *innermost* container wins, because
 * the narrower one is the one that actually holds the blocks.
 */
export function findSection(root: ParentNode, kind: RepeaterKind): RepeaterSection | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter(
    (heading) => SECTION_HEADINGS[kind].test(cleanText(heading.textContent)),
  );

  const found: RepeaterSection[] = [];
  for (const heading of headings) {
    // Education must not be matched by a heading that is really about work, and
    // the reverse. "Education" appearing inside "Work Experience and Education"
    // is a combined section, and the first kind to claim it is not necessarily
    // the right one — so a heading that names *another* kind more specifically
    // is left to that kind.
    const container = containerForHeading(heading, kind);
    if (!container) continue;
    found.push({ kind, container, heading: cleanText(heading.textContent) });
  }
  if (found.length === 0) return null;

  // Innermost first: a container that contains another candidate's container is
  // the outer one, and the outer one is the page, not the section.
  found.sort((left, right) =>
    left.container.contains(right.container)
      ? 1
      : right.container.contains(left.container)
        ? -1
        : 0,
  );
  return found[0] ?? null;
}

/**
 * How many blocks this section is showing right now.
 *
 * One anchor is one block. Counted synchronously, because it is polled between
 * two DOM mutations while an Add press is being waited for — an asynchronous
 * answer would describe a page that has already moved on.
 */
export function countBlocks(section: RepeaterSection): number {
  return anchorControlsWithin(section.container, section.kind).length;
}

/**
 * The outermost ancestor that holds this anchor and no other anchor.
 *
 * That element is the repeated block, whatever tag the vendor wrapped it in.
 * Bounded by the section, so a block can never grow to swallow its siblings.
 */
function blockContainerFor(
  section: RepeaterSection,
  anchor: HTMLElement,
  allAnchors: readonly HTMLElement[],
): HTMLElement {
  let best: HTMLElement = anchor;
  let current: HTMLElement | null = anchor.parentElement;
  // Stops *below* the section container, never at it. A section holding one
  // block contains exactly one anchor, so an unbounded walk would call the
  // whole section "the block" — and the section also contains the Add control,
  // which the search below then discards as belonging to a block. That is how a
  // page with one Work Experience block reports no Add button at all.
  while (current && current !== section.container) {
    const holder = current;
    if (allAnchors.filter((element) => holder.contains(element)).length !== 1) break;
    best = holder;
    current = holder.parentElement;
  }
  return best;
}

export interface RepeaterBlock {
  /** `experience:block:1`. Stable for the life of one run. */
  blockId: string;
  index: number;
  element: HTMLElement;
  anchor: HTMLElement;
  /** What the anchor control currently holds. Empty means an unused block. */
  anchorValue: string;
}

/** The current value of a control, however the vendor renders it. */
export function readControlValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return cleanText(element.value);
  }
  if (element instanceof HTMLSelectElement) {
    const selected = element.selectedOptions[0];
    // A select sitting on its own prompt is empty, not answered. Without this a
    // block showing "Select one…" reads as filled and is never bound.
    if (!selected || selected.value === '') return '';
    return cleanText(selected.textContent);
  }
  return cleanText(element.getAttribute('aria-label') ?? element.textContent);
}

/**
 * This section's blocks, in page order.
 *
 * Page order is the binding order, and it is deterministic: `experience[0]` goes
 * to the first Work Experience block on the page every run, so pressing Autofill
 * twice cannot shuffle a history.
 */
export function findBlocks(section: RepeaterSection): RepeaterBlock[] {
  const anchors = anchorControlsWithin(section.container, section.kind);
  return anchors.map((anchor, index) => ({
    blockId: `${section.kind}:block:${index}`,
    index,
    element: blockContainerFor(section, anchor, anchors),
    anchor,
    anchorValue: readControlValue(anchor),
  }));
}

/**
 * This section's Add control, or null when it has none.
 *
 * Searched inside the section and nowhere else. A control that says "Add" and
 * sits outside this section belongs to another one, and pressing it adds a block
 * the applicant then has to delete.
 *
 * When the section holds several — some forms put one under each block — the
 * last in document order is taken, which is the one that appends rather than
 * inserts.
 */
export function findAddControl(section: RepeaterSection): HTMLElement | null {
  const anchors = anchorControlsWithin(section.container, section.kind);
  const candidates = Array.from(
    section.container.querySelectorAll<HTMLElement>(ADD_CONTROL_SELECTOR),
  ).filter((element) => {
    if (!isUsable(element)) return false;
    if (isForbiddenControl(element)) return false;
    const text = controlText(element);
    if (!ADD_WORDS.test(text) && element.getAttribute('aria-label') === null) return false;
    if (!ADD_WORDS.test(text)) return false;
    // A "Remove"/"Delete" control sometimes carries the word "another" in a
    // confirmation label. Never pressed.
    if (/\b(remove|delete|clear)\b/i.test(text)) return false;
    // A control *inside* a block adds something to that block — an extra
    // responsibility line — rather than adding a block to the section.
    return !anchors.some((anchor) => {
      const block = blockContainerFor(section, anchor, anchors);
      return block !== element && block.contains(element);
    });
  });

  return candidates.length === 0 ? null : (candidates[candidates.length - 1] ?? null);
}

/**
 * A block's identity, used to tell a block the page just created from the ones
 * that were already there.
 *
 * Deliberately structural — the anchor's own identity in the document — rather
 * than positional. A form that *inserts* a new block above the existing ones
 * would defeat an index comparison, and this does not care where it appeared.
 */
export function fingerprint(block: RepeaterBlock): string {
  const anchor = block.anchor;
  return [
    anchor.getAttribute('id') ?? '',
    anchor.getAttribute('name') ?? '',
    anchor.getAttribute('data-automation-id') ?? '',
  ].join('|');
}

/**
 * Fingerprints that are unique, paired with the ones that are not.
 *
 * A vendor that clones a block without renaming its controls produces identical
 * fingerprints. That is not a failure — it just means new blocks have to be told
 * apart by count and position instead, which the creator falls back to.
 */
export function fingerprintsAreDistinct(blocks: readonly RepeaterBlock[]): boolean {
  const seen = new Set(blocks.map(fingerprint));
  return seen.size === blocks.length && !seen.has('||');
}
