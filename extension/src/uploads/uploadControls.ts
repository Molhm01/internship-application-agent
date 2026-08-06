import {
  classifyDocumentField,
  type DocumentFieldContext,
  type UploadControlKind,
  type UploadDiscovery,
} from '@internship-agent/shared';

/**
 * Finding the upload controls a page actually has, rather than the ones it
 * happens to express as a bare `input[type=file]`.
 *
 * The previous discovery was one `querySelectorAll('input[type="file"]')`. On a
 * live employer form showing "Resume — My Computer | Google Drive | Dropbox |
 * OneDrive" it returned zero elements and the run reported "This page has no
 * file upload control", because that widget has no file input in the DOM until
 * its "My Computer" button is pressed.
 *
 * So this module works the way a person does: it finds the *sections* that
 * accept a document, and then works out how each one takes a file. Existing
 * inputs first — hidden, transparent, off-screen and shadow-rooted ones
 * included, since a widget-driven input is populated programmatically and its
 * visibility says nothing about whether it can be filled. Only when a section
 * offers no input by any static route is its launcher activated and the DOM
 * watched, briefly, for the input the widget creates.
 *
 * Two things this module will not do. It never treats Google Drive, Dropbox,
 * OneDrive or Box as a local-file target — those open an OAuth flow, not a file
 * chooser, and clicking one navigates the user somewhere they did not ask to
 * go. And it never activates anything that is not a file-upload launcher, which
 * is what keeps "the final Submit button is never clicked" a property of the
 * code.
 */

/** Long enough for a widget to insert its input; short enough not to feel hung. */
const MUTATION_WAIT_MS = 1_500;

/** The words a local-file launcher uses. Ordered so the log reads sensibly. */
const LAUNCHER_LABELS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bmy\s*computer\b/i, label: 'my computer' },
  { pattern: /\bchoose\s*(a\s*)?file/i, label: 'choose file' },
  { pattern: /\bselect\s*(a\s*)?file/i, label: 'select file' },
  { pattern: /\bbrowse\b/i, label: 'browse' },
  { pattern: /\bupload\b/i, label: 'upload' },
  { pattern: /\battach\b/i, label: 'attach' },
  { pattern: /\badd\s*(a\s*)?(file|document|attachment)\b/i, label: 'add file' },
  { pattern: /\bdrag\s*(and|&)?\s*drop\b/i, label: 'drop zone' },
];

/**
 * Buttons that hand the upload to somebody else's website.
 *
 * Excluded before the launcher patterns run, because "Upload from Dropbox"
 * matches `/\bupload\b/` and clicking it would send the user to an OAuth
 * consent screen mid-application.
 */
const CLOUD_PATTERN = /\b(google\s*drive|dropbox|one\s*drive|onedrive|box|icloud|sharepoint)\b/i;

/** Controls that must never be activated, whatever text they carry. */
const FORBIDDEN_PATTERN = /\b(submit|apply now|send application|finish|complete application)\b/i;

const LAUNCHER_SELECTOR =
  'button, [role="button"], a[href="#"], a:not([href]), label, [class*="upload"], [class*="attach"], [data-automation-id*="upload" i]';

export interface DiscoveredUploadControl {
  controlId: string;
  kind: UploadControlKind;
  discovery: UploadDiscovery;
  /** Null when a launcher exists but no input could be reached from it. */
  input: HTMLInputElement | null;
  context: DocumentFieldContext;
  hidden: boolean;
  launcherLabel?: string;
  /** Kept so a section can be re-activated on demand rather than up front. */
  launcher?: HTMLElement;
}

/** The element a control is positioned by: its input, or the button that drives it. */
function anchorOf(control: DiscoveredUploadControl): HTMLElement | undefined {
  return control.input ?? control.launcher;
}

/**
 * Document order for two elements, tolerating elements in different trees.
 *
 * Two controls in separate shadow roots are `DOCUMENT_POSITION_DISCONNECTED`,
 * which carries no ordering. They are left in discovery order rather than being
 * given an arbitrary one.
 */
