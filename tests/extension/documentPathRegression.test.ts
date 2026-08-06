import { describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  profileSchema,
  type ApplicationScanResult,
} from '@internship-agent/shared';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { runSingleFrameAttachment } from './helpers/singleFrameAttach.js';

/**
 * The document-only path must not have changed how the fields that already work
 * are planned or filled.
 *
 * First name, last name, email, and phone are the four this repair was told not
 * to disturb, so they are asserted directly rather than left to be implied by a
 * larger suite passing.
 */

const NOW = '2026-08-05T12:00:00.000Z';

function field(id: string, label: string, canonicalKey: string): Record<string, unknown> {
  return {
    id,
    pageId: 'page-1',
    label,
    normalizedLabel: label.toLowerCase(),
    canonicalKey,
    fieldType: 'text',
    question: label,
    selector: `#${id}`,
    required: true,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label_for'],
  };
}

const scan: ApplicationScanResult = applicationScanResultSchema.parse({
  id: 'scan-regression',
  createdAt: NOW,
  url: 'https://example.test/apply',
  domain: 'example.test',
  ats: {
    id: 'generic',
    displayName: 'Generic HTML form',
    confidence: 1,
    detectionReason: 'fixture',
    supported: true,
  },
  jobContext: { sourceUrl: 'https://example.test/apply' },
  fields: [
    field('first', 'First name', 'first_name'),
    field('last', 'Last name', 'last_name'),
    field('email', 'Email', 'email'),
    field('phone', 'Phone number', 'phone'),
  ],
  warnings: [],
  statistics: {
    total: 4,
    supported: 4,
    unknown: 0,
    required: 4,
    optional: 0,
    text: 4,
    textarea: 0,
    select: 0,
    combobox: 0,
    radio: 0,
    checkbox: 0,
    file: 0,
  },
  durationMs: 10,
  status: 'completed',
  readOnly: true,
});

const profile = profileSchema.parse({
  updatedAt: NOW,
  personal: {
    legalFirstName: 'Jordan',
    legalLastName: 'Rivera',
    email: 'jordan@example.com',
    phone: '+16175550142',
    address: {},
  },
});

describe('existing field autofill is unchanged', () => {
  it('still plans first name, last name, email, and phone from the saved profile', () => {
    const plan = buildDeterministicPlan(scan, profile, []);

    const value = (fieldId: string): unknown =>
      plan.actions.find((action) => action.fieldId === fieldId)?.proposedValue;

    expect(value('first')).toBe('Jordan');
    expect(value('last')).toBe('Rivera');
    expect(value('email')).toBe('jordan@example.com');
    expect(value('phone')).toBe('+16175550142');

    for (const id of ['first', 'last', 'email', 'phone']) {
      const action = plan.actions.find((candidate) => candidate.fieldId === id);
      expect(action?.action).toBe('fill_text');
      expect(action?.source).toBe('profile');
    }
  });
});

describe('the document-only path touches nothing but file inputs', () => {
  it('leaves text fields, checkboxes, and buttons exactly as it found them', async () => {
    document.body.innerHTML = `
      <form>
        <label for="first">First name</label><input id="first" name="first_name" type="text" value="Jordan" />
        <label for="email">Email</label><input id="email" name="email" type="email" value="jordan@example.com" />
        <label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="+16175550142" />
        <input id="agree" type="checkbox" />
        <label for="resume">Resume</label><input id="resume" type="file" />
        <p id="resume-filename"></p>
        <button id="submit-application" type="submit">Submit application</button>
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    input.addEventListener('change', () => {
      document.getElementById('resume-filename')!.textContent = input.files?.[0]?.name ?? '';
    });

    const bytes = Buffer.from('%PDF-1.4\nresume\n%%EOF\n');
    await runSingleFrameAttachment('run-regression', 'https://example.test/apply', [
      {
        documentType: 'resume',
        filename: 'Resume-Acme.pdf',
        mimeType: 'application/pdf',
        byteLength: bytes.byteLength,
        source: 'tailored',
        contentBase64: bytes.toString('base64'),
      },
    ]);

    expect((document.getElementById('first') as HTMLInputElement).value).toBe('Jordan');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('jordan@example.com');
    expect((document.getElementById('phone') as HTMLInputElement).value).toBe('+16175550142');
    expect((document.getElementById('agree') as HTMLInputElement).checked).toBe(false);
    // And the résumé did land, so the assertions above are not passing merely
    // because nothing ran.
    expect(input.files?.[0]?.name).toBe('Resume-Acme.pdf');
  });
});
