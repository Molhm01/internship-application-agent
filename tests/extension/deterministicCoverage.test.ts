import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  matchCanonicalQuestion,
  type CanonicalQuestion,
  type DetectedField,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { buildAnalysisRequest } from '../../extension/src/analysis/formAnalysis.js';
import {
  buildCoverage,
  describeCoverage,
  summarizeCoverage,
} from '../../extension/src/autofill/coverage.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * How much of a real application the deterministic pass can answer on its own.
 *
 * The live run filled one field out of twenty-seven, and the reason was
 * invisible: every unfilled field reported "needs information", which is the
 * symptom of a missing profile value, a missing mapping, a rejected action and
 * a refused write alike. The coverage table separates those, and these tests
 * hold the floor so a mapping cannot quietly disappear again.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
}

async function scanFields(): Promise<DetectedField[]> {
  return (await scanDom(document, 'page-icims', new AbortController().signal)).fields;
}

async function coverage() {
  const fields = await scanFields();
  const plan = buildDeterministicPlan(icimsScan(fields), profileFixture(), []);
  return { fields, plan, rows: buildCoverage(fields, plan) };
}

beforeEach(() => {
  loadFixture();
});

describe('1. every canonical profile key reaches its intended intent', () => {
  /** The label an employer writes, and the question it must resolve to. */
  const MAPPINGS: ReadonlyArray<readonly [string, CanonicalQuestion]> = [
    ['First Name', 'first_name'],
    ['Middle Name', 'middle_name'],
    ['Last Name', 'last_name'],
    ['Preferred Name', 'preferred_name'],
    ['Suffix', 'name_suffix'],
    ['Email Address', 'email'],
    ['Phone Country Code', 'phone_country_code'],
    ['Phone Type', 'phone_type'],
    ['Phone Number', 'phone'],
    ['Address Type', 'address_type'],
    ['Address Line 1', 'address_line1'],
    ['Address Line 2', 'address_line2'],
    ['City', 'city'],
    ['State/Province', 'state'],
    ['Zip/Postal Code', 'postal_code'],
    ['Country', 'country'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub', 'github'],
    ['Portfolio', 'portfolio'],
    ['Personal Website', 'website'],
    ['School', 'school'],
    ['Highest Level of Education', 'highest_degree_awarded'],
    ['Major', 'major'],
    ['Minor', 'minor'],
    ['GPA', 'gpa'],
    ['Graduation Month', 'graduation_month'],
    ['Graduation Year', 'graduation_year'],
    ['Employer', 'employer'],
    ['Position Title', 'job_title'],
    ['Employer Location', 'experience_location'],
    ['Responsibilities', 'responsibilities'],
    ['Are you authorized to work', 'work_authorization'],
    ['Do you require sponsorship', 'sponsorship_required'],
    ['Are you willing to relocate?', 'willing_to_relocate'],
    ['Earliest start date', 'earliest_start_date'],
    ['How did you hear about us?', 'how_did_you_hear'],
    ['Resume', 'resume'],
    ['Cover Letter', 'cover_letter'],
    ['Login', 'account_username'],
  ];

  it.each(MAPPINGS)('"%s" resolves to %s', (label, expected) => {
    expect(matchCanonicalQuestion(label).question).toBe(expected);
  });

  it('keeps the location questions apart', () => {
    // Three different questions that all contain the word "location".
    expect(matchCanonicalQuestion('Employer Location').question).toBe('experience_location');
    expect(matchCanonicalQuestion('Current location').question).toBe('current_location');
    expect(matchCanonicalQuestion('Job Location').question).toBe('preferred_locations');
    expect(matchCanonicalQuestion('Would you consider moving to the job location?').question).toBe(
      'willing_to_relocate',
    );
  });
});

describe('2 & 3. the deterministic pass carries the page', () => {
  it('classifies nearly every control', async () => {
    const summary = summarizeCoverage((await coverage()).rows);
    expect(summary.scanned).toBeGreaterThanOrEqual(30);
    expect(summary.classified / summary.scanned).toBeGreaterThan(0.85);
  });

  it('produces an executable action for most of the page without any AI', async () => {
    const { rows } = await coverage();
    const summary = summarizeCoverage(rows);
    // Was 13 of 24 before the experience and education mappings existed.
    expect(summary.executed, describeCoverage(rows)).toBeGreaterThanOrEqual(24);
  });

  it('rejects nothing on contract grounds', async () => {
    const { rows } = await coverage();
    expect(rows.filter((row) => row.stage === 'action_rejected')).toEqual([]);
  });

  it('leaves nothing unclassified', async () => {
    const { rows } = await coverage();
    expect(rows.filter((row) => row.stage === 'unclassified')).toEqual([]);
  });

  it('names the canonical keys it resolved, without their values', async () => {
    const { rows } = await coverage();
    const resolved = rows.filter((row) => row.hasProfileValue).map((row) => row.intent);
    for (const intent of [
      'first_name',
      'last_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'postal_code',
      'country',
      'school',
      'major',
      'employer',
      'job_title',
      'experience_location',
    ]) {
      expect(resolved, `${intent} had no profile value`).toContain(intent);
    }
    // The table is diagnostics, not a data leak: no value ever appears in it.
    expect(JSON.stringify(rows)).not.toMatch(/Rutgers|Northwind|Clifton|Molhm|Jordan/);
  });
});

describe('12. deterministic fields never reach the model', () => {
  it('excludes everything the profile already answered', async () => {
    const fields = await scanFields();
    const scan = icimsScan(fields);
    const profile = profileFixture();
    const plan = buildDeterministicPlan(scan, profile, []);
    const built = buildAnalysisRequest({ scan, plan, profile, answers: [] });
    const sent = built.questions.map((question) => question.likelyIntent);

    for (const deterministic of [
      'first_name',
      'last_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'postal_code',
      'country',
      'school',
      'major',
      'minor',
      'gpa',
      'employer',
      'job_title',
      'experience_location',
      'highest_degree_awarded',
    ]) {
      expect(sent, `${deterministic} was sent to the model`).not.toContain(deterministic);
    }
  });

  it('sends only the handful nobody could answer from saved data', async () => {
    const fields = await scanFields();
    const scan = icimsScan(fields);
    const profile = profileFixture();
    const plan = buildDeterministicPlan(scan, profile, []);
    const built = buildAnalysisRequest({ scan, plan, profile, answers: [] });
    expect(built.questions.length).toBeLessThanOrEqual(6);
  });
});
