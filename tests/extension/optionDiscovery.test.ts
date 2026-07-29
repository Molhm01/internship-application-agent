import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetectedField } from '@internship-agent/shared';
import {
  controlTypeFor,
  discoverLiveOptions,
  findListbox,
  readOptions,
  selectableOptions,
} from '../../extension/src/scanner/optionDiscovery.js';

/**
 * jsdom reports zero-size rects, so visibility checks would reject everything.
 * Stubbing the rect models a laid-out page; the code under test is unchanged.
 */
function makeVisible(): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const hidden =
        this.style.display === 'none' ||
        this.hasAttribute('hidden') ||
        this.dataset.testHidden === 'true';
      return hidden
        ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
        : { width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24 };
    },
  });
}

beforeEach(makeVisible);
afterEach(() => {
  document.body.innerHTML = '';
});

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    pageId: 'page-1',
    label: 'Question',
    normalizedLabel: 'question',
    question: 'Question',
    fieldType: 'combobox',
    selector: '#control',
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: [],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

describe('live option extraction', () => {
  it('reads every option a native select already carries', async () => {
    document.body.innerHTML = `
      <select id="control">
        <option value="">Select…</option>
        <option value="us" selected>United States</option>
        <option value="ca">Canada</option>
      </select>`;
    const element = document.getElementById('control')!;
    const set = await discoverLiveOptions(field({ fieldType: 'select' }), element);

    expect(set.controlType).toBe('native_select');
    expect(set.opened).toBe(false);
    expect(set.options.map((option) => option.label)).toEqual([
      'Select…',
      'United States',
      'Canada',
    ]);
    expect(set.options.find((option) => option.label === 'United States')?.selected).toBe(true);
  });

  it('marks disabled options rather than dropping them, and excludes them from selection', async () => {
    document.body.innerHTML = `
      <select id="control">
        <option value="" disabled selected>Choose one</option>
        <option value="a">Answer A</option>
      </select>`;
    const set = await discoverLiveOptions(
      field({ fieldType: 'select' }),
      document.getElementById('control') as HTMLElement,
    );

    expect(set.options).toHaveLength(2);
    expect(set.options[0]?.disabled).toBe(true);
    // The placeholder is visible evidence, but never a choice.
    expect(selectableOptions(set).map((option) => option.label)).toEqual(['Answer A']);
  });

  it('excludes hidden options from a listbox', () => {
    document.body.innerHTML = `
      <ul id="list" role="listbox">
        <li role="option">Visible</li>
        <li role="option" data-test-hidden="true">Hidden</li>
        <li role="option" aria-hidden="true">Aria hidden</li>
      </ul>`;
    const options = readOptions(document.getElementById('list') as HTMLElement);
    expect(options.map((option) => option.label)).toEqual(['Visible']);
  });

  it('suppresses an option rendered twice', async () => {
    document.body.innerHTML = `
      <div id="control" role="combobox" aria-controls="list"></div>
      <ul id="list" role="listbox">
        <li role="option">Canada</li>
        <li role="option">Canada</li>
        <li role="option">Mexico</li>
      </ul>`;
    const set = await discoverLiveOptions(
      field(),
      document.getElementById('control') as HTMLElement,
    );
    expect(set.options.map((option) => option.label)).toEqual(['Canada', 'Mexico']);
  });

  it('records the option label and value exactly as the page wrote them', async () => {
    document.body.innerHTML = `
      <div id="control" role="combobox" aria-controls="list"></div>
      <ul id="list" role="listbox">
        <li role="option" data-value="US">  United   States of America </li>
      </ul>`;
    const set = await discoverLiveOptions(
      field(),
      document.getElementById('control') as HTMLElement,
    );
    // Whitespace is collapsed; the wording itself is untouched.
    expect(set.options[0]?.label).toBe('United States of America');
    expect(set.options[0]?.value).toBe('US');
  });
});

describe('associating a listbox with its own control', () => {
  it('finds the listbox named by aria-controls', () => {
    document.body.innerHTML = `
      <button id="trigger" aria-controls="mine"></button>
      <ul id="mine" role="listbox"><li role="option">Right</li></ul>
      <ul id="theirs" role="listbox"><li role="option">Wrong</li></ul>`;
    const listbox = findListbox(document.getElementById('trigger') as HTMLElement);
    expect(listbox?.id).toBe('mine');
  });

  it('finds a portal-mounted listbox rendered far from its trigger', async () => {
    document.body.innerHTML = `
      <form><div id="control" role="combobox" aria-controls="portal-list"></div></form>
      <div id="portal"><ul id="portal-list" role="listbox">
        <li role="option">Portal option</li>
      </ul></div>`;
    const set = await discoverLiveOptions(
      field(),
      document.getElementById('control') as HTMLElement,
    );
    expect(set.options.map((option) => option.label)).toEqual(['Portal option']);
    expect(set.listboxId).toBe('portal-list');
  });

  it('never reads a listbox left open by a different field', () => {
    // A control that names its own listbox has said which element is its list.
    // When that element is absent the control is closed, and another field's
    // open list must not stand in for it — doing so answered one question from
    // the previous question's choices.
    document.body.innerHTML = `
      <div id="mine" role="combobox" aria-controls="my-list"></div>
      <div id="portal">
        <ul id="someone-elses-list" role="listbox">
          <li role="option">Their option</li>
        </ul>
      </div>`;
    expect(findListbox(document.getElementById('mine') as HTMLElement)).toBeNull();
  });

  it('refuses to read a dropdown belonging to another field', () => {
    // Two listboxes open, neither tied to this trigger by ARIA. Guessing which
    // one belongs to the control would fill a field from someone else's list.
    document.body.innerHTML = `
      <div><button id="trigger"></button></div>
      <ul id="one" role="listbox"><li role="option">A</li></ul>
      <ul id="two" role="listbox"><li role="option">B</li></ul>`;
    expect(findListbox(document.getElementById('trigger') as HTMLElement)).toBeNull();
  });

  it('reports the failure instead of inventing options when nothing opens', async () => {
    document.body.innerHTML = `<div id="control" role="combobox"></div>`;
    const set = await discoverLiveOptions(
      field(),
      document.getElementById('control') as HTMLElement,
    );
    expect(set.options).toEqual([]);
    expect(set.warnings.join(' ')).toContain('did not open');
  });
});

