import type { FastifyInstance } from 'fastify';
import { fail } from './responses.js';

interface PlannedRoute {
  method: 'GET' | 'PUT' | 'POST';
  url: string;
  milestone: string;
}

/**
 * These endpoints are part of the documented API surface but have no
 * implementation yet. They are registered so callers get a precise, honest
 * answer — a 501 naming the milestone — instead of a 404 that looks like a
 * misconfigured server, and so no stub can ever fake a success response.
 */
const PLANNED_ROUTES: readonly PlannedRoute[] = [
  { method: 'POST', url: '/applications/plan', milestone: 'Milestone 4 — Ollama planning' },
  {
    method: 'POST',
    url: '/applications/report',
    milestone: 'Milestone 3 — deterministic autofill',
  },
  { method: 'GET', url: '/applications/:id', milestone: 'Milestone 3 — deterministic autofill' },
];

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerPlannedRoutes(app: FastifyInstance): Promise<void> {
  for (const route of PLANNED_ROUTES) {
    app.route({
      method: route.method,
      url: route.url,
      handler: (_request, reply) =>
        fail(reply, {
          code: 'NOT_IMPLEMENTED',
          message: `${route.method} ${route.url} is not implemented yet. It is scheduled for ${route.milestone}.`,
          recoverable: false,
          suggestedAction: `Wait for ${route.milestone}. This build provides /health, /version, /models, /profile, /documents, and /answers.`,
          debugContext: { milestone: route.milestone },
        }),
    });
  }
}

export const PLANNED_ROUTE_LIST = PLANNED_ROUTES;
