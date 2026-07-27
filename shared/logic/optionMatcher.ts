import type { FieldOption } from '../schemas/fields.js';

export interface OptionMatchResult {
  matched: boolean;
  ambiguous: boolean;
  option?: FieldOption;
  reason: string;
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPTION_ALIASES: ReadonlyArray<readonly string[]> = [
  ['yes', 'true', 'y'],
  ['no', 'false', 'n'],
  ['united states', 'united states of america', 'usa', 'us', 'u s'],
  ['bachelors', "bachelor's", 'bachelor degree', "bachelor's degree", 'bs', 'ba'],
  ['masters', "master's", 'master degree', "master's degree", 'ms', 'ma'],
  ['decline to answer', 'prefer not to answer', 'i do not wish to answer'],
];

const aliasGroup = (value: string): readonly string[] => {
  const key = normalized(value);
  return OPTION_ALIASES.find((group) => group.some((entry) => normalized(entry) === key)) ?? [key];
};

/** Matches only exact normalized labels/values or an explicitly documented alias group. */
export function matchOption(
  rawValue: string | boolean | number,
  options: readonly FieldOption[],
): OptionMatchResult {
  const requested =
    typeof rawValue === 'boolean' ? (rawValue ? 'yes' : 'no') : String(rawValue).trim();
  const requestedAliases = new Set(aliasGroup(requested).map(normalized));
  const exact = options.filter((option) => {
    const label = normalized(option.label);
    const value = normalized(option.value);
    return requestedAliases.has(label) || requestedAliases.has(value);
  });
  if (exact.length === 1) {
    return {
      matched: true,
      ambiguous: false,
      option: exact[0],
      reason: `Exact deterministic option match: "${exact[0]?.label}".`,
    };
  }
  if (exact.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      reason: `Multiple options matched "${requested}" equally.`,
    };
  }
  return {
    matched: false,
    ambiguous: false,
    reason: `No detected option exactly matched "${requested}".`,
  };
}

export function normalizeOptionText(value: string): string {
  return normalized(value);
}
