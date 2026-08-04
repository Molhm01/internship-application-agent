import {
  applicationScanResultSchema,
  profileSchema,
  type ApplicationScanResult,
  type Profile,
} from '@internship-agent/shared';

const NOW = '2026-07-31T12:00:00.000Z';

/**
 * A filled-in but ordinary profile. It deliberately carries no sensitive
 * policies: tests that expect a sensitive question to be left alone must be
 * exercising the rule, not a gap in the fixture.
 */
export function profileFixture(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    updatedAt: NOW,
    personal: {
      legalFirstName: 'Jordan',
      preferredName: 'Jo',
      legalLastName: 'Ellis',
      email: 'jordan.ellis@example.com',
      phone: '+1 201 555 0134',
      linkedin: 'https://www.linkedin.com/in/jordanellis',
      github: 'https://github.com/jordanellis',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
    education: [
      {
        id: 'education-1',
        institution: 'Rutgers University',
        degree: "Bachelor's Degree",
        major: 'Computer Science',
        minor: 'Mathematics',
        gpa: 3.7,
        graduationDate: '2027-05',
        status: 'in_progress',
      },
      {
        id: 'education-2',
        institution: 'Clifton High School',
        degree: 'High School',
        status: 'completed',
      },
    ],
    // The awarded credential and the one being studied for, stated rather than
    // derived, so a test asserting the distinction is testing the mapping and
    // not the derivation.
    highestCompletedDegree: 'High School',
    currentDegreeInProgress: "Bachelor's Degree",
    experience: [
      {
        id: 'experience-1',
        employer: 'Northwind Robotics',
        title: 'Engineering Intern',
        // Deliberately not the applicant's own city: a test that used the same
        // place could not tell the two mappings apart.
        location: 'Newark, New Jersey',
        startDate: '2026-06',
        endDate: '2026-08',
        current: false,
        responsibilities: ['Built test rigs for actuator assemblies.'],
        achievements: [],
      },
    ],
    eligibility: {
      workAuthorization: 'U.S. Citizen',
      willingToRelocate: true,
      hasDriversLicense: true,
      meetsMinimumAge: true,
      earliestStartDate: '2027-06-01',
    },
    preferences: { discoverySource: 'LinkedIn' },
    ...overrides,
  });
}

export function emptyApplicationScan(url: string): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: `scan-empty-${new URL(url).hostname}`,
    createdAt: NOW,
    url,
    domain: new URL(url).hostname,
    ats: {
      id: 'generic',
      displayName: 'Generic HTML form',
      confidence: 0,
      detectionReason: 'No supported fields found.',
      supported: true,
    },
    jobContext: { sourceUrl: url },
    fields: [],
    warnings: [],
    statistics: {
      total: 0,
      supported: 0,
      unknown: 0,
      required: 0,
      optional: 0,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 1,
    status: 'completed',
    readOnly: true,
  });
}
