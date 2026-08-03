import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chooseDiscoverySource,
  contractViolation,
  degreeAnswersFor,
  isPasswordConfirmationField,
  isPasswordField,
  isUsernameField,
  profileSchema,
  questionIdentity,
  type DetectedField,
  type Profile,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import {
  buildDeterministicPlan,
  classifyAction,
} from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * What the live iCIMS account-creation run got wrong, stated as tests.
 *
 * Every case here corresponds to something the page actually did: a heading
 * reported as a question, a text box searched for options, a duplicated
 * dropdown, an optional field reported as missing information. They are in one
 * file because they are one story — the page — and because a regression in any
 * of them looks identical to the user.
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

/** The profile the live run had: a bachelor's in progress, high school awarded. */
function applicantProfile(overrides: Partial<Profile> = {}): Profile {
  return profileSchema.parse({
    ...profileFixture(),
    personal: {
      ...profileFixture().personal,
      legalFirstName: 'Molhm',
      legalMiddleName: undefined,
      legalLastName: 'Ellis',
      email: 'molhm@example.com',
      address: {
        line1: '48 Maple Avenue',
        city: 'Clifton',
        state: 'New Jersey',
        postalCode: '07011',
        country: 'United States',
      },
    },
    highestCompletedDegree: 'High School',
    currentDegreeInProgress: "Bachelor's Degree",
    preferences: {},
    ...overrides,
  });
}

async function planFor(profile = applicantProfile()) {
  const fields = await scanFields();
  return { fields, plan: buildDeterministicPlan(icimsScan(fields), profile, []) };
}

function actionFor(
  plan: Awaited<ReturnType<typeof planFor>>['plan'],
  field: DetectedField | undefined,
) {
  return plan.actions.find((action) => action.fieldId === field?.id);
}

beforeEach(() => {
  loadFixture();
});

describe('1. the extension does not scan its own UI', () => {
  it('never reports "Enable AI Autofill" as an application question', async () => {
    const labels = (await scanFields()).map((field) => field.label);
    expect(labels).not.toContain('Enable AI Autofill');
    expect(labels.join(' ')).not.toMatch(/autofill/i);
  });

  it('skips every control inside the extension-owned panel', async () => {
    const fields = await scanFields();
    const owned = ['agent-ai-toggle', 'agent-profile-picker'];
    for (const id of owned) {
      expect(fields.some((field) => field.metadata.elementId === id)).toBe(false);
    }
  });
});

describe('2. section headings are not questions', () => {
  it('does not report the Addresses accordion header', async () => {
    const labels = (await scanFields()).map((field) => field.label);
    expect(labels).not.toContain('Addresses (1)* required.');
    expect(labels.filter((label) => /addresses \(1\)/i.test(label))).toEqual([]);
  });

  it('does not report the Phones accordion header', async () => {
    const labels = (await scanFields()).map((field) => field.label);
    expect(labels.filter((label) => /^phones \(1\)$/i.test(label))).toEqual([]);
  });

  it('does not turn the validation summary into questions', async () => {
    const labels = (await scanFields()).map((field) => field.label);
    expect(labels.join(' ')).not.toMatch(/some required information is missing/i);
  });
});

describe('3. no duplicate questions', () => {
  it('reports Highest Level of Education exactly once', async () => {
    const matches = (await scanFields()).filter(
      (field) => field.label === 'Highest Level of Education',
    );
    expect(matches).toHaveLength(1);
    // The one that survived is the select, not the accordion summary: it is the
    // one that actually carries the choices.
    expect(matches[0]?.fieldType).toBe('select');
    expect(matches[0]?.options?.length).toBeGreaterThan(1);
  });

  it('gives every question a distinct runtime identity', async () => {
    const fields = await scanFields();
    const identities = fields.map(questionIdentity);
    expect(new Set(identities).size).toBe(fields.length);
  });
});

describe('4. a text field is typed into, never searched for options', () => {
  it('gives First Name no options at all, despite the "menu" sibling', async () => {
    const first = byCanonical(await scanFields(), 'first_name');
    expect(first?.fieldType).toBe('text');
    expect(first?.options).toBeUndefined();
  });

  it('plans fill_text for First Name', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'first_name'));
    expect(action?.action).toBe('fill_text');
    expect(action?.proposedValue).toBe('Molhm');
  });

  it('refuses an option action on a text control rather than attempting it', () => {
    const violation = contractViolation('text', 'select_suggested_option');
    expect(violation).not.toBeNull();
    expect(violation?.reason).toMatch(/typed into/i);
  });

  it('the executor rejects the incompatible plan it was somehow handed', async () => {
    const fields = await scanFields();
    const first = byCanonical(fields, 'first_name')!;
    const result = await executeDomAction(
      document,
      first,
      {
        id: 'action-bogus',
        fieldId: first.id,
        question: first.question,
        fieldType: 'text',
        action: 'select_suggested_option',
        proposedValue: 'Molhm',
        matchedOption: { label: 'Molhm', value: 'Molhm' },
        source: 'profile',
        confidence: 1,
        sensitive: false,
        requiresReview: false,
        approved: true,
        reason: 'test',
        warnings: [],
      },
      new AbortController().signal,
    );
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('UNSUPPORTED_CONTROL');
    // The old message. It must not come back.
    expect(result.error?.message).not.toMatch(/no option on the page matched/i);
  });
});

