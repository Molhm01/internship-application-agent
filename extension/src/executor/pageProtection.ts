import type { ApplicationScanResult, DeterministicFillPlan } from '@internship-agent/shared';

export interface PageIdentityResult {
  valid: boolean;
  reason: string;
}

export function validatePageIdentity(
  currentUrl: string,
  scan: ApplicationScanResult,
  plan: DeterministicFillPlan,
): PageIdentityResult {
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return { valid: false, reason: 'Current page URL is invalid.' };
  }
  if (
    current.href !== scan.url ||
    current.hostname !== scan.domain ||
    plan.scanId !== scan.id ||
    plan.url !== scan.url ||
    plan.domain !== scan.domain
  ) {
    return { valid: false, reason: 'The current page, scan, and fill plan do not match.' };
  }
  return { valid: true, reason: 'Page URL, domain, scan ID, and plan identity match.' };
}
