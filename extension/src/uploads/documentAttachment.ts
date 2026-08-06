import {
  classifyDocumentField,
  documentFieldText,
  selectDocumentTargets,
  type DocumentFieldContext,
  type DocumentFieldKind,
  type DocumentAttachmentOutcome,
  type LatestDocumentType,
} from '@internship-agent/shared';

/**
 * The document-only attachment path, in the page.
 *
 * Deliberately narrow: it looks at `input[type=file]` and nothing else. No text
 * box is read, no value is typed, no model is consulted, and no control other
 * than a file input is ever touched — which is what makes "the final Submit
 * button is never clicked" a property of the code rather than a promise.
 */

/** How long to give the page's own upload handling before judging the result. */
const VERIFY_TIMEOUT_MS = 3_000;
const VERIFY_POLL_MS = 100;

export interface DocumentFileField {
  element: HTMLInputElement;
  kind: DocumentFieldKind;
  /** Everything on the page that says what this control is for. */
  context: DocumentFieldContext;
  /** Stable enough to re-find the element after the page re-renders. */
  selector: string;
}

/**
 * `CSS.escape` is missing in older engines and in jsdom, and an id containing a
 * quote would otherwise build a selector that matches nothing — or, worse,
 * something else.
 */
function escapeSelector(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\\]]/g, '\\$&');
}

function textOf(node: Element | null | undefined): string | undefined {
  const text = node?.textContent?.replace(/\s+/g, ' ').trim();
  return text && text.length > 0 ? text.slice(0, 400) : undefined;
}

function labelText(input: HTMLInputElement, root: Document): string | undefined {
  if (input.id) {
    const explicit = root.querySelector(`label[for="${escapeSelector(input.id)}"]`);
    const text = textOf(explicit);
    if (text) return text;
  }
  return textOf(input.closest('label'));
}

function ariaLabelledByText(input: HTMLInputElement, root: Document): string | undefined {
  const ids = input.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const parts = ids
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => textOf(root.getElementById(id)))
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * The nearest heading above this control.
 *
 * An iCIMS or Workday page frequently labels the control with nothing at all and
 * puts "Resume/CV" in a section heading two containers up, so this is often the
 * only evidence of what the field wants.
 */
function sectionHeading(input: HTMLInputElement): string | undefined {
  let node: Element | null = input.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const legend = node.querySelector(':scope > legend');
    const heading = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
    const text = textOf(legend) ?? textOf(heading);
    if (text) return text;
  }
  return undefined;
}

/** Instructional text and the styled button that drives a hidden input. */
function surroundingText(input: HTMLInputElement): {
  nearbyText?: string | undefined;
  buttonText?: string | undefined;
} {
  const container = input.closest('div, section, fieldset, li, td') ?? input.parentElement;
  const button = container?.querySelector('button, [role="button"], .btn, label');
  return {
    nearbyText: textOf(container),
    buttonText: textOf(button),
  };
}

function selectorFor(input: HTMLInputElement, index: number): string {
  if (input.id) return `#${escapeSelector(input.id)}`;
  if (input.name) return `input[type="file"][name="${escapeSelector(input.name)}"]`;
  return `input[type="file"]:nth-of-type(${index + 1})`;
}

/**
 * Every file control on the page, with what each one wants.
 *
 * Hidden inputs are included on purpose. A file input the page hides and drives
 * from a styled "Upload résumé" button is the standard control on every ATS
 * worth naming; it is populated programmatically, so its visibility says nothing
 * about whether it can be filled. Disabled inputs are excluded — those genuinely
 * cannot accept a file.
 */
export function collectDocumentFileFields(root: Document): DocumentFileField[] {
  const inputs = Array.from(root.querySelectorAll('input[type="file"]')).filter(
    (element): element is HTMLInputElement =>
      element instanceof HTMLInputElement && !element.disabled,
  );

  return inputs.map((element, index) => {
    const context: DocumentFieldContext = {
      label: labelText(element, root),
      ariaLabel: element.getAttribute('aria-label') ?? undefined,
      ariaLabelledByText: ariaLabelledByText(element, root),
      name: element.name || undefined,
      elementId: element.id || undefined,
      sectionHeading: sectionHeading(element),
      accept: element.getAttribute('accept') ?? undefined,
      title: element.getAttribute('title') ?? undefined,
      placeholder: element.getAttribute('placeholder') ?? undefined,
      ...surroundingText(element),
    };
    return {
      element,
      context,
      kind: classifyDocumentField(context),
      selector: selectorFor(element, index),
    };
  });
}

