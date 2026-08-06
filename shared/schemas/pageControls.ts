import { z } from 'zod';

/**
 * What the extension found on a page, frame by frame, and what it did about it.
 *
 * This exists because a run that discovered nothing used to report the same
 * shape as a run that discovered everything, and the difference was a single
 * count nobody looked at. A page showing four "My Computer" buttons came back
 * saying "This page has no file upload control" in 0.0 seconds, and there was no
 * artefact anywhere that could have contradicted it.
 *
 * Everything here is structural: frame counts, control counts, kinds, and
 * outcome codes. No label text the user typed, no profile value, no filename
 * other than the one this extension itself generated. The trace is safe to
 * export and attach to a bug report.
 */

/** How a file input was arrived at. The interesting axis when one is missing. */
export const uploadDiscoverySchema = z.enum([
  /** An `input[type=file]` that was already in the DOM and reachable. */
  'existing_input',
  /** Reached from a `label[for]`, `aria-controls`, or a launcher's container. */
  'launcher_linked',
  /** Inside an open shadow root. */
  'shadow_root',
  /** Only existed after the launcher was activated and mutations were observed. */
  'launcher_activated',
  /** A launcher was found and no input could be reached from it by any route. */
  'launcher_unresolved',
]);

export type UploadDiscovery = z.infer<typeof uploadDiscoverySchema>;

/** What an upload section is for. Mirrors `DocumentFieldKind`. */
export const uploadControlKindSchema = z.enum(['resume', 'cover_letter', 'generic', 'unrelated']);

export type UploadControlKind = z.infer<typeof uploadControlKindSchema>;

/**
 * One upload target, in one frame.
 *
 * `controlId` is minted by the frame that found it and is only meaningful to
 * that frame — which is exactly why `frameId` travels with it everywhere. An
 * action is sent back to the frame that issued the id, never to the tab at
 * large.
 */
export const uploadControlSchema = z.object({
  controlId: z.string().min(1).max(120),
  frameId: z.number().int().nonnegative(),
  frameUrl: z.string().max(2048),
  frameOrigin: z.string().max(300),
  kind: uploadControlKindSchema,
  discovery: uploadDiscoverySchema,
  /** True when an `input[type=file]` was actually reached. */
  accessible: z.boolean(),
  /** Structural identifiers only — never free page text. */
  elementId: z.string().max(200).optional(),
  elementName: z.string().max(200).optional(),
  accept: z.string().max(300).optional(),
  hidden: z.boolean(),
  /** The launcher's normalized label, e.g. `my computer`. Bounded vocabulary. */
  launcherLabel: z.string().max(60).optional(),
});

export type UploadControl = z.infer<typeof uploadControlSchema>;

/** Everything one frame reported about its own upload surface. */
export const frameUploadSurveySchema = z.object({
  frameId: z.number().int().nonnegative(),
  frameUrl: z.string().max(2048),
  frameOrigin: z.string().max(300),
  /** True for the tab's main frame. */
  topFrame: z.boolean(),
  fileInputs: z.number().int().nonnegative(),
  hiddenFileInputs: z.number().int().nonnegative(),
  uploadLaunchers: z.number().int().nonnegative(),
  /** Cloud-provider buttons, counted so they are visibly *not* treated as targets. */
  cloudLaunchers: z.number().int().nonnegative(),
  controls: z.array(uploadControlSchema).max(60),
});

export type FrameUploadSurvey = z.infer<typeof frameUploadSurveySchema>;

/**
 * The result of one document's attachment attempt, in trace form.
 *
 * `field_found` without `attachment_attempted` is the state the old build
 * silently produced; naming it makes it assertable.
 */
export const attachmentStageSchema = z.enum([
  'no_field_found',
  'field_found',
  'attachment_attempted',
  'attachment_verified',
  'failed_with_error',
]);

export type AttachmentStage = z.infer<typeof attachmentStageSchema>;

