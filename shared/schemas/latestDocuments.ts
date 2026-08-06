import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';
import { agentErrorSchema } from './error.js';
import { LIMITS } from '../constants/network.js';

/**
 * The one document contract shared by Internship Pilot, the agent server, and
 * the extension.
 *
 * Deliberately narrow. Tailored résumés and cover letters are the only things
 * that travel this path, they are always PDFs, and the whole point of the record
 * is that all three components agree byte-for-byte on which file is current —
 * so the checksum is part of the contract rather than an optional extra.
 *
 * Bytes never appear here. They are fetched separately, by id, over the
 * authenticated loopback API, and are never placed in a prompt, in
 * `chrome.storage.sync`, in a URL, or in a log line.
 */

export const latestDocumentTypeSchema = z.enum(['resume', 'cover_letter']);
export type LatestDocumentType = z.infer<typeof latestDocumentTypeSchema>;

/** `tailored` is generated for one job; `default` is the standing master file. */
export const latestDocumentSourceSchema = z.enum(['tailored', 'default']);
export type LatestDocumentSource = z.infer<typeof latestDocumentSourceSchema>;

/** Lowercase hex SHA-256 of the raw file bytes. */
export const checksumSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'checksum must be a lowercase hex SHA-256 digest');

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const latestDocumentRecordSchema = z.object({
  id: z.string().min(1).max(200),
  documentType: latestDocumentTypeSchema,
  filename: z.string().min(1).max(255),
  /** Only PDFs are generated, and only PDFs are accepted. */
  mimeType: z.literal('application/pdf'),
  byteLength: z.number().int().positive().max(LIMITS.maxDocumentBytes),
  createdAt: isoDateTimeSchema,
  source: latestDocumentSourceSchema,
  company: z.string().min(1).max(200).optional(),
  jobTitle: z.string().min(1).max(300).optional(),
  jobId: z.string().min(1).max(200).optional(),
  checksum: checksumSchema,
});

export type LatestDocumentRecord = z.infer<typeof latestDocumentRecordSchema>;

/** Body of `POST /documents/latest`. */
export const latestDocumentUploadSchema = latestDocumentRecordSchema
  .omit({ id: true, byteLength: true, createdAt: true })
  .extend({
    createdAt: isoDateTimeSchema.optional(),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil((LIMITS.maxDocumentBytes * 4) / 3) + 1024)
      .refine((value) => BASE64_PATTERN.test(value.replace(/\s/g, '')), {
        message: 'contentBase64 must be valid base64 without a data: prefix',
      }),
  });

export type LatestDocumentUpload = z.infer<typeof latestDocumentUploadSchema>;

/**
 * `GET /documents/latest`. Both keys are always present; `null` means "asked and
 * there is none", which the popup must be able to distinguish from "could not
 * ask".
 */
export const latestDocumentListResponseSchema = z.object({
  resume: latestDocumentRecordSchema.nullable(),
  coverLetter: latestDocumentRecordSchema.nullable(),
});

export type LatestDocumentListResponse = z.infer<typeof latestDocumentListResponseSchema>;

/** `GET /documents/latest/:id/content`. */
export const latestDocumentContentResponseSchema = latestDocumentRecordSchema.extend({
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((LIMITS.maxDocumentBytes * 4) / 3) + 1024)
    .regex(BASE64_PATTERN),
});

export type LatestDocumentContentResponse = z.infer<typeof latestDocumentContentResponseSchema>;

/**
 * What the extension holds locally, and what the popup renders. `receivedAt` is
 * when this browser stored it, which is what the user is actually asking about
 * when they look at the Documents section.
 */
export const storedLatestDocumentSchema = latestDocumentRecordSchema.extend({
  receivedAt: isoDateTimeSchema,
});

export type StoredLatestDocument = z.infer<typeof storedLatestDocumentSchema>;

export const storedLatestDocumentsSchema = z.object({
  resume: storedLatestDocumentSchema.nullable(),
  coverLetter: storedLatestDocumentSchema.nullable(),
});

export type StoredLatestDocuments = z.infer<typeof storedLatestDocumentsSchema>;

