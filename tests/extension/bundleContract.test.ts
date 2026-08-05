import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_BUNDLE_VERSION,
  applicationBundleTransferSchema,
  bundleVersionProblem,
  companyRelationshipSchema,
  profileSchema,
  CURRENT_PROFILE_VERSION,
} from '@internship-agent/shared';

/**
 * The contract between Internship Pilot and this extension.
 *
 * These tests exist because the two halves live in separate repositories and
 * nothing else forces them to agree. Every field asserted here is one the
 * website's `buildProfileSnapshot` emits; if the website adds a field and this
 * schema does not learn it, the field arrives, is stripped by Zod, and becomes
 * an unanswered question that looks exactly like a blank profile.
 *
 * The shape below is a literal transcription of what
 * `Internship-AI/src/lib/applications/profileSnapshot.ts` produces at v2.
 */

const WEBSITE_SNAPSHOT_V2 = {
  version: 2,
  id: 'primary',
  personal: {
    legalFirstName: 'Jordan',
    legalMiddleName: 'Avery',
    noMiddleName: undefined,
    legalLastName: 'Ellis',
    suffix: 'Jr.',
    preferredName: 'Jo',
    pronouns: 'they/them',
    email: 'jordan.applies@example.com',
    alternateEmail: 'jordan@personal.example.com',
    phone: '+1 201 555 0134',
    phoneCountryCode: '+1',
    address: {
      line1: '48 Maple Avenue',
      line2: 'Apt 3B',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      country: 'United States',
      metroRegion: 'New York City Metro Area',
    },
    linkedin: 'https://www.linkedin.com/in/jordanellis',
    github: 'https://github.com/jordanellis',
    portfolio: 'https://jordanellis.dev',
    personalWebsite: 'https://jordan.example.com',
    preferredWebsiteField: 'github',
  },
  education: [
    {
      id: 'education-primary',
      institution: 'Rutgers University',
      degree: "Bachelor's Degree",
      major: 'Computer Science',
      minor: 'Mathematics',
      startDate: '2024-09',
      graduationDate: '2027-05',
      gpa: 3.7,
      gpaScale: 4,
      coursework: ['Data Structures'],
      honors: [],
      activities: [],
    },
  ],
  experience: [
    {
      id: 'x1',
      employer: 'Lockheed Martin',
      title: 'Engineering Intern',
      location: 'Moorestown, NJ',
      startDate: '2026-06',
      endDate: '2026-08',
      current: false,
      responsibilities: ['Wrote test fixtures'],
      achievements: ['Cut regression time by half'],
    },
  ],
  projects: [
    {
      id: 'p1',
      name: 'Rover telemetry',
      description: 'Built in C++',
      technologies: ['C++'],
      accomplishments: ['Embedded systems'],
    },
  ],
  skills: { technical: ['C++'], programmingLanguages: [] },
  eligibility: {
    workAuthorization: 'U.S. Citizen',
    requiresSponsorshipNow: false,
    requiresFutureSponsorship: false,
    securityClearanceStatus: 'Not currently cleared',
    willingToRelocate: true,
    hasDriversLicense: true,
    meetsMinimumAge: true,
    earliestStartDate: '2027-06-01',
    internshipAvailability: 'Summer 2027',
  },
  preferences: {
    targetRoles: [],
    industries: [],
    preferredLocations: ['Newark, NJ'],
    discoverySource: 'LinkedIn',
    remotePreference: 'hybrid',
    salaryPreference: 'Negotiable',
    salaryStrategy: 'negotiable',
    salaryMinimum: '25',
    marketingTextConsent: true,
    resumeSelectionRules: [],
  },
  sensitivePolicies: [{ category: 'gender', policy: 'decline_to_answer' }],
  updatedAt: '2026-08-02T09:00:00.000Z',
};

