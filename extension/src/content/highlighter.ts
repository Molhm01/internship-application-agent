import {
  ANNOTATION_BADGES,
  ANNOTATION_COLOURS,
  isDrawnAnnotation,
  type AnnotationKind,
  type ReviewReason,
} from '@internship-agent/shared';
import { createOwnedElement } from './ownedDom.js';

/**
 * Draws attention to fields that need a person, without editing the employer's
 * page.
 *
 * Every mark is an absolutely-positioned overlay inside one Shadow DOM host
 * appended to `<body>`. The application's own elements get a single `outline`
 * and one data attribute and nothing else — no wrappers, no class names on
 * their nodes, no style rules that could cascade into their layout. Removing
 * the host removes every trace.
 */

const HOST_ID = 'internship-agent-review-layer';
const MARKED_ATTRIBUTE = 'data-internship-agent-review';

export interface HighlightRequest {
  fieldId: string;
  selector: string;
  /**
   * What this field's mark means, chosen from its *final* status.
   *
   * This replaced a colour chosen from the review reason, which was computed
   * before the executor ran and never revisited — so a field that filled and
   * verified kept whatever mark the planner's uncertainty had earned it, and a
   * page full of correctly filled answers stayed covered in "Information
   * needed". The mark is now a function of the outcome and of nothing else.
   */
  annotation: AnnotationKind;
  /** Retained for the review queue's own wording. Never chooses the colour. */
  reason?: ReviewReason;
  badge: string;
  question?: string;
}

interface ActiveHighlight extends HighlightRequest {
  element: HTMLElement;
  /** The element's own inline outline, restored exactly when we remove ours. */
  previousOutline: string;
  previousOutlineOffset: string;
  badgeNode: HTMLElement;
}

const COLOURS = ANNOTATION_COLOURS;

/**
 * The marks a person is meant to act on.
 *
 * A verified field and a deliberately blank optional one are drawn quietly —
 * they are reported, not requested — and are excluded from the review queue and
 * from "scroll to the first field that needs you".
 */
const NEEDS_ATTENTION: readonly AnnotationKind[] = [
  'information_needed',
  'sensitive_decision',
  'execution_failed',
];

export function needsAttention(annotation: AnnotationKind): boolean {
  return NEEDS_ATTENTION.includes(annotation);
}

/** A mark reporting finished work rather than asking for any. */
function isSettled(annotation: AnnotationKind): boolean {
  return annotation === 'verified' || annotation === 'optional_blank';
}

const active = new Map<string, ActiveHighlight>();
let host: HTMLElement | null = null;
let layer: HTMLElement | null = null;
let reposition: (() => void) | null = null;

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  host = document.getElementById(HOST_ID);
  if (!host) {
    // Claims the whole subtree, shadow root included, so the next scan skips
    // every badge and check mark instead of reading them as page content.
    host = createOwnedElement(document, 'div');
    host.id = HOST_ID;
    // The host itself must never intercept a click meant for the application.
    host.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
    document.body.append(host);
  }
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const style = createOwnedElement(document, 'style');
  style.textContent = `
    .layer { position: absolute; top: 0; left: 0; pointer-events: none; }
    .badge {
      position: absolute;
      font: 600 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #fff;
      padding: 2px 6px;
      border-radius: 4px 4px 0 0;
      white-space: nowrap;
      pointer-events: none;
    }
    .check {
      position: absolute;
      font: 600 12px/1 system-ui, sans-serif;
      color: #15803d;
      pointer-events: none;
    }
  `;
  const created = createOwnedElement(document, 'div');
  created.className = 'layer';
  root.append(style, created);
  layer = created;
  return created;
}

function place(badgeNode: HTMLElement, element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const left = rect.left + window.scrollX;
  badgeNode.style.top = `${Math.max(0, top - 18)}px`;
  badgeNode.style.left = `${Math.max(0, left)}px`;
}

function repositionAll(): void {
  for (const highlight of active.values()) {
    if (highlight.element.isConnected) place(highlight.badgeNode, highlight.element);
  }
}

function startTracking(): void {
  if (reposition) return;
  reposition = () => repositionAll();
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition, { passive: true });
}

function stopTracking(): void {
  if (!reposition) return;
  window.removeEventListener('scroll', reposition);
  window.removeEventListener('resize', reposition);
  reposition = null;
}

/** The mark currently drawn on this element, whichever field owns it. */
function markOn(element: HTMLElement): ActiveHighlight | null {
  for (const highlight of active.values()) {
    if (highlight.element === element) return highlight;
  }
  return null;
}

function findElement(selector: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    // A selector the page's own markup made invalid is not an error worth
    // throwing over; the field simply cannot be marked.
    return null;
  }
}

/**
 * Marks a field. Returns false when the element is no longer on the page, so
 * the caller can report an honest count rather than assuming success.
 */
