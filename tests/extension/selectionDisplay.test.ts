import { beforeEach, describe, expect, it } from 'vitest';
import { displaysSelection, isPlaceholderSelection } from '@internship-agent/shared';
import {
  alreadyDisplays,
  verifyDisplayedSelection,
} from '../../extension/src/dropdown/dropdownVerifier.js';

/**
 * The "No Selection" defect, pinned open.
 *
 * A `Graduated?` control sitting on its own placeholder was asked whether it
 * already displayed "No". "No Selection".includes("No") is true, so the engine
 * skipped the control as already answered and the run reported it verified over
 * a page that visibly said No Selection. Every assertion here exists so that
 * comparison can never come back.
 */

function collected(displayedText: string, value = displayedText) {
  return {
    optionId: 'option-0',
    displayedText,
    value,
    disabled: false,
    selected: false,
    normalizedText: displayedText.toLowerCase(),
  };
}

describe('placeholder detection', () => {
  it.each([
    'No Selection',
    'no selection',
    'Make a Selection',
    'Select',
    'Select...',
    'Select One',
    'Choose',
    'Choose...',
    'Please Select',
    'None Selected',
    '-- Select --',
    '   ',
    '',
    '--',
  ])('treats %j as a prompt rather than an answer', (text) => {
    expect(isPlaceholderSelection(text)).toBe(true);
  });

  it.each(['No', 'Yes', 'New Jersey', 'United States of America', 'Choose not to disclose'])(
    'treats %j as a real answer',
    (text) => {
      expect(isPlaceholderSelection(text)).toBe(false);
    },
  );
});

describe('displaysSelection', () => {
  it('never lets "No Selection" satisfy "No"', () => {
    expect(displaysSelection('No Selection', 'No')).toBe(false);
  });

  it.each([
    ['No Selection', 'No'],
    ['Make a Selection', 'Yes'],
    ['None Selected', 'No'],
    ['-- Select --', 'Select a school'],
    ['Not Applicable', 'No'],
    ['United States Minor Outlying Islands', 'US'],
    ['NJ Transit', 'NJ'],
  ])('refuses %j as evidence of %j', (shown, wanted) => {
    expect(displaysSelection(shown, wanted)).toBe(false);
  });

  it.each([
    ['No', 'No'],
    ['no', 'No'],
    ['Yes', 'Yes'],
    ['New Jersey', 'New Jersey'],
  ])('accepts the exact answer %j for %j', (shown, wanted) => {
    expect(displaysSelection(shown, wanted)).toBe(true);
  });

  it('accepts an explicitly aliased spelling of the same answer', () => {
    expect(displaysSelection('False', 'No')).toBe(true);
    expect(displaysSelection('True', 'Yes')).toBe(true);
  });

  it('accepts the control’s own decoration around the answer', () => {
    expect(displaysSelection('United States of America (US)', 'United States of America')).toBe(
      true,
    );
    expect(displaysSelection('New Jersey ✕', 'New Jersey')).toBe(true);
    expect(displaysSelection('Selected: New Jersey', 'New Jersey')).toBe(true);
  });

  it('accepts a multi-token answer as a contiguous run inside a longer phrase', () => {
    expect(displaysSelection('Clifton, New Jersey, United States', 'New Jersey')).toBe(true);
  });

  it('refuses a short answer found inside a longer phrase', () => {
    // The same rule as above, denied for a two-character answer — which is the
    // whole reason containment was unsafe.
    expect(displaysSelection('Clifton, New Jersey, United States', 'NJ')).toBe(false);
  });

  it('accepts a short answer standing beside a code, and only beside a code', () => {
    // A combined phone widget renders "US +1" and its answer is "+1". The
    // surrounding token is an abbreviation, so the answer is the whole of what
    // the control shows.
    expect(displaysSelection('US +1', '+1')).toBe(true);
    expect(displaysSelection('US +1', 'US')).toBe(true);
    // …and an ordinary word beside it is coincidence, not decoration.
    expect(displaysSelection('NJ Transit', 'NJ')).toBe(false);
    expect(displaysSelection('United States Minor Outlying Islands', 'US')).toBe(false);
    // The mandatory case is unaffected: a placeholder is refused before any of
    // this is reached, whatever it happens to contain.
    expect(displaysSelection('No Selection', 'No')).toBe(false);
  });

  it('uses a directive’s own alternative wordings and never invents them', () => {
    // An unrelated answer is not accepted on similarity…
    expect(displaysSelection('Associate Degree', "Bachelor's Degree")).toBe(false);
    // …but is accepted when the directive itself named it as another wording of
    // the same saved fact.
    expect(
      displaysSelection('Associate Degree', "Bachelor's Degree", {
        aliases: ['Associate Degree'],
      }),
    ).toBe(true);
  });
});

describe('alreadyDisplays, against a real control', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is false for a Graduated? control still showing its placeholder', () => {
    document.body.innerHTML = `
      <label for="graduated">Graduated?</label>
      <select id="graduated">
        <option value="" selected>No Selection</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>`;
    const control = document.getElementById('graduated') as HTMLSelectElement;
    expect(alreadyDisplays(control, 'No')).toBe(false);
  });

  it('is true once the control actually holds No', async () => {
    document.body.innerHTML = `
      <select id="graduated">
        <option value="" selected>No Selection</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>`;
    const control = document.getElementById('graduated') as HTMLSelectElement;
    control.value = 'no';
    expect(alreadyDisplays(control, 'No')).toBe(true);
    const verification = await verifyDisplayedSelection(control, collected('No', 'no'));
    expect(verification.verified).toBe(true);
  });

  it('does not verify a custom control left on its placeholder', async () => {
    document.body.innerHTML = `
      <div id="graduated" role="combobox"><span>No Selection</span></div>`;
    const control = document.getElementById('graduated') as HTMLElement;
    expect(alreadyDisplays(control, 'No')).toBe(false);
    const verification = await verifyDisplayedSelection(control, collected('No', 'no'));
    expect(verification.verified).toBe(false);
    expect(verification.observed).toBe('No Selection');
  });
});
