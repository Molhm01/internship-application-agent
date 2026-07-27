import { applicationScanResultSchema, type ApplicationScanResult } from '@internship-agent/shared';

const LAST_SCAN_KEY = 'lastApplicationScan';

export async function loadLastScan(): Promise<ApplicationScanResult | null> {
  const stored = await chrome.storage.local.get(LAST_SCAN_KEY);
  const parsed = applicationScanResultSchema.safeParse(stored[LAST_SCAN_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveLastScan(result: ApplicationScanResult): Promise<void> {
  const validated = applicationScanResultSchema.parse(result);
  await chrome.storage.local.set({ [LAST_SCAN_KEY]: validated });
}

export async function clearLastScan(): Promise<void> {
  await chrome.storage.local.remove(LAST_SCAN_KEY);
}

/** Defense in depth for review copy/download output. */
export function sanitizeScanForExport(result: ApplicationScanResult): ApplicationScanResult {
  const secretKey = /(access|auth|refresh)?token|secret|password|authorization/i;
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !secretKey.test(key))
        .map(([key, entry]) => [key, sanitize(entry)]),
    );
  };
  return applicationScanResultSchema.parse(sanitize(result));
}