export function highlightField(request: HighlightRequest): boolean {
  const element = findElement(request.selector);
  if (!element) return false;

  // Always first. A field being re-annotated after verification must lose the
  // mark it was wearing before, and the outline it carried with it — leaving
  // the old one in place under a new badge is exactly how a filled field went
  // on displaying "Information needed".
  removeHighlight(request.fieldId);

  // `none` means "this field carries no mark". The removal above is the whole
  // of the work: a field the agent did not touch, because the page already held
  // the right answer, is left exactly as the user wrote it. Returning true is
  // correct — the request was honoured, and the element was found.
  //
  // Deliberately before the shared-element rule below: `none` un-marks its own
  // field and no one else's, so it can never erase another record's verdict from
  // a control the two of them share.
  if (!isDrawnAnnotation(request.annotation)) return true;

  // One control, one mark — whoever asked for it.
  //
  // Two field records can resolve to the same element: a superseded record from
  // an earlier identity, a duplicate the scan deduplicated, or a widget whose
  // halves share a selector. Keying marks by field id alone let both of them
  // draw, and only the last one drawn owned the outline — a green border under
  // an orange badge, which is precisely what the page showed. An outcome that is
  // already settled is never displaced by one still asking for something, so the
  // surviving mark does not depend on which order the requests arrived in.
  const occupant = markOn(element);
  if (occupant && occupant.fieldId !== request.fieldId) {
    if (isSettled(occupant.annotation) && needsAttention(request.annotation)) return true;
    removeHighlight(occupant.fieldId);
  }

  const container = ensureLayer();
  const colour = COLOURS[request.annotation];

  const badgeNode = createOwnedElement(document, 'div');
  badgeNode.className = request.annotation === 'verified' ? 'check' : 'badge';
  if (request.annotation === 'verified') {
    // A tick, not a banner. Twenty-five green labels down a filled form is
    // noise; twenty-five ticks is a page a person can read at a glance.
    badgeNode.style.color = colour;
    badgeNode.textContent = '✓';
  } else {
    badgeNode.style.background = colour;
    badgeNode.textContent = request.badge || ANNOTATION_BADGES[request.annotation];
  }
  container.append(badgeNode);

  const previousOutline = element.style.outline;
  const previousOutlineOffset = element.style.outlineOffset;
  element.style.outline = `2px solid ${colour}`;
  element.style.outlineOffset = '1px';
  // The annotation kind, so a test — and a person with the inspector open —
  // can read a field's verdict off the page itself rather than inferring it
  // from a colour.
  element.setAttribute(MARKED_ATTRIBUTE, request.annotation);

  active.set(request.fieldId, {
    ...request,
    element,
    previousOutline,
    previousOutlineOffset,
    badgeNode,
  });
  place(badgeNode, element);
  startTracking();
  return true;
}

/** Restores the element exactly as it was found. */
export function removeHighlight(fieldId: string): void {
  const highlight = active.get(fieldId);
  if (!highlight) return;
  if (highlight.element.isConnected) {
    highlight.element.style.outline = highlight.previousOutline;
    highlight.element.style.outlineOffset = highlight.previousOutlineOffset;
    highlight.element.removeAttribute(MARKED_ATTRIBUTE);
  }
  highlight.badgeNode.remove();
  active.delete(fieldId);
  if (active.size === 0) stopTracking();
}

export function clearHighlights(): void {
  for (const fieldId of [...active.keys()]) removeHighlight(fieldId);
  host?.remove();
  host = null;
  layer = null;
  stopTracking();
}

export function highlightCount(): number {
  return active.size;
}

/**
 * Entries that need a person, in the order they appear down the page.
 *
 * Verified and optional-blank marks are excluded: scrolling the user to the
 * first green tick and calling it "the first field needing review" is how a
 * finished form looked like an unfinished one.
 */
export function reviewOrder(): ActiveHighlight[] {
  return [...active.values()]
    .filter((highlight) => highlight.element.isConnected && needsAttention(highlight.annotation))
    .sort((first, second) => {
      const position = first.element.compareDocumentPosition(second.element);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
}

/**
 * Brings a field into view and focuses it.
 *
 * Focus never changes an answer: a `<select>` is scrolled to but not focused,
 * because focusing one and then a stray keystroke would change its value.
 */
export function focusField(fieldId: string): boolean {
  const highlight = active.get(fieldId);
  if (!highlight?.element.isConnected) return false;
  highlight.element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  if (!(highlight.element instanceof HTMLSelectElement)) {
    highlight.element.focus?.({ preventScroll: true });
  }
  return true;
}

/**
 * Clears a field's mark once the user has answered it themselves.
 *
 * Called on input and change: once a person has touched the field, the agent's
 * uncertainty about it is no longer the useful thing to show.
 */
export function watchForManualAnswer(fieldId: string): void {
  const highlight = active.get(fieldId);
  if (!highlight) return;
  const clear = (): void => {
    removeHighlight(fieldId);
    highlight.element.removeEventListener('input', clear);
    highlight.element.removeEventListener('change', clear);
  };
  highlight.element.addEventListener('input', clear, { once: true });
  highlight.element.addEventListener('change', clear, { once: true });
}

export function isHighlighted(fieldId: string): boolean {
  return active.has(fieldId);
}
