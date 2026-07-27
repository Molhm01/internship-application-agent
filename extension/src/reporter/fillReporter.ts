import {
  fillRunReportSchema,
  type ApplicationScanResult,
  type DeterministicFillPlan,
  type FillExecutionResult,
  type FillRunReport,
} from '@internship-agent/shared';

export function createRunningReport(
  plan: DeterministicFillPlan,
  scan: ApplicationScanResult,
  runId: string,
): FillRunReport {
  return fillRunReportSchema.parse({
    id: runId,
    planId: plan.id,
    scanId: scan.id,
    startedAt: new Date().toISOString(),
    url: scan.url,
    ats: scan.ats.id,
    totalActions: plan.actions.length,
    approvedActions: plan.actions.filter((action) => action.approved).length,
    verifiedActions: 0,
    failedActions: 0,
    reviewActions: plan.statistics.review,
    skippedActions: plan.statistics.skipped,
    unsupportedActions: plan.statistics.unsupported,
    status: 'running',
    results: [],
    warnings: ['No application was submitted. Review the application and continue manually.'],
    submitted: false,
  });
}

export function completeReport(
  report: FillRunReport,
  results: readonly FillExecutionResult[],
): FillRunReport {
  const cancelled = results.some((result) => result.status === 'cancelled');
  const failed = results.filter(
    (result) => result.status === 'failed' || result.status === 'filled_unverified',
  ).length;
  return fillRunReportSchema.parse({
    ...report,
    completedAt: new Date().toISOString(),
    verifiedActions: results.filter((result) => result.status === 'verified').length,
    failedActions: failed,
    reviewActions: results.filter((result) => result.status === 'needs_review').length,
    skippedActions: results.filter((result) => result.status === 'skipped').length,
    unsupportedActions: results.filter((result) => result.status === 'unsupported').length,
    status: cancelled ? 'cancelled' : failed ? 'completed_with_errors' : 'completed',
    results,
  });
}
