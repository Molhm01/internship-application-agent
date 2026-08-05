/**
 * The version of the shapes the three extension components exchange.
 *
 * Bumped by hand whenever a message, scan, plan, or run schema changes in a way
 * an older bundle cannot read. It is stamped into `BUILD_ID`, so a popup, a
 * worker, and a content script built against different schema generations
 * announce the fact instead of failing somewhere downstream with an error that
 * blames a value.
 *
 * This is deliberately not derived from the package version: the package
 * version tracks releases, and what matters here is whether two bundles loaded
 * in the same browser agree about the data crossing between them.
 */
export const RUNTIME_SCHEMA_VERSION = 3;

/** The three components that must agree before a run may start. */
export const RUNTIME_COMPONENTS = ['popup', 'worker', 'content'] as const;

export type RuntimeComponent = (typeof RUNTIME_COMPONENTS)[number];

/**
 * What the user is told when the loaded bundles disagree.
 *
 * One sentence, and it names the only action that fixes it. A mixed-version run
 * is refused rather than attempted, because the failures it produces are
 * unreadable: a scan the worker cannot parse, a plan the executor rejects, a
 * field type that "does not exist" while the source clearly defines it.
 */
export const BUILD_MISMATCH_MESSAGE =
  'Extension components are from different builds. Reload the extension and this page.';
