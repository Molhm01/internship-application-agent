import type { FieldOption } from '../schemas/fields.js';
import { DECLINE_PHRASINGS, normalizeOptionLabel } from './synonyms.js';

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

/**
 * One normalization for both matchers.
 *
 * Contractions are expanded before punctuation is stripped, so a page that says
 * "I don't wish to self-identify" reduces to the same text as a saved
 * "I do not wish to self-identify". Stripping the apostrophe first would leave
 * "i don t wish to self identify" and the two would never meet.
 */
function normalized(value: string): string {
  return normalizeOptionLabel(value).replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
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

  // Phone type, as split phone controls actually word it. A saved "Mobile"
  // against a dropdown offering only "Cell" left the phone type unset, and the
  // control is required on most iCIMS and Taleo forms.
  ['mobile', 'cell', 'cellular', 'cell phone', 'mobile phone'],
  ['home', 'home phone', 'residence', 'landline'],
  ['work', 'work phone', 'business', 'office'],

  // Employment type, as work-history sections word it. Never inferred — these
  // only ever rename a fact the profile already states.
  ['full time', 'full time employee', 'permanent', 'regular full time'],
  ['part time', 'part time employee', 'regular part time'],
  ['internship', 'intern', 'co op', 'coop', 'internship co op'],
  ['contract', 'contractor', 'temporary', 'temp', 'contract temporary'],

  // The escape hatch every long dropdown offers. Kept as an alias group so
  // "Other" and "Other (please specify)" are the same choice, and *only*
  // reachable through the explicit `other` fallback in the dropdown matcher —
  // never as a substitute for an answer the page actually offers.
  ['other', 'other please specify', 'others', 'not listed', 'none of the above'],

  // Phone dialling codes as split phone controls actually spell them.
  //
  // `normalized` has already stripped punctuation and turned "+" into a space,
  // so "United States (+1)", "US +1" and "+1 - United States" all arrive here as
  // a country name and a number in one order or the other. Both orders are
  // listed because both are common, and a dropdown entry that does not match
  // leaves the applicant's country code unset rather than merely unstyled.
  [
    '+1',
    '1',
    'united states 1',
    'us 1',
    'usa 1',
    'united states of america 1',
    '1 united states',
    '1 us',
    '1 usa',
    '1 united states of america',
  ],
  ['+44', '44', 'united kingdom 44', 'uk 44', '44 united kingdom', '44 uk'],
  ['+91', '91', 'india 91', '91 india'],

  // Declining an answer. Sourced from the single canonical set so this matcher
  // and the semantic resolver can never disagree about what "decline" means.
  DECLINE_PHRASINGS,
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
    canonical === 'current_location' ||
    canonical === 'address_line1'
  );
}

/**
 * Reduces a US state token to its full name, so "NJ" and "New Jersey" compare
 * equal. Returns null for anything not on the closed list — never a guess.
 */
export function canonicalStateName(token: string): string | null {
  const key = normalized(token);
  if (US_STATES[key]) return US_STATES[key];
  return Object.values(US_STATES).includes(key) ? key : null;
}

/** Reduces a country token to one documented spelling, or null when unknown. */
export function canonicalCountryName(token: string): string | null {
  const key = normalized(token);
  const group = OPTION_ALIASES.find(
    (candidate) =>
      candidate.length > 0 &&
      candidate[0] !== undefined &&
      /^(united states|united kingdom|canada|india)$/.test(candidate[0]) &&
      candidate.some((entry) => normalized(entry) === key),
  );
  return group?.[0] ?? null;
}
