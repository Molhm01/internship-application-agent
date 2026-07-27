import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProfileCompleteness,
  errorResponseSchema,
  healthResponseSchema,
  profileSchema,
} from '@internship-agent/shared';
import { authHeaders, completeProfileBody, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function put(body: Record<string, unknown>) {
  return server!.app.inject({
    method: 'PUT',
    url: '/profile',
    headers: authHeaders,
    payload: body,
  });
}

describe('GET /profile', () => {
  it('reports PROFILE_MISSING rather than inventing an empty profile', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(404);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('PROFILE_MISSING');
    expect(error.error.recoverable).toBe(true);
    expect(error.error.suggestedAction).toContain('settings');
  });

  it('requires a token', async () => {
    server = await createTestServer();
    const response = await server.app.inject({ method: 'GET', url: '/profile' });
    expect(response.statusCode).toBe(401);
  });
});

describe('PUT /profile validation', () => {
  it('rejects a malformed email and names the offending field', async () => {
    server = await createTestServer();
    const response = await put({ personal: { email: 'not-an-email' } });

    expect(response.statusCode).toBe(422);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('VALIDATION_FAILED');
    expect(error.error.message).toContain('personal.email');
    expect(error.error.debugContext['fields']).toEqual(['personal.email']);
  });

  it('does not echo the rejected value back in the error', async () => {
    server = await createTestServer();
    // Invalid (no @), and distinctive enough to spot if it leaks.
    const response = await put({ personal: { email: 'secret-leak-canary-value' } });

    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain('secret-leak-canary-value');
    expect(response.body).toContain('personal.email');
  });

  it('rejects a malformed graduation date', async () => {
    server = await createTestServer();
    const response = await put({
      education: [{ id: 'e1', institution: 'Somewhere', graduationDate: 'May 2027' }],
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.message).toContain('graduationDate');
  });

  it('rejects a link that is not a URL', async () => {
    server = await createTestServer();
    expect((await put({ personal: { linkedin: 'linkedin' } })).statusCode).toBe(422);
  });

  it('rejects an unknown sensitive category', async () => {
    server = await createTestServer();
    const response = await put({
      sensitivePolicies: [{ category: 'astrology', policy: 'review_required' }],
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects a travel percentage outside 0..100', async () => {
    server = await createTestServer();
    expect((await put({ eligibility: { willingToTravelPercent: 150 } })).statusCode).toBe(422);
  });
});

describe('PUT /profile persistence', () => {
  it('saves and returns the profile with a server-owned timestamp', async () => {
    server = await createTestServer();
    const response = await put(completeProfileBody());
    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: { profile: unknown; completeness: unknown } }>();
    const profile = profileSchema.parse(body.data.profile);
    expect(profile.id).toBe('primary');
    expect(profile.personal.legalFirstName).toBe('Jordan');
    expect(new Date(profile.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('round-trips through the database on a subsequent read', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    const read = await server.app.inject({ method: 'GET', url: '/profile', headers: authHeaders });
    expect(read.statusCode).toBe(200);

    const profile = profileSchema.parse(read.json<{ data: { profile: unknown } }>().data.profile);
    expect(profile.education[0]?.institution).toBe('Northeastern University');
    expect(profile.eligibility.requiresFutureSponsorship).toBe(false);
    expect(profile.preferences.targetRoles).toEqual(['Embedded Software Intern']);
  });

  it('never fabricates values for fields the user left out', async () => {
    server = await createTestServer();
    await put({ personal: { legalFirstName: 'Jordan' } });

    const profile = profileSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/profile', headers: authHeaders })).json<{
        data: { profile: unknown };
      }>().data.profile,
    );

    expect(profile.personal.legalLastName).toBeUndefined();
    expect(profile.personal.email).toBeUndefined();
    expect(profile.eligibility.workAuthorization).toBeUndefined();
    // A missing boolean stays missing rather than defaulting to false, which
    // would be an answer the user never gave.
    expect(profile.eligibility.requiresFutureSponsorship).toBeUndefined();
    expect(profile.education).toEqual([]);
  });

  it('updates an existing profile in place instead of creating a second one', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    const updated = completeProfileBody();
    (updated['personal'] as Record<string, unknown>)['preferredName'] = 'Jo';
    const response = await put(updated);

    const profile = profileSchema.parse(
      response.json<{ data: { profile: unknown } }>().data.profile,
    );
    expect(profile.personal.preferredName).toBe('Jo');

    // Exactly one row, so repeated saves update rather than accumulate.
    const count = server.db.handle.prepare('SELECT COUNT(*) AS count FROM profile').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it('drops a removed education entry rather than merging it back', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    const withoutEducation = { ...completeProfileBody(), education: [] };
    await put(withoutEducation);

    const profile = profileSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/profile', headers: authHeaders })).json<{
        data: { profile: unknown };
      }>().data.profile,
    );
    expect(profile.education).toEqual([]);
  });
});

describe('profile completeness', () => {
  it('reports 100% for a profile with every required section', async () => {
    server = await createTestServer();
    const response = await put(completeProfileBody());

    const completeness = response.json<{ data: { completeness: { percent: number } } }>().data
      .completeness;
    expect(completeness.percent).toBe(100);
  });

  it('names exactly what is missing and never guesses a value', () => {
    const blank = profileSchema.parse({ updatedAt: '2026-07-26T12:00:00.000Z' });
    const completeness = computeProfileCompleteness(blank);

    expect(completeness.percent).toBe(0);
    expect(completeness.completeSections).toBe(0);

    const identity = completeness.sections.find((section) => section.id === 'identity');
    expect(identity?.missing).toEqual(['Legal first name', 'Legal last name']);

    const links = completeness.sections.find((section) => section.id === 'links');
    expect(links?.missing).toEqual(['At least one professional link']);
  });

  it('treats optional sections as reportable but not scored', () => {
    const blank = profileSchema.parse({ updatedAt: '2026-07-26T12:00:00.000Z' });
    const completeness = computeProfileCompleteness(blank);

    const optional = completeness.sections.filter((section) => !section.required);
    expect(optional.map((section) => section.id)).toContain('projects');
    expect(optional.map((section) => section.id)).toContain('certifications');
    expect(completeness.totalRequiredSections).toBe(
      completeness.sections.filter((section) => section.required).length,
    );
  });

  it('counts a partially filled section as incomplete', async () => {
    server = await createTestServer();
    const body = completeProfileBody();
    // Remove one address line: the section must not count as done.
    delete ((body['personal'] as Record<string, unknown>)['address'] as Record<string, unknown>)[
      'postalCode'
    ];

    const completeness = (await put(body)).json<{
      data: {
        completeness: {
          percent: number;
          sections: Array<{ id: string; complete: boolean; missing: string[] }>;
        };
      };
    }>().data.completeness;

    expect(completeness.percent).toBeLessThan(100);
    const address = completeness.sections.find((section) => section.id === 'address');
    expect(address?.complete).toBe(false);
    expect(address?.missing).toEqual(['Postal code']);
  });
});

describe('/health stored-data summary', () => {
  it('withholds profile detail from an unauthenticated caller', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    const health = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health' })).json<{ data: unknown }>().data,
    );

    expect(health.authenticated).toBe(false);
    expect(health.profileCompleteness).toBeUndefined();
    expect(health.documentCounts).toBeUndefined();
    expect(health.approvedAnswerCount).toBeUndefined();
  });

  it('includes completeness for an authenticated caller', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    const health = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health', headers: authHeaders })).json<{
        data: unknown;
      }>().data,
    );

    expect(health.profileLoaded).toBe(true);
    expect(health.profileCompleteness?.percent).toBe(100);
    expect(health.documentCounts).toEqual({ total: 0, resumes: 0, hasDefaultResume: false });
    expect(health.approvedAnswerCount).toBe(0);
  });

  it('omits completeness when no profile exists', async () => {
    server = await createTestServer();
    const health = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health', headers: authHeaders })).json<{
        data: unknown;
      }>().data,
    );

    expect(health.profileLoaded).toBe(false);
    expect(health.profileCompleteness).toBeUndefined();
  });
});

