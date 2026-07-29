import type { FieldOption } from '../schemas/fields.js';

export interface OptionMatchResult {
  matched: boolean;
  ambiguous: boolean;
  option?: FieldOption;
  /** Which alias group produced the match, for the review screen to show. */
  aliasUsed?: string;
  /**
   * How the match was reached. `region_suffix` is the only kind that infers
   * something the saved value did not state (a city's region), so callers hold
   * it back for confirmation while treating a spelling alias as equivalent.
   */
  matchKind?: 'literal' | 'alias' | 'region_suffix';
  /** 'high' for a literal match, 'medium' for an alias or region-suffix match. */
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  warnings: string[];
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

/**
 * Explicit, hand-written equivalences only. Every group is a closed set of
 * spellings for one real-world answer — never a similarity heuristic, because a
 * near-miss on a dropdown silently submits the wrong answer.
 */
const OPTION_ALIASES: ReadonlyArray<readonly string[]> = [
  // Booleans
  ['yes', 'true', 'y'],
  ['no', 'false', 'n'],

  // Countries seen on US-facing application forms.
  ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america'],
  ['united kingdom', 'uk', 'great britain', 'u k'],
  ['canada', 'ca'],
  ['india', 'in'],

  // Degrees
  [
    'bachelors',
    "bachelor's",
    'bachelor degree',
    "bachelor's degree",
    'bs',
    'ba',
    'bsc',
    'b s',
    'b a',
    'bachelor of science',
    'bachelor of arts',
    'undergraduate degree',
  ],
  [
    'masters',
    "master's",
    'master degree',
    "master's degree",
    'ms',
    'ma',
    'msc',
    'm s',
    'm a',
    'master of science',
    'master of arts',
    'graduate degree',
  ],
  ['doctorate', 'phd', 'ph d', 'doctoral degree', 'doctor of philosophy'],
  ['associates', "associate's", "associate's degree", 'associate degree', 'aa', 'as'],
  ['high school', 'high school diploma', 'secondary school', 'ged'],

  // Declining an answer
  [
    'decline to answer',
    'prefer not to answer',
    'i do not wish to answer',
    'i prefer not to answer',
    'i don t wish to answer',
    'decline to self identify',
    'i do not wish to self identify',
    'prefer not to disclose',
    'do not wish to disclose',
  ],
];

/** US state abbreviation ↔ full name. Deterministic and closed. */
const US_STATES: Readonly<Record<string, string>> = {
  al: 'alabama',
  ak: 'alaska',
  az: 'arizona',
  ar: 'arkansas',
  ca: 'california',
  co: 'colorado',
  ct: 'connecticut',
  de: 'delaware',
  fl: 'florida',
  ga: 'georgia',
  hi: 'hawaii',
  id: 'idaho',
  il: 'illinois',
  in: 'indiana',
  ia: 'iowa',
  ks: 'kansas',
  ky: 'kentucky',
  la: 'louisiana',
  me: 'maine',
  md: 'maryland',
  ma: 'massachusetts',
  mi: 'michigan',
  mn: 'minnesota',
  ms: 'mississippi',
  mo: 'missouri',
  mt: 'montana',
  ne: 'nebraska',
  nv: 'nevada',
  nh: 'new hampshire',
  nj: 'new jersey',
  nm: 'new mexico',
  ny: 'new york',
  nc: 'north carolina',
  nd: 'north dakota',
  oh: 'ohio',
  ok: 'oklahoma',
  or: 'oregon',
  pa: 'pennsylvania',
  ri: 'rhode island',
  sc: 'south carolina',
  sd: 'south dakota',
  tn: 'tennessee',
  tx: 'texas',
  ut: 'utah',
  vt: 'vermont',
  va: 'virginia',
  wa: 'washington',
  wv: 'west virginia',
  wi: 'wisconsin',
  wy: 'wyoming',
  dc: 'district of columbia',
};

const STATE_GROUPS: ReadonlyArray<readonly string[]> = Object.entries(US_STATES).map(
  ([abbreviation, name]) => [abbreviation, name],
);

const ALL_GROUPS: ReadonlyArray<readonly string[]> = [...OPTION_ALIASES, ...STATE_GROUPS];

function aliasGroup(value: string): readonly string[] {
  const key = normalized(value);
  return ALL_GROUPS.find((group) => group.some((entry) => normalized(entry) === key)) ?? [key];
}

/**
 * A city answer often has to match an option that carries a region suffix:
 * "Clifton" → "Clifton, New Jersey, United States". Accepted only when exactly
 * one option starts with the requested value followed by a separator, so
 * "Springfield" against several states stays ambiguous rather than guessing.
 */
function matchWithRegionSuffix(
  requested: string,
  options: readonly FieldOption[],
): { option: FieldOption; ambiguous: false } | { option?: undefined; ambiguous: boolean } {
  const key = normalized(requested);
  if (key.length === 0) return { ambiguous: false };

  const prefixed = options.filter((option) => {
    const label = normalized(option.label);
    return label === key || label.startsWith(`${key} `);
  });

  if (prefixed.length === 1 && prefixed[0]) return { option: prefixed[0], ambiguous: false };
  return { ambiguous: prefixed.length > 1 };
}

export interface MatchOptionSettings {
  /**
   * Permits the region-suffix rule. Enabled for place-like questions (city,
   * state, country, location) and off everywhere else, so an unrelated question
   * can never match on a prefix.
   */
  allowRegionSuffix?: boolean;
}

/**
 * Matches a proposed value against the options actually present on the page.
 *
 * Only three things match: a literal (normalized) label or value, a documented
 * alias group, or — when explicitly permitted — an unambiguous region-suffixed
 * option. Anything else is reported as unmatched, and several equally good
 * candidates are reported as ambiguous rather than resolved by picking one.
 */
export function matchOption(
  rawValue: string | boolean | number,
  options: readonly FieldOption[],
  settings: MatchOptionSettings = {},
): OptionMatchResult {
  const requested =
    typeof rawValue === 'boolean' ? (rawValue ? 'yes' : 'no') : String(rawValue).trim();

  if (requested.length === 0) {
    return {
      matched: false,
      ambiguous: false,
      confidence: 'low',
      reason: 'No value was proposed for this control.',
      warnings: [],
    };
  }

  const group = aliasGroup(requested);
  const requestedAliases = new Set(group.map(normalized));
  const requestedKey = normalized(requested);

  // Literal match first: the page's own wording always wins over an alias.
  const literal = options.filter(
    (option) =>
      normalized(option.label) === requestedKey || normalized(option.value) === requestedKey,
  );
  if (literal.length === 1 && literal[0]) {
    return {
      matched: true,
      ambiguous: false,
      option: literal[0],
      matchKind: 'literal',
      confidence: 'high',
      reason: `Exact option match: "${literal[0].label}".`,
      warnings: [],
    };
  }
  if (literal.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      confidence: 'low',
      reason: `Multiple options are labelled "${requested}".`,
      warnings: ['Several options matched equally; choose one manually.'],
    };
  }

