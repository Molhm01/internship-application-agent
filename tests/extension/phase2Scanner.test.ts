import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { markExtensionOwned, type DetectedField } from '@internship-agent/shared';
import {
  extensionOwnedViolation,
  isExtensionOwned,
  requiredEvidence,
  scanDom,
} from '../../extension/src/scanner/domScanner.js';
import {
  clearHighlights,
  highlightCount,
  highlightField,
} from '../../extension/src/content/highlighter.js';

/**
 * The Phase 2 acceptance gates, run against one realistic candidate-profile
 * page.
 *
 * Every gate below names something the live extension actually got wrong: an
 * accordion header reported as a question, a section's asterisk making an
 * optional field required, two "Type" controls that could not be told apart,
 * and the agent's own review badges scanned as employer content. The fixture
 * reproduces all of them in one document, including a nested frame whose
 * control shares a name, an id and a label with one in the parent.
 */

const FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'phase2-candidate-profile.html');
const FRAME_FIXTURE = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'phase2-candidate-profile-frame.html',
);

function loadFixture(): Document {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8');
  const frame = document.getElementById('nested-details') as HTMLIFrameElement | null;
  const frameDocument = frame?.contentDocument;
  if (frameDocument) {
    frameDocument.open();
    frameDocument.write(readFileSync(FRAME_FIXTURE, 'utf8'));
    frameDocument.close();
  }
  return document;
}

function scan(): Promise<{ fields: DetectedField[]; warnings: string[] }> {
  return scanDom(document, 'page-phase2', new AbortController().signal);
}

function labels(fields: readonly DetectedField[]): string[] {
  return fields.map((field) => field.label);
}

function byIntent(fields: readonly DetectedField[], intent: string): DetectedField[] {
  return fields.filter((field) => field.canonicalKey === intent);
}

function one(fields: readonly DetectedField[], intent: string): DetectedField {
  const found = byIntent(fields, intent);
  expect(found, `expected exactly one ${intent}`).toHaveLength(1);
  return found[0] as DetectedField;
}

