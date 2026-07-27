import { describe, expect, it } from 'vitest';
import { deterministicFillPlanSchema, fillRunReportSchema } from '@internship-agent/shared';
import {
  clearFillState,
  loadFillPlan,
  loadFillReport,
  saveFillPlan,
  saveFillReport,
} from '../../extension/src/storage/fill.js';

const NOW = '2026-07-26T12:00:00.000Z';

describe('fill persistence', () => {
  it('round trips validated plan approval state and reports, then clears both', async () => {
    const plan = deterministicFillPlanSchema.parse({
      id: 'plan-1',
      scanId: 'scan-1',
      createdAt: NOW,
      updatedAt: NOW,
      url: 'https://example.test/apply',
      domain: 'example.test',
      ats: 'generic',
      actions: [],
      warnings: [],
      statistics: { total: 0, ready: 0, review: 0, skipped: 0, unsupported: 0, sensitive: 0 },
    });
    const report = fillRunReportSchema.parse({
      id: 'run-1',
      planId: plan.id,
      scanId: plan.scanId,
      startedAt: NOW,
      completedAt: NOW,
      url: plan.url,
      ats: plan.ats,
      totalActions: 0,
      approvedActions: 0,
      verifiedActions: 0,
      failedActions: 0,
      reviewActions: 0,
      skippedActions: 0,
      unsupportedActions: 0,
      status: 'completed',
      results: [],
      warnings: [],
    });
    await saveFillPlan(plan);
    await saveFillReport(report);
    expect(await loadFillPlan()).toEqual(plan);
    expect(await loadFillReport()).toEqual(report);
    await clearFillState();
    expect(await loadFillPlan()).toBeNull();
    expect(await loadFillReport()).toBeNull();
  });
});
