import { afterEach, describe, expect, it } from 'vitest';
import {
  dropdownSeedSchema,
  type ApplicationScanResult,
  type DetectedField,
  type DropdownSeed,
} from '@internship-agent/shared';
import {
  resetDropdownRegistry,
  scanDropdowns,
} from '../../extension/src/dropdown/dropdownScanner.js';
import { runDropdownDirectives } from '../../extension/src/dropdown/dropdownEngine.js';
import { dropdownSeedsByFrame } from '../../extension/src/background/dropdownAcrossFrames.js';

/**
 * The authoritative scan, actually consumed.
 *
 * `runDropdownStage(scan)` took a scan and ignored it: every frame rediscovered
 * the page with `dropdownScanner`'s own selector list, and a control the
 * application scan classified as a dropdown whose markup that list does not
 * recognise reached the engine through neither route. On the live employer form
 * that was State/Province, Employment Type, Education Type, Education Country,
 * Education State, School, Area of Study and Graduated? — eight controls that
 * did not fail, but disappeared.
 *
 * The fixture below is the shape that matters: a widget the main scanner
 * recognises as an option field and `CANDIDATE_SELECTOR` does not. It has no
 * `role`, no `aria-haspopup`, no `aria-expanded`, and is not a `<select>`.
 */

afterEach(() => {
  document.body.innerHTML = '';
  resetDropdownRegistry();
});

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

/** A control nothing in `CANDIDATE_SELECTOR` matches. */
const OPAQUE_WIDGET = `
  <div class="fld">
    <span class="lbl">Graduated?</span>
    <div id="graduated" class="vendor-picker" data-testid="graduated">
      <span class="vendor-picker__value">No Selection</span>
    </div>
  </div>`;

function seed(overrides: Partial<DropdownSeed> = {}): DropdownSeed {
  return dropdownSeedSchema.parse({
    fieldId: 'field-graduated',
    selector: '#graduated',
    label: 'Graduated?',
    sectionContext: 'education',
    required: true,
    ...overrides,
  });
}

describe('the dedicated scanner alone', () => {
  it('does not recognise a vendor widget with no ARIA at all', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    expect(scanDropdowns(document)).toEqual([]);
  });
});

describe('seeding from the application scan', () => {
  it('reaches the engine for a control only the main scanner found', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    const found = scanDropdowns(document, [seed()]);
    expect(found).toHaveLength(1);
    expect(found[0]!.descriptor.discoverySource).toBe('main_scan');
    expect(found[0]!.descriptor.scanFieldId).toBe('field-graduated');
    expect(found[0]!.descriptor.label).toBe('Graduated?');
    expect(found[0]!.element.id).toBe('graduated');
  });

  it('keeps the scan’s own intent rather than re-deriving it', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    const found = scanDropdowns(document, [seed({ canonicalQuestion: 'graduation_date' })]);
    expect(found[0]!.descriptor.scanCanonicalQuestion).toBe('graduation_date');
  });

  it('records the control structure without recording any value', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    const structure = scanDropdowns(document, [seed()])[0]!.descriptor.structure;
    expect(structure).toBeDefined();
    expect(structure!.triggerTag).toBe('div');
    expect(structure!.ariaHasPopup).toBe('');
    expect(structure!.classFingerprint).toMatch(/^c[a-z0-9]+\/\d+$/);
    // The fingerprint is a digest, never the classes themselves.
    expect(JSON.stringify(structure)).not.toContain('vendor-picker');
    expect(JSON.stringify(structure)).not.toContain('No Selection');
  });
});