describe('phase 2 — only real employer controls become application fields', () => {
  let fields: DetectedField[];

  beforeEach(async () => {
    loadFixture();
    fields = (await scan()).fields;
  });

  it('GATE 1 — "Phones (1)* required." produces no field', () => {
    expect(labels(fields).filter((label) => /^Phones \(1\)/.test(label))).toEqual([]);
    // Nor does it survive as some other control's question.
    expect(fields.some((field) => field.selector === '#phones-header')).toBe(false);
  });

  it('GATE 2 — "Addresses (1)* required." produces no field', () => {
    expect(labels(fields).filter((label) => /^Addresses \(1\)/.test(label))).toEqual([]);
    expect(fields.some((field) => field.selector === '#addresses-header')).toBe(false);
  });

  it('GATE 3 — instructional paragraphs produce no field', () => {
    expect(fields.some((field) => /Complete every section marked required/.test(field.label))).toBe(
      false,
    );
    expect(fields.some((field) => /provide your legal name as it appears/i.test(field.label))).toBe(
      false,
    );
  });

  it('GATE 4 — the validation summary produces no field', () => {
    expect(fields.some((field) => /Information needed\./.test(field.label))).toBe(false);
    expect(fields.some((field) => /City is required\./.test(field.label))).toBe(false);
  });

  it('GATE 5 — no field originates in extension-owned DOM', () => {
    // The fixture carries a marked host containing a checkbox, a select and a
    // button — all of them controls the selector matches.
    const owned = document.querySelector('[data-internship-agent-owned="true"]');
    expect(owned?.querySelectorAll('input, select, button').length).toBeGreaterThan(0);

    for (const field of fields) {
      const element = document.querySelector(field.selector);
      if (element) expect(isExtensionOwned(element)).toBe(false);
    }
    expect(fields.some((field) => /Autofill/i.test(field.label))).toBe(false);
    expect(fields.some((field) => field.label === 'Information needed')).toBe(false);
    expect(fields.some((field) => field.label === 'Manual response required')).toBe(false);
  });

  it('GATE 6 — Previous, Next and Submit are not application questions', () => {
    for (const selector of ['#previous-step', '#next-step', '#final-submit']) {
      expect(fields.some((field) => field.selector === selector)).toBe(false);
    }
    expect(fields.some((field) => /^(Previous|Next|Submit Application)$/.test(field.label))).toBe(
      false,
    );
  });

  it('GATE 7 — Middle Name is optional', () => {
    const middleName = one(fields, 'middle_name');
    expect(middleName.required).toBe(false);
    expect(middleName.requiredSource).toBe('none');
  });

  it('GATE 8 — Address Line 2 is optional', () => {
    const line2 = one(fields, 'address_line2');
    expect(line2.required).toBe(false);
    expect(line2.requiredSource).toBe('none');
  });

  it('GATE 9 — Address Line 1 stays required, on stated evidence', () => {
    const line1 = byIntent(fields, 'address_line1').find(
      (field) => field.metadata.framePath === undefined,
    );
    expect(line1?.required).toBe(true);
    expect(line1?.requiredSource).toBe('native_required');
  });

  it('GATE 10 — Highest Level of Education appears exactly once', () => {
    // Named three ways at once: label[for], aria-labelledby, and section text.
    const found = fields.filter((field) => field.label === 'Highest Level of Education');
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe('#highestEducation');
    expect(one(fields, 'highest_degree_awarded').fieldType).toBe('select');
  });

  it('GATE 11 — the radio group normalizes as one question with its options', () => {
    const radios = fields.filter((field) => field.fieldType === 'radio');
    expect(radios).toHaveLength(1);
    const group = radios[0] as DetectedField;
    expect(group.label).toBe('Are you legally authorized to work in the United States?');
    expect(group.options?.map((option) => option.label)).toEqual(['Yes', 'No']);
    expect(group.metadata.groupName).toBe('workAuthorized');
    expect(group.metadata.groupedControls).toBe(2);
  });

  it('GATE 11b — the standalone checkbox is its own field, not a group', () => {
    const checkboxes = fields.filter((field) => field.fieldType === 'checkbox');
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]?.selector).toBe('#marketingConsent');
    expect(checkboxes[0]?.options).toBeUndefined();
  });

  it('GATE 12 — Phone Type and Address Type receive distinct intents', () => {
    const types = fields.filter((field) => field.label === 'Type');
    expect(types).toHaveLength(2);
    expect(one(fields, 'phone_type').selector).toBe('#phoneType');
    expect(one(fields, 'address_type').selector).toBe('#addressType');
    expect(types.map((field) => field.metadata.sectionHeading)).toEqual([
      'Phones (1)* required.',
      'Addresses (1)* required.',
    ]);
  });

  it('GATE 13 — experience Location is not a personal location', () => {
    const location = one(fields, 'experience_location');
    expect(location.selector).toBe('#experienceLocation');
    expect(location.section).toBe('experience');
    expect(byIntent(fields, 'current_location')).toEqual([]);
  });

  it('GATE 13b — every repeated generic label inherits its own section', () => {
    const sections = Object.fromEntries(
      fields.map((field) => [field.selector, field.metadata.sectionHeading]),
    );
    expect(sections['#phoneNumber']).toBe('Phones (1)* required.');
    expect(sections['#city']).toBe('Addresses (1)* required.');
    expect(sections['#experienceStart']).toBe('Professional Experience');
    expect(sections['#school']).toBe('Education');
  });

  it('GATE 14 — an identical control in another frame stays a separate field', () => {
    const addressLines = byIntent(fields, 'address_line1');
    expect(addressLines).toHaveLength(2);
    const framePaths = addressLines.map((field) => field.metadata.framePath);
    expect(framePaths.filter((path) => path === undefined)).toHaveLength(1);
    expect(framePaths.filter(Array.isArray)).toHaveLength(1);
    // Same selector, same name, same intent — two questions all the same.
    expect(new Set(addressLines.map((field) => field.selector)).size).toBe(1);
    expect(new Set(addressLines.map((field) => field.id)).size).toBe(2);
  });

  it('GATE 15 — a repeated scan of an unchanged page is identical', async () => {
    const again = (await scan()).fields;
    expect(again.map((field) => field.id)).toEqual(fields.map((field) => field.id));
    expect(again).toHaveLength(fields.length);
  });

  it('GATE 16 — a repeated scan creates no additional extension annotations', async () => {
    const before = document.querySelectorAll('[data-internship-agent-owned="true"]').length;
    await scan();
    await scan();
    expect(document.querySelectorAll('[data-internship-agent-owned="true"]').length).toBe(before);
    // Discovery never marks anything: marks are the planner's to place.
    expect(document.querySelectorAll('[data-internship-agent-review]')).toHaveLength(0);
  });

  it('every field carries exactly one required-source verdict', () => {
    for (const field of fields) {
      expect(field.requiredSource).toBeDefined();
      expect(field.required).toBe(field.requiredSource !== 'none');
    }
  });
});

