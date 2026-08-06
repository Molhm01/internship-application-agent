import type { ApplicationScanResult, DeterministicFillPlan } from '@internship-agent/shared';

export interface PageIdentityResult {
  valid: boolean;
  reason: string;
}

/**
 * Proves the document about to be written to is the one that was scanned.
 *
 * `expectedFrameUrl` exists because a form split across frames is executed one
 * frame at a time, and a subframe's URL is legitimately not the scan's — a
 * Workday upload widget on `wd5.myworkdayjobs.com` inside a page on the
 * employer's own domain is the ordinary case, not an attack. When it is given,
 * it is what this document is checked against; the scan and plan must still
 * agree with each other, which is the part that stops a plan built for one page
 * being run against another.
 */
export function validatePageIdentity(
  currentUrl: string,
  scan: ApplicationScanResult,
  plan: DeterministicFillPlan,
  expectedFrameUrl?: string,
): PageIdentityResult {
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return { valid: false, reason: 'Current page URL is invalid.' };
  }
  if (plan.scanId !== scan.id || plan.url !== scan.url || plan.domain !== scan.domain) {
    return { valid: false, reason: 'The scan and fill plan do not match.' };
  }
  if (expectedFrameUrl !== undefined) {
    if (current.href !== expectedFrameUrl) {
      return { valid: false, reason: 'This frame navigated after it was scanned.' };
    }
    return { valid: true, reason: 'Frame URL, scan ID, and plan identity match.' };
  }
  if (current.href !== scan.url || current.hostname !== scan.domain) {
    return { valid: false, reason: 'The current page, scan, and fill plan do not match.' };
  }
  return { valid: true, reason: 'Page URL, domain, scan ID, and plan identity match.' };
}
