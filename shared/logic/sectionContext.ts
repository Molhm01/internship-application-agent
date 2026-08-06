import { normalizeLabel } from './normalizeQuestion.js';

/**
 * Section context for labels that mean nothing on their own.
 *
 * Real ATS forms repeat one-word labels under repeating blocks. iCIMS renders
 *
 *     Phones (1)      Addresses (1)
 *       Type            Type
 *       Number          Address
 *                       Address 2
 *
 * and a scanner that reads the label alone produces two unrelated questions
 * both called "Type", classifies both as unknown, and asks the user which is
 * which. The section heading is the missing half of the question, so it is
 * folded in *before* canonical matching rather than after.
 *
 * Deliberately narrow: only labels that are genuinely ambiguous are rewritten,
 * and only when the heading names a domain this understands. "First Name" under
 * "Your name" is already a complete question and is left exactly as the page
 * wrote it.
 */

/** A domain a repeating section can belong to. */
type SectionDomain = 'phone' | 'address' | 'email' | 'website' | 'experience' | 'education';

const DOMAIN_RULES: ReadonlyArray<readonly [SectionDomain, RegExp]> = [
  ['phone', /\b(phones?|telephones?|mobiles?|contact numbers?)\b/],
  ['address', /\b(addresses|address|mailing|residence|location details)\b/],
  ['email', /\b(e ?mails?|e ?mail addresses)\b/],
  ['website', /\b(web ?sites?|links|social)\b/],
  // Ordered after the contact domains, whose headings these patterns must never
  // steal: "Address" is an address block even on a page whose next heading is
  // "Work Experience".
  ['experience', /\b(experiences?|employment|work history|employment history|positions?)\b/],
  ['education', /\b(education|academic|schools?|universit(y|ies)|degrees?)\b/],
];

/**
 * Labels that need their section to be a question at all.
 *
 * Each maps to the phrasing the canonical rules already understand, per domain.
 * A domain with no entry for a label leaves the label untouched — inventing
 * "website type" would be worse than reporting an unrecognized question.
 */
const GENERIC_LABELS: Readonly<Record<string, Partial<Record<SectionDomain, string>>>> = {
  type: { phone: 'phone type', address: 'address type', email: 'email type' },
  'phone type': { phone: 'phone type' },
  number: { phone: 'phone number' },
  // A bare "Code" beside a phone number is the dialling code. Deliberately
  // *only* under a phone heading: a "Code" under an address block is a postal
  // code on some forms and a discount code on others, and guessing between
  // them would put a dialling code where a postcode belongs.
  code: { phone: 'phone country code' },
  'country code': { phone: 'phone country code' },
  country: { phone: 'phone country code' },
  'address 1': { address: 'address line 1' },
  'address 2': { address: 'address line 2' },
  'line 1': { address: 'address line 1' },
  'line 2': { address: 'address line 2' },
  address: { address: 'address line 1' },
  value: { phone: 'phone number', email: 'email', website: 'website' },
  primary: {},
  // A repeating experience block labels its columns as bare nouns. "Location"
  // under it is where a *past job* was, and reading it as the applicant's own
  // location is how a home address became the one thing a whole run wrote.
  location: { experience: 'employer location' },
  'position or title': { experience: 'job title' },
  position: { experience: 'job title' },
  title: { experience: 'job title' },
  employer: { experience: 'employer' },
  // Dates repeat verbatim across the two repeating blocks that have them, and
  // an employment start date and an enrolment start date are different answers.
  'start date': { experience: 'employment start date', education: 'education start date' },
  'end date': { experience: 'employment end date', education: 'graduation date' },
  from: { experience: 'employment start date' },
  to: { experience: 'employment end date' },
  school: { education: 'school' },
  'graduation date': { education: 'graduation date' },
};

/** The domain a section heading names, or null when it names none. */
export function sectionDomain(heading: string | undefined): SectionDomain | null {
  const normalized = normalizeLabel(heading ?? '');
  if (!normalized) return null;
  return DOMAIN_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

/**
 * The question a label is really asking, given the section it sits in.
 *
 * Returns the original label unchanged whenever the label is already specific,
 * the heading names no domain, or the pair has no documented reading — so this
 * can only ever add context, never remove or contradict it.
 */
export function contextualQuestionLabel(label: string, sectionHeading?: string): string {
  const normalized = normalizeLabel(label);
  const entry = GENERIC_LABELS[normalized];
  if (!entry) return label;
  const domain = sectionDomain(sectionHeading);
  if (!domain) return label;
  return entry[domain] ?? label;
}

/**
 * True when a label cannot be understood without its section.
 *
 * Used by the report so a question that was disambiguated says which block it
 * came from, rather than showing the user two identical "Type" cards.
 */
export function needsSectionContext(label: string): boolean {
  return normalizeLabel(label) in GENERIC_LABELS;
}
