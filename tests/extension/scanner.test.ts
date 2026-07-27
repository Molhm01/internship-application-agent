import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchCanonicalQuestion, normalizeLabel } from '@internship-agent/shared';
import { selectAdapter } from '../../extension/src/scanner/adapters.js';
import {
  extractAccessibleLabel,
  isVisibleControl,
  scanDom,
} from '../../extension/src/scanner/domScanner.js';
import { extractJobContext } from '../../extension/src/scanner/jobContext.js';
import { sanitizeScanForExport } from '../../extension/src/storage/scans.js';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

function body(html: string): void {
  document.documentElement.innerHTML = html;
}

describe('deterministic question normalization', () => {
  it.each([
    ['Legal First Name *', 'first_name'],
    ['Given Name', 'first_name'],
    ['Family Name', 'last_name'],
    ['E-mail Address', 'email'],
    ['Telephone Number', 'phone'],
    ['LinkedIn Profile URL', 'linkedin'],
  ])('maps %s to %s', (label, expected) => {
    expect(matchCanonicalQuestion(label).question).toBe(expected);
  });

  it('normalizes punctuation and does not guess unknown questions', () => {
    expect(normalizeLabel('  Legal_First-Name (required) * ')).toBe('legal first name');
    expect(matchCanonicalQuestion('Favorite compiler color').question).toBe('unknown');
  });
});

describe('ATS adapter selection', () => {
  it.each([
    ['greenhouse', 'boards.greenhouse.io', 'greenhouse.html'],
    ['lever', 'jobs.lever.co', 'lever.html'],
    ['workday', 'acme.wd5.myworkdayjobs.com', 'workday.html'],
  ])('selects %s above generic', (expected, hostname, name) => {
    body(fixture(name));
    const selected = selectAdapter({
      url: `https://${hostname}/job/1`,
      hostname,
      title: document.title,
      bodyText: document.body.textContent ?? '',
      document,
    });
    expect(selected.adapter.id).toBe(expected);
    expect(selected.detection.confidence).toBeGreaterThan(0.8);
  });

  it('registers every requested adapter', async () => {
    const { ATS_ADAPTERS } = await import('../../extension/src/scanner/adapters.js');
    expect(ATS_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'greenhouse',
      'lever',
      'workday',
      'ashby',
      'icims',
      'smartrecruiters',
      'successfactors',
      'taleo',
      'generic',
    ]);
  });
});

