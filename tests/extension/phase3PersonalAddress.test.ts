import { describe, expect, it } from 'vitest';
import {
  actionSuitsControl,
  allowsRegionSuffix,
  contractViolation,
  fullLegalName,
  matchCanonicalQuestion,
  matchOption,
  profileSchema,
  resolveStructuralField,
  type DetectedField,
  type FieldOption,
} from '@internship-agent/shared';
import { matchField } from '../../extension/src/matcher/deterministicMatcher.js';
import {
  allowsEmailAsUsername,
  buildDeterministicPlan,
  isDependentControl,
} from '../../extension/src/planner/deterministicPlanner.js';
import {
  awaitDependentOptions,
  offersRealChoice,
} from '../../extension/src/content/dependentOptions.js';
import { applicationScanResultSchema } from '@internship-agent/shared';

/**
 * Phase 3: the personal, phone, address, Country/Region, State/Province and
 * Legal Name path, at the level of the modules that decide each of them.
 *
 * The built-extension proof is `tests/e2e/phase3-personal-address.spec.ts`;
 * this suite pins the reasoning that proof depends on, so a regression names
 * the rule it broke instead of showing up as a blank box in a browser.
 */

const NOW = '2026-08-06T00:00:00.000Z';

/** The canonical Phase 3 applicant: no middle name, no second address line. */
const PROFILE = profileSchema.parse({
  updatedAt: NOW,
  personal: {
    legalFirstName: 'Molhm',
    legalLastName: 'Ellis',
    email: 'molhm@example.com',
    phone: '+1 929 264 3117',
    phoneCountryCode: '+1',
    phoneType: 'mobile',
    address: {
      type: 'home',
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      country: 'United States',
    },
  },
  education: [{ id: 'edu-1', institution: 'Rutgers University' }],
});

