import { formatDateForField } from './dateValues.js';
import type { DetectedField } from '../schemas/fields.js';

export type FormattableValue = string | string[] | boolean | number;
export type FormattedValue = string | string[] | boolean;

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
};

function phone(value: string, placeholder = ''): string {
  const hasPlus = value.trim().startsWith('+');
  const digits = value.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return value.trim();
  if (/\(\D*555\D*\)\D*555[-\s]5555/.test(placeholder) || placeholder.includes('(')) {
    return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  }
  if (placeholder.includes('-')) {
    return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  }
  if (hasPlus || placeholder.includes('+1')) return `+1${local}`;
  return local;
}

/**
 * Formats a stored date for a control, and never invents a component of it.
 *
 * The whole body of this used to be here, and two of its branches wrote a day
 * the profile never stated: `${year}-${month}-${day ?? '01'}` for a native date
 * input, and the same `?? '01'` for an `MM/DD/YYYY` box. A graduation stored as
 * "May 2027" therefore arrived on the employer's form as the first of May.
 *
 * `formatDateForField` decides instead, has no clock, and refuses rather than
 * fabricates. A refusal returns the value untouched here so the verifier fails
 * honestly — the matcher gates factual dates before reaching this point and
 * turns a refusal into a question for the user.
 */
function date(value: string, field: DetectedField): string {
  const outcome = formatDateForField(field, value);
  return outcome.kind === 'value' ? outcome.value : value.trim();
}

function state(value: string, field: DetectedField): string {
  const trimmed = value.trim();
  const abbreviation = Object.entries(STATE_NAMES).find(
    ([code, name]) =>
      code.toLowerCase() === trimmed.toLowerCase() || name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!abbreviation) return trimmed;
  const wantsCode =
    /\b(state code|2 letters?|abbreviation)\b/i.test(
      `${field.placeholder ?? ''} ${field.helpText ?? ''}`,
    ) || field.options?.some((option) => option.label === abbreviation[0]);
  return wantsCode ? abbreviation[0] : abbreviation[1];
}

export function formatValue(field: DetectedField, raw: FormattableValue): FormattedValue {
  if (Array.isArray(raw)) return raw.map((entry) => entry.trim());
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (field.canonicalKey === 'gpa') return Number.isInteger(raw) ? String(raw) : String(raw);
    return String(raw);
  }
  const value = raw.trim();
  switch (field.canonicalKey ?? field.semanticType) {
    case 'phone':
      return phone(value, field.placeholder);
    case 'state':
      return state(value, field);
    case 'postal_code':
      return value.replace(/\s+/g, ' ').toUpperCase();
    case 'country':
      return /^(us|usa|u\.s\.a?\.?)$/i.test(value) ? 'United States' : value;
    case 'linkedin':
    case 'github':
    case 'portfolio':
    case 'website':
      return /^(https?:\/\/)/i.test(value) ? value : `https://${value}`;
    case 'graduation_date':
    case 'education_start_date':
    case 'employment_start_date':
    case 'employment_end_date':
    case 'earliest_start_date':
      return date(value, field);
    default:
      return field.fieldType === 'date' ? date(value, field) : value;
  }
}

export function stateAliases(value: string): string[] {
  const entry = Object.entries(STATE_NAMES).find(
    ([code, name]) =>
      code.toLowerCase() === value.toLowerCase() || name.toLowerCase() === value.toLowerCase(),
  );
  return entry ? [entry[0], entry[1]] : [value];
}
