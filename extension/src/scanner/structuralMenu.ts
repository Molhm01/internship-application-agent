import type { MenuDetectionStrategy, OptionCandidateStrategy } from '@internship-agent/shared';

/**
 * Finding a menu that opened without saying so.
 *
 * Everything else in this extension locates a dropdown's popup by what it
 * *declares*: `aria-controls`, `role="listbox"`, `role="menu"`, a portal data
 * attribute. That covers the widget libraries, and it does not cover a large
 * amount of what employers actually ship. A live portal's Education Type control
 * is a `div` that mounts another `div` full of `li` elements under
 * `document.body` and tells nobody. To this codebase that control opened
 * nothing, and the honest-but-useless report was `OPEN_FAILED` over a menu the
 * applicant could see.
 *
 * So there is one more way in, and it is deliberately the last one tried: watch
 * what the click *did* to the document, and treat a container that appeared
 * because of it as the menu.
 *
 * ## Why this is not "click everything that looks clickable"
 *
 * The dangerous version of this idea is a global sweep — every `div` with a
 * click handler becomes an option, and the engine starts pressing navigation
 * links and section headers on a page it is supposed to be filling in. Three
 * rules keep that from being what this is:
 *
 * 1. **Scoped to the mutation.** Only elements that were added, or made visible,
 *    between the moment before the press and the moment after it are ever
 *    considered. A container that was already on the page is not a menu that
 *    just opened.
 * 2. **Scoped to one container.** Exactly one element is chosen as *the menu*,
 *    and option candidates are only ever looked for inside it.
 * 3. **Repetition is the evidence.** A menu is a list: several sibling elements
 *    of the same shape, each with its own short text. One clickable div is not a
 *    menu, and this will not call it one.
 *
 * Nothing here dispatches an event. It observes, it ranks, and it returns an
 * element — the driving is still the executor's, through the same open →
 * enumerate → match → select → verify sequence every other widget goes through.
 */

/** A menu must offer at least this many candidates before it is believed. */
const MIN_CANDIDATES = 2;

/** How far from its trigger a menu may be mounted and still be its menu. */
const MAX_TRIGGER_DISTANCE_PX = 600;

/**
 * The conservative shapes an option is allowed to take when it has no role.
 *
 * A closed list, and every member is an element type whose whole purpose is to
 * be one entry among several: a list item, a button, a link, or something the
 * page itself tagged with a value.
 */
const STRUCTURAL_OPTION_SELECTOR =
  'li,button,a,[data-value],[data-key],[data-option],[data-item],[data-index]';

/** Repeated same-shaped siblings are the last resort inside a chosen menu. */
const REPEATED_TAGS = new Set(['DIV', 'SPAN', 'P']);
const MIN_REPEATED_SIBLINGS = 3;

/**
 * Menus this module has identified, so every later step agrees with the one
 * that found them.
 *
 * A `WeakSet` rather than an attribute on the element: marking the employer's
 * DOM to remember our own decision changes the page, and a page that is only
 * being read must look exactly as it did before.
 */
const STRUCTURAL_MENUS = new WeakSet<HTMLElement>();

/** The menu this module last opened for a trigger, for re-finding it later. */
const OPENED_MENUS = new WeakMap<HTMLElement, HTMLElement>();

export function isStructuralMenu(element: HTMLElement): boolean {
  return STRUCTURAL_MENUS.has(element);
}

/** The menu found for this trigger, while it is still on the page and open. */
export function rememberedMenu(trigger: HTMLElement): HTMLElement | null {
  const menu = OPENED_MENUS.get(trigger);
  if (!menu || !menu.isConnected) return null;
  return menu;
}

export function forgetMenu(trigger: HTMLElement): void {
  OPENED_MENUS.delete(trigger);
}

export interface MenuWatch {
  /** Everything added or revealed since the watch began. */
  settle(): HTMLElement[];
}

/**
 * Watches a document for elements that appear, or become visible, from now on.
 *
 * Attribute changes count as well as insertions: a menu that is rendered up
 * front and toggled with `hidden`, a class, or an inline `display` is just as
 * newly-visible as one that was mounted, and only observing `childList` missed
 * the entire toggled family.
 */
export function watchForMenu(scope: Document | ShadowRoot): MenuWatch {
  const touched = new Set<HTMLElement>();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) touched.add(node);
      }
      if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        touched.add(record.target);
      }
    }
  });

  const options: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open', 'data-state'],
  };
  // Both trees: a portal escapes the shadow root it was triggered from, and a
  // shadow-rooted widget renders its menu inside. Watching one missed one.
  const roots = new Set<Node>();
  if (scope instanceof ShadowRoot) roots.add(scope);
  if (document.documentElement) roots.add(document.documentElement);
  for (const root of roots) observer.observe(root, options);

  return {
    settle(): HTMLElement[] {
      // Anything the observer has seen but not yet delivered.
      for (const record of observer.takeRecords()) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) touched.add(node);
        }
        if (record.type === 'attributes' && record.target instanceof HTMLElement) {
          touched.add(record.target);
        }
      }
      observer.disconnect();
      return [...touched];
    },
  };
}

/** Whether an element is laid out and not hidden. Local so this file stands alone. */
function laidOut(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.hidden) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The shortest distance between two boxes, in CSS pixels. */
function distanceBetween(left: DOMRect, right: DOMRect): number {
  const dx = Math.max(0, Math.max(left.left - right.right, right.left - left.right));
  const dy = Math.max(0, Math.max(left.top - right.bottom, right.top - left.bottom));
  return Math.hypot(dx, dy);
}