function documentOrder(left: HTMLElement | undefined, right: HTMLElement | undefined): number {
  if (!left || !right || left === right) return 0;
  const relation = left.compareDocumentPosition(right);
  if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

export interface UploadSurvey {
  controls: DiscoveredUploadControl[];
  fileInputs: number;
  hiddenFileInputs: number;
  uploadLaunchers: number;
  cloudLaunchers: number;
}

function textOf(node: Element | null | undefined): string | undefined {
  const text = node?.textContent?.replace(/\s+/g, ' ').trim();
  return text && text.length > 0 ? text.slice(0, 400) : undefined;
}

function escapeSelector(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\\]]/g, '\\$&');
}

/**
 * Every root in the frame: the document plus every open shadow root beneath it.
 *
 * Closed shadow roots are unreachable by design and are simply not searched —
 * `element.shadowRoot` is null for them, and there is no supported way around
 * that from a content script.
 */
export function allRoots(root: Document | ShadowRoot): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [root];
  const queue: Array<Document | ShadowRoot> = [root];
  // Bounded: a pathological page must not be able to make discovery run forever.
  while (queue.length > 0 && roots.length < 200) {
    const current = queue.shift()!;
    for (const element of current.querySelectorAll('*')) {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        queue.push(shadow);
      }
    }
  }
  return roots;
}

function queryAll(root: Document | ShadowRoot, selector: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const scope of allRoots(root)) {
    for (const element of scope.querySelectorAll(selector)) {
      if (element instanceof HTMLElement) found.push(element);
    }
  }
  return found;
}

function fileInputsIn(root: Document | ShadowRoot): HTMLInputElement[] {
  return queryAll(root, 'input[type="file"]').filter(
    (element): element is HTMLInputElement => element instanceof HTMLInputElement,
  );
}

/**
 * Whether the control is hidden from sight.
 *
 * Recorded, never used to exclude. A hidden file input is the normal shape of a
 * styled upload widget, and refusing those is what left "Resume *" unattached on
 * a page that plainly showed an upload button.
 */
function isHidden(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  if (Number.parseFloat(style.opacity || '1') === 0) return true;
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return true;
  return box.bottom < -500 || box.right < -500;
}

/** The container a whole upload section lives in. */
function sectionOf(element: HTMLElement): HTMLElement {
  let node: HTMLElement = element;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    node = parent;
    // A container that holds a heading, a legend, or its own labelled group is
    // the section a person would point at.
    if (
      node.matches('fieldset, section, [role="group"], [class*="section" i], [class*="field" i]') ||
      node.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4')
    ) {
      return node;
    }
  }
  return node;
}

function labelText(input: HTMLElement, root: Document | ShadowRoot): string | undefined {
  if (input.id) {
    for (const scope of allRoots(root)) {
      const explicit = scope.querySelector(`label[for="${escapeSelector(input.id)}"]`);
      const text = textOf(explicit);
      if (text) return text;
    }
  }
  return textOf(input.closest('label'));
}

function ariaLabelledByText(element: HTMLElement, root: Document | ShadowRoot): string | undefined {
  const ids = element.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    for (const scope of allRoots(root)) {
      const text = textOf(scope.querySelector(`#${escapeSelector(id)}`));
      if (text) {
        parts.push(text);
        break;
      }
    }
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * The nearest heading above this control.
 *
 * Frequently the only evidence there is: a live form labels its upload with
 * nothing at all and puts "Resume" in a heading two containers up.
 */
function sectionHeading(element: HTMLElement): string | undefined {
  let node: Element | null = element.parentElement;
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const legend = node.querySelector(':scope > legend');
    const heading = node.querySelector(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > [class*="heading" i], :scope > [class*="title" i]',
    );
    const text = textOf(legend) ?? textOf(heading);
    if (text) return text;
  }
  return undefined;
}

/**
 * Everything the page says about one upload section.
 *
 * The launcher's own text is included because on a widget-driven form it is
 * often the *only* words attached to the control — and on this particular
 * employer page the words are "My Computer", which say nothing, so the section
 * heading is what carries "Resume" or "Cover Letter".
 */
