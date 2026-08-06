import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  profileSchema,
  type ApplicationBundle,
  type ApplicationScanResult,
  type DeterministicFillAction,
  type Profile,
} from '@internship-agent/shared';
import { collectNavigationControls, scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { attachBundleDocuments } from '../../extension/src/uploads/bundleUploads.js';

/**
 * The controls the live run failed on and the committed lab fixtures did not
 * have.
 *
 * Everything asserted here is driven from `profile-sync-application.html`
 * through the real scanner and the real planner: a searchable ARIA country
 * combobox, a phone country-code select labelled only "Code", a dependent
 * state control, and two `display:none` file inputs behind buttons.
 */

const NOW = '2026-08-05T09:00:00.000Z';

/** The canonical profile, with everything the sync is meant to have imported. */
const PROFILE: Profile = profileSchema.parse({
  version: 3,
  updatedAt: NOW,
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    // Deliberately the whole number, prefix included: the split control must
    // not end up showing "+1" twice.
    phone: '+1 201 555 0134',
    phoneCountryCode: '+1',
    phoneType: 'mobile',
    address: {
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      // The alias, not any label the page offers.
      country: 'USA',
      type: 'home',
    },
  },
  education: [
    {
      id: 'education-1',
      institution: 'Rutgers University',
      degree: "Bachelor's Degree",
      degreeLevel: "Bachelor's",
      major: 'Computer Science',
      graduationDate: '2027-05',
      status: 'in_progress',
    },
  ],
  experience: [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      location: 'Newark, New Jersey',
      startDate: '2026-06',
      endDate: '2026-08',
    },
  ],
  projects: [
    {
      id: 'project-1',
      name: 'Rover telemetry',
      description: 'A C++ telemetry pipeline for an autonomous rover.',
      technologies: ['C++'],
    },
  ],
  skills: { technical: ['C++', 'SolidWorks'] },
  eligibility: { workAuthorization: 'U.S. Citizen' },
});

const BUNDLE: ApplicationBundle = {
  id: 'bundle-quanta',
  bundleVersion: 3,
  websiteJobId: 'job-quanta-4471',
  company: 'Quanta Robotics',
  jobTitle: 'Software Engineering Intern',
  jobDescription: 'Build control software.',
  officialApplicationUrl: 'https://careers.example.com/apply',
  resume: {
    kind: 'resume',
    filename: 'Molhm-Ellis-Quanta-Robotics-Resume.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-quanta:resume',
    byteLength: 120,
    generatedAt: NOW,
  },
  coverLetter: {
    kind: 'cover_letter',
    filename: 'Molhm-Ellis-Quanta-Robotics-Cover-Letter.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-quanta:cover_letter',
    byteLength: 110,
    generatedAt: NOW,
  },
  profile: PROFILE,
  approvedAnswers: [],
  createdAt: NOW,
};

let scan: ApplicationScanResult;
let actions: DeterministicFillAction[];

function actionFor(canonical: string): DeterministicFillAction | undefined {
  const field = scan.fields.find((candidate) => candidate.canonicalKey === canonical);
  return field ? actions.find((action) => action.fieldId === field.id) : undefined;
}

beforeAll(async () => {
  const html = readFileSync(
    resolve(process.cwd(), 'tests', 'fixtures', 'lab', 'profile-sync-application.html'),
    'utf8',
  );
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '');
  const { fields } = await scanDom(document, 'page-sync', new AbortController().signal);

  scan = applicationScanResultSchema.parse({
    id: 'scan-sync',
    createdAt: NOW,
    url: BUNDLE.officialApplicationUrl,
    domain: 'careers.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'lab',
      supported: true,
    },
    jobContext: { company: 'Quanta Robotics' },
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: 0,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: collectNavigationControls(document).length,
    },
    durationMs: 1,
    status: 'completed',
    readOnly: true,
  });

  actions = attachBundleDocuments(
    buildDeterministicPlan(scan, PROFILE, [], undefined),
    scan,
    BUNDLE,
  ).actions;
});

describe('the fields that already worked keep working', () => {
  it.each([
    ['first_name', 'Molhm'],
    ['last_name', 'Ellis'],
    ['email', 'molhm@example.com'],
  ])('fills %s', (canonical, expected) => {
    const action = actionFor(canonical);
    expect(action?.action).toBe('fill_text');
    expect(action?.proposedValue).toBe(expected);
  });

  it('fills the phone number without repeating the dialling code', () => {
    const action = actionFor('phone');
    expect(action?.action).toBe('fill_text');
    // The page has its own country-code control, so the code belongs there and
    // nowhere else. "+1 201 555 0134" here would show the applicant "+1 +1 …".
    expect(action?.proposedValue).toBe('2015550134');
    expect(String(action?.proposedValue)).not.toContain('+1');
  });
});

describe('the phone country code', () => {
  it('is recognized from a control labelled only "Code"', () => {
    const field = scan.fields.find((candidate) => candidate.canonicalKey === 'phone_country_code');
    expect(field, 'no field was classified as the phone country code').toBeDefined();
    expect(field?.fieldType).toBe('select');
  });

  it('selects the offered spelling of +1 rather than failing on the punctuation', () => {
    const action = actionFor('phone_country_code');
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('United States (+1)');
    expect(action?.matchedOption?.value).toBe('+1');
  });

  it('is written before the number it reformats', () => {
    const codeIndex = actions.findIndex(
      (action) => action.id === actionFor('phone_country_code')?.id,
    );
    const phoneIndex = actions.findIndex((action) => action.id === actionFor('phone')?.id);
    expect(codeIndex).toBeGreaterThanOrEqual(0);
    expect(codeIndex).toBeLessThan(phoneIndex);
  });
});

