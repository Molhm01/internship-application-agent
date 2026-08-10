import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropdownSeedSchema } from '@internship-agent/shared';
import {
  resetDropdownRegistry,
  scanDropdowns,
} from '../../extension/src/dropdown/dropdownScanner.js';
import { runDropdownDirectives } from '../../extension/src/dropdown/dropdownEngine.js';
import { openControl, readOptions } from '../../extension/src/scanner/optionDiscovery.js';

/**
 * A menu that opens and tells nobody.
 *
 * Everything else here locates a popup by what the control *declares* —
 * `aria-controls`, `role="listbox"`, `role="menu"`, a portal data attribute.
 * That covers the widget libraries and not the vendor pickers employers
 * actually ship: a `div` that mounts another `div` full of `li` elements under
 * `document.body` on click. To this codebase such a control opened nothing, and
 * the report was `OPEN_FAILED` over a menu the applicant could see.
 *
 * These tests build exactly that, with no ARIA anywhere, and require the engine
 * to open it, find the entries, scroll to one below the fold, click it, and
 * verify against the trigger's own text.
 */

const ROWS = [
  'High School',
  'Certificate',
  'Associate Degree',
  "Bachelor's Degree",
  "Master's Degree",
  'Doctorate',
  'Professional Degree',
  'Other',
];

/** Boxes that make the menu look like it sits just under its trigger. */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const top = this.classList.contains('vendor-menu') ? 40 : 0;
      return {
        width: 200,
        height: 32,
        top,
        left: 0,
        right: 200,
        bottom: top + 32,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  });
}

/**
 * The fixture: a plain div trigger, a menu mounted under `document.body` on
 * click, plain `li` rows, and no role, `aria-haspopup` or `aria-expanded`
 * anywhere.
 */
function mountHostileControl(rows: readonly string[] = ROWS): void {
  document.body.innerHTML = `
    <div class="fld">
      <span class="lbl">Education Type</span>
      <div id="edu-type" class="vendor-picker"><span class="val">No Selection</span></div>
    </div>`;
  const trigger = document.getElementById('edu-type') as HTMLElement;
  const display = trigger.querySelector('.val') as HTMLElement;

  trigger.addEventListener('mousedown', () => {
    if (document.querySelector('.vendor-menu')) return;
    const menu = document.createElement('div');
    menu.className = 'vendor-menu';
    const list = document.createElement('ul');
    for (const row of rows) {
      const item = document.createElement('li');
      item.textContent = row;
      item.addEventListener('mousedown', () => {
        display.textContent = row;
        menu.remove();
      });
      list.append(item);
    }
    menu.append(list);
    document.body.append(menu);
  });
}

beforeEach(() => {
  stubLayout();
});

afterEach(() => {
  document.body.innerHTML = '';
  resetDropdownRegistry();
  vi.restoreAllMocks();
});

describe('opening a control with no ARIA at all', () => {
  it('finds the menu the click mounted, by what the click changed', async () => {
    mountHostileControl();
    const trigger = document.getElementById('edu-type') as HTMLElement;
    const container = await openControl(trigger);
    expect(container).not.toBeNull();
    // The *list*, not the overlay it sits in: the narrowing step walks down to
    // the most specific element that still holds every entry, so the container
    // the executor clicks inside is the rows' own parent.
    expect(container!.closest('.vendor-menu')).not.toBeNull();
    expect(container!.querySelectorAll('li')).toHaveLength(ROWS.length);
  });

  it('reads the plain list items as the choices on offer', async () => {
    mountHostileControl();
    const trigger = document.getElementById('edu-type') as HTMLElement;
    const container = await openControl(trigger);
    expect(readOptions(container!).map((option) => option.label)).toEqual([...ROWS]);
  });

  it('does not invent a menu out of a click that changed nothing', async () => {
    document.body.innerHTML = `<div id="inert" class="vendor-picker"><span>No Selection</span></div>`;
    const trigger = document.getElementById('inert') as HTMLElement;
    expect(await openControl(trigger)).toBeNull();
  });

  it('does not treat a single clickable element as a list', async () => {
    document.body.innerHTML = `<div id="one" class="vendor-picker"><span>No Selection</span></div>`;
    const trigger = document.getElementById('one') as HTMLElement;
    trigger.addEventListener('mousedown', () => {
      const lone = document.createElement('div');
      lone.className = 'vendor-menu';
      lone.innerHTML = '<div>Just a tooltip</div>';
      document.body.append(lone);
    });
    // One entry is not repetition, and repetition is the whole evidence.
    expect(await openControl(trigger)).toBeNull();
  });
});