/** Candidates with a candidate inside them removed, so each entry is one entry. */
function outermost(candidates: readonly HTMLElement[]): HTMLElement[] {
  return candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)),
  );
}

/**
 * Sibling groups of the same plain tag, which is what an unstyled menu row is.
 *
 * Requires three, not two: two same-shaped divs is a layout, three or more with
 * their own text is a list. The threshold is the whole safety of this rule.
 */
function repeatedSiblings(container: HTMLElement): HTMLElement[] {
  const byParent = new Map<HTMLElement, HTMLElement[]>();
  for (const element of container.querySelectorAll<HTMLElement>('div,span,p')) {
    const parent = element.parentElement;
    if (!parent) continue;
    if (!REPEATED_TAGS.has(element.tagName)) continue;
    // An entry has its own words and does not wrap other entries.
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > 200) continue;
    if (element.querySelector('div,span,p,li,button,a')) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), element]);
  }
  let best: HTMLElement[] = [];
  for (const group of byParent.values()) {
    if (group.length >= MIN_REPEATED_SIBLINGS && group.length > best.length) best = group;
  }
  return best;
}

/**
 * The entries of a menu that has no ARIA roles to name them.
 *
 * Only ever called with a container this module already decided is a menu, which
 * is what stops it from being a page-wide hunt for clickable things.
 */
export function structuralOptionItems(container: HTMLElement): HTMLElement[] {
  const tagged = outermost(
    [...container.querySelectorAll<HTMLElement>(STRUCTURAL_OPTION_SELECTOR)].filter(
      (element) => (element.textContent ?? '').trim().length > 0 && laidOut(element),
    ),
  );
  if (tagged.length >= MIN_CANDIDATES) return tagged;
  const repeated = repeatedSiblings(container).filter(laidOut);
  return repeated.length >= MIN_CANDIDATES ? repeated : tagged;
}

/**
 * How many entries a container would offer if it were treated as a menu.
 *
 * Counted rather than collected, because ranking happens over several
 * candidates and only the winner's entries are ever read.
 */
function candidateCount(container: HTMLElement): number {
  return structuralOptionItems(container).length;
}

export interface StructuralMenuResult {
  container: HTMLElement | null;
  strategy: MenuDetectionStrategy;
  optionStrategy: OptionCandidateStrategy;
}

/**
 * The menu the click just opened, chosen from what the click changed.
 *
 * Ranked rather than taken first-found, because a single press routinely mutates
 * several things: an overlay backdrop, a positioning wrapper, and the list
 * itself. The list is the one that is near its trigger, holds repeated entries,
 * and is the most specific element that still holds all of them.
 */
export function findStructuralMenu(
  trigger: HTMLElement,
  touched: readonly HTMLElement[],
): StructuralMenuResult {
  const none: StructuralMenuResult = {
    container: null,
    strategy: 'none',
    optionStrategy: 'none',
  };
  if (touched.length === 0) return none;

  const triggerBox = trigger.getBoundingClientRect();
  const declared = (
    trigger.getAttribute('aria-controls') ??
    trigger.getAttribute('aria-owns') ??
    ''
  )
    .split(/\s+/)
    .filter(Boolean);

  // Every mutated element, plus their descendants: a portal mounts one wrapper
  // and the list is inside it, so the wrapper alone is rarely the right answer.
  const pool = new Set<HTMLElement>();
  for (const element of touched) {
    if (!element.isConnected) continue;
    pool.add(element);
    for (const descendant of element.querySelectorAll<HTMLElement>('*')) pool.add(descendant);
  }

  const scored: Array<{ element: HTMLElement; score: number; count: number }> = [];
  for (const element of pool) {
    // A menu is never an ancestor of its own trigger, and never the trigger.
    if (element === trigger || element.contains(trigger)) continue;
    if (!laidOut(element)) continue;
    const count = candidateCount(element);
    if (count < MIN_CANDIDATES) continue;

    let score = count;
    // Named by the trigger: as good as evidence gets without a role.
    if (element.id && declared.includes(element.id)) score += 100;
    // Sharing an id, class token or data attribute with the trigger's own
    // wiring is the next best association a portal offers.
    if (element.id && trigger.getAttribute('aria-activedescendant') === element.id) score += 50;
    const distance = distanceBetween(triggerBox, element.getBoundingClientRect());
    if (distance > MAX_TRIGGER_DISTANCE_PX) continue;
    score += Math.max(0, 40 - distance / 20);
    // Something that calls itself a menu without using a role still says so.
    if (/menu|dropdown|listbox|options|select/i.test(element.className || '')) score += 20;
    scored.push({ element, score, count });
  }
  if (scored.length === 0) return none;

  scored.sort((left, right) => right.score - left.score);
  const winner = scored[0];
  if (!winner) return none;

  // The most specific element that still holds every entry the winner offers,
  // so the menu is the list rather than the overlay it sits in.
  let container = winner.element;
  for (;;) {
    const inner = [...container.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && candidateCount(child) === winner.count,
    );
    const next = inner[0];
    if (inner.length !== 1 || !next) break;
    container = next;
  }

  STRUCTURAL_MENUS.add(container);
  OPENED_MENUS.set(trigger, container);
  return {
    container,
    strategy: 'mutation_fallback',
    // Whether the entries carried a role is decided by the reader, not here —
    // a mutation-found container may still be full of `role="option"` rows on a
    // widget that simply never wired up `aria-controls`.
    optionStrategy: container.querySelector('[role="option"],[role="menuitem"]')
      ? 'aria_option_role'
      : 'structural_candidates',
  };
}
