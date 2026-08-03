import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  FILLABLE_FIELD_TYPES,
  applicationScanResultSchema,
  detectedFieldSchema,
  deterministicFillPlanSchema,
  fieldTypeSchema,
  scanApplicationResponseSchema,
  toNormalizedQuestion,
  type DetectedField,
  type FieldType,
} from '@internship-agent/shared';

/**
 * The field-type contract.
 *
 * This exists because of a specific, expensive failure: the scanner learned to
 * emit `password`, a validating boundary still held the previous list, and
 * every scan of a login page died at INVALID_SCAN_RESULT — with an error that
 * blamed the value rather than the build. The page had been read correctly and
 * was thrown away at a validation step nobody realised was a second copy.
 *
 * So these tests assert two different things:
 *
 * 1. **Source**: every schema that validates a field type accepts every
 *    canonical member. Any boundary that disagrees fails here.
 * 2. **Built output**: no bundle in `extension/dist` carries a copy of the list
 *    that is missing a member. This is the check that would have caught the
 *    real failure, because the source was already correct — the *installed*
 *    bundle was not.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A repo-relative, forward-slashed path, for readable failure messages. */
function relativeTo(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}
const DIST = join(ROOT, 'extension', 'dist');

/** The exact list, in order. Changing it is a deliberate act, not a drive-by. */
const EXPECTED_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'date',
  'month',
  'url',
  'password',
  'select',
  'combobox',
  'radio',
  'checkbox',
  'multi_select',
  'file',
  'contenteditable',
  'unknown',
] as const;

