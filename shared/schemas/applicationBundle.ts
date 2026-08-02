import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/**
 * The application bundle: everything Internship Pilot hands to the extension
 * when the user clicks "Apply with Application Agent".
 *
 * This deliberately replaces the ApplicationSession handoff. There is no server
 * row, no auth token, no URL fragment, and no local-agent dependency — the
 * website posts a message, the extension stores it, and the extension owns it
 * from then on. The extension therefore still works when the website is closed
 * and when the user opened the employer page themselves.
 */

/** PDFs are the only thing the website generates; nothing else is accepted. */
export const BUNDLE_DOCUMENT_MIME_TYPES = ['application/pdf'] as const;

/** 12 MB. Larger than any tailored one-page résumé, small enough to hold in memory. */
export const MAXIMUM_BUNDLE_DOCUMENT_BYTES = 12 * 1024 * 1024;

export const bundleDocumentKindSchema = z.enum(['resume', 'cover_letter']);
export type BundleDocumentKind = z.infer<typeof bundleDocumentKindSchema>;

/**
 * A document as it arrives over the page bridge: bytes inline, base64-encoded,
 * because `window.postMessage` structured clone of an ArrayBuffer across an
 * isolated world is not guaranteed across every Chrome version we support.
 */
export const bundleDocumentTransferSchema = z.object({
  kind: bundleDocumentKindSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.enum(BUNDLE_DOCUMENT_MIME_TYPES),
  /** Base64 of the file bytes. Never placed in a URL. */
  contentBase64: z.string().min(1).max(Math.ceil((MAXIMUM_BUNDLE_DOCUMENT_BYTES * 4) / 3) + 16),
  byteLength: z.number().int().positive().max(MAXIMUM_BUNDLE_DOCUMENT_BYTES),
  generatedAt: isoDateTimeSchema,
});

export type BundleDocumentTransfer = z.infer<typeof bundleDocumentTransferSchema>;

/** What the page posts. Validated before a single byte is written. */
export const applicationBundleTransferSchema = z.object({
  websiteJobId: z.string().min(1).max(200),
  company: z.string().min(1).max(300),
  jobTitle: z.string().min(1).max(300),
  jobDescription: z.string().max(60_000).default(''),
  officialApplicationUrl: z.string().url().max(4000),
  documents: z.array(bundleDocumentTransferSchema).min(1).max(4),
  createdAt: isoDateTimeSchema,
});

export type ApplicationBundleTransfer = z.infer<typeof applicationBundleTransferSchema>;

/**
 * A document once stored. `bytesReference` is the IndexedDB key of the blob —
 * the bytes themselves never live in `chrome.storage`, which is quota-limited
 * and synchronised.
 */
export const storedBundleDocumentSchema = z.object({
  kind: bundleDocumentKindSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.enum(BUNDLE_DOCUMENT_MIME_TYPES),
  bytesReference: z.string().min(1).max(200),
  byteLength: z.number().int().positive().max(MAXIMUM_BUNDLE_DOCUMENT_BYTES),
  generatedAt: isoDateTimeSchema,
});

export type StoredBundleDocument = z.infer<typeof storedBundleDocumentSchema>;

export const applicationBundleSchema = z.object({
  id: idSchema,
  websiteJobId: z.string().min(1).max(200),
  company: z.string().min(1).max(300),
  jobTitle: z.string().min(1).max(300),
  jobDescription: z.string().max(60_000).default(''),
  officialApplicationUrl: z.string().url().max(4000),
  resume: storedBundleDocumentSchema.optional(),
  coverLetter: storedBundleDocumentSchema.optional(),
  createdAt: isoDateTimeSchema,
  /** Set the first time an application page for this bundle is recognized. */
  lastMatchedUrl: z.string().url().max(4000).optional(),
});

export type ApplicationBundle = z.infer<typeof applicationBundleSchema>;

/** What the content script posts back so the website knows the bytes landed. */
export const bundleAcknowledgementSchema = z.object({
  ok: z.literal(true),
  bundleId: idSchema,
  storedDocuments: z.array(bundleDocumentKindSchema).min(1).max(4),
  storedAt: isoDateTimeSchema,
});

export type BundleAcknowledgement = z.infer<typeof bundleAcknowledgementSchema>;

export const bundleRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.string().min(1).max(600),
});

export type BundleRejection = z.infer<typeof bundleRejectionSchema>;

/** Message names on the page bridge. Namespaced so no other script collides. */
export const BUNDLE_BRIDGE = {
  probe: 'internship-agent:bridge-probe',
  probeAck: 'internship-agent:bridge-available',
  offer: 'internship-agent:bundle-offer',
  result: 'internship-agent:bundle-result',
} as const;

export const bundleProbeMessageSchema = z.object({
  channel: z.literal(BUNDLE_BRIDGE.probe),
  requestId: z.string().min(1).max(120),
});

export const bundleOfferMessageSchema = z.object({
  channel: z.literal(BUNDLE_BRIDGE.offer),
  requestId: z.string().min(1).max(120),
  bundle: applicationBundleTransferSchema,
});

export const bundleResultMessageSchema = z.object({
  channel: z.literal(BUNDLE_BRIDGE.result),
  requestId: z.string().min(1).max(120),
  result: z.union([bundleAcknowledgementSchema, bundleRejectionSchema]),
});

export type BundleOfferMessage = z.infer<typeof bundleOfferMessageSchema>;
export type BundleResultMessage = z.infer<typeof bundleResultMessageSchema>;

/**
 * Whether a page is the application page for this bundle. Compared on origin
 * plus path so an ATS that appends its own tracking query still matches, while
 * a different employer never does.
 */
export function bundleMatchesUrl(bundle: ApplicationBundle, url: string): boolean {
  try {
    const target = new URL(bundle.officialApplicationUrl);
    const actual = new URL(url);
    if (target.origin !== actual.origin) return false;
    const normalize = (value: string): string => value.replace(/\/+$/, '').toLowerCase();
    const targetPath = normalize(target.pathname);
    const actualPath = normalize(actual.pathname);
    if (targetPath === actualPath) return true;
    // ATS flows push the applicant from /jobs/123 to /jobs/123/apply and back.
    return actualPath.startsWith(`${targetPath}/`) || targetPath.startsWith(`${actualPath}/`);
  } catch {
    return false;
  }
}
