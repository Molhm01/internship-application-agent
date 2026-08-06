import {
  documentAttachmentReportSchema,
  pageControlTraceSchema,
  selectDocumentTargets,
  uploadControlsResponseSchema,
  attachToControlResponseSchema,
  type AttachableDocumentPayload,
  type AttachmentFailureCode,
  type AttachmentStage,
  type DocumentAttachmentOutcome,
  type DocumentAttachmentReport,
  type DocumentTraceEntry,
  type FrameUploadSurvey,
  type PageControlTrace,
  type UploadControl,
} from '@internship-agent/shared';
import { BUILD_ID } from '../generated/buildInfo.js';
import { askEveryFrame, sendToFrame, type FrameTarget } from './frames.js';

/**
 * "Attach Resume and Cover Letter", across every frame of the application.
 *
 * Two phases, deliberately. Every frame is asked what upload controls it has;
 * the answers are pooled *with their frame ids intact*; the résumé and
 * cover-letter decisions are made once over the whole pool; and then each
 * document is sent back to the single frame that offered the control it goes
 * in. A control is never addressed by a selector this module composed — only by
 * an id the frame itself minted moments earlier.
 *
 * No model is consulted anywhere on this path. "Resume" is not an ambiguous
 * word, and an AI request here would be slower, less predictable, and
 * impossible to test deterministically.
 */

/** Cloud buttons and unrelated sections never receive a document. */
function attachable(control: UploadControl): boolean {
  return control.kind === 'resume' || control.kind === 'cover_letter' || control.kind === 'generic';
}

interface PhaseOneResult {
  surveys: FrameUploadSurvey[];
  controls: UploadControl[];
  framesReached: number;
}

/**
 * Asks every frame what it has, and stamps each answer with the frame it came
 * from.
 *
 * The stamping is the point. A frame cannot learn its own `frameId` — only the
 * worker knows it — so a survey that arrives unstamped and is merged unstamped
 * loses the one piece of information needed to act on it.
 */
async function surveyFrames(
  tabId: number,
  frames: readonly FrameTarget[],
  runId: string,
  mayActivateLaunchers: boolean,
): Promise<PhaseOneResult> {
  const replies = await askEveryFrame<unknown>(tabId, frames, {
    type: 'DISCOVER_UPLOAD_CONTROLS',
    runId,
    mayActivateLaunchers,
  });

  const surveys: FrameUploadSurvey[] = [];
  const controls: UploadControl[] = [];
  let framesReached = 0;

  for (const reply of replies) {
    const parsed = uploadControlsResponseSchema.safeParse(reply.response);
    if (!parsed.success || parsed.data.type !== 'UPLOAD_CONTROLS') continue;
    framesReached += 1;
    const stamped: FrameUploadSurvey = {
      ...parsed.data.survey,
      frameId: reply.frame.frameId,
      controls: parsed.data.survey.controls.map((control) => ({
        ...control,
        frameId: reply.frame.frameId,
      })),
    };
    surveys.push(stamped);
    controls.push(...stamped.controls.filter(attachable));
  }

  return { surveys, controls, framesReached };
}

function outcome(
  documentType: 'resume' | 'cover_letter',
  fields: Partial<DocumentAttachmentOutcome>,
): DocumentAttachmentOutcome {
  return {
    documentType,
    fieldFound: false,
    attached: false,
    verified: false,
    filename: null,
    source: null,
    message: null,
    ...fields,
  };
}

function traceEntry(
  documentType: 'resume' | 'cover_letter',
  stage: AttachmentStage,
  elapsedMs: number,
  control: UploadControl | null,
  filename: string | null,
  verified: boolean,
  failureCode: AttachmentFailureCode | null,
): DocumentTraceEntry {
  return {
    documentType,
    stage,
    frameId: control?.frameId ?? null,
    controlId: control?.controlId ?? null,
    elementId: control?.elementId ?? null,
    discovery: control?.discovery ?? null,
    filename,
    verified,
    failureCode,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
  };
}

interface OneDocumentResult {
  outcome: DocumentAttachmentOutcome;
  trace: DocumentTraceEntry;
}

/**
 * Sends one document to the one frame that holds its control.
 *
 * A failure here is confined to this document by construction: the caller runs
 * this once per document and never lets one result gate the other, because a
 * form with a résumé slot and a broken cover-letter widget must still end with
 * the résumé attached.
 */
