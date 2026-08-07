import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyDropdown,
  executeDropdown,
  executeDropdownWithRetry,
  readSelectedText,
} from '../../extension/src/executor/dropdownEngine.js';
import {
  findListbox,
  readOptions,
  resolveTrigger,
} from '../../extension/src/scanner/optionDiscovery.js';

/**
 * The universal dropdown engine, driven the way the executor drives it.
 *
 * Every widget shape here is one that failed on a real application: a native
 * select rebuilt by its parent, an ARIA combobox, a button-driven menu, a menu
 * mounted into a portal, a searchable list, and a list that does not exist until
 * the control is opened. The assertions are about *observed control state*
 * afterwards — a call that returned without throwing has never been evidence
 * that a field was filled.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * jsdom reports zero-size rects, so visibility checks would reject everything.
 * Stubbing the rect models a laid-out page; the code under test is unchanged.
 */
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

describe('dropdown classification', () => {
  it('tells a native select from a custom one', () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    expect(classifyDropdown(document.getElementById('s') as HTMLElement)).toBe('native_select');
  });

  it('tells a typed-into combobox from a clicked one', () => {
    document.body.innerHTML = `
      <div id="typed"><input role="combobox" aria-autocomplete="list" /></div>
      <div id="clicked"><button role="combobox"></button></div>`;
    expect(classifyDropdown(document.getElementById('typed') as HTMLElement)).toBe(
      'searchable_combobox',
    );
    expect(classifyDropdown(document.getElementById('clicked') as HTMLElement)).toBe(
      'aria_combobox',
    );
  });

  it('recognises a button that opens a menu', () => {
    document.body.innerHTML = '<div id="m"><button aria-haspopup="menu">Choose</button></div>';
    expect(classifyDropdown(document.getElementById('m') as HTMLElement)).toBe('button_menu');
  });
});

describe('native select execution', () => {
  it('selects an option and verifies the control holds it', async () => {
    document.body.innerHTML = `
      <select id="country">
        <option value="">Select</option>
        <option value="CA">Canada</option>
        <option value="US">United States of America</option>
      </select>`;
    const select = document.getElementById('country') as HTMLSelectElement;
    const result = await executeDropdown({
      fieldId: 'field-country',
      root: select,
      desiredSemanticValue: 'United States',
      canonicalQuestion: 'country',
    });

    expect(result.verified).toBe(true);
    expect(result.dropdownKind).toBe('native_select');
    expect(result.matchedOptionText).toBe('United States of America');
    // Observed state, not a return value.
    expect(select.value).toBe('US');
    expect(select.selectedOptions[0]?.textContent).toBe('United States of America');
  });

  it('reads the options the control offers now, not the ones it offered before', async () => {
    document.body.innerHTML = '<select id="state"><option value="">Select</option></select>';
    const select = document.getElementById('state') as HTMLSelectElement;
    // The page rebuilds the list after its parent is chosen — exactly what a
    // Country → State cascade does, and what a scan snapshot cannot know.
    select.innerHTML =
      '<option value="">Select</option><option value="NJ">New Jersey</option><option value="NY">New York</option>';

    const result = await executeDropdown({
      fieldId: 'field-state',
      root: select,
      desiredSemanticValue: 'New Jersey',
      canonicalQuestion: 'state',
    });

    expect(result.verified).toBe(true);
    expect(select.value).toBe('NJ');
  });

  it('reports a list that still holds nothing but a prompt as a dependency', async () => {
    document.body.innerHTML =
      '<select id="state"><option value="">Select a country first</option></select>';
    const result = await executeDropdown({
      fieldId: 'field-state',
      root: document.getElementById('state') as HTMLElement,
      desiredSemanticValue: 'New Jersey',
      canonicalQuestion: 'state',
      dependsOnAnotherField: true,
    });

    expect(result.verified).toBe(false);
    expect(result.failureCode).toBe('DEPENDENT_CONTROL_NOT_REFRESHED');
  });

  it('reports a known answer the list does not offer as OPTION_NOT_FOUND', async () => {
    document.body.innerHTML = `
      <select id="c"><option value="">Select</option><option value="CA">Canada</option></select>`;
    const result = await executeDropdown({
      fieldId: 'field-c',
      root: document.getElementById('c') as HTMLElement,
      desiredSemanticValue: 'Atlantis',
      canonicalQuestion: 'country',
    });

    expect(result.failureCode).toBe('OPTION_NOT_FOUND');
    expect((document.getElementById('c') as HTMLSelectElement).value).toBe('');
  });

  it('leaves a control that already holds the answer exactly as it is', async () => {
    document.body.innerHTML = `
      <select id="c"><option value="CA">Canada</option><option value="US" selected>United States</option></select>`;
    const select = document.getElementById('c') as HTMLSelectElement;
    let changes = 0;
    select.addEventListener('change', () => {
      changes += 1;
    });

    const result = await executeDropdown({
      fieldId: 'field-c',
      root: select,
      desiredSemanticValue: 'United States',
      canonicalQuestion: 'country',
    });

    expect(result.verified).toBe(true);
    // A redundant `change` is what made a page rebuild its region list and throw
    // away the state chosen moments earlier.
    expect(changes).toBe(0);
  });
});

