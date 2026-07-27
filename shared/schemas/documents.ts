import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { LIMITS } from '../constants/network.js';

export const documentTypeSchema = z.enum([
  'resume',
  'cover_letter',
  'transcript',
  'portfolio',
  'other',
]);

export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * Only these types may be stored. An application form expects a document, not an
 * executable, and refusing everything else keeps the documents directory from
 * becoming a place to stage arbitrary files.
 */
export const ALLOWED_DOCUMENT_MIME_TYPES = {
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/rtf': ['rtf'],
  'text/plain': ['txt'],
  'text/markdown': ['md'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
} as const satisfies Record<string, readonly string[]>;

export type AllowedDocumentMimeType = keyof typeof ALLOWED_DOCUMENT_MIME_TYPES;

export const documentMimeTypeSchema = z.enum(
  Object.keys(ALLOWED_DOCUMENT_MIME_TYPES) as [
    AllowedDocumentMimeType,
    ...AllowedDocumentMimeType[],
  ],
);

export const savedDocumentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  type: documentTypeSchema,
  /**
   * Absolute path inside the configured documents directory. The server is the
   * only component that resolves or validates this; it is never chosen by the
   * model and never handed to the page.
   */
  filePath: z.string().min(1).max(4096),
  /** Basename only — safe to show in the UI without leaking the directory layout. */
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  tags: z.array(z.string().max(80)).default([]),
  targetRoles: z.array(z.string().max(200)).default([]),
  targetIndustries: z.array(z.string().max(200)).default([]),
  isDefault: z.boolean().default(false),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type SavedDocument = z.infer<typeof savedDocumentSchema>;

/**
 * What the model is allowed to see about a document: enough to recommend one,
 * with no filesystem detail.
 */
export const documentSummarySchema = savedDocumentSchema.pick({
  id: true,
  name: true,
  type: true,
  tags: true,
  targetRoles: true,
  targetIndustries: true,
  isDefault: true,
});

export type DocumentSummary = z.infer<typeof documentSummarySchema>;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Body of `POST /documents`. The file arrives as base64 chosen by the user
 * through a browser file picker, and the server writes it into the documents
 * directory under a name it generates. No caller ever supplies a path, so no
 * caller can reach outside that directory.
 */
export const documentUploadSchema = z.object({
  name: z.string().min(1).max(200),
  type: documentTypeSchema,
  /** Original filename, used only for its extension and for display. */
  fileName: z.string().min(1).max(255),
  mimeType: documentMimeTypeSchema,
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((LIMITS.maxDocumentBytes * 4) / 3) + 1024)
    .refine((value) => BASE64_PATTERN.test(value.replace(/\s/g, '')), {
      message: 'contentBase64 must be valid base64 without a data: prefix',
    }),
  tags: z.array(z.string().max(80)).max(50).default([]),
  targetRoles: z.array(z.string().max(200)).max(50).default([]),
  targetIndustries: z.array(z.string().max(200)).max(50).default([]),
  isDefault: z.boolean().default(false),
});

export type DocumentUpload = z.infer<typeof documentUploadSchema>;

/**
 * Body of `PUT /documents/:id`. Metadata only — the stored file is immutable;
 * replacing it means registering a new document.
 */
export const documentUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: documentTypeSchema.optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  targetRoles: z.array(z.string().max(200)).max(50).optional(),
  targetIndustries: z.array(z.string().max(200)).max(50).optional(),
  isDefault: z.boolean().optional(),
});

export type DocumentUpdate = z.infer<typeof documentUpdateSchema>;

export const documentListResponseSchema = z.object({
  documents: z.array(savedDocumentSchema),
  /** The resume used when the user has not chosen one explicitly. */
  defaultResumeId: idSchema.nullable(),
});

export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

export const documentDeleteResponseSchema = z.object({
  id: idSchema,
  deleted: z.literal(true),
  /** False when the row existed but the file was already gone from disk. */
  fileRemoved: z.boolean(),
});
