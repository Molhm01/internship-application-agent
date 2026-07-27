import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  documentDeleteResponseSchema,
  documentContentResponseSchema,
  documentListResponseSchema,
  documentUpdateSchema,
  documentUploadSchema,
  savedDocumentSchema,
} from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';
import { DocumentContentError, DocumentTooLargeError } from '../documents/storage.js';
import { newDocumentId } from '../documents/repository.js';
import { PathOutsideRootError } from '../security/paths.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerDocumentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  app.get('/documents', (_request, reply) =>
    sendValidated(reply, documentListResponseSchema, {
      documents: ctx.documents.list(),
      defaultResumeId: ctx.documents.defaultResumeId(),
    }),
  );

  app.get<{ Params: { id: string } }>('/documents/:id/content', (request, reply) => {
    const document = ctx.documents.find(request.params.id);
    if (!document || !ctx.documentStorage.exists(document.fileName)) {
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: `No readable document with id ${request.params.id} is registered.`,
        recoverable: true,
        suggestedAction: 'Refresh the document library and choose an available document.',
      });
    }
    const content = ctx.documentStorage.read(document.fileName);
    return sendValidated(reply, documentContentResponseSchema, {
      id: document.id,
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: content.byteLength,
      contentBase64: content.toString('base64'),
    });
  });

  app.route({
    method: 'POST',
    url: '/documents',
    // Documents arrive base64-encoded, so this route alone needs a larger body.
    bodyLimit: LIMITS.maxDocumentRequestBytes,
    handler: (request, reply) => {
      const parsed = parseBody(documentUploadSchema, request.body);
      if (!parsed.ok) {
        return reply.status(422).send({ ok: false, error: parsed.error });
      }

      const documentId = newDocumentId();
      try {
        const stored = ctx.documentStorage.write(
          documentId,
          parsed.data.fileName,
          parsed.data.contentBase64,
          parsed.data.mimeType,
        );

        const created = ctx.documents.create(parsed.data, stored, documentId);
        ctx.logger.info('document registered', {
          documentId: created.id,
          type: created.type,
          sizeBytes: created.sizeBytes,
          mimeType: created.mimeType,
        });

        return sendValidated(reply, savedDocumentSchema, created, 201);
      } catch (cause) {
        if (cause instanceof DocumentTooLargeError) {
          return fail(reply, {
            code: 'REQUEST_TOO_LARGE',
            message: `That file is ${Math.round(cause.sizeBytes / 1024)} KB, over the ${Math.round(
              cause.limitBytes / 1024 / 1024,
            )} MB limit.`,
            recoverable: true,
            suggestedAction: 'Compress the document or export a smaller version, then try again.',
          });
        }
        if (cause instanceof DocumentContentError) {
          return fail(reply, {
            code: 'VALIDATION_FAILED',
            message: cause.message,
            recoverable: true,
            suggestedAction: 'Choose a different file, or re-export it in the declared format.',
          });
        }
        if (cause instanceof PathOutsideRootError) {
          // Reaching here would mean the sanitizer failed; refuse loudly.
          ctx.logger.error('document path escaped the documents directory', {
            documentId,
          });
          return fail(reply, {
            code: 'PERMISSION_DENIED',
            message: 'The resolved file path fell outside the permitted documents directory.',
            recoverable: false,
            suggestedAction: 'Rename the file to plain ASCII characters and try again.',
          });
        }
        throw cause;
      }
    },
  });

  app.put<{ Params: { id: string } }>('/documents/:id', (request, reply) => {
    const parsed = parseBody(documentUpdateSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    const updated = ctx.documents.update(request.params.id, parsed.data);
    if (!updated) {
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: `No document with id ${request.params.id} is registered.`,
        recoverable: false,
        suggestedAction: 'Refresh the document list; it may have been deleted in another window.',
      });
    }

    return sendValidated(reply, savedDocumentSchema, updated);
  });

  app.delete<{ Params: { id: string } }>('/documents/:id', (request, reply) => {
    const removed = ctx.documents.remove(request.params.id);
    if (!removed) {
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: `No document with id ${request.params.id} is registered.`,
        recoverable: false,
        suggestedAction: 'Refresh the document list; it may already have been deleted.',
      });
    }

    ctx.logger.info('document deleted', {
      documentId: removed.document.id,
      fileRemoved: removed.fileRemoved,
    });

    return sendValidated(reply, documentDeleteResponseSchema, {
      id: removed.document.id,
      deleted: true as const,
      fileRemoved: removed.fileRemoved,
    });
  });
}
