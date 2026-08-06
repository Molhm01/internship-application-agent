import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  latestDocumentContentResponseSchema,
  latestDocumentListResponseSchema,
  latestDocumentRecordSchema,
  latestDocumentUploadSchema,
} from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';
import { DocumentContentError, DocumentTooLargeError } from '../documents/storage.js';
import { checksumOf, newLatestDocumentId } from '../documents/latestRepository.js';
import { PathOutsideRootError } from '../security/paths.js';

/**
 * The tailored-document API: the newest résumé and cover letter, nothing else.
 *
 * Every route here is authenticated with `x-agent-token` by the server-wide hook
 * and reachable only on 127.0.0.1, because the server binds nowhere else. No
 * handler logs a filename's contents, a checksum's source bytes, or the token.
 */

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerLatestDocumentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  app.get('/documents/latest', (_request, reply) =>
    sendValidated(reply, latestDocumentListResponseSchema, {
      resume: ctx.latestDocuments.latest('resume'),
      coverLetter: ctx.latestDocuments.latest('cover_letter'),
    }),
  );

  app.get<{ Params: { id: string } }>('/documents/latest/:id/content', (request, reply) => {
    const found = ctx.latestDocuments.find(request.params.id);
    if (!found || !ctx.documentStorage.exists(found.fileName)) {
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: `No readable tailored document with id ${request.params.id} is stored.`,
        recoverable: true,
        suggestedAction: 'Refresh documents in the extension, or generate the document again.',
      });
    }

    const content = ctx.documentStorage.read(found.fileName);
    // The bytes on disk are what gets attached, so they are what is checked —
    // re-hashing the row's own recorded digest would prove nothing.
    const checksum = checksumOf(content);
    if (checksum !== found.record.checksum || content.byteLength !== found.record.byteLength) {
      ctx.logger.error('stored tailored document no longer matches its record', {
        documentId: found.record.id,
        documentType: found.record.documentType,
        expectedBytes: found.record.byteLength,
        actualBytes: content.byteLength,
      });
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: 'The stored file no longer matches the checksum recorded for it.',
        recoverable: true,
        suggestedAction: 'Generate the document again on Internship Pilot.',
      });
    }

    return sendValidated(reply, latestDocumentContentResponseSchema, {
      ...found.record,
      contentBase64: content.toString('base64'),
    });
  });

  app.route({
    method: 'POST',
    url: '/documents/latest',
    // A base64 PDF, so this route alone needs the larger body limit.
    bodyLimit: LIMITS.maxDocumentRequestBytes,
    handler: (request, reply) => {
      const parsed = parseBody(latestDocumentUploadSchema, request.body);
      if (!parsed.ok) {
        return reply.status(422).send({ ok: false, error: parsed.error });
      }

      // Verified before anything is written. Storing a file whose bytes do not
      // match the sender's digest would mean the extension attaches a document
      // nobody has checked.
      const bytes = Buffer.from(parsed.data.contentBase64.replace(/\s/g, ''), 'base64');
      const checksum = checksumOf(bytes);
      if (checksum !== parsed.data.checksum) {
        return fail(reply, {
          code: 'VALIDATION_FAILED',
          message: 'The document bytes do not match the checksum sent with them.',
          recoverable: true,
          suggestedAction: 'Generate the document again; the transfer was corrupted.',
        });
      }

      const documentId = newLatestDocumentId();
      try {
        const stored = ctx.documentStorage.write(
          documentId,
          parsed.data.filename,
          parsed.data.contentBase64,
          parsed.data.mimeType,
        );
        const record = ctx.latestDocuments.save(parsed.data, stored, checksum, documentId);

        // Filename, type, and size only. Never a byte of the document.
        ctx.logger.info('latest tailored document stored', {
          documentId: record.id,
          documentType: record.documentType,
          source: record.source,
          byteLength: record.byteLength,
        });

        return sendValidated(reply, latestDocumentRecordSchema, record, 201);
      } catch (cause) {
        if (cause instanceof DocumentTooLargeError) {
          return fail(reply, {
            code: 'REQUEST_TOO_LARGE',
            message: `That document is ${Math.round(cause.sizeBytes / 1024)} KB, over the ${Math.round(
              cause.limitBytes / 1024 / 1024,
            )} MB limit.`,
            recoverable: true,
            suggestedAction: 'Regenerate the document; a tailored PDF should be far smaller.',
          });
        }
        if (cause instanceof DocumentContentError) {
          return fail(reply, {
            code: 'VALIDATION_FAILED',
            message: cause.message,
            recoverable: true,
            suggestedAction: 'Regenerate the document as a PDF and send it again.',
          });
        }
        if (cause instanceof PathOutsideRootError) {
          ctx.logger.error('tailored document path escaped the documents directory', {
            documentType: parsed.data.documentType,
          });
          return fail(reply, {
            code: 'PERMISSION_DENIED',
            message: 'The resolved file path fell outside the permitted documents directory.',
            recoverable: false,
            suggestedAction: 'Use a plain ASCII filename for generated documents.',
          });
        }
        throw cause;
      }
    },
  });
}
