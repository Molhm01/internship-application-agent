import { beforeEach, describe, expect, it } from 'vitest';
import { executeDropdown } from '../../extension/src/executor/dropdownEngine.js';

/**
 * Strategy C: the widget that only its own key handler can operate.
 *
 * Clicking an option is the right first move and it reaches nearly every
 * dropdown. What it does not reach is the control that listens for `keydown` and
 * nothing else: the pointer sequence lands on the row, the widget ignores it,
 * and the control is left showing nothing at all. At the point of failure that
 * is indistinguishable from a click lost to an animation, so the engine tries
 * the other way of operating the same control before it reports anything.
 *
 * These widgets are deliberately hostile in the specific way the live portal's
 * were: pointer events are not merely unhandled, they are actively ignored.
 * A test whose control accepted a click would pass without the fallback
 * existing, and would therefore be proving nothing.
 */

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 160,
    height: 32,
    top: 0,
    left: 0,
    right: 160,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

interface WidgetOptions {
  /** Entries the menu offers, in the order it renders them. */
  labels: readonly string[];
  /** Whether Enter actually commits. Off models a control nothing can drive. */
  commitsOnEnter?: boolean;
  /** Whether the menu exists before the trigger is pressed. */
  opensOnPointer?: boolean;
}

/**
 * Builds a combobox that can only be driven from the keyboard.
 *
 * It tracks its own highlight through `aria-activedescendant`, moves it on
 * ArrowDown, commits on Enter, and discards every pointer event it receives.
 */
function keyboardOnlyCombobox(options: WidgetOptions): HTMLElement {
  const { labels, commitsOnEnter = true, opensOnPointer = true } = options;

  document.body.innerHTML = `
    <div id="control" class="combobox">
      <button
        id="trigger"
        type="button"
        role="combobox"
        aria-expanded="false"
        aria-controls="menu"
        aria-haspopup="listbox"
      ><span data-selected-label></span></button>
      <div id="menu" role="listbox" hidden></div>
    </div>
  `;

  const root = document.getElementById('control') as HTMLElement;
  const trigger = document.getElementById('trigger') as HTMLButtonElement;
  const menu = document.getElementById('menu') as HTMLElement;
  const display = root.querySelector('[data-selected-label]') as HTMLElement;

  labels.forEach((label, index) => {
    const item = document.createElement('div');
    item.id = `option-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('data-value', label.toLowerCase().replace(/\s+/g, '_'));
    item.textContent = label;
    // The whole point: a click on this row does nothing whatsoever.
    item.addEventListener('click', (event) => event.stopPropagation());
    menu.append(item);
  });

  let highlighted = -1;

  const open = (): void => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };

  if (opensOnPointer) {
    trigger.addEventListener('mousedown', open);
  }

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      if (menu.hidden) open();
      highlighted = Math.min(highlighted + 1, labels.length - 1);
      trigger.setAttribute('aria-activedescendant', `option-${highlighted}`);
      return;
    }
    if (event.key === 'Enter' && commitsOnEnter && highlighted >= 0) {
      display.textContent = labels[highlighted] ?? '';
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    if (event.key === 'Escape') {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      // The cursor dies with the menu. A highlight is not an answer, and a
      // widget that kept advertising the last row it hovered would be telling
      // the page it had been given a value nobody chose.
      highlighted = -1;
      trigger.removeAttribute('aria-activedescendant');
    }
  });

  return root;
}

const STATES = ['Alabama', 'California', 'New Jersey', 'New York', 'Texas'] as const;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a dropdown that ignores clicks and commits only on Enter', () => {
  it('selects the right option by walking to it with the arrow keys', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES] });

    const result = await executeDropdown({
      fieldId: 'state',
      root,
      desiredSemanticValue: 'New Jersey',
      canonicalQuestion: 'state',
    });

    expect(result.verified).toBe(true);
    expect(result.matchedOptionText).toBe('New Jersey');
    // The control's own displayed state, not the result object's opinion of it.
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('New Jersey');
  });

  it('leaves the widget closed once it has chosen', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES] });
    await executeDropdown({ fieldId: 'state', root, desiredSemanticValue: 'Texas' });

    expect(document.getElementById('trigger')?.getAttribute('aria-expanded')).toBe('false');
    expect((document.getElementById('menu') as HTMLElement).hidden).toBe(true);
  });

  it('walks to the first entry as readily as the last', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES] });
    await executeDropdown({ fieldId: 'state', root, desiredSemanticValue: 'Alabama' });

    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('Alabama');
  });

  it('resolves an abbreviation through the same walk', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES] });
    const result = await executeDropdown({
      fieldId: 'state',
      root,
      desiredSemanticValue: 'NJ',
      canonicalQuestion: 'state',
    });

    expect(result.verified).toBe(true);
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('New Jersey');
  });

  it('opens from the keyboard when the pointer will not open it either', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES], opensOnPointer: false });
    const result = await executeDropdown({
      fieldId: 'state',
      root,
      desiredSemanticValue: 'California',
    });

    expect(result.verified).toBe(true);
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('California');
  });
});

describe('the bounds on the walk', () => {
  it('reports an honest failure rather than pressing keys forever', async () => {
    // Highlights on ArrowDown but never commits: there is no way to drive this
    // control, and the engine has to say so instead of walking indefinitely.
    const root = keyboardOnlyCombobox({ labels: [...STATES], commitsOnEnter: false });

    const result = await executeDropdown({
      fieldId: 'state',
      root,
      desiredSemanticValue: 'New Jersey',
    });

    expect(result.verified).toBe(false);
    expect(result.executionAttempted).toBe(true);
    // A named stage, never a bare failure.
    expect(result.failureCode).toBe('SELECTION_NOT_ACCEPTED');
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('');
  });

  it('does not select something merely close when the answer is absent', async () => {
    const root = keyboardOnlyCombobox({ labels: [...STATES] });

    const result = await executeDropdown({
      fieldId: 'state',
      root,
      desiredSemanticValue: 'Ontario',
      canonicalQuestion: 'state',
    });

    expect(result.verified).toBe(false);
    // Nothing was chosen, which is the whole requirement: a fallback that
    // settles for a near miss puts a wrong answer on an application.
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('');
  });

  it('finishes a long list without exhausting its step budget', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `Option ${index + 1}`);
    const root = keyboardOnlyCombobox({ labels: many });

    const result = await executeDropdown({
      fieldId: 'long',
      root,
      desiredSemanticValue: 'Option 37',
    });

    expect(result.verified).toBe(true);
    expect(root.querySelector('[data-selected-label]')?.textContent).toBe('Option 37');
  });
});