describe('5 & 6. credentials', () => {
  it('reads Login as the account username', async () => {
    const login = (await scanFields()).find((field) => field.label.startsWith('Login'));
    expect(login).toBeDefined();
    expect(isUsernameField(login!)).toBe(true);
  });

  it('reads Password and Password Re-enter as a password and its confirmation', async () => {
    const fields = await scanFields();
    const passwords = fields.filter(isPasswordField);
    expect(passwords).toHaveLength(2);
    const confirmations = passwords.filter(isPasswordConfirmationField);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.label).toMatch(/re-enter/i);
  });

  it('keeps both password fields out of the deterministic plan', async () => {
    const { fields, plan } = await planFor();
    for (const password of fields.filter(isPasswordField)) {
      const action = actionFor(plan, password);
      expect(action?.proposedValue).toBeUndefined();
      expect(action?.action).not.toBe('fill_text');
    }
  });
});

describe('7 & 8. Phone Type and Address Type keep their section', () => {
  it('resolves the phone block’s "Type" to Mobile', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'phone_type'));
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('Mobile');
  });

  it('resolves the address block’s "Type" to Home', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'address_type'));
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('Home');
  });

  it('does not classify either as a generic unknown "Type"', async () => {
    const fields = await scanFields();
    const types = fields.filter((field) => field.label === 'Type');
    expect(types.map((field) => field.canonicalKey).sort()).toEqual(['address_type', 'phone_type']);
  });
});

describe('9. optional fields are not reported as missing information', () => {
  it('leaves Address 2 blank without asking, and never repeats line 1 into it', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'address_line2'));
    expect(action?.action).toBe('skip');
    expect(classifyAction(action!)).toBe('skipped');
    expect(action?.proposedValue).toBeUndefined();
    expect(action?.reason).toMatch(/optional/i);
    expect(action?.requiresReview).toBe(false);
  });

  it('leaves Middle Name blank when no middle name is saved', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'middle_name'));
    expect(action?.action).toBe('skip');
    expect(action?.requiresReview).toBe(false);
  });

  it('still fills Middle Name when one is saved', async () => {
    const profile = applicantProfile();
    const withMiddle = profileSchema.parse({
      ...profile,
      personal: { ...profile.personal, legalMiddleName: 'Rae' },
    });
    const { fields, plan } = await planFor(withMiddle);
    const action = actionFor(plan, byCanonical(fields, 'middle_name'));
    expect(action?.action).toBe('fill_text');
    expect(action?.proposedValue).toBe('Rae');
  });
});

describe('10 & 11. Country before State, and State once the options arrive', () => {
  it('sees State with no real options until a country is chosen', async () => {
    const state = byCanonical(await scanFields(), 'state');
    const real = (state?.options ?? []).filter((option) => option.value !== '');
    expect(real).toEqual([]);
  });

  it('fills Country first', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'country'));
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('United States');
  });

  it('fills State from the options the country produced', async () => {
    // The fixture repopulates State from a `change` listener, and jsdom does
    // not run scripts injected through innerHTML. So the page's own effect is
    // applied here directly — what is under test is the *rescan*, which must
    // read the new list rather than the "Select a country first" placeholder it
    // saw the first time.
    const country = document.getElementById('country') as HTMLSelectElement;
    country.value = 'US';
    const state = document.getElementById('stateProvince') as HTMLSelectElement;
    state.replaceChildren();
    for (const [value, label] of [
      ['', 'Please select'],
      ['NJ', 'New Jersey'],
      ['NY', 'New York'],
      ['PA', 'Pennsylvania'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      state.append(option);
    }

    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'state'));
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('New Jersey');
  });
});