async function attachOne(
  tabId: number,
  documentType: 'resume' | 'cover_letter',
  control: UploadControl | null,
  payload: AttachableDocumentPayload | undefined,
  runId: string,
  noFieldMessage: string,
  noFieldCode: AttachmentFailureCode,
  now: () => number,
): Promise<OneDocumentResult> {
  const started = now();

  if (!control) {
    return {
      outcome: outcome(documentType, { message: noFieldMessage }),
      trace: traceEntry(
        documentType,
        'no_field_found',
        now() - started,
        null,
        null,
        false,
        noFieldCode,
      ),
    };
  }

  if (!payload) {
    return {
      outcome: outcome(documentType, {
        fieldFound: true,
        message:
          documentType === 'resume'
            ? 'No résumé is stored in this extension yet.'
            : 'No cover letter is stored in this extension yet.',
      }),
      trace: traceEntry(
        documentType,
        'field_found',
        now() - started,
        control,
        null,
        false,
        'DOCUMENT_NOT_STORED',
      ),
    };
  }

  // A launcher that resolved to no input is reported honestly rather than as
  // "this page has no upload control" — the button is right there, and the user
  // needs to know the difference between "not found" and "found, not reachable".
  if (!control.accessible) {
    return {
      outcome: outcome(documentType, {
        fieldFound: true,
        message:
          'This upload button is visible but exposes no file input the extension can reach. Attach the file yourself.',
      }),
      trace: traceEntry(
        documentType,
        'failed_with_error',
        now() - started,
        control,
        null,
        false,
        'FILE_INPUT_NOT_ACCESSIBLE',
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await sendToFrame(tabId, control.frameId, {
      type: 'ATTACH_DOCUMENT_TO_CONTROL',
      runId,
      controlId: control.controlId,
      document: payload,
    });
  } catch (cause) {
    return {
      outcome: outcome(documentType, {
        fieldFound: true,
        message: `The frame holding this upload control did not answer: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
      trace: traceEntry(
        documentType,
        'failed_with_error',
        now() - started,
        control,
        null,
        false,
        'FRAME_UNREACHABLE',
      ),
    };
  }

  const parsed = attachToControlResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: outcome(documentType, {
        fieldFound: true,
        message: 'The frame returned an attachment result that failed validation.',
      }),
      trace: traceEntry(
        documentType,
        'failed_with_error',
        now() - started,
        control,
        null,
        false,
        'FRAME_UNREACHABLE',
      ),
    };
  }

  if (parsed.data.type === 'ATTACH_CONTROL_FAILED') {
    return {
      outcome: outcome(documentType, { fieldFound: true, message: parsed.data.message }),
      trace: traceEntry(
        documentType,
        'failed_with_error',
        now() - started,
        control,
        null,
        false,
        parsed.data.failureCode,
      ),
    };
  }

  const result = parsed.data;
  return {
    outcome: outcome(documentType, {
      fieldFound: true,
      attached: result.attached,
      verified: result.verified,
      // Named only when something actually carries the name, so the UI cannot
      // print a filename beside "attached: no".
      filename: result.attached ? payload.filename : null,
      source: result.attached ? payload.source : null,
      message: result.message,
    }),
    trace: traceEntry(
      documentType,
      result.verified
        ? 'attachment_verified'
        : result.attached
          ? 'attachment_attempted'
          : 'failed_with_error',
      now() - started,
      control,
      result.attached ? payload.filename : null,
      result.verified,
      result.failureCode,
    ),
  };
}

/**
 * The assertion the old build was missing.
 *
 * A run that saw upload launchers and still reported no field is a defect in
 * this extension, not a property of the page. Saying so in the run's own output
 * is what makes "elapsed 0.0 s beside four visible upload buttons" impossible to
 * ship again unnoticed.
 */
function assertDiscovery(
  surveys: readonly FrameUploadSurvey[],
  documents: readonly DocumentTraceEntry[],
): { failed: boolean; reason: string | null } {
  const launchers = surveys.reduce((total, survey) => total + survey.uploadLaunchers, 0);
  const inputs = surveys.reduce((total, survey) => total + survey.fileInputs, 0);
  const foundNothing = documents.every((entry) => entry.stage === 'no_field_found');

  if (foundNothing && launchers + inputs > 0) {
    return {
      failed: true,
      reason: `The page offers ${inputs} file input(s) and ${launchers} upload launcher(s), but neither document was matched to one. This is a classification failure in the extension, not a page without upload controls.`,
    };
  }
  return { failed: false, reason: null };
}

/**
 * A survey with no attachment: what every frame offers, and nothing done to it.
 *
 * Backs "Export Page Control Trace". It deliberately does not activate
 * launchers — the user has not asked for anything to be uploaded — so an
 * unresolved launcher appears as `launcher_unresolved` rather than being
 * clicked to find out. That is still enough to make a visible "My Computer"
 * button impossible to silently ignore: it is counted, named, and attributed to
 * its frame.
 */
export async function surveyPageControls(input: {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
  now?: () => number;
}): Promise<PageControlTrace> {
  const now = input.now ?? (() => Date.now());
  const startedAtMs = now();
  const { surveys, framesReached } = await surveyFrames(
    input.tabId,
    input.frames,
    input.runId,
    false,
  );
  return pageControlTraceSchema.parse({
    runId: input.runId,
    startedAt: new Date(startedAtMs).toISOString(),
    buildId: BUILD_ID,
    totalFrames: input.frames.length,
    framesReached,
    frames: surveys.slice(0, 40),
    documents: [],
    elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
    assertionFailed: false,
    assertionReason: null,
  });
}

export interface AttachAcrossFramesInput {
  tabId: number;
  url: string;
  frames: readonly FrameTarget[];
  documents: readonly AttachableDocumentPayload[];
  runId: string;
  now?: () => number;
}

/**
 * The whole document run, frames included.
 *
 * Always produces a report and always produces a trace, including when nothing
 * was found — an empty result is a finding, and it has to be visible as one.
 */
export async function attachAcrossFrames(
  input: AttachAcrossFramesInput,
): Promise<DocumentAttachmentReport> {
  const now = input.now ?? (() => Date.now());
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();

  const { surveys, controls, framesReached } = await surveyFrames(
    input.tabId,
    input.frames,
    input.runId,
    // The user pressed a button that says "Attach". Activating an upload
    // launcher is squarely within what they asked for, and it happens nowhere
    // else in the extension.
    true,
  );

  const targets = selectDocumentTargets(controls);
  const resumePayload = input.documents.find((entry) => entry.documentType === 'resume');
  const coverPayload = input.documents.find((entry) => entry.documentType === 'cover_letter');
  const anyControl = surveys.some(
    (survey) => survey.fileInputs > 0 || survey.uploadLaunchers > 0 || survey.controls.length > 0,
  );

  const resume = await attachOne(
    input.tabId,
    'resume',
    targets.resume,
    resumePayload,
    input.runId,
    anyControl
      ? 'No control on this page asks for a résumé.'
      : 'No file upload control was found in any frame of this page.',
    anyControl ? 'NO_MATCHING_SECTION' : 'NO_UPLOAD_CONTROL_ON_PAGE',
    now,
  );

  // The single-generic-field rule. When the only slot on the page was
  // unlabelled it has just taken the résumé, and putting the cover letter in it
  // too would either replace that résumé or attach a document the employer
  // never asked for.
  const coverLetter = targets.usedGenericForResume
    ? {
        outcome: outcome('cover_letter', {
          message:
            'This form has one unlabelled upload, which received the résumé. No separate cover-letter field was found.',
        }),
        trace: traceEntry(
          'cover_letter',
          'no_field_found',
          0,
          null,
          null,
          false,
          'NO_MATCHING_SECTION',
        ),
      }
    : await attachOne(
        input.tabId,
        'cover_letter',
        targets.coverLetter,
        coverPayload,
        input.runId,
        anyControl
          ? 'No control on this page asks for a cover letter.'
          : 'No file upload control was found in any frame of this page.',
        anyControl ? 'NO_MATCHING_SECTION' : 'NO_UPLOAD_CONTROL_ON_PAGE',
        now,
      );

  const documents = [resume.trace, coverLetter.trace];
  const assertion = assertDiscovery(surveys, documents);

  const trace: PageControlTrace = pageControlTraceSchema.parse({
    runId: input.runId,
    startedAt,
    buildId: BUILD_ID,
    totalFrames: input.frames.length,
    framesReached,
    frames: surveys.slice(0, 40),
    documents,
    elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
    assertionFailed: assertion.failed,
    assertionReason: assertion.reason,
  });

  return documentAttachmentReportSchema.parse({
    runId: input.runId,
    url: input.url,
    startedAt,
    elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
    resume: resume.outcome,
    coverLetter: coverLetter.outcome,
    fileFieldsSeen: surveys.reduce((total, survey) => total + survey.fileInputs, 0),
    trace,
    // Structural, not aspirational: nothing on this path can click a control
    // that is not a file-upload launcher.
    submitted: false,
  });
}