  const aliased = options.filter(
    (option) =>
      requestedAliases.has(normalized(option.label)) ||
      requestedAliases.has(normalized(option.value)),
  );
  if (aliased.length === 1 && aliased[0]) {
    return {
      matched: true,
      ambiguous: false,
      option: aliased[0],
      aliasUsed: `${requested} → ${aliased[0].label}`,
      matchKind: 'alias',
      confidence: 'medium',
      reason: `Alias match: "${requested}" is a documented spelling of "${aliased[0].label}".`,
      warnings: [],
    };
  }
  if (aliased.length > 1) {
    return {
      matched: false,
      ambiguous: true,
      confidence: 'low',
      reason: `"${requested}" matched several options through aliases.`,
      warnings: ['Several options matched equally; choose one manually.'],
    };
  }

  if (settings.allowRegionSuffix) {
    const suffixed = matchWithRegionSuffix(requested, options);
    if (suffixed.option) {
      return {
        matched: true,
        ambiguous: false,
        option: suffixed.option,
        aliasUsed: `${requested} → ${suffixed.option.label}`,
        matchKind: 'region_suffix',
        confidence: 'medium',
        reason: `"${requested}" uniquely identifies "${suffixed.option.label}".`,
        warnings: [],
      };
    }
    if (suffixed.ambiguous) {
      return {
        matched: false,
        ambiguous: true,
        confidence: 'low',
        reason: `"${requested}" matches several places on this list.`,
        warnings: ['More than one option begins with this value; choose one manually.'],
      };
    }
  }

  return {
    matched: false,
    ambiguous: false,
    confidence: 'low',
    reason: `No option on the page matched "${requested}".`,
    warnings: [],
  };
}

export function normalizeOptionText(value: string): string {
  return normalized(value);
}

/** Questions where a region-suffixed option ("Clifton, New Jersey") is expected. */
export function allowsRegionSuffix(canonical: string | undefined): boolean {
  return (
    canonical === 'city' ||
    canonical === 'state' ||
    canonical === 'country' ||
    canonical === 'address_line1'
  );
}
