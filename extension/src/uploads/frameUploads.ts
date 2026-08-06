import {
  type AttachableDocumentPayload,
  type AttachmentFailureCode,
  type FrameUploadSurvey,
  type UploadControl,
} from '@internship-agent/shared';
import { surveyUploadControls, type DiscoveredUploadControl } from './uploadControls.js';

/**
 * One frame's half of the document path.
 *
 * The frame discovers and describes; the background worker decides. That split
 * is what makes frame identity survive: the worker knows which `frameId` each
 * survey came from, matches documents to controls across every frame at once,
 * and then addresses its instruction back to the exact frame that offered the
 * control. A frame never acts on a control it did not itself report, because the
 * only thing it accepts is a `controlId` it minted.
 */

/** How long to give the page's own upload handling before judging the result. */
const VERIFY_TIMEOUT_MS = 3_000;
const VERIFY_POLL_MS = 100;

/**
 * Controls this frame has offered, by run.
 *
 * Held as live element references rather than selectors: the element was found
 * by walking shadow roots and observing mutations, and there is frequently no
 * selector that would find it again.
 */
const openRuns = new Map<string, Map<string, DiscoveredUploadControl>>();

/** Nothing is kept for a run the worker has stopped asking about. */
const MAX_OPEN_RUNS = 4;

function remember(runId: string, controls: DiscoveredUploadControl[]): void {
  if (openRuns.size >= MAX_OPEN_RUNS) {
    const oldest = openRuns.keys().next().value;
    if (oldest !== undefined) openRuns.delete(oldest);
  }
  openRuns.set(runId, new Map(controls.map((control) => [control.controlId, control])));
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // `about:blank` and `srcdoc` frames have no parseable origin. Naming the
    // scheme is more useful in a trace than an empty string.
    return url.split(':')[0] ?? 'unknown';
  }
}

/**
 * Everything this frame can accept a document into.
 *
 * `frameId` is filled in with 0 and corrected by the worker, which is the only
 * side that knows it — a frame genuinely cannot learn its own id.
 */
