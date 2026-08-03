import type { DetectedField, FieldOption } from '../schemas/fields.js';

/**
 * Fields that are about the *form*, not about the applicant.
 *
 * "Phone Type", "Address Type", "Contact Method" — an ATS asks these to shape
 * its own record, and there is exactly one sensible answer for a job applicant.
 * They were being treated as unanswerable personal facts, which is how a 26-field
 * iCIMS page produced a stack of "Information needed" cards for questions nobody
 * would ever want to be asked.
 *
 * The distinction that makes this safe: a structural field has a *correct*
 * answer derivable from the form's own vocabulary, and getting it wrong is a
 * clerical error rather than a misrepresentation. "Have you worked here before"
 * is not one of these and never becomes one — that is a fact about the person,
 * and it stays in the ask-the-user path however confidently it could be guessed.
 */

export interface StructuralResolution {
  /** The option to select. Always one the field actually offers. */
  option: FieldOption;
  /** Why, in the user's words. */
  reason: string;
  confidence: number;
}

interface StructuralRule {
  /** Recognizes the question. */
  matches: RegExp;
  /**
   * Preferred answers, best first, matched against the option's own words.
   * Ordered, because "Mobile" beats "Personal" beats "Home" for a phone an
   * employer will actually call.
   */
  preferences: readonly RegExp[];
  reason: string;
}

const RULES: readonly StructuralRule[] = [
  {
    matches: /\bphone (type|kind)\b|\btype of phone\b|\bphone number type\b/i,
    preferences: [/\bmobile\b|\bcell\b/i, /\bpersonal\b/i, /\bhome\b/i],
    reason: 'A mobile number is the one an employer should call.',
  },
  {
    matches: /\baddress type\b|\btype of address\b/i,
    preferences: [/\bhome\b/i, /\bpersonal\b/i, /\bcurrent\b/i, /\bpermanent\b/i],
    reason: 'Your saved address is a home address.',
  },
  {
    matches: /\bcontact (method|preference)\b|\bpreferred (method of )?contact\b/i,
    preferences: [/\be-?mail\b/i, /\bmobile\b|\bcell\b/i, /\bphone\b/i],
    reason: 'Email is the contact method on your profile.',
  },
  {
    matches: /\bcountry code\b/i,
    preferences: [/\bunited states\b|\bu\.?s\.?a?\b|\+1\b/i],
    reason: 'Matches the country on your saved address.',
  },
];

/** True when the option is a placeholder rather than a real answer. */
function isPlaceholder(option: FieldOption): boolean {
  const label = option.label.trim().toLowerCase();
  if (!label) return true;
  return (
    /^(-+|\s*)$/.test(label) ||
    /^(please )?select\b/.test(label) ||
    /^choose\b/.test(label) ||
    label === 'n/a' ||
    label === 'none'
  );
}

/**
 * The right option for a structural field, or null when this is not one.
 *
 * Returns null rather than guessing whenever the field is not recognized *or*
 * none of the preferred answers is on offer. Never returns the first option
 * merely because it exists — a form that offers only choices this does not
 * understand is one it has nothing useful to say about.
 */
export function resolveStructuralField(field: DetectedField): StructuralResolution | null {
  const haystack = [field.label, field.question, field.normalizedLabel].filter(Boolean).join(' ');
  const rule = RULES.find((candidate) => candidate.matches.test(haystack));
  if (!rule) return null;

  const options = (field.options ?? []).filter((option) => !isPlaceholder(option));
  if (options.length === 0) return null;

  for (const [index, preference] of rule.preferences.entries()) {
    const match = options.find((option) => preference.test(option.label));
    if (!match) continue;
    return {
      option: match,
      reason: rule.reason,
      // The first preference is the intended answer; later ones are fallbacks
      // and are reported as slightly less certain so the bands treat them as
      // the judgement calls they are.
      confidence: index === 0 ? 0.95 : 0.85,
    };
  }
  return null;
}

/**
 * Groups controls that ask the same thing more than once.
 *
 * iCIMS renders "I Agree to the Policies stated above" twice — once beside the
 * checkbox and once in the surrounding block — and the scanner honestly reports
 * two questions. Asking the user the same thing twice makes the agent look like
 * it did not understand either one.
 *
 * Fields are keyed by their normalized question and type, and the first
 * occurrence wins. Nothing is dropped from the scan: this only decides what the
 * user is *asked*, and the executor still fills every duplicate control.
 */
export function dedupeQuestions<T extends { question: string; fieldType?: string }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.fieldType ?? ''}|${item.question.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
