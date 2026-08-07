import { describe, expect, it } from 'vitest';
import {
  matchDropdownOption,
  matchSemanticOption,
  otherOption,
  realChoices,
  type FieldOption,
} from '@internship-agent/shared';

/**
 * Choosing one of the options a control is offering.
 *
 * The rule under test throughout is that an option is never invented: every
 * assertion below either names a label that appears in the list it was given, or
 * asserts that nothing was chosen.
 */

function options(...labels: string[]): FieldOption[] {
  return labels.map((label) => ({ label, value: label.toLowerCase().replace(/\W+/g, '_') }));
}

describe('placeholder and disabled entries', () => {
  it('drops prompts, and keeps real choices', () => {
    const list: FieldOption[] = [
      { label: 'No Selection', value: '' },
      { label: 'Please select', value: '0' },
      { label: 'New Jersey', value: 'NJ' },
      { label: 'New York', value: 'NY', disabled: true },
    ];
    expect(realChoices(list).map((option) => option.label)).toEqual(['New Jersey']);
  });
});

describe('deterministic aliases', () => {
  const cases: ReadonlyArray<[string, string[], string]> = [
    ['United States', ['Canada', 'United States of America'], 'United States of America'],
    ['USA', ['Canada', 'United States of America'], 'United States of America'],
    ['U.S.', ['Canada', 'United States of America'], 'United States of America'],
    ['New Jersey', ['NJ', 'NY'], 'NJ'],
    ['NJ', ['New Jersey', 'New York'], 'New Jersey'],
    ['Yes', ['True', 'False'], 'True'],
    ['No', ['True', 'False'], 'False'],
    ['Mobile', ['Cell', 'Home', 'Work'], 'Cell'],
    ['Cellular', ['Mobile', 'Home'], 'Mobile'],
    ["Bachelor's", ['Bachelor Degree', 'Master Degree'], 'Bachelor Degree'],
    ['Bachelors', ['Baccalaureate', 'Doctorate', 'Bachelor of Science'], 'Bachelor of Science'],
    ['Internship', ['Intern', 'Full-Time'], 'Intern'],
  ];

  for (const [desired, offered, expected] of cases) {
    it(`matches "${desired}" to "${expected}"`, () => {
      const outcome = matchDropdownOption({
        desiredSemanticValue: desired,
        options: options(...offered),
      });
      expect(outcome.option?.label).toBe(expected);
      expect(outcome.method === 'literal' || outcome.method === 'alias').toBe(true);
    });
  }

  it('folds an accent rather than exploding the word', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Mexico',
      options: options('Canada', 'México'),
    });
    expect(outcome.option?.label).toBe('México');
  });
});

describe('semantic matching, across the offered options only', () => {
  it('chooses the closest category a form actually offers', () => {
    const outcome = matchSemanticOption(
      'Internship Pilot job board',
      options(
        'Employee Referral',
        'Job Board',
        'College Career Center',
        'LinkedIn',
        'Company Website',
        'Other',
      ),
    );
    expect(outcome.option?.label).toBe('Job Board');
    expect(outcome.method).toBe('semantic');
  });

  it('never returns an option the page does not offer', () => {
    const offered = options('Employee Referral', 'LinkedIn', 'Company Website');
    const outcome = matchSemanticOption('Internship Pilot', offered);
    if (outcome.option) {
      expect(offered.map((option) => option.label)).toContain(outcome.option.label);
    } else {
      expect(outcome.method).toBe('none');
    }
  });

  it('refuses to pick between two equally close degrees', () => {
    const outcome = matchSemanticOption(
      'Engineering',
      options('Civil Engineering', 'Chemical Engineering'),
    );
    expect(outcome.option).toBeUndefined();
    expect(outcome.ambiguous).toBe(true);
  });

  it('does not turn one field of study into another', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Electrical Engineering',
      options: options('Nursing', 'History', 'Accounting'),
    });
    expect(outcome.option).toBeUndefined();
  });

  it('matches a field of study the form words differently', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Electrical Engineering',
      options: options('Nursing', 'Electrical and Computer Engineering', 'History'),
    });
    expect(outcome.option?.label).toBe('Electrical and Computer Engineering');
  });
});

describe('the Other fallback', () => {
  it('is not used unless the caller permits it', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Atlantis',
      options: options('Canada', 'Mexico', 'Other'),
    });
    expect(outcome.option).toBeUndefined();
  });

  it('chooses Other for a subject the form does not enumerate', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Electrical Engineering',
      options: options('Nursing', 'History', 'Other'),
      allowOtherFallback: true,
    });
    expect(outcome.option?.label).toBe('Other');
    expect(outcome.method).toBe('other_fallback');
  });

  it('prefers a real match over Other', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Electrical Engineering',
      options: options('Electrical Engineering', 'Other'),
      allowOtherFallback: true,
    });
    expect(outcome.option?.label).toBe('Electrical Engineering');
    expect(outcome.method).toBe('literal');
  });

  it('finds the one Other entry, and refuses an ambiguous pair', () => {
    expect(otherOption(options('A', 'Other'))?.label).toBe('Other');
    expect(otherOption(options('Other', 'Other (please specify)'))).toBeUndefined();
  });
});

describe('locations', () => {
  it('matches a city on its state and country together', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: 'Clifton',
      options: options('Clifton, Colorado, United States', 'Clifton, New Jersey, United States'),
      locationTarget: { city: 'Clifton', state: 'New Jersey', country: 'United States' },
    });
    expect(outcome.option?.label).toBe('Clifton, New Jersey, United States');
  });
});