/**
 * One document's outcome in an attachment run.
 *
 * `attached` means a `File` reached the control. `verified` means the page was
 * observed to hold it afterwards. They are separate booleans because a function
 * returning successfully is not evidence a field was filled, and the UI must
 * never report "uploaded" off the first one alone.
 */
export const documentAttachmentOutcomeSchema = z.object({
  documentType: latestDocumentTypeSchema,
  fieldFound: z.boolean(),
  attached: z.boolean(),
  verified: z.boolean(),
  filename: z.string().max(255).nullable(),
  /** Which stored file was used, so the UI can say "Default résumé" honestly. */
  source: latestDocumentSourceSchema.nullable(),
  /** Sanitized, user-facing, and never a stack trace or a document byte. */
  message: z.string().max(400).nullable(),
});

export type DocumentAttachmentOutcome = z.infer<typeof documentAttachmentOutcomeSchema>;

export const documentAttachmentReportSchema = z.object({
  runId: z.string().min(1).max(100),
  url: z.string().min(1).max(2048),
  startedAt: isoDateTimeSchema,
  elapsedMs: z.number().int().nonnegative(),
  resume: documentAttachmentOutcomeSchema,
  coverLetter: documentAttachmentOutcomeSchema,
  /** File controls seen on the page, whatever their purpose. Diagnostics only. */
  fileFieldsSeen: z.number().int().nonnegative(),
  /**
   * Structurally impossible to be anything else: this path has no submit
   * capability, and the schema records that fact for the report reader.
   */
  submitted: z.literal(false),
});

export type DocumentAttachmentReport = z.infer<typeof documentAttachmentReportSchema>;

/**
 * Background worker → content script. The one message that carries document
 * bytes into a page, and it carries nothing else: no selector, no script, no
 * instruction the page could execute.
 */
export const attachableDocumentSchema = z.object({
  documentType: latestDocumentTypeSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.literal('application/pdf'),
  byteLength: z.number().int().positive().max(LIMITS.maxDocumentBytes),
  source: latestDocumentSourceSchema,
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((LIMITS.maxDocumentBytes * 4) / 3) + 1024)
    .regex(BASE64_PATTERN),
});

export type AttachableDocumentPayload = z.infer<typeof attachableDocumentSchema>;

export const attachDocumentsMessageSchema = z.object({
  type: z.literal('ATTACH_DOCUMENTS_IN_PAGE'),
  runId: z.string().min(1).max(100),
  documents: z.array(attachableDocumentSchema).max(2),
});

export type AttachDocumentsMessage = z.infer<typeof attachDocumentsMessageSchema>;

export const attachDocumentsResponseSchema = z.union([
  z.object({
    type: z.literal('ATTACH_DOCUMENTS_COMPLETE'),
    report: documentAttachmentReportSchema,
  }),
  z.object({
    type: z.literal('ATTACH_DOCUMENTS_FAILED'),
    runId: z.string().min(1).max(100),
    error: agentErrorSchema,
  }),
]);

export type AttachDocumentsResponse = z.infer<typeof attachDocumentsResponseSchema>;

/**
 * What the popup gets back from a sync or a plain read.
 *
 * `documents` is always what this browser actually holds, even when `error` is
 * set: a server that went away must not blank out a résumé already stored here,
 * and the popup has to be able to say "these are yours, and the refresh failed"
 * in one render.
 */
export const latestDocumentSyncResponseSchema = z.object({
  documents: storedLatestDocumentsSchema,
  syncedAt: isoDateTimeSchema.nullable(),
  /**
   * The most recent attachment run, whoever started it. An "Autofill
   * Application" run attaches documents too, and its result has to be visible
   * in the same place as the document-only command's — otherwise the panel
   * would show nothing after a run that did the work.
   */
  lastReport: documentAttachmentReportSchema.nullable(),
  error: agentErrorSchema.optional(),
});

export type LatestDocumentSyncResponse = z.infer<typeof latestDocumentSyncResponseSchema>;

/** What the popup gets back from "Attach Resume and Cover Letter". */
export const attachDocumentsResultSchema = z.union([
  z.object({ report: documentAttachmentReportSchema }),
  z.object({ error: agentErrorSchema }),
]);

export type AttachDocumentsResult = z.infer<typeof attachDocumentsResultSchema>;
