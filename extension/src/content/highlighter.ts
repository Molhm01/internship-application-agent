import { REVIEW_BADGES, type ReviewReason } from '@internship-agent/shared';

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
  reason: ReviewReason;
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

const COLOURS: Record<ReviewReason, string> = {
  ai_suggestion: '#c2410c',
  missing_information: '#a16207',
  manual_required: '#7e22ce',
  failed: '#b91c1c',
};

const active = new Map<string, ActiveHighlight>();
let host: HTMLElement | null = null;
let layer: HTMLElement | null = null;
let reposition: (() => void) | null = null;

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    // The host itself must never intercept a click meant for the application.
    host.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
    document.body.append(host);
  }
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const style = document.createElement('style');
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
  const created = document.createElement('div');
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

  removeHighlight(request.fieldId);
  const container = ensureLayer();
  const colour = COLOURS[request.reason];

  const badgeNode = document.createElement('div');
  badgeNode.className = 'badge';
  badgeNode.style.background = colour;
  badgeNode.textContent = request.badge || REVIEW_BADGES[request.reason];
  container.append(badgeNode);

  const previousOutline = element.style.outline;
  const previousOutlineOffset = element.style.outlineOffset;
  element.style.outline = `2px solid ${colour}`;
  element.style.outlineOffset = '1px';
  element.setAttribute(MARKED_ATTRIBUTE, request.reason);

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

/** A quiet confirmation for a field that filled and verified. */
export function markVerified(fieldId: string, selector: string): boolean {
  const element = findElement(selector);
  if (!element) return false;
  removeHighlight(fieldId);
  const container = ensureLayer();
  const check = document.createElement('div');
  check.className = 'check';
  check.textContent = '✓';
  container.append(check);
  const rect = element.getBoundingClientRect();
  check.style.top = `${rect.top + window.scrollY - 14}px`;
  check.style.left = `${rect.left + window.scrollX}px`;
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

/** Review entries in the order they appear down the page. */
export function reviewOrder(): ActiveHighlight[] {
  return [...active.values()]
    .filter((highlight) => highlight.element.isConnected)
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
