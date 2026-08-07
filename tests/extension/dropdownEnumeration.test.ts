import { afterEach, describe, expect, it } from 'vitest';
import { matchDropdownOption } from '@internship-agent/shared';
import { enumerateAllOptions } from '../../extension/src/scanner/optionDiscovery.js';
import { executeDropdown } from '../../extension/src/executor/dropdownEngine.js';

/**
 * Reading the *whole* of a long option list, and answering a question two forms
 * word differently.
 *
 * Both are live failures. A field-of-study list whose answer sat below the fold
 * reported `OPTION_NOT_FOUND` and fell through to the "Other" box with the
 * answer in hand; an "Education Type" list naming degree programmes was offered
 * a value naming a kind of institution and matched nothing at all.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 160,
    height: 24,
    top: 0,
    left: 0,
    right: 160,
    bottom: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

/**
 * A menu that renders only the rows around its scroll position, as a
 * virtualized list does. jsdom has no layout, so the scroll geometry is modelled
 * explicitly — which is the only way this case can exist here at all.
 */
function mountVirtualizedMenu(labels: string[], windowSize = 8): HTMLElement {
  document.body.innerHTML = '<div id="menu" role="listbox"></div>';
  const menu = document.getElementById('menu') as HTMLElement;
  let scrollTop = 0;

  const render = (): void => {
    const first = Math.floor(scrollTop / 24);
    menu.innerHTML = '';
    for (const label of labels.slice(first, first + windowSize)) {
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.textContent = label;
      menu.append(item);
    }
  };

  Object.defineProperty(menu, 'scrollHeight', { get: () => labels.length * 24 });
  Object.defineProperty(menu, 'clientHeight', { get: () => windowSize * 24 });
  Object.defineProperty(menu, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, labels.length * 24 - windowSize * 24));
      render();
    },
  });

  render();
  return menu;
}

