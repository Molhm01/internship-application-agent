import {
  FIELD_SECTIONS,
  applicationScanResultSchema,
  type ApplicationScanResult,
  type ScanProgress,
  type ScanStatistics,
} from '@internship-agent/shared';
import { isSupportedField } from './domScanner.js';
import { selectAdapter, type BrowserScanContext } from './adapters.js';

export interface ScanApplicationOptions {
  scanId: string;
  document: Document;
  signal: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

function pageId(url: string): string {
  let hash = 0;
  for (const character of url) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `page-${(hash >>> 0).toString(36)}`;
}

function statistics(fields: ApplicationScanResult['fields']): ScanStatistics {
  const bySection = Object.fromEntries(FIELD_SECTIONS.map((section) => [section, 0])) as Record<
    (typeof FIELD_SECTIONS)[number],
    number
  >;
  for (const field of fields) bySection[field.section ?? 'other'] += 1;
  const count = (type: ApplicationScanResult['fields'][number]['fieldType']): number =>
    fields.filter((field) => field.fieldType === type).length;
  return {
    total: fields.length,
    supported: fields.filter(isSupportedField).length,
    unknown: count('unknown'),
    required: fields.filter((field) => field.required).length,
    optional: fields.filter((field) => !field.required).length,
    text: count('text'),
    textarea: count('textarea'),
    select: count('select') + count('multi_select'),
    combobox: count('combobox'),
    radio: count('radio'),
    checkbox: count('checkbox'),
    file: count('file'),
    bySection,
  };
}

export async function scanApplication({
  scanId,
  document,
  signal,
  onProgress,
}: ScanApplicationOptions): Promise<ApplicationScanResult> {
  const started = performance.now();
  const initialUrl = document.location.href;
  const emit = (
    stage: ScanProgress['stage'],
    message: string,
    percent: number,
    fieldsSoFar = 0,
  ): void => onProgress?.({ scanId, stage, message, percent, fieldsSoFar });

  emit('detecting_ats', 'Detecting applicant tracking system…', 10);
  const detectionContext = {
    url: initialUrl,
    hostname: document.location.hostname,
    title: document.title,
    bodyText: document.body?.innerText ?? '',
    document,
  };
  const selected = selectAdapter(detectionContext);
  console.info('[agent] scan adapter selected', {
    scanId,
    adapter: selected.adapter.id,
    confidence: selected.detection.confidence,
    reason: selected.detection.reason,
  });

  const warnings: string[] = [];
  const context: BrowserScanContext = {
    ...detectionContext,
    pageId: pageId(initialUrl),
    signal,
    warnings,
  };

  emit('extracting_job_context', 'Extracting job details…', 30);
  const jobContext = await selected.adapter.extractJobContext(context);
  emit('scanning_fields', 'Scanning application questions…', 50);
  const fields = await selected.adapter.scan(context);
  emit('normalizing', 'Normalizing fields and sections…', 78, fields.length);

  if (signal.aborted) throw new DOMException('Scan cancelled', 'AbortError');
  if (document.location.href !== initialUrl) {
    throw new DOMException('The page URL changed during scanning.', 'InvalidStateError');
  }

  if (!selected.detection.supported) {
    warnings.push(
      `${selected.adapter.displayName} is detected but dedicated support is unavailable.`,
    );
  }
  emit('validating', 'Validating scan result…', 92, fields.length);
  const uniqueWarnings = [...new Set(warnings)];
  const result = applicationScanResultSchema.parse({
    id: scanId,
    createdAt: new Date().toISOString(),
    url: initialUrl,
    domain: document.location.hostname,
    ats: {
      id: selected.adapter.id,
      displayName: selected.adapter.displayName,
      confidence: selected.detection.confidence,
      detectionReason: selected.detection.reason,
      supported: selected.detection.supported,
    },
    jobContext,
    fields,
    warnings: uniqueWarnings,
    statistics: statistics(fields),
    durationMs: Math.round(performance.now() - started),
    status: uniqueWarnings.length ? 'completed_with_warnings' : 'completed',
    readOnly: true,
  });
  emit('done', `Detected ${fields.length} fields.`, 100, fields.length);
  return result;
}
