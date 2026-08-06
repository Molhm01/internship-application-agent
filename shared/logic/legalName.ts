/**
 * The applicant's whole legal name, assembled from the parts they saved.
 *
 * A later step of a Workday or iCIMS application asks for the name again as one
 * box — "Full Legal Name", "Name as it appears on legal documents", the name to
 * type beside a signature. The profile stores the parts, so the whole was
 * unanswerable and every such control stayed blank.
 *
 * Assembly only, and nothing else:
 *
 *  - a missing middle name is omitted rather than substituted or initialled;
 *  - the user's own capitalization is kept exactly, because a legal name is not
 *    ours to title-case;
 *  - the preferred name is never part of it — a name someone goes by is not the
 *    name on their documents;
 *  - nothing is generated. With no first or last name saved there is no legal
 *    name to state, and the caller is told so rather than given half of one.
 */

export interface LegalNameParts {
  legalFirstName?: string | undefined;
  legalMiddleName?: string | undefined;
  legalLastName?: string | undefined;
  /** Kept when the applicant saved one: "Jr." is part of a legal name. */
  suffix?: string | undefined;
}

/** Collapses runs of whitespace without touching case or punctuation. */
function tidy(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * The full legal name, or null when the profile does not establish one.
 *
 * Null rather than a partial name on purpose: a box labelled "Full Legal Name"
 * holding only a surname is worse than one left for the applicant to complete,
 * because it looks answered.
 */
export function fullLegalName(parts: LegalNameParts): string | null {
  const first = tidy(parts.legalFirstName);
  const last = tidy(parts.legalLastName);
  if (!first || !last) return null;
  return [first, tidy(parts.legalMiddleName), last, tidy(parts.suffix)].filter(Boolean).join(' ');
}