export interface AttachableDocument {
  documentType: LatestDocumentType;
  filename: string;
  mimeType: 'application/pdf';
  bytes: Uint8Array;
  byteLength: number;
  source: 'tailored' | 'default';
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-finds the control after the page has had a chance to re-render.
 *
 * A React-controlled upload widget can replace its input node entirely in
 * response to the change event, and verifying against the original detached
 * element would report success for a file the page no longer holds.
 */
function refind(root: Document, field: DocumentFileField): HTMLInputElement | null {
  const bySelector = root.querySelector(field.selector);
  if (bySelector instanceof HTMLInputElement && bySelector.type === 'file') return bySelector;
  return field.element.isConnected ? field.element : null;
}

function holdsFile(input: HTMLInputElement | null, filename: string): boolean {
  if (!input?.files) return false;
  return Array.from(input.files).some((file) => file.name === filename);
}

/**
 * Whether the page itself is showing the filename.
 *
 * Many upload widgets clear the underlying input once they have posted the file
 * and render the name instead. That is a successful upload, and treating it as a
 * failure would be just as dishonest as the reverse.
 */
function displaysFilename(root: Document, field: DocumentFileField, filename: string): boolean {
  const container =
    refind(root, field)?.closest('form, section, div, fieldset') ?? root.body ?? null;
  const text = container?.textContent ?? '';
  return text.includes(filename);
}

export interface AttachmentAttempt {
  attached: boolean;
  verified: boolean;
  message: string | null;
}

/**
 * Puts one file into one control and then proves the page took it.
 *
 * Producing a `File` is not success. The result is judged only after the page
 * has been given time to run its own upload handling, and only from what the DOM
 * says afterwards.
 */
export async function attachDocumentToField(
  root: Document,
  field: DocumentFileField,
  document_: AttachableDocument,
  now: () => number = () => Date.now(),
): Promise<AttachmentAttempt> {
  const file = new File([document_.bytes.slice().buffer], document_.filename, {
    type: document_.mimeType,
  });

  let target = refind(root, field);
  if (!target) {
    return { attached: false, verified: false, message: 'The upload control left the page.' };
  }

  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    target.files = transfer.files;
  } catch (cause) {
    return {
      attached: false,
      verified: false,
      message: `The browser refused the file transfer: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }

  // The events a framework-backed upload widget listens for. Without them a
  // React or Angular control keeps its own empty state and the file vanishes on
  // the next render.
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));

  const deadline = now() + VERIFY_TIMEOUT_MS;
  let verified = false;
  while (now() < deadline) {
    target = refind(root, field);
    if (
      holdsFile(target, document_.filename) ||
      displaysFilename(root, field, document_.filename)
    ) {
      verified = true;
      break;
    }
    await wait(VERIFY_POLL_MS);
  }

  if (!verified) {
    return {
      attached: true,
      verified: false,
      message:
        'The file was handed to the upload control, but the page never showed it. Attach it yourself before continuing.',
    };
  }

  // An error the widget rendered next to the control — "file too large", "PDF
  // only" — means the page took the file and rejected it. Reported rather than
  // swallowed, but the attachment is still verified as having reached the page.
  const container = refind(root, field)?.closest('form, section, div, fieldset');
  const error = container?.querySelector('[role="alert"], .error, .field-error');
  const errorText = textOf(error);
  return {
    attached: true,
    verified: true,
    message: errorText ? `The page reported: ${errorText}` : null,
  };
}

export function notFoundOutcome(
  documentType: LatestDocumentType,
  message: string | null,
): DocumentAttachmentOutcome {
  return {
    documentType,
    fieldFound: false,
    attached: false,
    verified: false,
    filename: null,
    source: null,
    message,
  };
}

export { documentFieldText, selectDocumentTargets };