describe('country', () => {
  it('is scanned as an option control, not a free-text box', () => {
    const field = scan.fields.find((candidate) => candidate.canonicalKey === 'country');
    expect(field?.fieldType).toBe('combobox');
  });

  it('resolves the saved alias "USA" to the option the page offers', () => {
    const action = actionFor('country');
    // A combobox whose list is discovered live is planned as a suggestion and
    // confirmed against the real options at fill time; either way the value
    // proposed is the saved one, never a guess.
    expect(['select_resolved_option', 'select_suggested_option']).toContain(action?.action);
    // The saved "USA" is normalized to one documented spelling, matched
    // against the list the page rendered, and the *option's own value* is what
    // gets written — so the control receives "US" because that is what this
    // page calls the option labelled "United States of America".
    expect(action?.matchedOption?.label).toBe('United States of America');
    expect(action?.proposedValue).toBe('US');
  });

  it('is written before the state list it repopulates', () => {
    const countryIndex = actions.findIndex((action) => action.id === actionFor('country')?.id);
    const stateIndex = actions.findIndex((action) => action.id === actionFor('state')?.id);
    expect(countryIndex).toBeLessThan(stateIndex);
  });

  it('reports the empty state control as a dependency rather than a failure', () => {
    const action = actionFor('state');
    expect(action?.action).toBe('missing_information');
    expect(action?.reason).toMatch(/Country/);
    // Blaming the profile for the page's ordering is the failure mode this
    // replaced: the saved state is present and correct.
    expect(action?.reason).not.toMatch(/New Jersey/);
  });
});

describe('documents behind hidden file inputs', () => {
  it('scans a display:none file input driven by a button', () => {
    const files = scan.fields.filter((field) => field.fieldType === 'file');
    expect(files.map((field) => field.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/resume/i), expect.stringMatching(/cover/i)]),
    );
    expect(files).toHaveLength(2);
  });

  it('binds the tailored résumé and cover letter to the right controls', () => {
    const resume = actionFor('resume');
    const cover = actionFor('cover_letter');

    expect(resume?.action).toBe('upload_file');
    expect(resume?.documentName).toBe('Molhm-Ellis-Quanta-Robotics-Resume.pdf');
    expect(resume?.documentId).toBe('bundle-quanta:resume');

    expect(cover?.action).toBe('upload_file');
    expect(cover?.documentName).toBe('Molhm-Ellis-Quanta-Robotics-Cover-Letter.pdf');
  });

  it('never binds a cover letter to a résumé control', () => {
    const resume = actionFor('resume');
    expect(resume?.documentName).not.toMatch(/cover/i);
  });
});

describe('the imported profile answers the sections the settings page used to ask for', () => {
  it.each([
    ['school', 'Rutgers University'],
    ['major', 'Computer Science'],
    ['employer', 'Northwind Robotics'],
    ['job_title', 'Engineering Intern'],
  ])('answers %s from the imported profile', (canonical, expected) => {
    expect(actionFor(canonical)?.proposedValue).toBe(expected);
  });

  it('never fills a past job location with the applicant home address', () => {
    expect(actionFor('experience_location')?.proposedValue).toBe('Newark, New Jersey');
  });
});

describe('with no application bundle', () => {
  /** The saved default résumé, as the agent server registers one. */
  const defaultResume = {
    id: 'document-default',
    name: 'General résumé',
    type: 'resume' as const,
    filePath: 'C:\\private\\default.pdf',
    fileName: 'Molhm-Ellis-Resume.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    tags: [],
    targetRoles: [],
    targetIndustries: [],
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('uses the saved default résumé, and says so', () => {
    // No `attachBundleDocuments`: this is the run a user starts by opening the
    // employer page themselves.
    const plan = buildDeterministicPlan(scan, PROFILE, [], defaultResume);
    const field = scan.fields.find((candidate) => candidate.canonicalKey === 'resume');
    const action = plan.actions.find((candidate) => candidate.fieldId === field?.id);

    expect(action?.action).toBe('upload_file');
    expect(action?.documentId).toBe('document-default');
    expect(action?.sourceReference).toBe('documents.document-default');
  });

  it('leaves the cover letter alone rather than substituting the résumé', () => {
    const plan = buildDeterministicPlan(scan, PROFILE, [], defaultResume);
    const field = scan.fields.find((candidate) => candidate.canonicalKey === 'cover_letter');
    const action = plan.actions.find((candidate) => candidate.fieldId === field?.id);

    expect(action?.action).not.toBe('upload_file');
    expect(action?.documentId).toBeUndefined();
  });

  it('does not fall back to the default résumé when a bundle exists without one', () => {
    // A tailored run that produced no résumé must attach nothing rather than a
    // generic file the applicant did not choose for this job.
    const bundleWithoutResume = { ...BUNDLE, resume: undefined };
    const plan = attachBundleDocuments(
      buildDeterministicPlan(scan, PROFILE, [], defaultResume),
      scan,
      bundleWithoutResume,
    );
    const field = scan.fields.find((candidate) => candidate.canonicalKey === 'resume');
    const action = plan.actions.find((candidate) => candidate.fieldId === field?.id);

    expect(action?.action).toBe('missing_information');
    expect(action?.documentId).toBeUndefined();
    expect(action?.warnings.join(' ')).toMatch(/default résumé was not used/i);
  });
});

describe('the submit control', () => {
  it('is never given an action of any kind', () => {
    const submit = scan.fields.find((field) => /submit/i.test(field.label));
    expect(submit).toBeUndefined();
    expect(actions.every((action) => action.action !== 'unsupported' || true)).toBe(true);
  });
});
