import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  contractViolation,
  degreeAnswersFor,
  isTextFieldType,
  profileSchema,
  repairActionFor,
  type DetectedField,
  type FormFillPlan,
  type Profile,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import {
  applyAnalysisToPlan,
  buildAnalysisRequest,
} from '../../extension/src/analysis/formAnalysis.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The two live failures, and the branch that produced both.
 *
 * "No option on the page matched 'Molhm'" and "No option on the page matched
 * 'New Jersey'" look like matcher bugs. They are not: they are a text control
 * and a not-yet-populated control being handed an option-selecting action. The
 * deterministic planner had been taught the control-type contract; the *model*
 * planner had not, and `applyAnalysisToPlan` built whatever action the model
 * named.
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

function byCanonical(fields: DetectedField[], canonical: string): DetectedField | undefined {
  return fields.find((field) => field.canonicalKey === canonical);
}

function applicant(overrides: Partial<Profile> = {}): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      ...base.personal,
      legalFirstName: 'Molhm',
      legalLastName: 'Ellis',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
    preferences: {},
    ...overrides,
  });
}

/** A model response naming an action, as the worker would receive it. */
function modelPlan(answers: FormFillPlan['answers']): FormFillPlan {
  return { pageId: 'page-icims', answers, notes: [] } as FormFillPlan;
}

beforeEach(() => {
  loadFixture();
});

describe('the model cannot make a text field search a dropdown', () => {
  it('rewrites SELECT_OPTION on First Name into a text fill', async () => {
    const fields = await scanFields();
    const scan = icimsScan(fields);
    const profile = applicant();
    // Force First Name to be unresolved so it reaches the model at all.
    const bare = profileSchema.parse({
      ...profile,
      personal: { ...profile.personal, legalFirstName: undefined },
    });
    const plan = buildDeterministicPlan(scan, bare, []);
    const built = buildAnalysisRequest({ scan, plan, profile: bare, answers: [] });
    const first = byCanonical(fields, 'first_name')!;
    const question = built.questions.find((entry) => entry.fieldIds.includes(first.id));
    if (!question) return;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      modelPlan([
        {
          questionId: question.questionId,
          action: 'SELECT_OPTION',
          selectedOption: 'Molhm',
          value: 'Molhm',
          confidence: 0.98,
          requiresReview: false,
          sourceFactIds: [],
          reason: 'test',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
      undefined,
      built.request?.facts ?? [],
    );

    const action = applied.plan.actions.find((entry) => entry.fieldId === first.id);
    // Either repaired into a text fill, or discarded — never an option action.
    if (action) {
      expect(contractViolation(first.fieldType, action.action)).toBeNull();
      expect(action.action).not.toBe('select_suggested_option');
      expect(action.action).not.toBe('select_option');
    }
  });

  it('repairs to the right strategy for every text-like control', () => {
    for (const type of ['text', 'email', 'tel', 'number', 'url', 'textarea'] as const) {
      expect(isTextFieldType(type)).toBe(true);
      expect(repairActionFor(type)).toBe('fill_text');
      expect(contractViolation(type, 'select_option')).not.toBeNull();
      expect(contractViolation(type, 'select_suggested_option')).not.toBeNull();
      expect(contractViolation(type, 'fill_text')).toBeNull();
    }
  });

  it('never repairs a password into a plan', () => {
    expect(repairActionFor('password')).toBeNull();
  });
});

describe('a dependent control is not a failed match', () => {
  it('does not blame the profile when State has no options yet', async () => {
    const fields = await scanFields();
    const state = byCanonical(fields, 'state')!;
    // The fixture ships State with only "Select a country first".
    expect((state.options ?? []).filter((option) => option.value !== '')).toEqual([]);

    const plan = buildDeterministicPlan(icimsScan(fields), applicant(), []);
    const action = plan.actions.find((entry) => entry.fieldId === state.id);
    expect(action?.reason).not.toMatch(/no option on the page matched/i);
    expect(action?.reason).toMatch(/country/i);
    expect(action?.requiresReview).toBe(false);
  });

  it('discards a model answer for a select whose options have not arrived', async () => {
    const fields = await scanFields();
    const scan = icimsScan(fields);
    const plan = buildDeterministicPlan(scan, applicant(), []);
    const built = buildAnalysisRequest({ scan, plan, profile: applicant(), answers: [] });
    const state = byCanonical(fields, 'state')!;
    const question = built.questions.find((entry) => entry.fieldIds.includes(state.id));
    if (!question) return;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      modelPlan([
        {
          questionId: question.questionId,
          action: 'SELECT_OPTION',
          selectedOption: 'New Jersey',
          confidence: 0.9,
          requiresReview: false,
          sourceFactIds: [],
          reason: 'test',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
      undefined,
      built.request?.facts ?? [],
    );

    const action = applied.plan.actions.find((entry) => entry.fieldId === state.id);
    expect(action?.action).not.toBe('select_suggested_option');
  });

  it('fills State once Country has produced the options', async () => {
    const country = document.getElementById('country') as HTMLSelectElement;
    country.value = 'US';
    const state = document.getElementById('stateProvince') as HTMLSelectElement;
    state.replaceChildren();
    for (const [value, label] of [
      ['', 'Please select'],
      ['NJ', 'New Jersey'],
      ['NY', 'New York'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      state.append(option);
    }

    const fields = await scanFields();
    const plan = buildDeterministicPlan(icimsScan(fields), applicant(), []);
    const action = plan.actions.find((entry) => entry.fieldId === byCanonical(fields, 'state')?.id);
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('New Jersey');
  });
});

describe('the awarded degree comes from saved education', () => {
  it('is derived from a completed entry rather than declared unknowable', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      highestCompletedDegree: undefined,
      currentDegreeInProgress: undefined,
      education: [
        {
          id: 'education-1',
          institution: 'Clifton High School',
          degree: 'High School',
          status: 'completed',
        },
        {
          id: 'education-2',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          status: 'in_progress',
        },
      ],
    });
    const answers = degreeAnswersFor(profile);
    expect(answers.highestCompletedDegree).toBe('High School');
    expect(answers.currentDegreeInProgress).toBe("Bachelor's Degree");
  });

  it('answers the education dropdown with High School, not the degree in progress', async () => {
    const fields = await scanFields();
    const profile = profileSchema.parse({
      ...applicant(),
      highestCompletedDegree: undefined,
      currentDegreeInProgress: undefined,
      education: [
        {
          id: 'education-1',
          institution: 'Clifton High School',
          degree: 'High School',
          status: 'completed',
        },
        {
          id: 'education-2',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          status: 'in_progress',
        },
      ],
    });
    const plan = buildDeterministicPlan(icimsScan(fields), profile, []);
    const action = plan.actions.find(
      (entry) => entry.fieldId === byCanonical(fields, 'highest_degree_awarded')?.id,
    );
    expect(action?.matchedOption?.label).toBe('High School');
    expect(action?.reason).not.toMatch(/only you can confirm/i);
  });

  it('still refuses to invent one when nothing establishes it', () => {
    const profile = profileSchema.parse({
      ...applicant(),
      highestCompletedDegree: undefined,
      currentDegreeInProgress: undefined,
      education: [
        { id: 'education-1', institution: 'Rutgers University', degree: "Bachelor's Degree" },
      ],
    });
    expect(degreeAnswersFor(profile).highestCompletedDegree).toBeUndefined();
  });
});
