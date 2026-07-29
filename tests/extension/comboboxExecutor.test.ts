import { afterEach, describe, expect, it } from 'vitest';
import {
  findListbox,
  readDisplayedValue,
  readOptions,
  resolveTrigger,
  selectComboboxOption,
} from '../../extension/src/executor/comboboxExecutor.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * jsdom reports zero-size rects, so visibility checks would reject everything.
 * Stubbing the rect models a laid-out page; the code under test is unchanged.
 */
function makeVisible(): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width: 120,
      height: 32,
      top: 0,
      left: 0,
      right: 120,
      bottom: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

makeVisible();

/** A Greenhouse-style combobox: a button trigger and a listbox rendered on open. */
function mountCombobox(options: string[], portal = false): HTMLElement {
  document.body.innerHTML = `
    <div class="select" id="country-root">
      <button id="country" role="combobox" aria-expanded="false" aria-controls="country-list" aria-haspopup="listbox">
        <span class="value"></span>
      </button>
    </div>
    ${portal ? '<div id="portal-root"></div>' : ''}
  `;

  const root = document.getElementById('country-root') as HTMLElement;
  const trigger = document.getElementById('country') as HTMLElement;
  const host = portal ? (document.getElementById('portal-root') as HTMLElement) : root;

  trigger.addEventListener('click', () => {
    if (document.getElementById('country-list')) return;
    const list = document.createElement('ul');
    list.id = 'country-list';
    list.setAttribute('role', 'listbox');
    for (const label of options) {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.textContent = label;
      item.addEventListener('click', () => {
        const display = root.querySelector('.value');
        if (display) display.textContent = label;
        item.setAttribute('aria-selected', 'true');
        list.remove();
        trigger.setAttribute('aria-expanded', 'false');
      });
      list.append(item);
    }
    host.append(list);
    trigger.setAttribute('aria-expanded', 'true');
  });

  return root;
}

describe('combobox option discovery', () => {
  it('opens the control and reads the options actually rendered', async () => {
    const root = mountCombobox(['Canada', 'United States of America']);
    const outcome = await selectComboboxOption({
      root,
      proposedValue: 'United States of America',
    });

    expect(outcome.discoveredOptions.map((option) => option.label)).toEqual([
      'Canada',
      'United States of America',
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.matchedLabel).toBe('United States of America');
  });

  it('finds a portal-mounted listbox rendered outside the control', async () => {
    const root = mountCombobox(['Canada', 'United States of America'], true);
    const outcome = await selectComboboxOption({
      root,
      proposedValue: 'United States of America',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.discoveredOptions).toHaveLength(2);
  });

  it('verifies the displayed value after the control rerenders', async () => {
    const root = mountCombobox(['Canada', 'United States of America']);
    const outcome = await selectComboboxOption({ root, proposedValue: 'Canada' });

    expect(outcome.ok).toBe(true);
    expect(outcome.observedValue).toContain('Canada');
    expect(root.querySelector('.value')?.textContent).toBe('Canada');
  });
});

describe('combobox matching safety', () => {
  it('refuses an ambiguous match instead of selecting by index', async () => {
    const root = mountCombobox([
      'Springfield, Illinois, United States',
      'Springfield, Missouri, United States',
    ]);
    const outcome = await selectComboboxOption({
      root,
      proposedValue: 'Springfield',
      allowRegionSuffix: true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/several places/i);
    // Nothing was selected.
    expect(root.querySelector('.value')?.textContent).toBe('');
  });

  it('refuses a value that no option matches', async () => {
    const root = mountCombobox(['Canada', 'Mexico']);
    const outcome = await selectComboboxOption({ root, proposedValue: 'Atlantis' });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('Atlantis');
    expect(root.querySelector('.value')?.textContent).toBe('');
  });

  it('selects an unambiguous region-suffixed option when permitted', async () => {
    const root = mountCombobox([
      'Clifton, New Jersey, United States',
      'Newark, New Jersey, United States',
    ]);
    const outcome = await selectComboboxOption({
      root,
      proposedValue: 'Clifton',
      allowRegionSuffix: true,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.matchedLabel).toBe('Clifton, New Jersey, United States');
  });

  it('reports a control whose list never opens', async () => {
    document.body.innerHTML = '<div id="dead"><button role="combobox">Choose</button></div>';
    const outcome = await selectComboboxOption({
      root: document.getElementById('dead') as HTMLElement,
      proposedValue: 'Anything',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/did not open/i);
  });

  it('refuses a disabled combobox', async () => {
    document.body.innerHTML =
      '<div id="off" aria-disabled="true"><button role="combobox">Choose</button></div>';
    const outcome = await selectComboboxOption({
      root: document.getElementById('off') as HTMLElement,
      proposedValue: 'Anything',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('disabled');
  });
});

describe('combobox helpers', () => {
  it('resolves the inner interactive trigger', () => {
    document.body.innerHTML = '<div id="wrap"><input role="combobox" id="inner" /></div>';
    const trigger = resolveTrigger(document.getElementById('wrap') as HTMLElement);
    expect(trigger.id).toBe('inner');
  });

  it('locates a listbox through aria-controls', () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="list"></button>
      <ul id="list" role="listbox"><li role="option">One</li></ul>`;
    const listbox = findListbox(document.getElementById('t') as HTMLElement);
    expect(listbox?.id).toBe('list');
    // Discovery now records whether each option is disabled or already selected
    // alongside its wording.
    expect(readOptions(listbox as HTMLElement)).toEqual([
      { label: 'One', value: 'One', disabled: false, selected: false, elementFingerprint: 'One' },
    ]);
  });

  it('reads a hidden input value as the displayed value', () => {
    document.body.innerHTML =
      '<div id="r"><button id="b"></button><input type="hidden" value="US" /></div>';
    const value = readDisplayedValue(
      document.getElementById('r') as HTMLElement,
      document.getElementById('b') as HTMLElement,
    );
    expect(value).toBe('US');
  });
});