export async function discoverInFrame(
  root: Document,
  runId: string,
  mayActivateLaunchers: boolean,
): Promise<Omit<FrameUploadSurvey, 'frameId'>> {
  const survey = await surveyUploadControls(root, mayActivateLaunchers);
  remember(runId, survey.controls);

  const view = root.defaultView;
  const url = view?.location.href ?? '';
  const controls: UploadControl[] = survey.controls.map((control) => ({
    controlId: control.controlId,
    // Overwritten by the worker. Present so the shape is valid in the frame.
    frameId: 0,
    frameUrl: url.slice(0, 2048),
    frameOrigin: originOf(url),
    kind: control.kind,
    discovery: control.discovery,
    accessible: control.input !== null,
    hidden: control.hidden,
    ...(control.input?.id ? { elementId: control.input.id.slice(0, 200) } : {}),
    ...(control.input?.name ? { elementName: control.input.name.slice(0, 200) } : {}),
    ...(control.input?.getAttribute('accept')
      ? { accept: control.input.getAttribute('accept')!.slice(0, 300) }
      : {}),
    ...(control.launcherLabel ? { launcherLabel: control.launcherLabel } : {}),
  }));

  return {
    frameUrl: url.slice(0, 2048),
    frameOrigin: originOf(url),
    topFrame: view ? view.top === view : true,
    fileInputs: survey.fileInputs,
    hiddenFileInputs: survey.hiddenFileInputs,
    uploadLaunchers: survey.uploadLaunchers,
    cloudLaunchers: survey.cloudLaunchers,
    controls: controls.slice(0, 60),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function holdsFile(input: HTMLInputElement, filename: string): boolean {
  return input.files ? Array.from(input.files).some((file) => file.name === filename) : false;
}

/**
 * Whether the page itself is showing the filename.
 *
 * Many upload widgets clear the underlying input once they have posted the file
 * and render the name instead. That is a successful upload, and treating it as a
 * failure would be as dishonest as the reverse.
 */
function displaysFilename(input: HTMLInputElement, filename: string): boolean {
  const container =
    input.closest('form, section, fieldset, div') ?? input.ownerDocument.body ?? null;
  return (container?.textContent ?? '').includes(filename);
}

function textOf(node: Element | null | undefined): string | undefined {
  const text = node?.textContent?.replace(/\s+/g, ' ').trim();
  return text && text.length > 0 ? text.slice(0, 200) : undefined;
}

export interface FrameAttachResult {
  attached: boolean;
  verified: boolean;
  failureCode: AttachmentFailureCode | null;
  message: string | null;
}

/**
 * Puts one stored file into one control this frame offered, and proves the page
 * took it.
 *
 * Producing a `File` is not success. The verdict comes only from what the DOM
 * says after the page has had its own upload handling run.
 */
export async function attachInFrame(
  runId: string,
  controlId: string,
  payload: AttachableDocumentPayload,
  now: () => number = () => Date.now(),
): Promise<FrameAttachResult> {
  const control = openRuns.get(runId)?.get(controlId);
  if (!control) {
    return {
      attached: false,
      verified: false,
      failureCode: 'CONTROL_LEFT_PAGE',
      message: 'That upload control is no longer being tracked in this frame.',
    };
  }

  const input = control.input;
  if (!input) {
    return {
      attached: false,
      verified: false,
      failureCode: 'FILE_INPUT_NOT_ACCESSIBLE',
      message:
        'This upload button is visible but exposes no file input the extension can reach. Attach the file yourself.',
    };
  }
  if (!input.isConnected) {
    return {
      attached: false,
      verified: false,
      failureCode: 'CONTROL_LEFT_PAGE',
      message: 'The upload control left the page before the file could be attached.',
    };
  }

  const bytes = decodeBase64(payload.contentBase64);
  // The byte length the record claims is checked against the bytes actually
  // held, so a truncated copy is refused rather than uploaded.
  if (bytes.byteLength !== payload.byteLength || bytes.byteLength === 0) {
    return {
      attached: false,
      verified: false,
      failureCode: 'DOCUMENT_NOT_STORED',
      message: 'The stored document did not match its recorded length and was not attached.',
    };
  }

  const file = new File([bytes.slice().buffer], payload.filename, {
    type: payload.mimeType,
  });

  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  } catch (cause) {
    return {
      attached: false,
      verified: false,
      failureCode: 'FILE_TRANSFER_REFUSED',
      message: `The browser refused the file transfer: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }

  // The events a framework-backed upload widget listens for. `composed` matters
  // for a widget whose input lives in a shadow root: without it the event stops
  // at the shadow boundary and the host component never hears it.
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('blur', { bubbles: false, composed: true }));

  const deadline = now() + VERIFY_TIMEOUT_MS;
  let verified = false;
  while (now() < deadline) {
    if (holdsFile(input, payload.filename) || displaysFilename(input, payload.filename)) {
      verified = true;
      break;
    }
    await wait(VERIFY_POLL_MS);
  }

  if (!verified) {
    return {
      attached: true,
      verified: false,
      failureCode: 'NOT_VERIFIED_BY_PAGE',
      message:
        'The file was handed to the upload control, but the page never showed it. Attach it yourself before continuing.',
    };
  }

  // An error the widget rendered beside the control — "file too large", "PDF
  // only" — means the page took the file and rejected it. Reported rather than
  // swallowed; the attachment is still verified as having reached the page.
  const error = input
    .closest('form, section, fieldset, div')
    ?.querySelector('[role="alert"], .error, .field-error');
  const errorText = textOf(error);
  return {
    attached: true,
    verified: true,
    failureCode: errorText ? 'PAGE_REJECTED_FILE' : null,
    message: errorText ? `The page reported: ${errorText}` : null,
  };
}
