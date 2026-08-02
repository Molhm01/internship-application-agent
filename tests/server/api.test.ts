import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_HEADER,
  errorResponseSchema,
  healthResponseSchema,
  modelsResponseSchema,
  versionResponseSchema,
} from '@internship-agent/shared';
import { LATEST_SCHEMA_VERSION } from '../../agent-server/src/database/migrations.js';
import {
  TEST_TOKEN,
  createTestServer,
  healthyOllamaFetch,
  unreachableOllamaFetch,
  type TestServer,
} from './helpers.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('GET /health', () => {
  it('reports ok and a connected Ollama when the daemon answers', async () => {
    server = await createTestServer({ fetchImpl: healthyOllamaFetch() });

    const response = await server.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ ok: boolean; data: unknown }>();
    expect(body.ok).toBe(true);

    const health = healthResponseSchema.parse(body.data);
    expect(health.status).toBe('ok');
    expect(health.ollama.state).toBe('connected');
    expect(health.ollama.modelCount).toBe(2);
    expect(health.ollama.selectedModelInstalled).toBe(true);
    expect(health.ollama.version).toBe('0.5.4');
    expect(health.database.state).toBe('ready');
    expect(health.database.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(health.profileLoaded).toBe(false);
  });

  it('reports degraded with an actionable error when Ollama is unreachable', async () => {
    server = await createTestServer({ fetchImpl: unreachableOllamaFetch() });

    const response = await server.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const health = healthResponseSchema.parse(response.json<{ data: unknown }>().data);
    expect(health.status).toBe('degraded');
    expect(health.ollama.state).toBe('disconnected');
    expect(health.ollama.error?.code).toBe('OLLAMA_UNAVAILABLE');
    // The whole point of the error contract: never a bare failure string.
    expect(health.ollama.error?.message).toContain('127.0.0.1:11434');
    expect(health.ollama.error?.suggestedAction.length ?? 0).toBeGreaterThan(10);
  });

  it('flags the selected model as missing when it is not installed', async () => {
    server = await createTestServer({ defaultModel: 'mistral-large:123b' });

    const health = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health' })).json<{ data: unknown }>().data,
    );
    expect(health.ollama.selectedModelInstalled).toBe(false);
  });

  it('is reachable without a token but reports authentication state honestly', async () => {
    server = await createTestServer();

    const anonymous = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health' })).json<{ data: unknown }>().data,
    );
    expect(anonymous.authenticated).toBe(false);

    const authenticated = healthResponseSchema.parse(
      (
        await server.app.inject({
          method: 'GET',
          url: '/health',
          headers: { [AUTH_HEADER]: TEST_TOKEN },
        })
      ).json<{ data: unknown }>().data,
    );
    expect(authenticated.authenticated).toBe(true);
  });
});

describe('GET /version', () => {
  it('returns a payload matching the shared schema', async () => {
    server = await createTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);

    const version = versionResponseSchema.parse(response.json<{ data: unknown }>().data);
    expect(version.name).toBe('internship-application-agent');
    expect(version.milestone).toContain('Milestone 6');
  });
});

describe('GET /models', () => {
  it('lists installed models when Ollama answers', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/models',
      headers: { [AUTH_HEADER]: TEST_TOKEN },
    });
    expect(response.statusCode).toBe(200);

    const models = modelsResponseSchema.parse(response.json<{ data: unknown }>().data);
    expect(models.models.map((model) => model.name)).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    expect(models.models[0]?.parameterSize).toBe('8B');
  });

  it('returns 503 with an OLLAMA_UNAVAILABLE code when the daemon is down', async () => {
    server = await createTestServer({ fetchImpl: unreachableOllamaFetch() });
    const response = await server.app.inject({
      method: 'GET',
      url: '/models',
      headers: { [AUTH_HEADER]: TEST_TOKEN },
    });

    expect(response.statusCode).toBe(503);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('OLLAMA_UNAVAILABLE');
    expect(error.error.suggestedAction).toContain('ollama serve');
  });
});

describe('routes reserved for later milestones', () => {
  it('answers 501 naming the milestone rather than pretending to succeed', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/applications/plan',
      headers: { [AUTH_HEADER]: TEST_TOKEN },
      payload: {},
    });

    expect(response.statusCode).toBe(501);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('NOT_IMPLEMENTED');
    expect(error.error.message).toContain('Milestone 4');
    expect(error.error.recoverable).toBe(false);
  });

  it.each([
    ['POST', '/applications/plan'],
    ['POST', '/applications/report'],
    ['GET', '/applications/run-123'],
  ] as const)('registers %s %s', async (method, url) => {
    server = await createTestServer();
    const response = await server.app.inject({
      method,
      url,
      headers: { [AUTH_HEADER]: TEST_TOKEN },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    expect(response.statusCode).toBe(501);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404 for an authenticated caller', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { [AUTH_HEADER]: TEST_TOKEN },
    });

    expect(response.statusCode).toBe(404);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('NOT_FOUND');
    expect(error.error.suggestedAction).toContain('docs/API.md');
  });
});