describe('the profile snapshot the website sends', () => {
  it('parses, and keeps every field rather than stripping one', () => {
    const parsed = profileSchema.parse(WEBSITE_SNAPSHOT_V2);

    expect(parsed.version).toBe(CURRENT_PROFILE_VERSION);
    expect(parsed.personal.suffix).toBe('Jr.');
    expect(parsed.personal.phoneCountryCode).toBe('+1');
    expect(parsed.personal.preferredWebsiteField).toBe('github');
    expect(parsed.personal.address.line2).toBe('Apt 3B');
    expect(parsed.personal.address.metroRegion).toBe('New York City Metro Area');
    expect(parsed.eligibility.requiresSponsorshipNow).toBe(false);
    expect(parsed.eligibility.securityClearanceStatus).toBe('Not currently cleared');
    expect(parsed.preferences.salaryStrategy).toBe('negotiable');
    expect(parsed.preferences.salaryMinimum).toBe('25');
    expect(parsed.preferences.marketingTextConsent).toBe(true);
    expect(parsed.experience[0]?.title).toBe('Engineering Intern');
    expect(parsed.projects[0]?.technologies).toEqual(['C++']);
  });

  it('defaults an unversioned snapshot to v1 instead of rejecting it', () => {
    const { version: _version, ...unversioned } = WEBSITE_SNAPSHOT_V2;
    expect(profileSchema.parse(unversioned).version).toBe(1);
  });

  it('leaves an absent address line 2 absent rather than defaulting it', () => {
    const parsed = profileSchema.parse({
      ...WEBSITE_SNAPSHOT_V2,
      personal: { ...WEBSITE_SNAPSHOT_V2.personal, address: { line1: '48 Maple Avenue' } },
    });
    expect(parsed.personal.address.line2).toBeUndefined();
    expect(parsed.personal.address.line2).not.toBe(parsed.personal.address.line1);
  });

  it('refuses a marketing consent expressed as false, so absence is the only "not consented"', () => {
    const parsed = profileSchema.safeParse({
      ...WEBSITE_SNAPSHOT_V2,
      preferences: { ...WEBSITE_SNAPSHOT_V2.preferences, marketingTextConsent: false },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a "no middle name" expressed as false for the same reason', () => {
    const parsed = profileSchema.safeParse({
      ...WEBSITE_SNAPSHOT_V2,
      personal: { ...WEBSITE_SNAPSHOT_V2.personal, noMiddleName: false },
    });
    expect(parsed.success).toBe(false);
  });

  it('carries no password-shaped key or value', () => {
    const serialized = JSON.stringify(profileSchema.parse(WEBSITE_SNAPSHOT_V2));
    expect(serialized).not.toMatch(/password|passwd|secret|token|credential/i);
  });
});

describe('company relationship facts', () => {
  it('accepts a row where every fact is unknown', () => {
    const parsed = companyRelationshipSchema.parse({
      companyKey: 'acme corp',
      companyName: 'Acme Corp',
    });
    expect(parsed.previouslyEmployed).toBeUndefined();
    expect(parsed.hasReferral).toBeUndefined();
  });

  it('keeps an explicit No distinct from an unknown', () => {
    const parsed = companyRelationshipSchema.parse({
      companyKey: 'acme corp',
      companyName: 'Acme Corp',
      previouslyEmployed: false,
    });
    expect(parsed.previouslyEmployed).toBe(false);
    expect(parsed.previouslyInterviewed).toBeUndefined();
  });
});

describe('bundle versioning', () => {
  const transfer = {
    bundleVersion: CURRENT_BUNDLE_VERSION,
    websiteJobId: 'job-1',
    company: 'Acme Corp',
    jobTitle: 'Engineering Intern',
    jobDescription: 'Build things.',
    officialApplicationUrl: 'https://careers.acme.example.com/apply/1',
    documents: [
      {
        kind: 'resume' as const,
        filename: 'Resume.pdf',
        mimeType: 'application/pdf' as const,
        contentBase64: 'AAAA',
        byteLength: 3,
        generatedAt: '2026-08-02T09:00:00.000Z',
      },
    ],
    createdAt: '2026-08-02T09:00:00.000Z',
  };

  it('accepts the current version', () => {
    const parsed = applicationBundleTransferSchema.parse(transfer);
    expect(bundleVersionProblem(parsed)).toBeNull();
  });

  it('treats a bundle with no version as v1 rather than rejecting it', () => {
    const { bundleVersion: _version, ...unversioned } = transfer;
    const parsed = applicationBundleTransferSchema.parse(unversioned);
    expect(parsed.bundleVersion).toBe(1);
    expect(bundleVersionProblem(parsed)).toBeNull();
  });

  it('refuses a bundle from a newer website and says to update the extension', () => {
    const problem = bundleVersionProblem({ bundleVersion: CURRENT_BUNDLE_VERSION + 1 });
    expect(problem).toMatch(/update the extension/i);
    expect(problem).toContain(`v${CURRENT_BUNDLE_VERSION + 1}`);
  });

  it('carries company relationship facts through the transfer schema', () => {
    const parsed = applicationBundleTransferSchema.parse({
      ...transfer,
      companyRelationship: {
        companyKey: 'acme corp',
        companyName: 'Acme Corp',
        hasReferral: true,
        referralName: 'Dana Reed',
      },
    });
    expect(parsed.companyRelationship?.referralName).toBe('Dana Reed');
  });

  it('carries the portal strategy but has nowhere to put a password', () => {
    const parsed = applicationBundleTransferSchema.parse({
      ...transfer,
      accountPreferences: {
        applicationEmail: 'jordan.applies@example.com',
        preferredUsername: 'jordanellis',
        wantsAccountCreationHelp: true,
        portalStrategy: 'create_when_required',
        // Deliberately smuggled in; Zod strips unknown keys and it must not survive.
        password: 'hunter2',
      },
    });
    expect(parsed.accountPreferences?.portalStrategy).toBe('create_when_required');
    expect(JSON.stringify(parsed.accountPreferences)).not.toContain('hunter2');
  });
});

/**
 * The other half of the contract: is the transcription above still current?
 *
 * Everything before this asserts that *this* repository reads a v2 snapshot
 * correctly. None of it can notice the website moving to v3 — the two live in
 * separate repositories, and the first sign would be a real applicant getting a
 * silently stripped profile that looks exactly like an empty one.
 *
 * So when the sibling checkout is present, its declared version is read off
 * disk and compared. Skipped rather than failed when it is absent, because a
 * standalone clone of this repository is a legitimate way to work on it and
 * must not have a red suite for a directory it was never given.
 */
describe('the website and this extension agree on the bundle version', () => {
  const WEBSITE_SNAPSHOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'Internship-AI',
    'src',
    'lib',
    'applications',
    'profileSnapshot.ts',
  );

  it.skipIf(!existsSync(WEBSITE_SNAPSHOT))('reads the same version the website declares', () => {
    const source = readFileSync(WEBSITE_SNAPSHOT, 'utf8');
    const declared = /PROFILE_SNAPSHOT_VERSION\s*=\s*(\d+)/.exec(source)?.[1];
    expect(declared, 'the website no longer declares PROFILE_SNAPSHOT_VERSION').toBeDefined();
    expect(
      Number(declared),
      `Internship-AI emits snapshot v${declared} but this extension reads up to v${CURRENT_BUNDLE_VERSION}. ` +
        'Teach the schema the new shape and update WEBSITE_SNAPSHOT_V2 above before bumping.',
    ).toBe(CURRENT_BUNDLE_VERSION);
  });
});