describe('country to state cascade', () => {
  it('fills State from the list the page produces after Country is chosen', async () => {
    document.body.innerHTML = `
      <select id="country"><option value="">Select</option><option value="US">United States</option></select>
      <select id="state"><option value="">Select a country first</option></select>`;
    const country = document.getElementById('country') as HTMLSelectElement;
    const state = document.getElementById('state') as HTMLSelectElement;
    country.addEventListener('change', () => {
      // The page replaces the whole control, so every reference taken before now
      // is stale — which is why the engine re-queries and re-reads.
      const replacement = document.createElement('select');
      replacement.id = 'state';
      replacement.innerHTML =
        '<option value="">Select</option><option value="NJ">New Jersey</option><option value="NY">New York</option>';
      state.replaceWith(replacement);
    });

    const first = await executeDropdown({
      fieldId: 'field-country',
      root: country,
      desiredSemanticValue: 'United States',
      canonicalQuestion: 'country',
    });
    expect(first.verified).toBe(true);

    const refreshed = document.getElementById('state') as HTMLSelectElement;
    const second = await executeDropdown({
      fieldId: 'field-state',
      root: refreshed,
      desiredSemanticValue: 'New Jersey',
      canonicalQuestion: 'state',
    });

    expect(second.verified).toBe(true);
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('NJ');
  });
});