describe('phase 2 — required detection reads only evidence bound to the control', () => {
  function control(html: string, selector = '#target'): HTMLElement {
    document.body.innerHTML = html;
    return document.querySelector<HTMLElement>(selector) as HTMLElement;
  }

  it('reads the native property first', () => {
    const element = control('<input id="target" required />');
    expect(requiredEvidence([element])).toEqual({ required: true, source: 'native_required' });
  });

  it('reads aria-required when there is no native flag', () => {
    const element = control('<div id="target" role="combobox" aria-required="true"></div>');
    expect(requiredEvidence([element])).toEqual({ required: true, source: 'aria_required' });
  });

  it('reads ATS metadata on the control', () => {
    const element = control('<input id="target" data-required="true" />');
    expect(requiredEvidence([element])).toEqual({ required: true, source: 'ats_metadata' });
  });

  it('reads a marker in the control’s own label', () => {
    const element = control(
      '<div class="field"><label for="target">City <span class="required-indicator">*</span></label><input id="target" /></div>',
    );
    expect(requiredEvidence([element])).toEqual({
      required: true,
      source: 'associated_visual_marker',
    });
  });

  it('reads a requirement attached to the actual radio group', () => {
    document.body.innerHTML = `
      <fieldset><legend>Work authorized? *</legend>
        <label><input type="radio" name="auth" value="y" /> Yes</label>
        <label><input type="radio" name="auth" value="n" /> No</label>
      </fieldset>`;
    const radios = Array.from(document.querySelectorAll<HTMLElement>('input[name="auth"]'));
    expect(requiredEvidence(radios)).toEqual({ required: true, source: 'group_requirement' });
  });

  it('does not inherit a required sibling’s asterisk', () => {
    document.body.innerHTML = `
      <fieldset>
        <div class="field"><label for="first">First Name *</label><input id="first" required /></div>
        <div class="field"><label for="middle">Middle Name</label><input id="middle" /></div>
      </fieldset>`;
    const middle = document.querySelector<HTMLElement>('#middle') as HTMLElement;
    expect(requiredEvidence([middle])).toEqual({ required: false, source: 'none' });
  });

  it('does not read a section heading’s asterisk', () => {
    document.body.innerHTML = `
      <section aria-label="Addresses (1)* required.">
        <div class="field"><label for="line2">Address 2</label><input id="line2" /></div>
      </section>`;
    const line2 = document.querySelector<HTMLElement>('#line2') as HTMLElement;
    expect(requiredEvidence([line2])).toEqual({ required: false, source: 'none' });
  });

  it('does not read a nearby validation message', () => {
    const element = control(
      '<div class="field"><label for="target">Notes</label><input id="target" aria-invalid="true" /><p role="alert">This field is required.</p></div>',
    );
    expect(requiredEvidence([element])).toEqual({ required: false, source: 'none' });
  });

  it('does not read a validation summary elsewhere on the page', () => {
    document.body.innerHTML = `
      <div class="validation-summary" role="alert">City is required. Country is required.</div>
      <div class="field"><label for="notes">Additional Information</label><textarea id="notes"></textarea></div>`;
    const notes = document.querySelector<HTMLElement>('#notes') as HTMLElement;
    expect(requiredEvidence([notes])).toEqual({ required: false, source: 'none' });
  });
});

describe('phase 2 — the extension-owned invariant', () => {
  it('recognizes a marked node and every descendant, across shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.querySelector<HTMLElement>('#host') as HTMLElement;
    markExtensionOwned(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('input');
    root.append(inner);
    expect(isExtensionOwned(host)).toBe(true);
    expect(isExtensionOwned(inner)).toBe(true);
    expect(extensionOwnedViolation([inner])).toBe(true);
  });

  it('drops an extension-owned control and says so, rather than scanning it', async () => {
    document.body.innerHTML = `
      <div class="field"><label for="real">First Name</label><input id="real" /></div>
      <div data-internship-agent-owned="true">
        <label for="agent">Enable AI Autofill</label><input id="agent" type="checkbox" />
      </div>`;
    const result = await scanDom(document, 'page-owned', new AbortController().signal);
    expect(result.fields.map((field) => field.selector)).toEqual(['#real']);
  });
});

describe('phase 2 — page marks stay one per field across repeated scans', () => {
  beforeEach(() => {
    clearHighlights();
    document.body.innerHTML =
      '<div class="field"><label for="city">City</label><input id="city" /></div>';
  });

  it('re-marking a field by its stable id replaces rather than duplicates', () => {
    const request = {
      fieldId: 'field-city',
      selector: '#city',
      annotation: 'information_needed' as const,
      badge: 'Information needed',
    };
    expect(highlightField(request)).toBe(true);
    expect(highlightField(request)).toBe(true);
    expect(highlightField({ ...request, annotation: 'verified', badge: 'Verified' })).toBe(true);
    expect(highlightCount()).toBe(1);
    expect(document.querySelectorAll('[data-internship-agent-review]')).toHaveLength(1);
  });

  it('never leaves an unmarked page holding an annotation', () => {
    clearHighlights();
    expect(document.querySelectorAll('[data-internship-agent-review]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-internship-agent-owned="true"]')).toHaveLength(0);
  });
});
