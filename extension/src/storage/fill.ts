import {
  applicationAutofillReportSchema,
  deterministicFillPlanSchema,
  fillRunReportSchema,
  type ApplicationAutofillReport,
  type DeterministicFillPlan,
  type FillRunReport,
} from '@internship-agent/shared';

const FILL_PLAN_KEY = 'latestDeterministicFillPlan';
const FILL_REPORT_KEY = 'latestFillRunReport';
const AUTOFILL_REPORT_KEY = 'latestApplicationAutofillReport';

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

/**
 * The one-button autofill report, kept separately from the deterministic fill
 * report: a run spans several scans and several fill passes, and the popup
 * needs the run's totals rather than the last pass's.
 */
export async function loadAutofillReport(): Promise<ApplicationAutofillReport | null> {
  const stored = await chrome.storage.local.get(AUTOFILL_REPORT_KEY);
  const parsed = applicationAutofillReportSchema.safeParse(stored[AUTOFILL_REPORT_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveAutofillReport(report: ApplicationAutofillReport): Promise<void> {
  await chrome.storage.local.set({
    [AUTOFILL_REPORT_KEY]: applicationAutofillReportSchema.parse(report),
  });
}

export async function clearFillState(): Promise<void> {
  await chrome.storage.local.remove([FILL_PLAN_KEY, FILL_REPORT_KEY, AUTOFILL_REPORT_KEY]);
}
