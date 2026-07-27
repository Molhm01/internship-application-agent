import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_HEADER, errorResponseSchema } from '@internship-agent/shared';
import { createRateLimiter } from '../../agent-server/src/security/rateLimit.js';
import { isOriginAllowed } from '../../agent-server/src/security/origin.js';
import { tokenMatches } from '../../agent-server/src/security/token.js';
import { isSensitiveKey, redact } from '../../agent-server/src/logging/redact.js';
import { TEST_TOKEN, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('authentication', () => {
  it('rejects protected routes without a token', async () => {
    server = await createTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/profile' });

    expect(response.statusCode).toBe(401);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('UNAUTHORIZED');
    expect(error.error.suggestedAction).toContain('token');
  });

  it('rejects a wrong token of the same length', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: { [AUTH_HEADER]: 'x'.repeat(TEST_TOKEN.length) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not leak route existence to unauthenticated callers', async () => {
    server = await createTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/no-such-route' });
    expect(response.statusCode).toBe(401);
  });

  it('compares tokens without short-circuiting on length alone', () => {
    expect(tokenMatches('abcdef', 'abcdef')).toBe(true);
    expect(tokenMatches('abcdef', 'abcdeg')).toBe(false);
    expect(tokenMatches('abcdef', 'abcde')).toBe(false);
    expect(tokenMatches('abcdef', undefined)).toBe(false);
  });
});

describe('origin validation', () => {
  it('allows extension and loopback origins, rejects the open web', async () => {
    server = await createTestServer();

    const extension = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    expect(extension.statusCode).toBe(200);

    const hostile = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(hostile.statusCode).toBe(403);
    expect(errorResponseSchema.parse(hostile.json()).error.code).toBe('ORIGIN_REJECTED');
  });

  it('applies the policy consistently at the unit level', () => {
    const strict = { allowLocalOrigins: false };
    const relaxed = { allowLocalOrigins: true };

    expect(isOriginAllowed(undefined, strict)).toBe(true);
    expect(isOriginAllowed('chrome-extension://abc', strict)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', strict)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:5173', relaxed)).toBe(true);
    expect(isOriginAllowed('https://greenhouse.io', relaxed)).toBe(false);
    // A hostname that merely contains a permitted one must not pass.
    expect(isOriginAllowed('https://127.0.0.1.evil.com', relaxed)).toBe(false);
  });
});

describe('rate limiting', () => {
  it('returns 429 with a retry hint once the window is exhausted', async () => {
    server = await createTestServer({
      rateLimiter: createRateLimiter({ max: 2, windowMs: 60_000 }),
    });

    expect((await server.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    const limited = await server.app.inject({ method: 'GET', url: '/health' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(errorResponseSchema.parse(limited.json()).error.code).toBe('RATE_LIMITED');
  });

  it('starts a fresh window after the interval elapses', () => {
    let clock = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => clock });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    clock += 1_001;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('tracks clients independently', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });
});

describe('log redaction', () => {
  it('removes sensitive values while keeping diagnostic structure', () => {
    const record = redact({
      url: '/applications/plan',
      token: 'super-secret',
      profile: { email: 'someone@example.com' },
      action: { fieldId: 'field-1', value: 'my home address', status: 'filled' },
    }) as Record<string, unknown>;

    expect(record['url']).toBe('/applications/plan');
    expect(record['token']).toBe('[redacted]');
    expect(record['profile']).toBe('[redacted]');
    const action = record['action'] as Record<string, unknown>;
    expect(action['fieldId']).toBe('field-1');
    expect(action['status']).toBe('filled');
    expect(action['value']).toBe('[redacted]');
  });

  it('survives circular references and truncates long strings', () => {
    const cyclic: Record<string, unknown> = { name: 'run' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();

    const long = redact({ note: 'x'.repeat(5000) }) as Record<string, string>;
    expect(long['note']?.endsWith('[truncated]')).toBe(true);
  });

  it('matches sensitive keys case-insensitively', () => {
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('attemptedValue')).toBe(true);
    expect(isSensitiveKey('fieldId')).toBe(false);
  });
});