/** Sanitized failure codes. A closed set, so the popup can explain each one. */
export const attachmentFailureCodeSchema = z.enum([
  'NO_UPLOAD_CONTROL_ON_PAGE',
  'NO_MATCHING_SECTION',
  'FILE_INPUT_NOT_ACCESSIBLE',
  'DOCUMENT_NOT_STORED',
  'FILE_TRANSFER_REFUSED',
  'CONTROL_LEFT_PAGE',
  'NOT_VERIFIED_BY_PAGE',
  'FRAME_UNREACHABLE',
  'PAGE_REJECTED_FILE',
]);

export type AttachmentFailureCode = z.infer<typeof attachmentFailureCodeSchema>;

export const documentTraceEntrySchema = z.object({
  documentType: z.enum(['resume', 'cover_letter']),
  stage: attachmentStageSchema,
  frameId: z.number().int().nonnegative().nullable(),
  controlId: z.string().max(120).nullable(),
  elementId: z.string().max(200).nullable(),
  discovery: uploadDiscoverySchema.nullable(),
  /** This extension generated the filename, so it is not page-derived data. */
  filename: z.string().max(255).nullable(),
  verified: z.boolean(),
  failureCode: attachmentFailureCodeSchema.nullable(),
  elapsedMs: z.number().int().nonnegative(),
});

export type DocumentTraceEntry = z.infer<typeof documentTraceEntrySchema>;

/**
 * The whole run, exportable.
 *
 * `assertionFailed` is the honesty check: a run that saw upload launchers and
 * still reported no field is a defect in this extension, not a property of the
 * page, and it says so in its own output rather than waiting to be noticed.
 */
export const pageControlTraceSchema = z.object({
  runId: z.string().min(1).max(100),
  startedAt: z.string().min(1).max(40),
  buildId: z.string().max(120),
  totalFrames: z.number().int().nonnegative(),
  framesReached: z.number().int().nonnegative(),
  frames: z.array(frameUploadSurveySchema).max(40),
  documents: z.array(documentTraceEntrySchema).max(4),
  elapsedMs: z.number().int().nonnegative(),
  assertionFailed: z.boolean(),
  assertionReason: z.string().max(400).nullable(),
});

export type PageControlTrace = z.infer<typeof pageControlTraceSchema>;

/** Worker → frame: "tell me what upload controls you have." Carries no bytes. */
export const discoverUploadControlsMessageSchema = z.object({
  type: z.literal('DISCOVER_UPLOAD_CONTROLS'),
  runId: z.string().min(1).max(100),
  /**
   * Whether the frame may click an upload launcher to make its hidden input
   * appear. False during a plain scan, true only inside a run the user started
   * by pressing an attach button.
   */
  mayActivateLaunchers: z.boolean(),
});

export const uploadControlsResponseSchema = z.union([
  z.object({
    type: z.literal('UPLOAD_CONTROLS'),
    runId: z.string().min(1).max(100),
    survey: frameUploadSurveySchema,
  }),
  z.object({
    type: z.literal('UPLOAD_CONTROLS_FAILED'),
    runId: z.string().min(1).max(100),
    reason: z.string().max(400),
  }),
]);

export type UploadControlsResponse = z.infer<typeof uploadControlsResponseSchema>;

/**
 * The frame's answer to "put this file in that control."
 *
 * The request itself lives in `latestDocuments.ts`, because it carries document
 * bytes and that module owns them; this file stays free of imports so it can
 * describe the page without depending on anything.
 */
export const attachToControlResponseSchema = z.union([
  z.object({
    type: z.literal('ATTACH_CONTROL_RESULT'),
    runId: z.string().min(1).max(100),
    attached: z.boolean(),
    verified: z.boolean(),
    failureCode: attachmentFailureCodeSchema.nullable(),
    message: z.string().max(400).nullable(),
  }),
  z.object({
    type: z.literal('ATTACH_CONTROL_FAILED'),
    runId: z.string().min(1).max(100),
    failureCode: attachmentFailureCodeSchema,
    message: z.string().max(400),
  }),
]);

export type AttachToControlResponse = z.infer<typeof attachToControlResponseSchema>;
