import {
  deterministicFillPlanSchema,
  fillRunReportSchema,
  type DeterministicFillPlan,
  type FillRunReport,
} from '@internship-agent/shared';

const FILL_PLAN_KEY = 'latestDeterministicFillPlan';
const FILL_REPORT_KEY = 'latestFillRunReport';

export async function loadFillPlan(): Promise<DeterministicFillPlan | null> {
  const stored = await chrome.storage.local.get(FILL_PLAN_KEY);
  const parsed = deterministicFillPlanSchema.safeParse(stored[FILL_PLAN_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveFillPlan(plan: DeterministicFillPlan): Promise<void> {
  await chrome.storage.local.set({ [FILL_PLAN_KEY]: deterministicFillPlanSchema.parse(plan) });
}

export async function loadFillReport(): Promise<FillRunReport | null> {
  const stored = await chrome.storage.local.get(FILL_REPORT_KEY);
  const parsed = fillRunReportSchema.safeParse(stored[FILL_REPORT_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveFillReport(report: FillRunReport): Promise<void> {
  await chrome.storage.local.set({ [FILL_REPORT_KEY]: fillRunReportSchema.parse(report) });
}

export async function clearFillState(): Promise<void> {
  await chrome.storage.local.remove([FILL_PLAN_KEY, FILL_REPORT_KEY]);
}
