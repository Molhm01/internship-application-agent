import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROFILE_VERSION,
  migrateProfile,
  mergeProfiles,
  orderSources,
  profileSchema,
  profileVersionProblem,
  type Profile,
} from '@internship-agent/shared';

/**
 * The merge is a recovery operation on real user data, so these tests are
 * written around the one promise that makes it safe to run unattended: nothing
 * a user entered is ever lost, replaced by a blank, or silently duplicated.
 */

const OLD = '2026-07-01T09:00:00.000Z';
const NEW = '2026-08-01T09:00:00.000Z';

function profile(overrides: Record<string, unknown> = {}, updatedAt = OLD): Profile {
  return profileSchema.parse({ version: CURRENT_PROFILE_VERSION, updatedAt, ...overrides });
}

/** The agent server's copy as this machine actually holds it: contact only. */
const agentServerCopy = profile(
  {
    personal: {
      legalFirstName: 'Jordan',
      legalLastName: 'Ellis',
      email: 'jordan@example.com',
      phone: '+19295550142',
      address: {
        line1: '1 Example Street',
        city: 'Clifton',
        state: 'New Jersey',
        country: 'United States',
      },
    },
  },
  NEW,
);

/** Internship Pilot's copy: the sections the settings page kept asking for. */
const websiteCopy = profile(
  {
    personal: { legalFirstName: 'Jordan', legalLastName: 'Ellis', email: 'jordan@example.com' },
    education: [
      { id: 'edu-1', institution: 'Example University', degree: 'BS', major: 'Robotics' },
    ],
    experience: [{ id: 'exp-1', employer: 'Northwind Robotics', title: 'Intern' }],
    projects: [{ id: 'prj-1', name: 'Line Follower', technologies: ['C++'] }],
    skills: { technical: ['ROS', 'SolidWorks'] },
    eligibility: { workAuthorization: 'US Citizen' },
  },
  OLD,
);

describe('profile version contract', () => {
  it('refuses a profile stamped newer than this build rather than stripping it', () => {
    expect(profileVersionProblem(CURRENT_PROFILE_VERSION)).toBeNull();
    expect(profileVersionProblem(CURRENT_PROFILE_VERSION + 1)).toMatch(/reads up to/);
    expect(() => migrateProfile({ version: 99, updatedAt: OLD })).toThrow(/reads up to/);
  });

  it('migrates an older profile without inventing a value', () => {
    const { profile: migrated, migratedFrom } = migrateProfile({
      version: 1,
      updatedAt: OLD,
      personal: { legalFirstName: 'Jordan' },
    });
    expect(migratedFrom).toBe(1);
    expect(migrated.version).toBe(CURRENT_PROFILE_VERSION);
    expect(migrated.personal.legalFirstName).toBe('Jordan');
    expect(migrated.personal.phoneCountryCode).toBeUndefined();
    expect(migrated.experience).toEqual([]);
  });

  it('reports a current profile as not migrated', () => {
    expect(migrateProfile(agentServerCopy).migratedFrom).toBeNull();
  });
});

describe('mergeProfiles', () => {
  it('imports the sections the agent server never had', () => {
    const { profile: merged } = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: websiteCopy },
    ]);

    expect(merged.experience.map((entry) => entry.employer)).toEqual(['Northwind Robotics']);
    expect(merged.projects.map((entry) => entry.name)).toEqual(['Line Follower']);
    expect(merged.education.map((entry) => entry.institution)).toEqual(['Example University']);
    expect(merged.skills.technical).toEqual(['ROS', 'SolidWorks']);
    expect(merged.eligibility.workAuthorization).toBe('US Citizen');
  });

  it('never replaces a populated value with an empty one', () => {
    const emptyButNewer = profile({ personal: {} }, '2026-09-01T09:00:00.000Z');
    const { profile: merged } = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: emptyButNewer },
    ]);

    expect(merged.personal.legalFirstName).toBe('Jordan');
    expect(merged.personal.phone).toBe('+19295550142');
    expect(merged.personal.address.city).toBe('Clifton');
  });

  it('lets the most recently saved explicit value win', () => {
    const newerWebsite = profile(
      { personal: { legalFirstName: 'Jordan', preferredName: 'Jo' } },
      '2026-09-01T09:00:00.000Z',
    );
    const { profile: merged } = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: newerWebsite },
    ]);
    expect(merged.personal.preferredName).toBe('Jo');
  });

  it('orders sources by recency and breaks ties by declared rank', () => {
    const ordered = orderSources([
      { label: 'legacy_extension', profile: profile({}, OLD) },
      { label: 'agent_server', profile: profile({}, OLD) },
      { label: 'internship_pilot', profile: profile({}, NEW) },
    ]);
    expect(ordered.map((source) => source.label)).toEqual([
      'internship_pilot',
      'agent_server',
      'legacy_extension',
    ]);
  });

  it('deduplicates rather than creating a second copy of one entry', () => {
    const sameJobDifferentId = profile({
      experience: [
        { id: 'other-id', employer: 'Northwind Robotics', title: 'Intern', location: 'Newark, NJ' },
      ],
    });
    const { profile: merged } = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: websiteCopy },
      { label: 'legacy_extension', profile: sameJobDifferentId },
    ]);

    expect(merged.experience).toHaveLength(1);
    // The duplicate contributed the field the winner lacked, and nothing else.
    expect(merged.experience[0]?.location).toBe('Newark, NJ');
    expect(merged.experience[0]?.title).toBe('Intern');
  });

  it('is idempotent, so running it on every load changes nothing the second time', () => {
    const first = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: websiteCopy },
    ]);
    const second = mergeProfiles(first.profile, [
      { label: 'internship_pilot', profile: websiteCopy },
    ]);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.profile.experience).toHaveLength(1);
  });

  it('reports key-level status and never a value', () => {
    const { report } = mergeProfiles(agentServerCopy, [
      { label: 'internship_pilot', profile: websiteCopy },
    ]);
    const byKey = new Map(report.map((entry) => [entry.key, entry.status]));

    expect(byKey.get('nameContact.legalFirstName')).toBe('present');
    expect(byKey.get('nameContact.phoneCountryCode')).toBe('missing');
    expect(byKey.get('experience[0].employer')).toBe('imported');
    expect(byKey.get('projects[0].projectName')).toBe('imported');
    expect(byKey.get('eligibility.workAuthorization')).toBe('imported');

    const serialized = JSON.stringify(report);
    for (const secret of ['Jordan', 'Ellis', 'jordan@example.com', '9295550142', 'Clifton']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
