import {
  applicationScanResultSchema,
  classifyPage,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import {
  censusForPage,
  collectNavigationControls,
} from '../../extension/src/scanner/domScanner.js';

/**
 * Wraps scanned iCIMS fields in a valid `ApplicationScanResult`.
 *
 * The planner takes a whole scan, not a field list, and building one inline in
 * every test buried the assertion under thirty lines of statistics nobody was
 * checking. The statistics here are derived rather than hand-written, so this
 * helper can never drift from the fields it describes.
 */
export function icimsScan(fields: readonly DetectedField[]): ApplicationScanResult {
  const count = (type: DetectedField['fieldType']): number =>
    fields.filter((field) => field.fieldType === type).length;

  return applicationScanResultSchema.parse({
    id: 'scan-icims-fixture',
    createdAt: '2026-08-03T09:00:00.000Z',
    url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
    domain: 'careers2-quanta.icims.com',
    ats: {
      id: 'icims',
      displayName: 'iCIMS',
      confidence: 0.98,
      detectionReason: 'hostname careers2-quanta.icims.com matches iCIMS',
      supported: true,
    },
    jobContext: {},
    fields,
    // Classified the same way the content script classifies it, rather than
    // omitted. Leaving it out made every test using this helper see a page of
    // kind `unknown`, which silently skipped the account-creation branch of the
    // run — so the credential fill was never exercised by anything.
    navigation: classifyPage({
      url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
      title: 'Create an Account',
      bodyText: document.body?.textContent?.slice(0, 20_000) ?? '',
      fields,
      controls: collectNavigationControls(document),
    }),
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
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
      credentialFields: count('password'),
      navigationActions: 0,
      // Read back from the scanner rather than invented, so a test asserting on
      // what the scan discarded is asserting on what it really discarded.
      ...censusForPage('page-icims'),
    },
    durationMs: 4,
    status: 'completed',
    readOnly: true,
  });
}
