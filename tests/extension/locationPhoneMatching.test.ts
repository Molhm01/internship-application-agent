import { describe, expect, it } from 'vitest';
import {
  canonicalStateName,
  dialCodeForCountry,
  locationSearchText,
  matchLocationOption,
  matchOption,
  splitPhoneNumber,
  type FieldOption,
  type LocationTarget,
} from '@internship-agent/shared';

/**
 * The saved profile from the repair brief: Clifton, New Jersey, United States,
 * phone +1 929 264 3117.
 */
const PROFILE: LocationTarget = {
  city: 'Clifton',
  state: 'New Jersey',
  country: 'United States',
};

const option = (label: string): FieldOption => ({ label, value: label });

/** The same city offered in five regions, as a real autocomplete does. */
const CLIFTONS: FieldOption[] = [
  option('Clifton, Arizona, United States'),
  option('Clifton, Bristol, United Kingdom'),
  option('Clifton, Colorado, United States'),
  option('Clifton, New Jersey, United States'),
  option('Clifton, Texas, United States'),
  option('Clifton Park, New York, United States'),
];

describe('location matching', () => {
  it('selects the Clifton in the saved state and rejects every other one', () => {
    const result = matchLocationOption(PROFILE, CLIFTONS);

    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe('Clifton, New Jersey, United States');
    expect(result.stateConfirmed).toBe(true);
    expect(result.confidence).toBe('high');
    // Same city, wrong region: named as rejected rather than silently ignored.
    expect(result.rejected.map((entry) => entry.label)).toEqual([
      'Clifton, Arizona, United States',
      'Clifton, Bristol, United Kingdom',
      'Clifton, Colorado, United States',
      'Clifton, Texas, United States',
    ]);
  });

  it('never treats a different city as the saved one', () => {
    const result = matchLocationOption(PROFILE, CLIFTONS);
    expect(result.option?.label).not.toContain('Clifton Park');
  });

  it('matches the abbreviated spelling of the saved state', () => {
    const result = matchLocationOption(PROFILE, [
      option('Clifton, CO, United States'),
      option('Clifton, NJ, United States'),
    ]);
    expect(result.option?.label).toBe('Clifton, NJ, United States');
    expect(result.stateConfirmed).toBe(true);
  });

  it('rejects the right city in the wrong country', () => {
    const result = matchLocationOption(PROFILE, [option('Clifton, Bristol, United Kingdom')]);
    expect(result.matched).toBe(false);
    expect(result.rejected).toHaveLength(1);
    expect(result.reason).toContain('other regions');
  });

  it('asks for confirmation when the option names no region at all', () => {
    const result = matchLocationOption(PROFILE, [option('Clifton')]);
    expect(result.matched).toBe(true);
    expect(result.stateConfirmed).toBe(false);
    expect(result.confidence).toBe('medium');
  });

  it('reports ambiguity rather than choosing between equal candidates', () => {
    const result = matchLocationOption(PROFILE, [
      option('Clifton, New Jersey, United States'),
      option('Clifton, New Jersey, United States (Metro)'),
    ]);
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it('searches on saved values only', () => {
    expect(locationSearchText(PROFILE)).toBe('Clifton, New Jersey');
    expect(locationSearchText({ city: 'Clifton' })).toBe('Clifton');
  });

  it('canonicalizes states without guessing at unknown tokens', () => {
    expect(canonicalStateName('NJ')).toBe('new jersey');
    expect(canonicalStateName('New Jersey')).toBe('new jersey');
    expect(canonicalStateName('Bristol')).toBeNull();
  });
});

describe('phone country code', () => {
  it('derives the dialling code from the saved country, not from the digits', () => {
    expect(dialCodeForCountry('United States')).toBe('+1');
    expect(dialCodeForCountry('USA')).toBe('+1');
    expect(dialCodeForCountry('United Kingdom')).toBe('+44');
    // An unlisted country yields nothing rather than a guess.
    expect(dialCodeForCountry('Latveria')).toBeNull();
    expect(dialCodeForCountry(undefined)).toBeNull();
  });

  it('selects the page option that carries the dialling code', () => {
    const options = [
      option('Canada (+1)'),
      option('India (+91)'),
      option('United Kingdom (+44)'),
      option('United States (+1)'),
    ];
    const result = matchOption('+1', options);
    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe('United States (+1)');
  });

  it('removes the dialling code from the local number when the form splits them', () => {
    const split = splitPhoneNumber('+19292643117', '+1');
    expect(split.dialCode).toBe('+1');
    expect(split.localNumber).toBe('9292643117');
    expect(split.strippedDialCode).toBe(true);
  });

  it('leaves a local number that never carried a dialling code alone', () => {
    const split = splitPhoneNumber('9292643117', '+1');
    expect(split.localNumber).toBe('9292643117');
    expect(split.strippedDialCode).toBe(false);
  });

  it('keeps the whole number when no dialling code is known', () => {
    const split = splitPhoneNumber('+19292643117', null);
    expect(split.localNumber).toBe('+19292643117');
    expect(split.strippedDialCode).toBe(false);
  });
});

describe('decline wording', () => {
  /** Every phrasing the four self-identification questions use in the fixture. */
  const cases: ReadonlyArray<readonly [string, string[]]> = [
    ['Male,Female,Non-binary,I do not wish to self-identify', ['I do not wish to self-identify']],
    ['Yes,No,Choose not to disclose', ['Choose not to disclose']],
    ['I am not a protected veteran,I prefer not to disclose', ['I prefer not to disclose']],
    ['No, I do not have a disability|Prefer not to answer', ['Prefer not to answer']],
  ];

  it.each(cases)('maps a saved decline onto this form’s own wording (%s)', (list, expected) => {
    const options = list.split(/[,|]/).map((label) => option(label.trim()));
    const result = matchOption('Decline to answer', options);
    expect(result.matched).toBe(true);
    expect(result.option?.label).toBe(expected[0]);
  });

  it('never selects a demographic category when declining', () => {
    const options = [option('Male'), option('Female'), option('Non-binary')];
    const result = matchOption('Decline to answer', options);
    expect(result.matched).toBe(false);
    expect(result.option).toBeUndefined();
  });
});