describe('corrupt stored profile', () => {
  it('reports a specific error instead of serving invalid data', async () => {
    server = await createTestServer();
    await put(completeProfileBody());

    // Simulate a hand-edited record or a schema that has since drifted.
    server.db.handle
      .prepare('UPDATE profile SET data = ? WHERE id = ?')
      .run(JSON.stringify({ personal: { email: 'not-an-email' } }), 'primary');

    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(422);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.code).toBe('VALIDATION_FAILED');
    expect(error.error.message).toContain('stored profile');
    expect(error.error.recoverable).toBe(false);
  });

  it('keeps /health usable when the profile cannot be parsed', async () => {
    server = await createTestServer();
    await put(completeProfileBody());
    server.db.handle
      .prepare('UPDATE profile SET data = ? WHERE id = ?')
      .run('{ not json', 'primary');

    const response = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const health = healthResponseSchema.parse(response.json<{ data: unknown }>().data);
    // The row exists, but completeness cannot be computed — reported as absent
    // rather than as a fabricated zero.
    expect(health.profileLoaded).toBe(true);
    expect(health.profileCompleteness).toBeUndefined();
  });

  it('lets the user overwrite a corrupt profile with a valid one', async () => {
    server = await createTestServer();
    await put(completeProfileBody());
    server.db.handle
      .prepare('UPDATE profile SET data = ? WHERE id = ?')
      .run('{ not json', 'primary');

    const response = await put(completeProfileBody());
    expect(response.statusCode).toBe(200);

    const read = await server.app.inject({ method: 'GET', url: '/profile', headers: authHeaders });
    expect(read.statusCode).toBe(200);
  });
});
