import { applicationScanResultSchema, type ApplicationScanResult } from '@internship-agent/shared';

const NOW = '2026-07-31T12:00:00.000Z';

export function emptyApplicationScan(url: string): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: `scan-empty-${new URL(url).hostname}`,
    createdAt: NOW,
    url,
    domain: new URL(url).hostname,
    ats: {
      id: 'generic',
      displayName: 'Generic HTML form',
      confidence: 0,
      detectionReason: 'No supported fields found.',
      supported: true,
    },
    jobContext: { sourceUrl: url },
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
    },
    durationMs: 1,
    status: 'completed',
    readOnly: true,
  });
}