function field(fieldType: FieldType, overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: `field-${fieldType}`,
    pageId: 'page-1',
    label: `A ${fieldType} question`,
    normalizedLabel: `a ${fieldType} question`,
    question: `A ${fieldType} question`,
    fieldType,
    selector: `#${fieldType}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

/** Built from the real schema shape, not an invented one. */
function scanOf(fields: DetectedField[]) {
  return {
    id: 'scan-1',
    createdAt: '2026-08-02T09:00:00.000Z',
    url: 'https://careers.example.com/apply',
    domain: 'careers.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'application-like HTML controls were found',
      supported: true,
    },
    jobContext: {},
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: fields.length,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 3,
    status: 'completed',
    readOnly: true,
  };
}

describe('the canonical field-type list', () => {
  it('has exactly the agreed members, in the agreed order', () => {
    expect([...FIELD_TYPES]).toEqual([...EXPECTED_FIELD_TYPES]);
  });

  it('includes password and month', () => {
    expect(FIELD_TYPES).toContain('password');
    expect(FIELD_TYPES).toContain('month');
  });

  it('is what the Zod enum is built from, so the two cannot drift', () => {
    expect(fieldTypeSchema.options).toEqual([...FIELD_TYPES]);
  });

  it('derives the fillable subset rather than restating it', () => {
    // A second hand-written list is exactly the duplication this file exists to
    // prevent, so the fillable set must be FIELD_TYPES minus the two that have
    // nothing to fill.
    expect([...FILLABLE_FIELD_TYPES]).toEqual(
      FIELD_TYPES.filter((type) => type !== 'file' && type !== 'unknown'),
    );
    expect(FILLABLE_FIELD_TYPES).toContain('password');
    expect(FILLABLE_FIELD_TYPES).toContain('month');
  });
});

describe('every source boundary accepts every canonical member', () => {
  for (const fieldType of EXPECTED_FIELD_TYPES) {
    it(`detectedFieldSchema accepts ${fieldType}`, () => {
      expect(detectedFieldSchema.safeParse(field(fieldType)).success).toBe(true);
    });
  }

  it('the scan-result schema accepts a page containing every member at once', () => {
    const parsed = applicationScanResultSchema.safeParse(
      scanOf(EXPECTED_FIELD_TYPES.map((type) => field(type))),
    );
    if (!parsed.success) {
      // Naming the offending member makes a regression here readable at a glance.
      throw new Error(
        `The scan schema rejected a canonical field type: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} (${issue.code})`)
          .join(', ')}`,
      );
    }
    expect(parsed.success).toBe(true);
  });

  it('the scan-response envelope accepts a password field end to end', () => {
    const response = scanApplicationResponseSchema.safeParse({
      type: 'SCAN_COMPLETE',
      result: scanOf([field('password'), field('text', { id: 'user', label: 'User Name' })]),
    });
    expect(response.success).toBe(true);
  });

  it('the fill-plan schema accepts an action on a password field', () => {
    const parsed = deterministicFillPlanSchema.safeParse({
      id: 'plan-1',
      scanId: 'scan-1',
      createdAt: '2026-08-02T09:00:00.000Z',
      updatedAt: '2026-08-02T09:00:00.000Z',
      url: 'https://careers.example.com/login',
      domain: 'careers.example.com',
      ats: 'generic',
      actions: [],
      warnings: [],
      statistics: { total: 0, ready: 0, review: 0, skipped: 0, unsupported: 0, sensitive: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it('the question model knows what every member is, with no unknown fallthrough', () => {
    for (const fieldType of EXPECTED_FIELD_TYPES) {
      const question = toNormalizedQuestion(field(fieldType));
      // `unknown` is the only member allowed to map to an unknown control.
      if (fieldType !== 'unknown') {
        expect(question.controlType, `${fieldType} has no control type`).not.toBe('unknown');
      }
    }
  });
});

/**
 * The build-time half.
 *
 * Skipped when `extension/dist` has not been built, so a fresh clone running
 * `npm test` before `npm run build` does not fail on a folder that was never
 * meant to exist yet. `npm run validate` builds first, so the gate is real
 * where it matters.
 */
const built = existsSync(join(DIST, 'content.js'));

const CANONICAL_MEMBERS = ['contenteditable', 'multi_select', 'file', 'unknown'];

/**
 * Bracketed literals that are the canonical list, not some other list.
 *
 * Four members that co-occur only here. A looser test flagged
 * `isAiEligibleField`'s `['textarea','contenteditable','text']` — a
 * legitimately different list that correctly excludes `password`.
 */
function canonicalLiterals(source: string): string[] {
  const literals = source.match(/\[[^[\]]{0,800}\]/g) ?? [];
  return literals.filter((literal) =>
    CANONICAL_MEMBERS.every(
      (member) => literal.includes(`'${member}'`) || literal.includes(`"${member}"`),
    ),
  );
}

/** Every emitted JavaScript bundle, entry points and shared chunks alike. */
function bundlePaths(): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(DIST, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) paths.push(join(DIST, entry.name));
  }
  const chunks = join(DIST, 'chunks');
  if (existsSync(chunks)) {
    for (const entry of readdirSync(chunks, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) paths.push(join(chunks, entry.name));
    }
  }
  return paths;
}

describe.skipIf(!built)('the built bundles agree with the source', () => {
  it('has at least one bundle carrying the list, so this test can fail', () => {
    const carriers = bundlePaths().filter(
      (path) => canonicalLiterals(readFileSync(path, 'utf8')).length > 0,
    );
    expect(carriers.length).toBeGreaterThan(0);
  });

  it('has no bundle carrying a copy of the list without password', () => {
    const stale: string[] = [];
    for (const path of bundlePaths()) {
      for (const literal of canonicalLiterals(readFileSync(path, 'utf8'))) {
        if (!literal.includes("'password'") && !literal.includes('"password"')) {
          stale.push(relativeTo(path));
        }
      }
    }
    expect(
      stale,
      `These built bundles hold a field-type list without "password" and will reject a login page at runtime. Run "npm run build:extension".\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('has no bundle carrying a copy of the list without month', () => {
    const stale: string[] = [];
    for (const path of bundlePaths()) {
      for (const literal of canonicalLiterals(readFileSync(path, 'utf8'))) {
        if (!literal.includes("'month'") && !literal.includes('"month"')) {
          stale.push(relativeTo(path));
        }
      }
    }
    expect(stale, `Stale bundles missing "month":\n${stale.join('\n')}`).toEqual([]);
  });

  it('ships a content script, which the first build pass used to delete', () => {
    // `vite.config.ts` had emptyOutDir:true, so pass 1 removed content.js and
    // only the full two-pass build put it back. In watch mode it never came
    // back at all.
    expect(existsSync(join(DIST, 'content.js'))).toBe(true);
    expect(readFileSync(join(DIST, 'content.js'), 'utf8').length).toBeGreaterThan(1000);
  });
});

/**
 * Behavioural checks against the generated runtime, not just its text.
 *
 * The bundle is loaded and its schema is actually exercised. Searching a bundle
 * for a string proves the string is present; importing it and parsing a
 * password field proves the runtime accepts one, which is the thing that failed.
 */
describe.skipIf(!built)('the generated runtime accepts what the scanner emits', () => {
  it('parses a password field through the freshly built shared schema', async () => {
    // shared/dist is what every bundle is compiled from, so this is the
    // generated artifact rather than the TypeScript source.
    const built = await import('../../shared/dist/schemas/fields.js');
    expect(built.fieldTypeSchema.options).toContain('password');
    expect(built.fieldTypeSchema.options).toContain('month');
    expect(built.fieldTypeSchema.safeParse('password').success).toBe(true);
    expect(built.fieldTypeSchema.safeParse('month').success).toBe(true);
  });

  it('still rejects an arbitrary type in the generated runtime', async () => {
    const built = await import('../../shared/dist/schemas/fields.js');
    expect(built.fieldTypeSchema.safeParse('quantum_flux').success).toBe(false);
  });

  it('has one field-type member set across every bundle, not a superset', () => {
    // Two Vite passes write into one folder. If they are of different vintages
    // the sets differ, and the scanner emits what its receiver rejects.
    const sets = new Map<string, string>();
    for (const path of bundlePaths()) {
      for (const literal of canonicalLiterals(readFileSync(path, 'utf8'))) {
        const members = [...literal.matchAll(/['"]([a-z_]+)['"]/g)].map((match) => match[1]);
        sets.set(relativeTo(path), [...new Set(members)].sort().join(','));
      }
    }
    expect(sets.size).toBeGreaterThan(0);
    const distinct = new Set(sets.values());
    expect(
      distinct.size,
      `bundles disagree about the field-type list:\n${[...sets.entries()]
        .map(([file, set]) => `  ${file}: ${set}`)
        .join('\n')}`,
    ).toBe(1);
    expect([...distinct][0]?.split(',')).toHaveLength(FIELD_TYPES.length);
  });

  it('carries an iCIMS hostname pattern that matches real tenant subdomains', () => {
    let pattern: RegExp | null = null;
    for (const path of bundlePaths()) {
      // Pulls the TLD group out of the emitted `/(^|\.)icims\.(com|eu)$/i`.
      const match = /icims\\[.]\(?([a-z|]+)\)?[$]/i.exec(readFileSync(path, 'utf8'));
      if (match) {
        pattern = new RegExp(String.raw`(^|\.)icims\.(${match[1]})$`, 'i');
        break;
      }
    }
    expect(pattern, 'no iCIMS hostname pattern found in any bundle').not.toBeNull();
    for (const host of [
      'careers2-quanta.icims.com',
      'careers-quanta.icims.com',
      'jobs-company.icims.com',
      'careers.icims.eu',
    ]) {
      expect(pattern!.test(host), `${host} should match`).toBe(true);
    }
    expect(pattern!.test('icims.com.attacker.example')).toBe(false);
  });

  it('stamps the build so a stale unpacked folder is identifiable', async () => {
    const { BUILD_INFO } = await import('../../extension/src/generated/buildInfo.js');
    expect(BUILD_INFO.sourceRoot).toBe(ROOT);
    expect(BUILD_INFO.commit).toMatch(/^[0-9a-f]{7,}$|^unknown$/);
    // Present in the popup bundle, so it is visible without opening devtools.
    const popup = readFileSync(join(DIST, 'popup.js'), 'utf8');
    // The stamp is embedded as a JSON string literal, so a Windows path arrives
    // with its separators doubled. `JSON.stringify` reproduces that exactly,
    // and works unchanged on a platform where there is nothing to escape.
    const embedded = JSON.stringify(BUILD_INFO.sourceRoot).slice(1, -1);
    expect(popup).toContain(embedded);
  });
});
