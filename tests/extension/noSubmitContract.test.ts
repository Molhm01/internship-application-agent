import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autofillSettingsSchema } from '../../shared/schemas/autofill.js';
import { fillRunReportSchema } from '../../shared/schemas/fill.js';

const NOW = '2026-07-31T12:00:00.000Z';

describe('standalone autofill submission boundary', () => {
  it('cannot disable neverSubmit or record an automatic submission', () => {
    expect(() => autofillSettingsSchema.parse({ neverSubmit: false })).toThrow();
    expect(() =>
      fillRunReportSchema.parse({
        id: 'fill-1',
        planId: 'plan-1',
        scanId: 'scan-1',
        startedAt: NOW,
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        ats: 'greenhouse',
        totalActions: 0,
        approvedActions: 0,
        verifiedActions: 0,
        failedActions: 0,
        reviewActions: 0,
        skippedActions: 0,
        unsupportedActions: 0,
        status: 'completed',
        results: [],
        submitted: true,
      }),
    ).toThrow();
  });

  it('contains no form submission operation in the DOM executor', () => {
    const executor = readFileSync(
      path.resolve(process.cwd(), 'extension/src/executor/domExecutor.ts'),
      'utf8',
    );
    expect(executor).not.toContain('requestSubmit(');
    expect(executor).not.toMatch(/\.submit\s*\(/);
  });
});
