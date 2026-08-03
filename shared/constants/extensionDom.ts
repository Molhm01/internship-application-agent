/**
 * How the extension marks DOM it owns.
 *
 * Anything the extension renders into an employer page — review badges, the
 * highlight layer, an autofill affordance — is not part of the employer's form,
 * and scanning it produces questions nobody asked. "Enable AI Autofill" was
 * reported as an application question for exactly this reason.
 *
 * The contract is one attribute, applied to the outermost element the extension
 * creates. The scanner skips that element *and every descendant*, including
 * anything inside a shadow root it hosts, so a single mark is enough however
 * deep the UI goes.
 */
export const EXTENSION_OWNED_ATTRIBUTE = 'data-internship-agent-owned';

export const EXTENSION_OWNED_SELECTOR = `[${EXTENSION_OWNED_ATTRIBUTE}="true"]`;

/**
 * Marks an element, and therefore its whole subtree, as extension-owned.
 *
 * Typed structurally rather than against `Element` so this constant lives with
 * the other shared constants, which are deliberately free of a DOM lib
 * dependency — the browser side supplies a real element, and nothing else can
 * satisfy the parameter by accident.
 */
export function markExtensionOwned<T extends { setAttribute(name: string, value: string): void }>(
  element: T,
): T {
  element.setAttribute(EXTENSION_OWNED_ATTRIBUTE, 'true');
  return element;
}