describe('grouped inputs', () => {
  it('reads a radio group from its inputs and labels', async () => {
    document.body.innerHTML = `
      <fieldset>
        <input type="radio" id="r1" name="q" value="yes" checked />
        <label for="r1">Yes, I am authorized</label>
        <input type="radio" id="r2" name="q" value="no" />
        <label for="r2">No, I am not</label>
      </fieldset>`;
    const inputs = Array.from(document.querySelectorAll<HTMLElement>('input[type="radio"]'));
    const set = await discoverLiveOptions(field({ fieldType: 'radio' }), inputs[0] as HTMLElement, {
      groupElements: inputs,
    });

    expect(set.controlType).toBe('radio_group');
    expect(set.options.map((option) => option.label)).toEqual([
      'Yes, I am authorized',
      'No, I am not',
    ]);
    expect(set.options[0]?.selected).toBe(true);
  });

  it('reads a checkbox group as a multi-answer control', async () => {
    document.body.innerHTML = `
      <fieldset>
        <input type="checkbox" id="c1" name="q" value="a" />
        <label for="c1">Option A</label>
        <input type="checkbox" id="c2" name="q" value="b" disabled />
        <label for="c2">Option B</label>
      </fieldset>`;
    const inputs = Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"]'));
    const set = await discoverLiveOptions(
      field({ fieldType: 'multi_select' }),
      inputs[0] as HTMLElement,
      { groupElements: inputs },
    );

    expect(set.controlType).toBe('checkbox_group');
    expect(set.options).toHaveLength(2);
    expect(selectableOptions(set).map((option) => option.label)).toEqual(['Option A']);
  });
});

describe('control classification', () => {
  it('recognizes a searchable autocomplete', () => {
    document.body.innerHTML = `
      <input id="control" role="combobox" aria-autocomplete="list" />`;
    const element = document.getElementById('control')!;
    expect(controlTypeFor(field(), element)).toBe('autocomplete');
  });

  it('recognizes a multiple native select', () => {
    document.body.innerHTML = `<select id="control" multiple></select>`;
    const element = document.getElementById('control')!;
    expect(controlTypeFor(field({ fieldType: 'multi_select' }), element)).toBe('multi_select');
  });

  it('treats an unclassified custom control as a combobox', () => {
    document.body.innerHTML = `<div id="control" role="combobox"></div>`;
    const element = document.getElementById('control')!;
    expect(controlTypeFor(field(), element)).toBe('combobox');
  });
});

describe('discovery leaves the page as it found it', () => {
  /** A control that renders its list only when clicked, as React ones do. */
  function mountOnClickCombobox(): HTMLElement {
    document.body.innerHTML = `
      <div id="control" role="combobox" aria-controls="list" aria-expanded="false"></div>
      <div id="portal"></div>`;
    const element = document.getElementById('control')!;
    element.addEventListener('click', () => {
      const list = document.createElement('ul');
      list.id = 'list';
      list.setAttribute('role', 'listbox');
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.textContent = 'A';
      list.append(item);
      document.getElementById('portal')?.append(list);
      element.setAttribute('aria-expanded', 'true');
    });
    return element;
  }

  it('closes a control it opened when no selection follows', async () => {
    const element = mountOnClickCombobox();
    let escaped = false;
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escaped = true;
    });

    const set = await discoverLiveOptions(field(), element);
    expect(set.options.map((option) => option.label)).toEqual(['A']);
    expect(escaped).toBe(true);
  });

  it('leaves a control the user already opened alone', async () => {
    // Closing it would be a side effect of a read, and would discard whatever
    // the user was in the middle of doing.
    document.body.innerHTML = `
      <div id="control" role="combobox" aria-controls="list" aria-expanded="true"></div>
      <ul id="list" role="listbox"><li role="option">A</li></ul>`;
    const element = document.getElementById('control')!;
    let escaped = false;
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escaped = true;
    });

    await discoverLiveOptions(field(), element);
    expect(escaped).toBe(false);
  });

  it('keeps the control open when a selection is about to be made', async () => {
    const element = mountOnClickCombobox();
    let escaped = false;
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escaped = true;
    });

    await discoverLiveOptions(field(), element, { keepOpen: true });
    expect(escaped).toBe(false);
  });
});