function contextFor(
  element: HTMLElement,
  root: Document | ShadowRoot,
  launcher?: HTMLElement,
): DocumentFieldContext {
  const section = sectionOf(element);
  const input = element instanceof HTMLInputElement ? element : null;
  return {
    label: labelText(element, root),
    ariaLabel:
      element.getAttribute('aria-label') ?? launcher?.getAttribute('aria-label') ?? undefined,
    ariaLabelledByText:
      ariaLabelledByText(element, root) ??
      (launcher ? ariaLabelledByText(launcher, root) : undefined),
    name: input?.name || undefined,
    elementId: element.id || undefined,
    sectionHeading: sectionHeading(launcher ?? element),
    accept: element.getAttribute('accept') ?? undefined,
    title: element.getAttribute('title') ?? undefined,
    placeholder: element.getAttribute('placeholder') ?? undefined,
    nearbyText: textOf(section),
    buttonText: textOf(launcher) ?? textOf(section.querySelector('button, [role="button"], label')),
  };
}

interface Launcher {
  element: HTMLElement;
  label: string;
}

/** The local-file launchers in this root, and a count of the cloud ones. */
function findLaunchers(root: Document | ShadowRoot): { local: Launcher[]; cloud: number } {
  const local: Launcher[] = [];
  let cloud = 0;
  const seen = new Set<HTMLElement>();

  for (const element of queryAll(root, LAUNCHER_SELECTOR)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const text = [
      element.textContent ?? '',
      element.getAttribute('aria-label') ?? '',
      element.getAttribute('title') ?? '',
      element.getAttribute('data-automation-id') ?? '',
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!text) continue;
    // Order matters. "Upload from Dropbox" matches the upload pattern too, and
    // activating it would leave the application for an OAuth consent screen.
    if (CLOUD_PATTERN.test(text)) {
      cloud += 1;
      continue;
    }
    if (FORBIDDEN_PATTERN.test(text)) continue;
    const matched = LAUNCHER_LABELS.find((candidate) => candidate.pattern.test(text));
    if (matched) local.push({ element, label: matched.label });
  }
  return { local, cloud };
}

/**
 * The file input a launcher drives, without activating anything.
 *
 * Tried in order of confidence: the input the launcher explicitly points at,
 * then the one inside it, then the one in its section. A `label[for]` is the
 * strongest signal there is — it is the platform's own way of saying "this
 * button operates that control".
 */
export function resolveLauncherInput(
  launcher: HTMLElement,
  root: Document | ShadowRoot,
): { input: HTMLInputElement; discovery: UploadDiscovery } | null {
  const linked = launcher.getAttribute('for') ?? launcher.getAttribute('aria-controls');
  if (linked) {
    for (const scope of allRoots(root)) {
      const target = scope.querySelector(`#${escapeSelector(linked)}`);
      if (target instanceof HTMLInputElement && target.type === 'file') {
        return { input: target, discovery: 'launcher_linked' };
      }
    }
  }

  const inside = launcher.querySelector('input[type="file"]');
  if (inside instanceof HTMLInputElement) return { input: inside, discovery: 'launcher_linked' };

  // Its own shadow root, then the section around it. A widget that encapsulates
  // its input is common enough to be worth the extra look.
  const shadow = launcher.shadowRoot ? fileInputsIn(launcher.shadowRoot)[0] : undefined;
  if (shadow) return { input: shadow, discovery: 'shadow_root' };

  const section = sectionOf(launcher);
  const sectionInput = Array.from(section.querySelectorAll('input[type="file"]')).find(
    (element): element is HTMLInputElement => element instanceof HTMLInputElement,
  );
  if (sectionInput) return { input: sectionInput, discovery: 'launcher_linked' };

  return null;
}

/**
 * Activates a launcher and waits, briefly, for the input it creates.
 *
 * Only reached when the section offers no input by any static route, and only
 * inside a run the user started. The click may open the browser's own file
 * chooser — which the extension cannot script and does not try to — but the
 * input element the widget inserts is in the DOM either way, and that is the
 * thing being waited for. The observer is disconnected on the first match or at
 * the deadline, whichever comes first.
 */