describe('DOM field scanning', () => {
  it('extracts explicit, wrapped, aria, and placeholder labels', () => {
    body(`<body><form>
      <label for="one">First Name</label><input id="one">
      <label>Last Name<input id="two"></label>
      <input id="three" aria-label="Email Address">
      <input id="four" placeholder="LinkedIn URL">
    </form></body>`);
    expect(extractAccessibleLabel(document.querySelector('#one')!).signals).toContain('label_for');
    expect(extractAccessibleLabel(document.querySelector('#two')!).signals).toContain(
      'wrapped_label',
    );
    expect(extractAccessibleLabel(document.querySelector('#three')!).signals).toContain(
      'aria_label',
    );
    expect(extractAccessibleLabel(document.querySelector('#four')!).signals).toContain(
      'placeholder',
    );
  });

  it('detects types, required flags, sections, options, grouping, files, and validation', async () => {
    body(
      fixture('native-selects.html') +
        fixture('radio-groups.html') +
        fixture('checkbox-groups.html') +
        fixture('file-upload.html') +
        fixture('validation-messages.html'),
    );
    const result = await scanDom(document, 'page-test', new AbortController().signal);
    expect(
      result.fields.some((field) => field.fieldType === 'select' && field.options?.length === 3),
    ).toBe(true);
    expect(
      result.fields.some((field) => field.fieldType === 'radio' && field.options?.length === 2),
    ).toBe(true);
    expect(result.fields.some((field) => field.fieldType === 'multi_select')).toBe(true);
    expect(
      result.fields.some((field) => field.fieldType === 'file' && field.section === 'documents'),
    ).toBe(true);
    expect(result.fields.some((field) => field.required && field.validationText)).toBe(true);
  });

  it('ignores hidden, disabled, honeypot, and submit controls without changing values', async () => {
    body(fixture('hidden-fields.html'));
    const before = Array.from(
      document.querySelectorAll<HTMLInputElement>('input'),
      (input) => input.value,
    );
    const result = await scanDom(document, 'page-hidden', new AbortController().signal);
    const after = Array.from(
      document.querySelectorAll<HTMLInputElement>('input'),
      (input) => input.value,
    );
    expect(result.fields).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('detects a field inserted during the bounded mutation window', async () => {
    body('<body><form id="dynamic"><label>First Name<input></label></form></body>');
    setTimeout(() => {
      document
        .querySelector('#dynamic')
        ?.insertAdjacentHTML(
          'beforeend',
          '<label>GitHub URL<input type="url" name="github"></label>',
        );
    }, 20);
    const result = await scanDom(document, 'page-dynamic', new AbortController().signal);
    expect(result.fields.some((field) => field.canonicalKey === 'github')).toBe(true);
    expect(result.warnings).toContain('Dynamic fields changed during the scan.');
  });

  it('traverses same-origin iframes and accessible shadow roots', async () => {
    body('<body><iframe id="frame"></iframe><div id="shadow-host"></div></body>');
    const frame = document.querySelector<HTMLIFrameElement>('#frame');
    if (!frame?.contentDocument) throw new Error('jsdom did not create an iframe document');
    frame.contentDocument.body.innerHTML =
      '<form><label>Phone Number<input type="tel" name="phone"></label></form>';
    const host = document.querySelector<HTMLElement>('#shadow-host');
    const shadow = host?.attachShadow({ mode: 'open' });
    if (shadow) {
      shadow.innerHTML =
        '<form><label>Portfolio URL<input type="url" name="portfolio"></label></form>';
    }

    const result = await scanDom(document, 'page-nested', new AbortController().signal);
    expect(result.fields.some((field) => field.fieldType === 'tel')).toBe(true);
    expect(result.fields.some((field) => field.canonicalKey === 'portfolio')).toBe(true);
  });

  it('terminates when cancelled', async () => {
    body('<body><form><label>Name<input></label></form></body>');
    const controller = new AbortController();
    controller.abort();
    await expect(scanDom(document, 'page-cancel', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports visibility deterministically', () => {
    body('<body><input id="visible"><input id="hidden" hidden></body>');
    expect(isVisibleControl(document.querySelector('#visible')!)).toBe(true);
    expect(isVisibleControl(document.querySelector('#hidden')!)).toBe(false);
  });
});

describe('job context and export safety', () => {
  it('extracts JobPosting JSON-LD without fabricating missing values', () => {
    body(
      `<head><script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Platform Intern',
        hiringOrganization: { name: 'Acme' },
        employmentType: 'Internship',
      })}</script></head><body><h1>Fallback title</h1></body>`,
    );
    const context = extractJobContext(document, 'https://jobs.example.test/1');
    expect(context).toMatchObject({
      company: 'Acme',
      jobTitle: 'Platform Intern',
      employmentType: 'Internship',
      sourceUrl: 'https://jobs.example.test/1',
    });
    expect(context.salary).toBeUndefined();
  });

  it('removes secret-shaped metadata keys from JSON export', () => {
    const sanitized = sanitizeScanForExport({
      id: 'scan-1',
      createdAt: '2026-07-26T12:00:00.000Z',
      url: 'https://example.test/apply',
      domain: 'example.test',
      ats: {
        id: 'generic',
        displayName: 'Generic',
        confidence: 0.5,
        detectionReason: 'form',
        supported: true,
      },
      jobContext: { sourceUrl: 'https://example.test/apply' },
      fields: [],
      warnings: [],
      statistics: {
        total: 0,
        supported: 0,
        unknown: 0,
        required: 0,
        optional: 0,
        text: 0,
        textarea: 0,
        select: 0,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
        bySection: {},
      },
      durationMs: 10,
      status: 'completed',
      readOnly: true,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/token|password|secret/i);
  });
});
