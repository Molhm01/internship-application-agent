import { markExtensionOwned } from '@internship-agent/shared';

/**
 * The only way the extension creates a node inside an employer's page.
 *
 * Marking is central rather than per-call-site because the failure it prevents
 * is a *future* one: a new review card, a new badge, a new affordance built with
 * a bare `document.createElement` is invisible until it shows up in a scan as an
 * application question — which is exactly how "Enable AI Autofill" was reported
 * as something the employer asked. `contentDomOwnership.test.ts` fails the build
 * if any content-script module calls `createElement` directly.
 *
 * The scanner skips a marked element and its whole subtree, shadow roots
 * included, so marking the host would be enough. Every node is marked anyway:
 * the contract in `EXTENSION_OWNED_ATTRIBUTE` is that extension DOM says so, and
 * a subtree that only inherits the claim cannot be audited by looking at it.
 */
export function createOwnedElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  return markExtensionOwned(ownerDocument.createElement(tagName));
}