describe('reading a complete option list', () => {
  it('scrolls a virtualized menu until it stops producing new options', async () => {
    const labels = Array.from({ length: 60 }, (_, index) => `Option ${index}`);
    const menu = mountVirtualizedMenu(labels);

    // Only the first screenful exists before it is read.
    expect(menu.querySelectorAll('[role="option"]').length).toBe(8);

    const options = await enumerateAllOptions(menu);
    expect(options.map((option) => option.label)).toEqual(labels);
  });

  it('puts the menu back where it found it', async () => {
    const menu = mountVirtualizedMenu(Array.from({ length: 40 }, (_, i) => `Option ${i}`));
    await enumerateAllOptions(menu);
    expect(menu.scrollTop).toBe(0);
  });

  it('costs one read on a list that is already complete', async () => {
    document.body.innerHTML = `
      <div id="menu" role="listbox">
        <div role="option">Alpha</div>
        <div role="option">Beta</div>
      </div>`;
    const options = await enumerateAllOptions(document.getElementById('menu') as HTMLElement);
    expect(options.map((option) => option.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('an answer that sits far below the fold', () => {
  it('is found and selected', async () => {
    const labels = ['Other/Not Listed', 'Accounting'];
    for (let index = 0; index < 40; index += 1) labels.push(`Filler Discipline ${index}`);
    labels.push('Electrical Engineering');

    document.body.innerHTML = `
      <div id="root">
        <button id="t" role="combobox" aria-expanded="false" aria-controls="menu">
          <span data-selected-label></span>
        </button>
      </div>`;
    const root = document.getElementById('root') as HTMLElement;
    const trigger = document.getElementById('t') as HTMLElement;
    trigger.addEventListener('click', () => {
      if (document.getElementById('menu')) return;
      const menu = mountVirtualizedMenuInto(root, labels);
      menu.addEventListener('click', (event) => {
        const item = (event.target as HTMLElement).closest('[role="option"]');
        if (!item) return;
        root.querySelector('[data-selected-label]')!.textContent = item.textContent;
        menu.remove();
      });
    });

    const result = await executeDropdown({
      fieldId: 'field-area',
      root,
      desiredSemanticValue: 'Electrical Engineering',
      allowOtherFallback: true,
    });

    expect(result.verified).toBe(true);
    expect(result.matchedOptionText).toBe('Electrical Engineering');
    // Emphatically not the escape hatch, which was the live outcome.
    expect(result.matchedOptionText).not.toBe('Other/Not Listed');
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('Electrical Engineering');
  });
});

/** The same virtualized menu, mounted inside a given root and given an id. */
function mountVirtualizedMenuInto(root: HTMLElement, labels: string[]): HTMLElement {
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.setAttribute('role', 'listbox');
  root.append(menu);
  const windowSize = 8;
  let scrollTop = 0;
  const render = (): void => {
    const first = Math.floor(scrollTop / 24);
    menu.innerHTML = '';
    for (const label of labels.slice(first, first + windowSize)) {
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.textContent = label;
      menu.append(item);
    }
  };
  Object.defineProperty(menu, 'scrollHeight', { get: () => labels.length * 24 });
  Object.defineProperty(menu, 'clientHeight', { get: () => windowSize * 24 });
  Object.defineProperty(menu, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, labels.length * 24 - windowSize * 24));
      render();
    },
  });
  render();
  return menu;
}

describe('a question two forms word differently', () => {
  const PROGRAMMES = [
    'No Selection',
    'High School or GED',
    'Trade or Vocational',
    'Associate Degree Program (or equivalent)',
    "Bachelor's Degree Program (or equivalent)",
    "Master's Degree Program (or equivalent)",
  ].map((label) => ({ label, value: label.toLowerCase().replace(/\W+/g, '_') }));

  const INSTITUTIONS = ['No Selection', 'High School', 'College/University', 'Trade School'].map(
    (label) => ({ label, value: label.toLowerCase().replace(/\W+/g, '_') }),
  );

  it('answers a degree-programme list from the degree', () => {
    const outcome = matchDropdownOption({
      desiredSemanticValue: "Bachelor's Degree",
      options: PROGRAMMES,
    });
    expect(outcome.option?.label).toBe("Bachelor's Degree Program (or equivalent)");
  });

  it('does not answer an institution list from the degree alone', () => {
    // Which is exactly why the engine is given both readings of the record.
    const outcome = matchDropdownOption({
      desiredSemanticValue: "Bachelor's Degree",
      options: INSTITUTIONS,
    });
    expect(outcome.option).toBeUndefined();
  });

  it('selects from an institution list once the alternative reading is offered', async () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="">No Selection</option>
        <option value="hs">High School</option>
        <option value="col">College/University</option>
        <option value="trade">Trade School</option>
      </select>`;
    const result = await executeDropdown({
      fieldId: 'field-education-type',
      root: document.getElementById('s') as HTMLElement,
      desiredSemanticValue: "Bachelor's Degree",
      alternativeValues: ['College/University'],
    });

    expect(result.verified).toBe(true);
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('col');
  });

  it('prefers the first reading when the list offers it', async () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="">No Selection</option>
        <option value="bach">Bachelor's Degree Program (or equivalent)</option>
        <option value="col">College/University</option>
      </select>`;
    const result = await executeDropdown({
      fieldId: 'field-education-type',
      root: document.getElementById('s') as HTMLElement,
      desiredSemanticValue: "Bachelor's Degree",
      alternativeValues: ['College/University'],
    });

    expect(result.verified).toBe(true);
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('bach');
  });

  it('never reaches Other while a real reading still matches', async () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="">No Selection</option>
        <option value="col">College/University</option>
        <option value="other">Other</option>
      </select>`;
    const result = await executeDropdown({
      fieldId: 'field-education-type',
      root: document.getElementById('s') as HTMLElement,
      desiredSemanticValue: "Bachelor's Degree",
      alternativeValues: ['College/University'],
      allowOtherFallback: true,
    });

    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('col');
    expect(result.matchedOptionText).not.toBe('Other');
  });
});