describe('12. the awarded degree is not the degree in progress', () => {
  it('reads both facts separately from the profile', () => {
    const answers = degreeAnswersFor(applicantProfile());
    expect(answers.highestCompletedDegree).toBe('High School');
    expect(answers.currentDegreeInProgress).toBe("Bachelor's Degree");
  });

  it('answers "Highest Level of Education" with High School', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'highest_degree_awarded'));
    expect(action?.matchedOption?.label).toBe('High School');
  });

  it('does not claim a bachelor’s degree merely because one is being studied for', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'highest_degree_awarded'));
    expect(action?.matchedOption?.label).not.toMatch(/bachelor/i);
  });

  it('answers nothing at all when the profile establishes no awarded degree', () => {
    const profile = profileSchema.parse({
      ...applicantProfile(),
      highestCompletedDegree: undefined,
      currentDegreeInProgress: undefined,
      education: [
        {
          id: 'education-1',
          institution: 'Rutgers University',
          degree: "Bachelor's Degree",
          graduationDate: '2099-05',
        },
      ],
    });
    expect(degreeAnswersFor(profile).highestCompletedDegree).toBeUndefined();
  });
});

describe('13. the source dropdown is chosen from every option, never the first', () => {
  it('picks Internet Job Board over the referral that sits first in the list', async () => {
    const source = byCanonical(await scanFields(), 'how_did_you_hear');
    const chosen = chooseDiscoverySource(source?.options ?? []);
    expect(chosen?.option.label).toBe('Internet Job Board');
  });

  it('never picks Employee Referral or a career fair', async () => {
    const source = byCanonical(await scanFields(), 'how_did_you_hear');
    const chosen = chooseDiscoverySource(source?.options ?? []);
    expect(chosen?.option.label).not.toMatch(/referral|career fair/i);
  });

  it('honours a saved attribution preference over the ranking', async () => {
    const source = byCanonical(await scanFields(), 'how_did_you_hear');
    const chosen = chooseDiscoverySource(source?.options ?? [], 'Company Website');
    expect(chosen?.option.label).toBe('Company Website');
  });

  it('answers nothing when no option is a true description', () => {
    const chosen = chooseDiscoverySource([
      { label: 'Please select', value: '' },
      { label: 'Employee Referral', value: 'referral' },
      { label: 'University Career Fair', value: 'fair' },
    ]);
    expect(chosen).toBeNull();
  });

  it('plans the source answer rather than deferring it to the user', async () => {
    const { fields, plan } = await planFor();
    const action = actionFor(plan, byCanonical(fields, 'how_did_you_hear'));
    expect(action?.action).toBe('select_option');
    expect(action?.matchedOption?.label).toBe('Internet Job Board');
  });
});

describe('14. the policy agreement is never ticked on its own', () => {
  it('leaves the consent checkbox for the user', async () => {
    const fields = await scanFields();
    const consent = fields.find((field) => field.label.includes('I Agree to the Policies'));
    expect(consent?.fieldType).toBe('checkbox');
    const plan = buildDeterministicPlan(icimsScan(fields), applicantProfile(), []);
    const action = actionFor(plan, consent);
    expect(action?.action).not.toBe('toggle_checkbox');
    expect(action?.requiresReview).toBe(true);
  });

  it('reports it once, not twice', async () => {
    const consent = (await scanFields()).filter((field) =>
      field.label.includes('I Agree to the Policies'),
    );
    expect(consent).toHaveLength(1);
  });
});

describe('15. the plan and the controls never disagree', () => {
  it('every planned action suits the control it targets', async () => {
    const { fields, plan } = await planFor();
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const action of plan.actions) {
      const field = byId.get(action.fieldId);
      if (!field) continue;
      const violation = contractViolation(field.fieldType, action.action);
      expect(
        violation,
        `${field.label} (${field.fieldType}) received "${action.action}"`,
      ).toBeNull();
    }
  });
});

describe('16. the final Submit is never clicked', () => {
  it('plans no action against the Create Account button', async () => {
    const { fields, plan } = await planFor();
    const submit = document.getElementById('createAccount');
    expect(submit).not.toBeNull();
    // The button is not a question, so nothing can be planned for it.
    expect(fields.some((field) => field.metadata.elementId === 'createAccount')).toBe(false);
    expect(plan.actions.some((action) => /create account/i.test(action.question))).toBe(false);
  });

  it('says so in the plan’s own warnings', async () => {
    const { plan } = await planFor();
    expect(plan.warnings.join(' ')).toMatch(/never submits/i);
  });
});

describe('17. the completion counters reconcile', () => {
  it('assigns every action to exactly one bucket', async () => {
    const { plan } = await planFor();
    const statistics = plan.statistics;
    const sum =
      statistics.ready +
      statistics.approved +
      statistics.review +
      statistics.missingInformation +
      statistics.skipped +
      statistics.unsupported;
    expect(sum).toBe(statistics.total);
    expect(statistics.total).toBe(plan.actions.length);
  });

  it('does not count an optional blank field as missing information', async () => {
    const { fields, plan } = await planFor();
    const optional = [byCanonical(fields, 'middle_name'), byCanonical(fields, 'address_line2')];
    for (const field of optional) {
      expect(classifyAction(actionFor(plan, field)!)).toBe('skipped');
    }
  });
});
