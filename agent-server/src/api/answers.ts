import type { FastifyInstance } from 'fastify';
import {
  answerDeleteResponseSchema,
  answerListResponseSchema,
  approvedAnswerInputSchema,
  approvedAnswerSchema,
} from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';
import { DuplicateQuestionError } from '../answers/repository.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerAnswerRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  app.get('/answers', (_request, reply) =>
    sendValidated(reply, answerListResponseSchema, { answers: ctx.answers.list() }),
  );

  app.post('/answers', (request, reply) => {
    const parsed = parseBody(approvedAnswerInputSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    try {
      const created = ctx.answers.create(parsed.data);
      ctx.logger.info('approved answer created', {
        answerId: created.id,
        category: created.category,
        answerType: created.answerType,
        sensitive: created.sensitive,
        autoFillAllowed: created.autoFillAllowed,
      });
      return sendValidated(reply, approvedAnswerSchema, created, 201);
    } catch (cause) {
      if (cause instanceof DuplicateQuestionError) {
        return fail(reply, {
          code: 'VALIDATION_FAILED',
          message: `An approved answer already exists for "${cause.canonicalQuestion}".`,
          recoverable: true,
          suggestedAction:
            'Edit the existing answer instead, or use a different canonical question.',
        });
      }
      throw cause;
    }
  });

  app.put<{ Params: { id: string } }>('/answers/:id', (request, reply) => {
    const parsed = parseBody(approvedAnswerInputSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    try {
      const updated = ctx.answers.update(request.params.id, parsed.data);
      if (!updated) {
        return fail(reply, {
          code: 'NOT_FOUND',
          message: `No approved answer with id ${request.params.id} exists.`,
          recoverable: false,
          suggestedAction: 'Refresh the answer list; it may have been deleted in another window.',
        });
      }
      return sendValidated(reply, approvedAnswerSchema, updated);
    } catch (cause) {
      if (cause instanceof DuplicateQuestionError) {
        return fail(reply, {
          code: 'VALIDATION_FAILED',
          message: `Another approved answer already uses the question "${cause.canonicalQuestion}".`,
          recoverable: true,
          suggestedAction: 'Give this answer a different canonical question.',
        });
      }
      throw cause;
    }
  });

  app.delete<{ Params: { id: string } }>('/answers/:id', (request, reply) => {
    const removed = ctx.answers.remove(request.params.id);
    if (!removed) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: `No approved answer with id ${request.params.id} exists.`,
        recoverable: false,
        suggestedAction: 'Refresh the answer list; it may already have been deleted.',
      });
    }

    ctx.logger.info('approved answer deleted', { answerId: removed.id });
    return sendValidated(reply, answerDeleteResponseSchema, {
      id: removed.id,
      deleted: true as const,
    });
  });
}
