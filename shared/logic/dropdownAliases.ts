import { normalizeOptionText } from './optionMatcher.js';

/**
 * Other names for the same answer.
 *
 * Every entry here restates one fact in a vocabulary some employer's list
 * actually uses. That is the whole rule and it is a narrow one: "New Jersey" and
 * "NJ" are the same place, so they may alias; "Freelance" and "Contractor" are
 * different working arrangements, so they may not — a form that offers both is
 * asking a question this table must not answer.
 *
 * The test of an alias is whether choosing it would make the applicant's saved
 * answer *untrue*. Anything that would is a semantic near-miss, and those belong
 * to the matcher's scored path where they can be rejected on confidence, not
 * here where they would be treated as certainties.
 *
 * ## Why this is not the country/state table
 *
 * `locationMatcher` already knows every US state and its postal code, and this
 * file does not duplicate it. What lives here is the handful of groups that are
 * not places at all — yes/no, phone and address types, degree levels, study
 * areas, employment arrangements — plus the few country spellings that appear on
 * application forms specifically.
 */

/** One canonical answer and the wordings a form may offer it under. */
export interface AliasGroup {
  /** What the profile would say. */
  readonly canonical: string;
  /** Wordings that mean exactly this. Includes the canonical itself. */
  readonly aliases: readonly string[];
}

const GROUPS: readonly AliasGroup[] = [
  {
    canonical: 'United States',
    aliases: [
      'United States',
      'United States of America',
      'USA',
      'US',
      'U.S.',
      'U.S.A.',
      'America',
    ],
  },
  { canonical: 'New Jersey', aliases: ['New Jersey', 'NJ', 'N.J.'] },
  { canonical: 'Yes', aliases: ['Yes', 'Y', 'True'] },
  { canonical: 'No', aliases: ['No', 'N', 'False'] },
  {
    canonical: 'Mobile',
    aliases: ['Mobile', 'Cell', 'Cellular', 'Cell Phone', 'Mobile Phone', 'Personal Mobile'],
  },
  {
    canonical: 'Home',
    aliases: ['Home', 'Residential', 'Personal', 'Primary', 'Home Address'],
  },
  {
    canonical: "Bachelor's Degree",
    aliases: [
      'Bachelor',
      "Bachelor's",
      "Bachelor's Degree",
      'Bachelors',
      'Bachelors Degree',
      'Undergraduate',
      'Undergraduate Degree',
      "Bachelor's Degree Program (or equivalent)",
    ],
  },
  {
    canonical: 'Electrical Engineering',
    aliases: [
      'Electrical Engineering',
      'Electrical & Electronics Engineering',
      'Electrical and Electronics Engineering',
      'Electrical/Electronic Engineering',
      'Electrical / Electronic Engineering',
      'Engineering - Electrical',
      'Engineering — Electrical',
    ],
  },
  {
    canonical: 'Freelance',
    aliases: [
      'Freelance',
      'Freelancer',
      'Self Employed',
      'Self-Employed',
      'Self-employment',
      'Independent Contractor',
    ],
  },
  {
    canonical: 'College/University',
    aliases: [
      'College/University',
      'College / University',
      'College or University',
      'University',
      'College',
      'Higher Education',
    ],
  },
  {
    canonical: 'Decline to answer',
    aliases: [
      'Decline to answer',
      'Decline to self-identify',
      'Decline to self identify',
      'I choose not to disclose',
      'I do not wish to answer',
      'I do not wish to disclose',
      'Prefer not to say',
      'Prefer not to answer',
      'Choose not to disclose',
      'Do not wish to disclose',
      'Not disclosed',
    ],
  },
];

/**
 * Aliases by normalized wording, built once.
 *
 * Two groups may not claim the same wording: "Yes" belonging to both Yes and No
 * would make every boolean dropdown a coin toss. The build asserts it rather
 * than trusting the table to stay disjoint as it grows.
 */
const BY_WORDING = ((): ReadonlyMap<string, AliasGroup> => {
  const index = new Map<string, AliasGroup>();
  for (const group of GROUPS) {
    for (const alias of group.aliases) {
      const key = normalizeOptionText(alias);
      if (key.length === 0) continue;
      const existing = index.get(key);
      if (existing && existing.canonical !== group.canonical) {
        throw new Error(
          `The alias "${alias}" is claimed by both "${existing.canonical}" and "${group.canonical}".`,
        );
      }
      index.set(key, group);
    }
  }
  return index;
})();

/** The group a wording belongs to, or nothing when it is not an aliased term. */
export function aliasGroupFor(value: string): AliasGroup | undefined {
  return BY_WORDING.get(normalizeOptionText(value));
}

/**
 * Whether two wordings are the same answer under this table.
 *
 * Symmetric and exact-by-group: it never reports a relationship it cannot name,
 * which is what keeps it usable as a *certain* match ahead of anything scored.
 */
export function aliasesMatch(left: string, right: string): boolean {
  const a = aliasGroupFor(left);
  if (!a) return false;
  const b = aliasGroupFor(right);
  return b !== undefined && a.canonical === b.canonical;
}

/**
 * Every wording of an answer, most canonical first.
 *
 * Used to widen an intended answer before it meets a list: the saved fact says
 * "Freelance", the form offers only "Self-Employed", and the alternatives are
 * how one reaches the other without the matcher having to guess.
 */
export function aliasesFor(value: string): readonly string[] {
  const group = aliasGroupFor(value);
  if (!group) return [value];
  const rest = group.aliases.filter(
    (alias) => normalizeOptionText(alias) !== normalizeOptionText(value),
  );
  return [value, ...rest];
}
