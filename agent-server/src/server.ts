import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { AUTH_HEADER, LIMITS } from '@internship-agent/shared';
import { registerHealthRoutes } from './api/health.js';
import { registerProfileRoutes } from './api/profile.js';
import { registerDocumentRoutes } from './api/documents.js';
import { registerAnswerRoutes } from './api/answers.js';
import { registerPlannedRoutes } from './api/planned.js';
import { registerAiRoutes } from './api/ai.js';
import { fail } from './api/responses.js';
import type { ServerContext } from './types/context.js';
import { isOriginAllowed } from './security/origin.js';
import { createRateLimiter, type RateLimiter } from './security/rateLimit.js';
import { tokenMatches } from './security/token.js';

export interface BuildServerOptions {
  context: ServerContext;
  allowLocalOrigins: boolean;
  rateLimiter?: RateLimiter;
}

/** Routes reachable without a token, because the popup needs them to report state. */
const PUBLIC_ROUTES = new Set(['/health', '/version']);

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { context } = options;
  const limiter =
    options.rateLimiter ??
    createRateLimiter({ max: LIMITS.rateLimitMax, windowMs: LIMITS.rateLimitWindowMs });

  const app = Fastify({
    logger: false,
    bodyLimit: LIMITS.maxRequestBytes,
    trustProxy: false,
  });

  app.decorateRequest('isAuthenticated', false);

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, { allowLocalOrigins: options.allowLocalOrigins }));
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['content-type', AUTH_HEADER],
    credentials: false,
    maxAge: 600,
  });

  app.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    if (!isOriginAllowed(origin, { allowLocalOrigins: options.allowLocalOrigins })) {
      context.logger.warn('rejected request origin', { origin, url: request.url });
      void fail(reply, {
        code: 'ORIGIN_REJECTED',
        message: `Origin ${String(origin)} is not permitted to call the local agent server.`,
        recoverable: false,
        debugContext: { url: request.url },
      });
      return;
    }

    const decision = limiter.check(request.ip || 'local');
    if (!decision.allowed) {
      void reply.header('retry-after', String(decision.retryAfterSeconds));
      void fail(reply, {
        code: 'RATE_LIMITED',
        message: `Rate limit of ${LIMITS.rateLimitMax} requests per ${
          LIMITS.rateLimitWindowMs / 1000
        }s exceeded.`,
        debugContext: { retryAfterSeconds: decision.retryAfterSeconds },
      });
      return;
    }

    const provided = request.headers[AUTH_HEADER];
    request.isAuthenticated = tokenMatches(
      context.token,
      typeof provided === 'string' ? provided : undefined,
    );

    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
    if (request.method !== 'OPTIONS' && !PUBLIC_ROUTES.has(path) && !request.isAuthenticated) {
      void fail(reply, {
        code: 'UNAUTHORIZED',
        message: `Missing or invalid ${AUTH_HEADER} header.`,
        recoverable: true,
        debugContext: { url: path, tokenProvided: typeof provided === 'string' },
      });
      return;
    }

    done();
  });

  app.setNotFoundHandler((request, reply) =>
    fail(reply, {
      code: 'NOT_FOUND',
      message: `No route matches ${request.method} ${request.url}.`,
      recoverable: false,
      suggestedAction: 'Check docs/API.md for the list of available endpoints.',
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return fail(reply, {
        code: 'VALIDATION_FAILED',
        message: `${request.method} ${request.url} expects a JSON body with content-type: application/json.`,
        recoverable: true,
      });
    }
    if (error.statusCode === 413) {
      return fail(reply, {
        code: 'REQUEST_TOO_LARGE',
        message: `Request body exceeded ${LIMITS.maxRequestBytes} bytes.`,
        recoverable: false,
      });
    }
    context.logger.error('unhandled request error', {
      url: request.url,
      method: request.method,
      error,
    });
    return fail(reply, {
      code: 'INTERNAL_ERROR',
      message: error.message || 'The local agent server hit an unexpected error.',
      recoverable: false,
      debugContext: { url: request.url },
    });
  });

  await registerHealthRoutes(app, context);
  await registerProfileRoutes(app, context);
  await registerDocumentRoutes(app, context);
  await registerAnswerRoutes(app, context);
  await registerPlannedRoutes(app);
  registerAiRoutes(app, context);

  return app;
}
