import { FILLABLE_FIELD_TYPES, type DetectedField, type FieldType } from '../schemas/fields.js';
import { FIELD_SECTIONS, type FieldSection } from '../constants/questions.js';

/**
 * The counts that describe a scan, derived from the fields themselves.
 *
 * There used to be two of these: one in the content script, which counted a
 * single document, and one in the background worker, which *added* the numbers
 * from every frame. Adding them was wrong the moment a control could appear in
 * two frame scans — the parent's walk into a same-origin iframe and the child's
 * own scan both found it — so a page with twenty-five questions reported
 * twenty-six supported ones. A count that disagrees with its own field list is
 * exactly the kind of number that makes a diagnostic useless.
 *
 * Only the census (`rawControls`, `falseControlsRemoved`,
 * `duplicateControlsRemoved`) and `navigationActions` are contributed by the
 * caller: those describe work the scan *did*, per document, and are genuinely
 * additive. Everything else is a property of the fields being reported.
 */

export interface ScanCensusCounts {
  rawControls: number;
  falseControlsRemoved: number;
  duplicateControlsRemoved: number;
}

export function countFieldStatistics(
  fields: readonly DetectedField[],
  navigationActions: number,
  census: ScanCensusCounts,
): Record<string, unknown> {
  const bySection = Object.fromEntries(FIELD_SECTIONS.map((section) => [section, 0])) as Record<
    FieldSection,
    number
  >;
  for (const field of fields) bySection[field.section ?? 'other'] += 1;
  const count = (type: FieldType): number =>
    fields.filter((field) => field.fieldType === type).length;

  return {
    total: fields.length,
    supported: fields.filter((field) => FILLABLE_FIELD_TYPES.includes(field.fieldType)).length,
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
    navigationActions,
    ...census,
    bySection,
  };
}
