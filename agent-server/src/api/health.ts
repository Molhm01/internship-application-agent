import type { FastifyInstance } from 'fastify';
import {
  computeProfileCompleteness,
  healthResponseSchema,
  modelsResponseSchema,
  versionResponseSchema,
  type HealthResponse,
} from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { CURRENT_MILESTONE, SERVER_VERSION } from '../config.js';

/**
 * `/health` is deliberately unauthenticated: the popup must be able to show a
 * truthful "server reachable / Ollama reachable" state before the user has
 * pasted a token.
 *
 * An unauthenticated caller receives connection facts only. Stored-data detail —
 * profile completeness, document and answer counts — is added only when the
 * request carries a valid token.
 */
type StoredDataSummary = Pick<
  HealthResponse,
  'profileCompleteness' | 'documentCounts' | 'approvedAnswerCount'
>;

/**
 * Summary of what the user has saved. A corrupt profile is reported as absent
 * completeness rather than taking the whole health check down — the popup still
 * needs to say the server is up.
 */
function buildStoredDataSummary(ctx: ServerContext): StoredDataSummary {
  let profileCompleteness: StoredDataSummary['profileCompleteness'];
  try {
    const profile = ctx.profiles.find();
    if (profile) profileCompleteness = computeProfileCompleteness(profile);
  } catch (cause) {
    ctx.logger.warn('could not compute profile completeness for /health', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  return {
    ...(profileCompleteness ? { profileCompleteness } : {}),
    documentCounts: ctx.documents.counts(),
    approvedAnswerCount: ctx.answers.count(),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerHealthRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  app.get('/health', async (request, reply) => {
    const ollama = await ctx.ollama.checkStatus();

    let databaseState: HealthResponse['database'];
    let profileLoaded = false;
    try {
      profileLoaded = ctx.db.profileExists();
      databaseState = {
        state: 'ready',
        path: ctx.db.path,
        schemaVersion: ctx.db.schemaVersion,
      };
    } catch (cause) {
      databaseState = {
        state: 'error',
        path: ctx.db.path,
        schemaVersion: ctx.db.schemaVersion,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }

    const payload: HealthResponse = {
      status: ollama.state === 'connected' && databaseState.state === 'ready' ? 'ok' : 'degraded',
      service: 'internship-application-agent',
      version: SERVER_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      ollama,
      database: databaseState,
      profileLoaded,
      authenticated: request.isAuthenticated,
      ...(request.isAuthenticated && databaseState.state === 'ready'
        ? buildStoredDataSummary(ctx)
        : {}),
    };

    return sendValidated(reply, healthResponseSchema, payload);
  });

  app.get('/version', (_request, reply) =>
    sendValidated(reply, versionResponseSchema, {
      name: 'internship-application-agent' as const,
      version: SERVER_VERSION,
      milestone: CURRENT_MILESTONE,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt: ctx.startedAt,
    }),
  );

  app.get('/models', async (_request, reply) => {
    try {
      const models = await ctx.ollama.listModels();
      return sendValidated(reply, modelsResponseSchema, models);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const timedOut = message.includes('did not respond within');
      return fail(reply, {
        code: timedOut ? 'OLLAMA_TIMEOUT' : 'OLLAMA_UNAVAILABLE',
        message: `Could not list models from Ollama at ${ctx.ollama.baseUrl}: ${message}`,
        debugContext: { baseUrl: ctx.ollama.baseUrl },
      });
    }
  });
}