function field(overrides: Partial<DetectedField> & { label: string }): DetectedField {
  const label = overrides.label;
  return {
    id: `field-${label.toLowerCase().replace(/\W+/g, '-')}`,
    pageId: 'page-1',
    normalizedLabel: label.toLowerCase(),
    question: label,
    fieldType: 'text',
    selector: `#${label.toLowerCase().replace(/\W+/g, '')}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

const option = (label: string, value = label): FieldOption => ({ label, value });

describe('personal-field aliases reach one canonical question', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['First Name', 'first_name'],
    ['Legal First Name', 'first_name'],
    ['Given Name', 'first_name'],
    ['Forename', 'first_name'],
    ['Middle Name', 'middle_name'],
    ['Legal Middle Name', 'middle_name'],
    ['Middle Initial', 'middle_name'],
    ['Last Name', 'last_name'],
    ['Legal Last Name', 'last_name'],
    ['Family Name', 'last_name'],
    ['Surname', 'last_name'],
    ['Preferred Name', 'preferred_name'],
    ['Chosen Name', 'preferred_name'],
    ['Name You Go By', 'preferred_name'],
    ['Email', 'email'],
    ['Email Address', 'email'],
    ['Primary Email', 'email'],
    ['Contact Email', 'email'],
    ['Login', 'account_username'],
    ['Username', 'account_username'],
    ['User ID', 'account_username'],
  ];
  for (const [label, expected] of cases) {
    it(`reads "${label}" as ${expected}`, () => {
      expect(matchCanonicalQuestion(label).question).toBe(expected);
    });
  }
});

describe('address aliases reach one canonical question', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Address Type', 'address_type'],
    ['Address', 'address_line1'],
    ['Address Line 1', 'address_line1'],
    ['Street Address', 'address_line1'],
    ['Primary Address', 'address_line1'],
    ['Address 2', 'address_line2'],
    ['Address Line 2', 'address_line2'],
    ['Apartment', 'address_line2'],
    ['Unit', 'address_line2'],
    ['Suite', 'address_line2'],
    ['Floor', 'address_line2'],
    ['City', 'city'],
    ['Town', 'city'],
    ['ZIP', 'postal_code'],
    ['ZIP Code', 'postal_code'],
    ['Postal Code', 'postal_code'],
    ['ZIP/Postal Code', 'postal_code'],
    ['State', 'state'],
    ['Province', 'state'],
    ['State/Province', 'state'],
    ['Region', 'state'],
  ];
  for (const [label, expected] of cases) {
    it(`reads "${label}" as ${expected}`, () => {
      expect(matchCanonicalQuestion(label).question).toBe(expected);
    });
  }
});

describe('a country control is never read as a state control', () => {
  // The root cause of the reported failure. "Country/Region" contains "region",
  // and the state rule accepts "region", so before the reordering every
  // Workday-shaped residence country matched `state` — offering the saved
  // "New Jersey" to a list of countries and leaving both controls blank.
  const cases = [
    'Country',
    'Country/Region',
    'Country/Region of Residence',
    'Residence Country',
    'Country of Residence',
  ];
  for (const label of cases) {
    it(`reads "${label}" as country`, () => {
      expect(matchCanonicalQuestion(label).question).toBe('country');
    });
  }

  it('still reads a genuine State/Province/Region control as state', () => {
    expect(matchCanonicalQuestion('State/Province/Region').question).toBe('state');
  });
});

describe('the full legal name is constructed, never generated', () => {
  it('joins first and last when there is no middle name', () => {
    expect(fullLegalName({ legalFirstName: 'Molhm', legalLastName: 'Ellis' })).toBe('Molhm Ellis');
  });

  it('includes a middle name when one is saved', () => {
    expect(
      fullLegalName({ legalFirstName: 'Molhm', legalMiddleName: 'Rae', legalLastName: 'Ellis' }),
    ).toBe('Molhm Rae Ellis');
  });

  it('keeps the saved capitalization and collapses stray whitespace', () => {
    expect(fullLegalName({ legalFirstName: '  de  Souza ', legalLastName: 'Ellis' })).toBe(
      'de Souza Ellis',
    );
  });

  it('never uses the preferred name', () => {
    const match = matchField(
      field({ label: 'Full Legal Name', canonicalKey: 'full_name' }),
      profileSchema.parse({
        ...PROFILE,
        personal: { ...PROFILE.personal, preferredName: 'Mo' },
      }),
      [],
    );
    expect(match.formattedValue).toBe('Molhm Ellis');
  });

  it('states no legal name at all when a part is missing', () => {
    expect(fullLegalName({ legalFirstName: 'Molhm' })).toBeNull();
  });

  const labels = [
    'Legal Name',
    'Full Legal Name',
    'Name as it appears on legal documents',
    'Signature Name',
    'Applicant Legal Name',
  ];
  for (const label of labels) {
    it(`recognizes "${label}"`, () => {
      expect(matchCanonicalQuestion(label).question).toBe('full_name');
    });
  }

  it('fills it as text, from the profile, on a text control', () => {
    const match = matchField(
      field({ label: 'Full Legal Name', canonicalKey: 'full_name' }),
      PROFILE,
      [],
    );
    expect(match.matched).toBe(true);
    expect(match.source).toBe('profile');
    expect(match.formattedValue).toBe('Molhm Ellis');
  });
});

describe('the control/action contract holds in both directions', () => {
  it('refuses an option action on every text-like control', () => {
    for (const type of ['text', 'email', 'tel', 'number', 'url', 'textarea'] as const) {
      expect(actionSuitsControl(type, 'select_option')).toBe(false);
      expect(contractViolation(type, 'select_suggested_option')).not.toBeNull();
      expect(actionSuitsControl(type, 'fill_text')).toBe(true);
    }
  });

  it('refuses a text action on an option control', () => {
    for (const type of ['select', 'radio', 'checkbox'] as const) {
      expect(contractViolation(type, 'fill_text')).not.toBeNull();
    }
  });

  it('never sends a first name through option matching', () => {
    const plan = planFor([
      field({ label: 'Legal First Name', canonicalKey: 'first_name', required: true }),
    ]);
    const action = plan.actions[0];
    expect(action?.action).toBe('fill_text');
    expect(action?.proposedValue).toBe('Molhm');
    expect(action?.matchedOption).toBeUndefined();
  });
});

describe('Country is matched against the options the page really offers', () => {
  const aliases = [
    'United States',
    'United States of America',
    'USA',
    'U.S.A.',
    'US',
    'U.S.',
    'united states',
  ];
  for (const offered of aliases) {
    it(`selects "${offered}" for a saved United States`, () => {
      const result = matchOption('United States', [option('Canada'), option(offered, 'us')], {
        allowRegionSuffix: allowsRegionSuffix('country'),
      });
      expect(result.matched).toBe(true);
      expect(result.option?.label).toBe(offered);
    });
  }

  it('plans a native Country select as select_option carrying an offered value', () => {
    const plan = planFor([
      field({
        label: 'Country/Region of Residence',
        canonicalKey: 'country',
        fieldType: 'select',
        required: true,
        options: [option('Select…', ''), option('Canada', 'CA'), option('United States', 'US')],
      }),
    ]);
    const action = plan.actions[0];
    expect(action?.action).toBe('select_option');
    expect(action?.proposedValue).toBe('US');
    expect(action?.requiresReview).toBe(false);
  });

  it('plans a custom Country combobox as a resolved option', () => {
    const plan = planFor([
      field({
        label: 'Country/Region',
        canonicalKey: 'country',
        fieldType: 'combobox',
        required: true,
        options: [option('United States of America', 'USA')],
      }),
    ]);
    expect(plan.actions[0]?.action).toBe('select_resolved_option');
    expect(plan.actions[0]?.proposedValue).toBe('USA');
  });
});

describe('State waits for the choices Country produces', () => {
  const emptyState = field({
    label: 'State/Province',
    canonicalKey: 'state',
    fieldType: 'select',
    required: true,
    options: [option('Select a country first', '')],
  });

  it('recognizes a control offering nothing but a prompt as dependent', () => {
    expect(isDependentControl(emptyState)).toBe(true);
  });

  it('does not blame the profile for an option the page has not produced', () => {
    const plan = planFor([emptyState]);
    expect(plan.actions[0]?.action).toBe('missing_information');
    expect(plan.actions[0]?.reason).toContain('Country');
    expect(plan.actions[0]?.requiresReview).toBe(false);
  });

  it('selects New Jersey once the options are there', () => {
    const plan = planFor([
      field({
        ...emptyState,
        options: [option('Select…', ''), option('New Jersey', 'NJ'), option('New York', 'NY')],
      }),
    ]);
    expect(plan.actions[0]?.action).toBe('select_option');
    expect(plan.actions[0]?.proposedValue).toBe('NJ');
  });

  it('matches an abbreviated New Jersey option too', () => {
    const result = matchOption('New Jersey', [option('NY'), option('NJ')], {
      allowRegionSuffix: allowsRegionSuffix('state'),
    });
    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe('NJ');
  });

  it('writes Country before State whatever order the page lists them in', () => {
    const plan = planFor([
      emptyState,
      field({
        label: 'Country/Region',
        canonicalKey: 'country',
        fieldType: 'select',
        required: true,
        options: [option('United States', 'US')],
      }),
    ]);
    expect(plan.actions.map((action) => action.fieldId)[0]).toContain('country');
  });
});

describe('the bounded dependent-options wait', () => {
  it('resolves immediately when the choices are already there', async () => {
    document.body.innerHTML = '<select id="state"><option value="NJ">New Jersey</option></select>';
    const outcome = await awaitDependentOptions(document, ['#state'], 2000);
    expect(outcome.populated).toEqual(['#state']);
    expect(outcome.pending).toEqual([]);
  });

  it('does not treat a prompt-only control as populated', () => {
    document.body.innerHTML =
      '<select id="state"><option value="">Select a country first</option></select>';
    const control = document.querySelector<HTMLElement>('#state');
    expect(control && offersRealChoice(control)).toBe(false);
  });

  it('resolves when the page produces the list, without waiting out the bound', async () => {
    document.body.innerHTML =
      '<select id="state"><option value="">Select a country first</option></select>';
    setTimeout(() => {
      const select = document.querySelector<HTMLSelectElement>('#state');
      if (select) select.innerHTML = '<option value="NJ">New Jersey</option>';
    }, 20);
    const outcome = await awaitDependentOptions(document, ['#state'], 2000);
    expect(outcome.populated).toEqual(['#state']);
    expect(outcome.waitedMs).toBeLessThan(2000);
  });

  it('gives up at the bound and reports the control as still pending', async () => {
    document.body.innerHTML =
      '<select id="state"><option value="">Select a country first</option></select>';
    const outcome = await awaitDependentOptions(document, ['#state'], 150);
    expect(outcome.pending).toEqual(['#state']);
    expect(outcome.waitedMs).toBeLessThan(2000);
  });

  it('names a control that is not on the page rather than waiting for it', async () => {
    document.body.innerHTML = '<div></div>';
    const outcome = await awaitDependentOptions(document, ['#state'], 150);
    expect(outcome.missing).toEqual(['#state']);
  });
});

describe('the phone block', () => {
  it('puts the whole saved number in a lone phone control', () => {
    const match = matchField(field({ label: 'Phone Number', canonicalKey: 'phone' }), PROFILE, []);
    expect(String(match.formattedValue).replace(/\D/g, '')).toBe('19292643117');
  });

  it('never repeats +1 when the page has a separate country-code control', () => {
    const match = matchField(
      field({ label: 'Phone Number', canonicalKey: 'phone' }),
      PROFILE,
      [],
      undefined,
      {
        hasPhoneCountryCodeField: true,
      },
    );
    expect(String(match.formattedValue).startsWith('+1')).toBe(false);
    expect(String(match.formattedValue).replace(/\D/g, '')).toBe('9292643117');
  });

  it('offers the saved dialling code to a separate country-code control', () => {
    const match = matchField(
      field({ label: 'Country Phone Code', canonicalKey: 'phone_country_code' }),
      PROFILE,
      [],
    );
    expect(match.formattedValue).toBe('+1');
  });

  const codeLabels = ['+1', 'United States (+1)', 'US +1', 'USA (+1)'];
  for (const label of codeLabels) {
    it(`selects the code option spelled "${label}"`, () => {
      const result = matchOption('+1', [option('Australia (+61)', '61'), option(label, '1')]);
      expect(result.matched).toBe(true);
      expect(result.option?.label).toBe(label);
    });
  }

  it('chooses the phone type from the form’s own vocabulary', () => {
    const resolved = resolveStructuralField(
      field({
        label: 'Phone Type',
        canonicalKey: 'phone_type',
        fieldType: 'select',
        options: [option('Home'), option('Mobile'), option('Work')],
      }),
    );
    expect(resolved?.option.label).toBe('Mobile');
  });
});

describe('the address block', () => {
  it('chooses Home for the address type', () => {
    const resolved = resolveStructuralField(
      field({
        label: 'Address Type',
        canonicalKey: 'address_type',
        fieldType: 'select',
        options: [option('Work'), option('Home'), option('Other')],
      }),
    );
    expect(resolved?.option.label).toBe('Home');
  });

  it('fills line 1, city and postal code from the saved address', () => {
    const plan = planFor([
      field({ label: 'Address Line 1', canonicalKey: 'address_line1', required: true }),
      field({ label: 'City', canonicalKey: 'city', required: true }),
      field({ label: 'ZIP/Postal Code', canonicalKey: 'postal_code', required: true }),
    ]);
    expect(plan.actions.map((action) => action.proposedValue)).toEqual([
      '48 Maple Avenue',
      'Clifton',
      '07011',
    ]);
  });

  it('leaves an optional Address Line 2 blank and never repeats line 1 into it', () => {
    const plan = planFor([
      field({ label: 'Address Line 2', canonicalKey: 'address_line2', required: false }),
    ]);
    expect(plan.actions[0]?.action).toBe('skip');
    expect(plan.actions[0]?.requiresReview).toBe(false);
    expect(plan.actions[0]?.proposedValue).toBeUndefined();
  });

  it('leaves an optional Middle Name blank', () => {
    const plan = planFor([
      field({ label: 'Middle Name', canonicalKey: 'middle_name', required: false }),
    ]);
    expect(plan.actions[0]?.action).toBe('skip');
    expect(plan.actions[0]?.requiresReview).toBe(false);
  });
});

describe('an account identifier the portal itself calls an email', () => {
  const loginField = field({
    label: 'Login',
    canonicalKey: 'account_username',
    fieldType: 'email',
    required: true,
  });

  it('is answered with the application email on an application form', () => {
    const plan = planFor([loginField]);
    expect(plan.actions[0]?.action).toBe('fill_text');
    expect(plan.actions[0]?.proposedValue).toBe('molhm@example.com');
  });

  it('is left entirely alone on a sign-in page', () => {
    const scan = scanOf([loginField], 'login');
    expect(allowsEmailAsUsername(scan)).toBe(false);
    const plan = buildDeterministicPlan(scan, PROFILE, []);
    expect(plan.actions[0]?.action).toBe('manual_review');
    expect(plan.actions[0]?.proposedValue).toBeUndefined();
  });

  it('is left alone when the page never said the identifier is an email', () => {
    const scan = scanOf(
      [field({ label: 'Username', canonicalKey: 'account_username', required: true })],
      'application_form',
    );
    expect(allowsEmailAsUsername(scan)).toBe(false);
  });
});

function scanOf(fields: readonly DetectedField[], kind = 'application_form') {
  return applicationScanResultSchema.parse({
    id: 'scan-phase3',
    createdAt: NOW,
    url: 'https://careers.example.com/apply',
    domain: 'careers.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic HTML form',
      confidence: 1,
      detectionReason: 'fixture',
      supported: true,
    },
    jobContext: { sourceUrl: 'https://careers.example.com/apply' },
    fields,
    navigation: { kind, actions: [], signals: [] },
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: fields.filter((entry) => entry.required).length,
      optional: fields.filter((entry) => !entry.required).length,
      text: fields.filter((entry) => entry.fieldType === 'text').length,
      textarea: 0,
      select: fields.filter((entry) => entry.fieldType === 'select').length,
      combobox: fields.filter((entry) => entry.fieldType === 'combobox').length,
      radio: 0,
      checkbox: 0,
      file: 0,
    },
    durationMs: 10,
    status: 'completed',
    readOnly: true,
  });
}

function planFor(fields: readonly DetectedField[]) {
  return buildDeterministicPlan(scanOf(fields), PROFILE, []);
}