describe('custom dropdown execution', () => {
  it('opens the control, reads what it rendered, and selects it', async () => {
    const root = mountCombobox(['Canada', 'United States of America']);
    const result = await executeDropdown({
      fieldId: 'field-country',
      root,
      desiredSemanticValue: 'United States of America',
      canonicalQuestion: 'country',
    });

    expect(result.verified).toBe(true);
    expect(result.optionCount).toBe(2);
    expect(result.matchedOptionText).toBe('United States of America');
    expect(root.querySelector('.value')?.textContent).toBe('United States of America');
  });

  it('finds a menu mounted into a portal outside the control', async () => {
    const root = mountCombobox(['Canada', 'United States of America'], true);
    const result = await executeDropdown({
      fieldId: 'field-country',
      root,
      desiredSemanticValue: 'Canada',
      canonicalQuestion: 'country',
    });

    expect(result.verified).toBe(true);
    expect(root.querySelector('.value')?.textContent).toBe('Canada');
  });

  it('drives a button-driven menu of role=menuitem entries', async () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="t" aria-haspopup="menu" aria-expanded="false" aria-controls="menu"></button>
        <span data-selected-label></span>
      </div>`;
    const root = document.getElementById('root') as HTMLElement;
    const trigger = document.getElementById('t') as HTMLElement;
    trigger.addEventListener('mousedown', () => {
      if (document.getElementById('menu')) return;
      const menu = document.createElement('div');
      menu.id = 'menu';
      menu.setAttribute('role', 'menu');
      for (const label of ['Full-Time', 'Internship', 'Part-Time']) {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', () => {
          root.querySelector('[data-selected-label]')!.textContent = label;
          menu.remove();
          trigger.setAttribute('aria-expanded', 'false');
        });
        menu.append(item);
      }
      root.append(menu);
      trigger.setAttribute('aria-expanded', 'true');
    });

    const result = await executeDropdown({
      fieldId: 'field-employment-type',
      root,
      desiredSemanticValue: 'Internship',
    });

    expect(result.dropdownKind).toBe('button_menu');
    expect(result.verified).toBe(true);
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('Internship');
  });

  it('types into a searchable control and picks from what it filters to', async () => {
    document.body.innerHTML = `
      <div id="root">
        <input id="t" role="combobox" aria-autocomplete="list" aria-controls="list" aria-expanded="false" />
        <ul id="list" role="listbox"></ul>
      </div>`;
    const input = document.getElementById('t') as HTMLInputElement;
    const list = document.getElementById('list') as HTMLElement;
    const schools = ['Rutgers University', 'Rowan University', 'Princeton University'];
    input.addEventListener('input', () => {
      list.innerHTML = '';
      const query = input.value.toLowerCase();
      for (const label of schools.filter((name) => name.toLowerCase().includes(query))) {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.textContent = label;
        item.addEventListener('click', () => {
          input.value = label;
          list.innerHTML = '';
        });
        list.append(item);
      }
      input.setAttribute('aria-expanded', 'true');
    });

    const result = await executeDropdown({
      fieldId: 'field-school',
      root: document.getElementById('root') as HTMLElement,
      desiredSemanticValue: 'Rutgers University',
      searchText: 'Rutgers',
    });

    expect(result.dropdownKind).toBe('searchable_combobox');
    expect(result.verified).toBe(true);
    expect(input.value).toBe('Rutgers University');
  });

  it('waits for a menu that mounts empty and fills a frame later', async () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="t" role="combobox" aria-controls="lazy" aria-expanded="false"><span class="value"></span></button>
      </div>`;
    const root = document.getElementById('root') as HTMLElement;
    const trigger = document.getElementById('t') as HTMLElement;
    trigger.addEventListener('click', () => {
      if (document.getElementById('lazy')) return;
      const list = document.createElement('ul');
      list.id = 'lazy';
      list.setAttribute('role', 'listbox');
      root.append(list);
      trigger.setAttribute('aria-expanded', 'true');
      setTimeout(() => {
        for (const label of ['Yes', 'No']) {
          const item = document.createElement('li');
          item.setAttribute('role', 'option');
          item.textContent = label;
          item.addEventListener('click', () => {
            root.querySelector('.value')!.textContent = label;
            list.remove();
          });
          list.append(item);
        }
      }, 60);
    });

    const result = await executeDropdown({
      fieldId: 'field-graduated',
      root,
      desiredSemanticValue: 'Yes',
    });

    expect(result.verified).toBe(true);
    expect(root.querySelector('.value')?.textContent).toBe('Yes');
  });
});

