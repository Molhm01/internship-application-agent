import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_HEADER, applicationSessionInputSchema } from '@internship-agent/shared';
import { TEST_TOKEN, authHeaders, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** The exact payload Internship-AI's /api/application-sessions route forwards. */
function websiteHandoffBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: 'Acme Robotics',
    jobTitle: 'Software Engineering Intern',
    url: 'https://boards.greenhouse.io/acme/jobs/12345',
    websiteJobId: 'acme-12345',
    location: 'Boston, MA',
    eligibilityScore: 0.65,
    tailoredResumeDocumentId: 'doc-resume-1',
    tailoredCoverLetterDocumentId: 'doc-cover-1',
    startAutofill: false,
    ...overrides,
  };
}

describe('POST /application-sessions', () => {
  it('accepts the exact website handoff payload under the canonical schema', () => {
    expect(applicationSessionInputSchema.safeParse(websiteHandoffBody()).success).toBe(true);
  });

  it('creates a session and returns 200/201 with an id when the token is valid', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: authHeaders,
      payload: websiteHandoffBody(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ ok: boolean; data: { id: string; sessionId: string } }>();
    expect(body.ok).toBe(true);
    expect(typeof body.data.id).toBe('string');
    expect(body.data.id.length).toBeGreaterThan(0);
    expect(body.data.sessionId).toBe(body.data.id);
  });

  it('sends the request with the correct x-agent-token header', () => {
    expect(AUTH_HEADER).toBe('x-agent-token');
  });

  it('rejects with 401 when no token is provided (missing token)', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      payload: websiteHandoffBody(),
    });

    expect(response.statusCode).toBe(401);
    const body = response.json<{ ok: false; error: { code: string } }>();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects with 401 when the wrong token is provided (stale/mismatched token)', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: { [AUTH_HEADER]: 'x'.repeat(TEST_TOKEN.length) },
      payload: websiteHandoffBody(),
    });

    expect(response.statusCode).toBe(401);
    const body = response.json<{ ok: false; error: { code: string } }>();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('never returns the auth token in the response body', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: authHeaders,
      payload: websiteHandoffBody(),
    });

    const raw = response.body;
    expect(raw).not.toContain(TEST_TOKEN);
  });

  it('derives domain from the canonical application url', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: authHeaders,
      payload: websiteHandoffBody(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ data: { url: string; domain: string } }>();
    expect(body.data.url).toBe('https://boards.greenhouse.io/acme/jobs/12345');
    expect(body.data.domain).toBe('boards.greenhouse.io');
  });

  it('rejects unknown legacy URL fields intentionally', async () => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: authHeaders,
      payload: websiteHandoffBody({
        officialApplyUrl: 'https://boards.greenhouse.io/acme/jobs/12345',
      }),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { debugContext: { fields: string[] } } }>();
    expect(body.error.debugContext.fields).toContain('(root)');
  });

  it.each([-0.01, 1.01, 65, null])(
    'rejects non-canonical eligibilityScore %s',
    async (eligibilityScore) => {
      server = await createTestServer();

      const response = await server.app.inject({
        method: 'POST',
        url: '/application-sessions',
        headers: authHeaders,
        payload: websiteHandoffBody({ eligibilityScore }),
      });

      expect(response.statusCode).toBe(422);
    },
  );

  it.each(['https://jobright.ai/jobs/info/example', 'https://www.intern-list.com/job/example'])(
    'rejects aggregator destination %s',
    async (url) => {
      server = await createTestServer();

      const response = await server.app.inject({
        method: 'POST',
        url: '/application-sessions',
        headers: authHeaders,
        payload: websiteHandoffBody({ url }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).not.toContain(TEST_TOKEN);
    },
  );

  it.each([
    'https://careers.example.com/jobs/123',
    'https://jobs.lever.co/acme/123',
    'https://boards.greenhouse.io/acme/jobs/123',
  ])('accepts direct employer/ATS destination %s', async (url) => {
    server = await createTestServer();

    const response = await server.app.inject({
      method: 'POST',
      url: '/application-sessions',
      headers: authHeaders,
      payload: websiteHandoffBody({ url }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('document contents must stay private');
  });
});
