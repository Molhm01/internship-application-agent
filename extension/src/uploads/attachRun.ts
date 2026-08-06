import {
  documentAttachmentReportSchema,
  selectDocumentTargets,
  type AttachableDocumentPayload,
  type DocumentAttachmentOutcome,
  type DocumentAttachmentReport,
} from '@internship-agent/shared';
import {
  attachDocumentToField,
  collectDocumentFileFields,
  notFoundOutcome,
  type DocumentFileField,
} from './documentAttachment.js';

/**
 * One document-only attachment run.
 *
 * Scans file controls, decides deterministically which document each one wants,
 * attaches, and reports exactly what the DOM said afterwards. A failure on one
 * document never stops the other: a form with a résumé slot and no cover-letter
 * slot must still end with the résumé attached.
 */

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function attachOne(
  root: Document,
  field: DocumentFileField | null,
  payload: AttachableDocumentPayload | undefined,
  documentType: 'resume' | 'cover_letter',
  missingDocumentMessage: string,
  missingFieldMessage: string,
): Promise<DocumentAttachmentOutcome> {
  if (!field) {
    return notFoundOutcome(documentType, missingFieldMessage);
  }
  if (!payload) {
    return {
      documentType,
      fieldFound: true,
      attached: false,
      verified: false,
      filename: null,
      source: null,
      message: missingDocumentMessage,
    };
  }

  const bytes = decodeBase64(payload.contentBase64);
  const attempt = await attachDocumentToField(root, field, {
    documentType,
    filename: payload.filename,
    mimeType: payload.mimeType,
    bytes,
    byteLength: payload.byteLength,
    source: payload.source,
  });

  return {
    documentType,
    fieldFound: true,
    attached: attempt.attached,
    verified: attempt.verified,
    // Named only when something actually carries the name, so the UI cannot
    // print a filename beside "attached: no".
    filename: attempt.attached ? payload.filename : null,
    source: attempt.attached ? payload.source : null,
    message: attempt.message,
  };
}

export async function runDocumentAttachment(
  root: Document,
  runId: string,
  url: string,
  documents: readonly AttachableDocumentPayload[],
  now: () => number = () => Date.now(),
): Promise<DocumentAttachmentReport> {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const fields = collectDocumentFileFields(root);
  const targets = selectDocumentTargets(fields);

  const resumePayload = documents.find((entry) => entry.documentType === 'resume');
  const coverPayload = documents.find((entry) => entry.documentType === 'cover_letter');

  const resume = await attachOne(
    root,
    targets.resume,
    resumePayload,
    'resume',
    'No résumé is stored in this extension yet.',
    fields.length === 0
      ? 'This page has no file upload control.'
      : 'No control on this page asks for a résumé.',
  );

  // The single-generic-field rule. When the only slot on the page was
  // unlabelled it has just taken the résumé, and putting the cover letter in it
  // too would either replace that résumé or attach a document the employer
  // never asked for.
  const coverLetter = targets.usedGenericForResume
    ? notFoundOutcome(
        'cover_letter',
        'This form has one unlabelled upload, which received the résumé. No separate cover-letter field was found.',
      )
    : await attachOne(
        root,
        targets.coverLetter,
        coverPayload,
        'cover_letter',
        'No cover letter is stored in this extension yet.',
        'No control on this page asks for a cover letter.',
      );

  return documentAttachmentReportSchema.parse({
    runId,
    url,
    startedAt,
    elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
    resume,
    coverLetter,
    fileFieldsSeen: fields.length,
    // Structural, not aspirational: this module has no code path that clicks
    // anything at all.
    submitted: false,
  });
}