describe('deduplication between the two sources', () => {
  it('describes a control both passes found exactly once, marked both', () => {
    document.body.innerHTML = `
      <label for="state">State/Province</label>
      <select id="state"><option value="">Select…</option><option value="NJ">New Jersey</option></select>`;
    const found = scanDropdowns(document, [
      seed({ fieldId: 'field-state', selector: '#state', label: 'State/Province' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.descriptor.discoverySource).toBe('both');
    expect(found[0]!.descriptor.scanFieldId).toBe('field-state');
  });

  it('keeps a control only the dedicated walk found', () => {
    document.body.innerHTML = `
      <label for="state">State/Province</label>
      <select id="state"><option value="NJ">New Jersey</option></select>`;
    const found = scanDropdowns(document, []);
    expect(found).toHaveLength(1);
    expect(found[0]!.descriptor.discoverySource).toBe('dropdown_scan');
  });

  it('answers one question once when two seeds name the same element', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    const found = scanDropdowns(document, [
      seed({ fieldId: 'field-a' }),
      seed({ fieldId: 'field-b' }),
    ]);
    expect(found).toHaveLength(1);
  });

  it('ignores a seed whose selector resolves to nothing', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    const found = scanDropdowns(document, [seed({ selector: '#not-on-this-page' })]);
    expect(found).toEqual([]);
  });

  it('ignores a seed whose selector this document will not parse', () => {
    document.body.innerHTML = OPAQUE_WIDGET;
    expect(() => scanDropdowns(document, [seed({ selector: ':::nonsense' })])).not.toThrow();
  });
});

describe('a seeded control is driven like any other', () => {
  it('opens, reads, selects and verifies a native select the walk skipped', async () => {
    // A `<select>` deliberately hidden behind a styled trigger — the walk finds
    // it, so this proves the seeded path drives an element end to end rather
    // than merely describing it.
    document.body.innerHTML = `
      <label for="grad">Graduated?</label>
      <select id="grad">
        <option value="" selected>No Selection</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>`;
    const found = scanDropdowns(document, [
      seed({ fieldId: 'field-grad', selector: '#grad', canonicalQuestion: 'other_custom' }),
    ]);
    const [result] = await runDropdownDirectives([
      {
        dropdownId: found[0]!.descriptor.dropdownId,
        canonicalQuestion: 'other_custom',
        intendedAnswer: 'No',
        intendedAnswerSource: 'approved_answer',
        alternativeValues: [],
        allowOtherFallback: false,
        requiresUserConfirmation: false,
        sensitive: false,
      },
    ]);

    // The whole point: the control started on "No Selection", which contains
    // "No", and the run must have driven it rather than skipping it as valid.
    expect(result!.finalStatus).toBe('FILLED_VERIFIED');
    expect(result!.selected).toBe(true);
    expect(result!.verified).toBe(true);
    expect(result!.targetFound).toBe(true);
    expect((document.getElementById('grad') as HTMLSelectElement).value).toBe('no');
  });
});

describe('grouping the scan into per-frame seeds', () => {
  const field = (overrides: Partial<DetectedField>): DetectedField =>
    ({
      id: 'field-1',
      pageId: 'page-1',
      label: 'State/Province',
      normalizedLabel: 'state province',
      question: 'State/Province',
      fieldType: 'select',
      selector: '#state',
      required: true,
      visible: true,
      disabled: false,
      ...overrides,
    }) as DetectedField;

  const scan = (fields: DetectedField[]): ApplicationScanResult =>
    ({ fields }) as ApplicationScanResult;

  it('seeds every option control the scan found', () => {
    const seeds = dropdownSeedsByFrame(
      scan([
        field({ id: 'a', fieldType: 'select' }),
        field({ id: 'b', fieldType: 'combobox', selector: '#b' }),
        field({ id: 'c', fieldType: 'multi_select', selector: '#c' }),
      ]),
    );
    expect(seeds.get(0)?.map((entry) => entry.fieldId)).toEqual(['a', 'b', 'c']);
  });

  it('leaves text, radio and checkbox controls out', () => {
    // A radio group is answered from a list and is not a menu. Driving one
    // through a dropdown engine opens nothing and reports a failure about a
    // control that works perfectly.
    const seeds = dropdownSeedsByFrame(
      scan([
        field({ id: 'a', fieldType: 'text', selector: '#a' }),
        field({ id: 'b', fieldType: 'radio', selector: '#b' }),
        field({ id: 'c', fieldType: 'checkbox', selector: '#c' }),
      ]),
    );
    expect(seeds.size).toBe(0);
  });

  it('keeps each control with the frame it lives in', () => {
    const seeds = dropdownSeedsByFrame(
      scan([
        field({ id: 'a', selector: '#a', frameId: 0 }),
        field({ id: 'b', selector: '#b', frameId: 2 }),
      ]),
    );
    expect(seeds.get(0)?.map((entry) => entry.fieldId)).toEqual(['a']);
    expect(seeds.get(2)?.map((entry) => entry.fieldId)).toEqual(['b']);
  });

  it('carries the intent and the section, and no answer', () => {
    const seeds = dropdownSeedsByFrame(
      scan([
        field({
          id: 'a',
          canonicalKey: 'state',
          section: 'education',
          currentValue: 'New Jersey',
          options: [{ label: 'New Jersey', value: 'NJ' }],
        }),
      ]),
    );
    const only = seeds.get(0)?.[0];
    expect(only?.canonicalQuestion).toBe('state');
    expect(only?.sectionContext).toBe('education');
    // The scan's option list travels for the report; nothing selects from it.
    expect(only?.knownOptions).toEqual(['New Jersey']);
    expect(JSON.stringify(only)).not.toContain('currentValue');
  });

  it('seeds a control the scan saw with no options at all', () => {
    // The dependent control that has not been populated yet is exactly the one
    // that has to be opened to find out what it now offers.
    const seeds = dropdownSeedsByFrame(scan([field({ id: 'a', options: [] })]));
    expect(seeds.get(0)).toHaveLength(1);
  });
});