describe('dropdown safety', () => {
  it('refuses an ambiguous match instead of selecting by position', async () => {
    const root = mountCombobox([
      'Springfield, Illinois, United States',
      'Springfield, Missouri, United States',
    ]);
    const result = await executeDropdown({
      fieldId: 'field-city',
      root,
      desiredSemanticValue: 'Springfield',
      canonicalQuestion: 'city',
    });

    expect(result.verified).toBe(false);
    expect(result.failureCode).toBe('AMBIGUOUS_OPTION_MATCH');
    expect(root.querySelector('.value')?.textContent).toBe('');
  });

  it('selects an unambiguous region-suffixed option', async () => {
    const root = mountCombobox([
      'Clifton, New Jersey, United States',
      'Newark, New Jersey, United States',
    ]);
    const result = await executeDropdown({
      fieldId: 'field-city',
      root,
      desiredSemanticValue: 'Clifton',
      canonicalQuestion: 'city',
    });

    expect(result.verified).toBe(true);
    expect(result.matchedOptionText).toBe('Clifton, New Jersey, United States');
  });

  it('reports a control whose list never opens', async () => {
    document.body.innerHTML = '<div id="dead"><button role="combobox">Choose</button></div>';
    const result = await executeDropdown({
      fieldId: 'field-dead',
      root: document.getElementById('dead') as HTMLElement,
      desiredSemanticValue: 'Anything',
    });

    expect(result.failureCode).toBe('OPEN_FAILED');
  });

  it('refuses a disabled control', async () => {
    document.body.innerHTML =
      '<div id="off" aria-disabled="true"><button role="combobox">Choose</button></div>';
    const result = await executeDropdown({
      fieldId: 'field-off',
      root: document.getElementById('off') as HTMLElement,
      desiredSemanticValue: 'Anything',
    });

    expect(result.failureCode).toBe('CONTROL_DISABLED');
  });

  it('calls an unknown answer ANSWER_UNKNOWN rather than a failed write', async () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    const result = await executeDropdown({
      fieldId: 'field-s',
      root: document.getElementById('s') as HTMLElement,
      desiredSemanticValue: '   ',
    });

    expect(result.failureCode).toBe('ANSWER_UNKNOWN');
    expect(result.executionAttempted).toBe(false);
  });

  it('lets the next dropdown run after one fails', async () => {
    document.body.innerHTML = `
      <div id="broken"><button role="combobox">Choose</button></div>
      <select id="after"><option value="">Select</option><option value="NJ">New Jersey</option></select>`;

    const failed = await executeDropdown({
      fieldId: 'field-broken',
      root: document.getElementById('broken') as HTMLElement,
      desiredSemanticValue: 'Anything',
    });
    const after = await executeDropdown({
      fieldId: 'field-after',
      root: document.getElementById('after') as HTMLElement,
      desiredSemanticValue: 'New Jersey',
      canonicalQuestion: 'state',
    });

    expect(failed.verified).toBe(false);
    // The failure above must cost the field below nothing.
    expect(after.verified).toBe(true);
    expect((document.getElementById('after') as HTMLSelectElement).value).toBe('NJ');
  });

  it('re-resolves the control before its one retry', async () => {
    document.body.innerHTML = '<div id="dead"><button role="combobox">Choose</button></div>';
    let resolves = 0;
    const result = await executeDropdownWithRetry(
      {
        fieldId: 'field-dead',
        root: document.getElementById('dead') as HTMLElement,
        desiredSemanticValue: 'Anything',
      },
      () => {
        resolves += 1;
        return document.getElementById('dead');
      },
    );

    expect(result.failureCode).toBe('OPEN_FAILED');
    expect(resolves).toBe(1);
  });
});

describe('dropdown helpers', () => {
  it('resolves the inner interactive trigger', () => {
    document.body.innerHTML = '<div id="wrap"><input role="combobox" id="inner" /></div>';
    expect(resolveTrigger(document.getElementById('wrap') as HTMLElement).id).toBe('inner');
  });

  it('locates a listbox through aria-controls and records each option', () => {
    document.body.innerHTML = `
      <button id="t" aria-controls="list"></button>
      <ul id="list" role="listbox"><li role="option">One</li></ul>`;
    const listbox = findListbox(document.getElementById('t') as HTMLElement);
    expect(listbox?.id).toBe('list');
    expect(readOptions(listbox as HTMLElement)).toEqual([
      { label: 'One', value: 'One', disabled: false, selected: false, elementFingerprint: 'One' },
    ]);
  });

  it('reads a hidden input value as the displayed value', () => {
    document.body.innerHTML =
      '<div id="r"><button id="b"></button><input type="hidden" value="US" /></div>';
    expect(readSelectedText(document.getElementById('r') as HTMLElement)).toBe('US');
  });
});