describe('the whole pass over a hostile control', () => {
  const directive = (intendedAnswer: string) => ({
    canonicalQuestion: 'degree' as const,
    intendedAnswer,
    intendedAnswerSource: 'profile_fact' as const,
    alternativeValues: [],
    allowOtherFallback: false,
    requiresUserConfirmation: false,
    sensitive: false,
  });

  it('opens, finds options, finds the target, selects and verifies', async () => {
    mountHostileControl();
    const found = scanDropdowns(document, [
      dropdownSeedSchema.parse({
        fieldId: 'field-edu-type',
        selector: '#edu-type',
        label: 'Education Type',
        canonicalQuestion: 'degree',
      }),
    ]);
    expect(found).toHaveLength(1);

    const [result] = await runDropdownDirectives([
      { ...directive("Bachelor's Degree"), dropdownId: found[0]!.descriptor.dropdownId },
    ]);

    expect(result!.opened).toBe(true);
    expect(result!.menuDetection).toBe('mutation_fallback');
    expect(result!.optionCandidates).toBe('structural_candidates');
    expect(result!.optionsFound).toBe(ROWS.length);
    expect(result!.targetFound).toBe(true);
    expect(result!.clickAttempted).toBe(true);
    expect(result!.selected).toBe(true);
    expect(result!.verified).toBe(true);
    expect(result!.finalStatus).toBe('FILLED_VERIFIED');
    expect(document.querySelector('#edu-type .val')?.textContent).toBe("Bachelor's Degree");
  });

  it('never accepts the placeholder as the answer', async () => {
    // The control opens on "No Selection". An intended answer of "No" — which
    // "No Selection" contains — must drive the control, not skip it.
    mountHostileControl(['Yes', 'No']);
    const found = scanDropdowns(document, [
      dropdownSeedSchema.parse({
        fieldId: 'field-grad',
        selector: '#edu-type',
        label: 'Graduated?',
        canonicalQuestion: 'other_custom',
      }),
    ]);
    const [result] = await runDropdownDirectives([
      {
        ...directive('No'),
        canonicalQuestion: 'other_custom',
        dropdownId: found[0]!.descriptor.dropdownId,
      },
    ]);
    expect(result!.finalStatus).not.toBe('SKIPPED_ALREADY_VALID');
    expect(result!.opened).toBe(true);
    expect(result!.verified).toBe(true);
    expect(document.querySelector('#edu-type .val')?.textContent).toBe('No');
  });

  it('scrolls a long role-less menu to reach an entry below the fold', async () => {
    // A virtualized vendor list: only the rows around the scroll position exist
    // as elements, and none of them carries a role. jsdom has no layout, so the
    // scroll geometry is modelled explicitly — it is the only way this case can
    // exist here at all. The browser-level proof is the e2e fixture.
    const labels = Array.from({ length: 60 }, (_, index) => `Field of Study ${index}`);
    const windowSize = 8;
    document.body.innerHTML = `
      <div class="fld"><span class="lbl">Area of Study</span>
        <div id="area" class="vendor-picker"><span class="val">No Selection</span></div></div>`;
    const trigger = document.getElementById('area') as HTMLElement;
    const display = trigger.querySelector('.val') as HTMLElement;

    trigger.addEventListener('mousedown', () => {
      if (document.querySelector('.vendor-menu')) return;
      const menu = document.createElement('div');
      menu.className = 'vendor-menu';
      const list = document.createElement('ul');
      let scrollTop = 0;
      const render = (): void => {
        const first = Math.floor(scrollTop / 24);
        list.innerHTML = '';
        for (const label of labels.slice(first, first + windowSize)) {
          const item = document.createElement('li');
          item.textContent = label;
          item.addEventListener('mousedown', () => {
            display.textContent = label;
            menu.remove();
          });
          list.append(item);
        }
      };
      Object.defineProperty(list, 'scrollHeight', { get: () => labels.length * 24 });
      Object.defineProperty(list, 'clientHeight', { get: () => windowSize * 24 });
      Object.defineProperty(list, 'scrollTop', {
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = Math.max(0, Math.min(next, (labels.length - windowSize) * 24));
          render();
        },
      });
      render();
      menu.append(list);
      document.body.append(menu);
    });

    const found = scanDropdowns(document, [
      dropdownSeedSchema.parse({
        fieldId: 'field-area',
        selector: '#area',
        label: 'Area of Study',
        canonicalQuestion: 'major',
      }),
    ]);
    const [result] = await runDropdownDirectives([
      {
        ...directive('Field of Study 52'),
        canonicalQuestion: 'major',
        dropdownId: found[0]!.descriptor.dropdownId,
      },
    ]);

    expect(result!.opened).toBe(true);
    expect(result!.menuDetection).toBe('mutation_fallback');
    expect(result!.scrolled).toBe(true);
    expect(result!.scrollIterations).toBeGreaterThan(1);
    expect(result!.optionsFound).toBe(labels.length);
    expect(result!.targetFound).toBe(true);
    expect(result!.verified).toBe(true);
    expect(display.textContent).toBe('Field of Study 52');
  });

  it('reports honestly when the menu opens and holds nothing', async () => {
    mountHostileControl([]);
    const found = scanDropdowns(document, [
      dropdownSeedSchema.parse({
        fieldId: 'field-edu-type',
        selector: '#edu-type',
        label: 'Education Type',
      }),
    ]);
    const [result] = await runDropdownDirectives([
      { ...directive("Bachelor's Degree"), dropdownId: found[0]!.descriptor.dropdownId },
    ]);
    // An empty menu is not a menu this code will claim to have found: nothing
    // repeated appeared, so the honest report is that it did not open.
    expect(result!.verified).toBe(false);
    expect(result!.errorCode).toBe('OPEN_FAILED');
  });
});
