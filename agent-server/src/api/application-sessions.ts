import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createApplicationSession as dbCreateApplicationSession,
  getApplicationSession as dbGetApplicationSession,
  claimApplicationSession as dbClaimApplicationSession,
  updateApplicationSessionStatus as dbUpdateApplicationSessionStatus,
  clearExpiredApplicationSessions,
} from '../database/application-sessions.js';
import { applicationSessionInputSchema, applicationSessionSchema } from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Derives the required url/domain/ats stored fields when the caller (the
 * website handoff) only supplied officialApplyUrl. The extension, which
 * already knows the page's url/domain/ats, may still pass them explicitly. */
function deriveStoredFields(input: z.infer<typeof applicationSessionInputSchema>): {
  url: string;
  domain: string;
  ats: string;
} {
  const url = input.url ?? input.officialApplyUrl;
  if (!url) {
    throw new Error('Either url or officialApplyUrl is required');
  }
  const domain = input.domain ?? new URL(url).hostname;
  const ats = input.ats ?? 'website-handoff';
  return { url, domain, ats };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerApplicationSessionRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  // Clear expired sessions once per hour.
  setInterval(() => {
    clearExpiredApplicationSessions(ctx.db);
  }, 60 * 60 * 1000);

  app.post('/application-sessions', (request, reply) => {
    const parsed = parseBody(applicationSessionInputSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }
    const input = parsed.data;

    let stored: { url: string; domain: string; ats: string };
    try {
      stored = deriveStoredFields(input);
    } catch (cause) {
      return fail(reply, {
        code: 'VALIDATION_FAILED',
        message: cause instanceof Error ? cause.message : 'Invalid session input',
        recoverable: true,
      });
    }

    const now = Date.now();
    try {
      const session = dbCreateApplicationSession(ctx.db, {
        sessionId: input.id ?? crypto.randomUUID(),
        createdAt: now,
        expiresAt: input.expiresAt ?? now + SESSION_TTL_MS,
        status: input.status ?? 'available',
        url: stored.url,
        domain: stored.domain,
        ats: stored.ats,
        jobContext: input.jobContext,
        company: input.company,
        jobTitle: input.jobTitle,
        officialApplyUrl: input.officialApplyUrl,
        websiteJobId: input.websiteJobId,
        location: input.location,
        eligibilityScore: input.eligibilityScore,
        tailoredResumeDocumentId: input.tailoredResumeDocumentId,
        tailoredCoverLetterDocumentId: input.tailoredCoverLetterDocumentId,
        startAutofill: input.startAutofill,
      });

      // `id` is the field the website handoff client contract expects; the
      // full session is included too for the extension's own use.
      return sendValidated(
        reply,
        applicationSessionSchema.extend({ id: z.string() }),
        { ...session, id: session.sessionId },
        201,
      );
    } catch (cause) {
      ctx.logger.error('failed to create application session', { error: String(cause) });
      return fail(reply, {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create application session',
        recoverable: false,
      });
    }
  });

  app.get('/application-sessions/:id', (request, reply) => {
    const { id } = request.params as { id: string };

    const session = dbGetApplicationSession(ctx.db, id);
    if (!session) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: 'Application session not found',
        recoverable: false,
        debugContext: { sessionId: id },
      });
    }

    if (session.expiresAt < Date.now()) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: 'Application session has expired',
        recoverable: false,
        debugContext: { sessionId: id },
      });
    }

    return sendValidated(reply, applicationSessionSchema, session);
  });

  app.post('/application-sessions/:id/claim', (request, reply) => {
    const { id } = request.params as { id: string };

    const session = dbClaimApplicationSession(ctx.db, id);
    if (!session) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: 'Application session not found or already claimed',
        recoverable: false,
        debugContext: { sessionId: id },
      });
    }

    return sendValidated(reply, applicationSessionSchema, session);
  });

  const statusBodySchema = z.object({ status: z.enum(['available', 'claimed', 'completed']) });

  app.patch('/application-sessions/:id/status', (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(statusBodySchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    const session = dbUpdateApplicationSessionStatus(ctx.db, id, parsed.data.status);
    if (!session) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: 'Application session not found',
        recoverable: false,
        debugContext: { sessionId: id },
      });
    }

    return sendValidated(reply, applicationSessionSchema, session);
  });
}