export async function activateAndObserve(
  launcher: HTMLElement,
  root: Document | ShadowRoot,
  waitMs = MUTATION_WAIT_MS,
): Promise<HTMLInputElement | null> {
  const before = new Set(fileInputsIn(root));
  const host = (root instanceof Document ? root.documentElement : root) as unknown as Node;

  const appeared = new Promise<HTMLInputElement | null>((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      // One last look: a widget that inserted synchronously during the click has
      // already been recorded by the observer, but one that swapped an existing
      // node's `type` attribute has not.
      resolve(fileInputsIn(root).find((input) => !before.has(input)) ?? null);
    }, waitMs);

    const observer = new MutationObserver(() => {
      const fresh = fileInputsIn(root).find((input) => !before.has(input));
      if (fresh) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(fresh);
      }
    });
    observer.observe(host, { childList: true, subtree: true, attributes: true });
  });

  try {
    launcher.click();
  } catch {
    // A launcher that throws on click has told us it is not usable this way.
    // The observer still gets its chance — some widgets bind to pointer events.
  }
  return appeared;
}

/**
 * Every upload target in this frame, classified.
 *
 * `mayActivateLaunchers` gates the only part of this that touches the page. A
 * scan never sets it; an attach run the user pressed a button for does.
 */
export async function surveyUploadControls(
  root: Document,
  mayActivateLaunchers: boolean,
  mintId: () => string = () => crypto.randomUUID(),
): Promise<UploadSurvey> {
  const inputs = fileInputsIn(root);
  const { local, cloud } = findLaunchers(root);

  const controls: DiscoveredUploadControl[] = [];
  const claimed = new Set<HTMLInputElement>();
  const resolvedLaunchers = new Set<HTMLElement>();

  const record = (
    input: HTMLInputElement | null,
    discovery: UploadDiscovery,
    launcher?: Launcher,
  ): void => {
    // Two launchers pointing at one input is one control, not two. Marking the
    // launcher resolved either way stops the second one being clicked in the
    // activation pass below for an input that was already found.
    if (launcher) resolvedLaunchers.add(launcher.element);
    if (input) {
      if (claimed.has(input)) return;
      claimed.add(input);
    }
    const anchor = input ?? launcher?.element;
    if (!anchor) return;
    const context = contextFor(anchor, root, launcher?.element);
    controls.push({
      controlId: `upload-${mintId()}`,
      kind: classifyDocumentField(context),
      discovery,
      input,
      context,
      hidden: input ? isHidden(input) : false,
      ...(launcher ? { launcherLabel: launcher.label, launcher: launcher.element } : {}),
    });
  };

  // Launchers first, so a hidden input is described by the button that drives it
  // rather than by the empty container it happens to sit in.
  for (const launcher of local) {
    const resolved = resolveLauncherInput(launcher.element, root);
    if (resolved) record(resolved.input, resolved.discovery, launcher);
  }

  // Then every input no launcher claimed. A plain `<input type="file">` with a
  // real label needs no button at all.
  for (const input of inputs) {
    if (input.disabled) continue;
    record(input, 'existing_input');
  }

  // Finally the launchers that resolved to nothing. These are the sections the
  // old build could not see, and the only ones worth activating.
  for (const launcher of local) {
    if (resolvedLaunchers.has(launcher.element)) continue;
    if (!mayActivateLaunchers) {
      record(null, 'launcher_unresolved', launcher);
      continue;
    }
    const created = await activateAndObserve(launcher.element, root);
    if (created) record(created, 'launcher_activated', launcher);
    else record(null, 'launcher_unresolved', launcher);
  }

  // Reported in the order a person reading the page would meet them.
  //
  // Discovery runs launcher-first, because a hidden input is better described by
  // the button that drives it than by the empty container it sits in — but that
  // is an implementation order, not a page order. Leaving it would mean that on
  // a form with a plain "Resume / CV" input followed by a styled "Upload Resume"
  // widget, the résumé went into the second one. Both are résumé slots and
  // either is defensible, but "the first one on the page" is the answer a person
  // expects and the one the rest of the system already assumed.
  controls.sort((left, right) => documentOrder(anchorOf(left), anchorOf(right)));

  return {
    controls,
    fileInputs: inputs.length,
    hiddenFileInputs: inputs.filter((input) => isHidden(input)).length,
    uploadLaunchers: local.length,
    cloudLaunchers: cloud,
  };
}
