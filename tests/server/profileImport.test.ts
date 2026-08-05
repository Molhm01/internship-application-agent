import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_PROFILE_VERSION, profileSchema } from '@internship-agent/shared';
import { authHeaders, createTestServer, type TestServer } from './helpers.js';

/**
 * `POST /profile/import`, the route that ends the profile split.
 *
 * The agent server and Internship Pilot each held a profile and nothing had
 * ever copied one into the other, so the settings page kept asking for work
 * history the user had already entered on the website. This route merges them,
 * and every test here is about the one property that makes it safe to run
 * unattended: it can add, and it cannot destroy.
 */

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const WEBSITE_PROFILE = profileSchema.parse({
  version: CURRENT_PROFILE_VERSION,
  updatedAt: '2026-08-01T09:00:00.000Z',
  personal: {
    legalFirstName: 'Jordan',
    legalLastName: 'Rivera',
    email: 'jordan@example.com',
    phoneCountryCode: '+1',
  },
  education: [{ id: 'edu-1', institution: 'Northeastern University', degree: 'BS' }],
  experience: [{ id: 'exp-1', employer: 'Northwind Robotics', title: 'Intern' }],
  projects: [{ id: 'prj-1', name: 'Rover telemetry' }],
  skills: { technical: ['C++'] },
  eligibility: { workAuthorization: 'U.S. Citizen' },
});

function importFrom(profile: unknown, label = 'internship_pilot') {
  return server!.app.inject({
    method: 'POST',
    url: '/profile/import',
    headers: authHeaders,
    payload: { sources: [{ label, profile }] },
  });
}

function readProfile() {
  return server!.app.inject({ method: 'GET', url: '/profile', headers: authHeaders });
}

describe('POST /profile/import', () => {
  it('creates the profile when none exists yet', async () => {
    server = await createTestServer();

    const response = await importFrom(WEBSITE_PROFILE);
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.changed).toBe(true);
    expect(body.profile.experience).toHaveLength(1);
    expect(body.profile.education).toHaveLength(1);
    expect(body.profile.projects).toHaveLength(1);

    // Persisted, not merely returned: this is the copy the settings page reads.
    const stored = readProfileBody(await readProfile());
    expect(stored.experience[0]?.employer).toBe('Northwind Robotics');
  });

  it('imports the sections the stored profile never had, keeping the ones it did', async () => {
    server = await createTestServer();
    await server.app.inject({
      method: 'PUT',
      url: '/profile',
      headers: authHeaders,
      payload: {
        personal: {
          legalFirstName: 'Jordan',
          legalLastName: 'Rivera',
          email: 'typed-by-hand@example.com',
          phone: '+1-555-0100',
          address: { city: 'Boston' },
        },
      },
    });

    const response = await importFrom(WEBSITE_PROFILE);
    expect(response.statusCode).toBe(200);
    const merged = response.json().data.profile;

    expect(merged.experience).toHaveLength(1);
    expect(merged.projects).toHaveLength(1);
    expect(merged.personal.phoneCountryCode).toBe('+1');
    // The locally typed values survive: the stored profile was saved after the
    // website's, so its explicit answers win.
    expect(merged.personal.email).toBe('typed-by-hand@example.com');
    expect(merged.personal.phone).toBe('+1-555-0100');
    expect(merged.personal.address.city).toBe('Boston');
  });

  it('never blanks a stored value from an emptier source', async () => {
    server = await createTestServer();
    await importFrom(WEBSITE_PROFILE);

    const emptier = profileSchema.parse({
      version: CURRENT_PROFILE_VERSION,
      // Newer than everything, and almost empty. Recency must not license loss.
      updatedAt: '2026-12-31T09:00:00.000Z',
      personal: { legalFirstName: 'Jordan' },
    });
    const response = await importFrom(emptier);

    const merged = response.json().data.profile;
    expect(merged.personal.legalLastName).toBe('Rivera');
    expect(merged.experience).toHaveLength(1);
    expect(merged.eligibility.workAuthorization).toBe('U.S. Citizen');
  });

  it('creates no duplicate entries when run twice', async () => {
    server = await createTestServer();
    const first = await importFrom(WEBSITE_PROFILE);
    const second = await importFrom(WEBSITE_PROFILE);

    expect(first.json().data.changed).toBe(true);
    expect(second.json().data.changed).toBe(false);

    const stored = readProfileBody(await readProfile());
    expect(stored.experience).toHaveLength(1);
    expect(stored.education).toHaveLength(1);
    expect(stored.projects).toHaveLength(1);
  });

  it('reports key-level status and never a profile value', async () => {
    server = await createTestServer();
    const report = (await importFrom(WEBSITE_PROFILE)).json().data.report as Array<{
      key: string;
      status: string;
    }>;

    const byKey = new Map(report.map((entry) => [entry.key, entry.status]));
    expect(byKey.get('nameContact.legalFirstName')).toBe('imported');
    expect(byKey.get('experience[0].employer')).toBe('imported');
    expect(byKey.get('nameContact.addressLine1')).toBe('missing');

    const serialized = JSON.stringify(report);
    for (const value of ['Jordan', 'Rivera', 'jordan@example.com', 'Northwind', 'Rover']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('migrates a stored profile from an older contract version', async () => {
    server = await createTestServer();
    await importFrom(WEBSITE_PROFILE);
    // A v1 record, as a build predating the current contract would have left it.
    server.db.handle
      .prepare('UPDATE profile SET data = ? WHERE id = ?')
      .run(
        JSON.stringify({
          version: 1,
          id: 'primary',
          personal: { legalFirstName: 'Jordan', address: {} },
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        'primary',
      );

    const response = await importFrom(WEBSITE_PROFILE);
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.migratedFrom).toBe(1);
    expect(body.profile.version).toBe(CURRENT_PROFILE_VERSION);
    expect(body.profile.experience).toHaveLength(1);
  });

  it('rejects a body that is not a set of profiles', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/profile/import',
      headers: authHeaders,
      payload: { sources: [] },
    });
    expect(response.statusCode).toBe(422);
  });
});

function readProfileBody(response: { json: () => { data: { profile: Record<string, never> } } }) {
  return response.json().data.profile as unknown as {
    experience: Array<{ employer: string }>;
    education: unknown[];
    projects: unknown[];
  };
}
