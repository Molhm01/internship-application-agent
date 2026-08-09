import type { FieldOption } from '../schemas/fields.js';

/**
 * "How did you hear about us?"
 *
 * Every ATS words its source list differently and none of them lists
 * "Internship Pilot", so the honest answer is the closest true category the
 * form actually offers. A job found through an aggregator *is* an internet job
 * board, so choosing that option states something true; picking the first
 * option in the list — which is what a naive resolver does — states something
 * arbitrary, and "Employee Referral" or "University Career Fair" would be
 * outright false.
 *
 * The ranking is therefore over *truth*, not over preference: each entry names
 * a category that genuinely describes a job discovered through Internship
 * Pilot, best-fitting first. Nothing outside the list is ever selected, and a
 * form offering none of them is reported as unanswered rather than guessed.
 */

/** Ordered best-fit first. Each is matched against the option's own wording. */
export const DISCOVERY_SOURCE_PREFERENCES: readonly RegExp[] = [
  /\binternet job board\b/i,
  /\bonline job board\b/i,
  /\bjob board\b/i,
  /\bother internet source\b/i,
  /\b(job (search|aggregator)|job site|career site aggregator)\b/i,
  /\binternet\b/i,
  /\bonline\b/i,
  /\b(company|corporate) (web ?site|careers page)\b/i,
  /\bweb ?site\b/i,
  /\bother\b/i,
];

/**
 * The same categories, written out, for a control whose list does not exist yet.
 *
 * `chooseDiscoverySource` ranks the options a page is *offering*, which is the
 * right thing to do and impossible on a custom combobox: its menu is built when
 * it opens, so the scan sees no options at all and the ranking has nothing to
 * rank. Refusing on that basis is what marked "How did you hear about this
 * position?" as the user's to answer on a control that lists the answer plainly
 * — the same snapshot-versus-live-list failure the executor was rebuilt to end,
 * one layer up.
 *
 * So these are handed to the engine instead, in the same order, and matched
 * against the list the control actually opens with. Entry *n* here is the
 * literal wording of pattern *n* above, and a test asserts that pairing holds,
 * so the two can never drift into meaning different things.
 */
export const DISCOVERY_SOURCE_CANDIDATES: readonly string[] = [
  'Internet Job Board',
  'Online Job Board',
  'Job Board',
  'Other Internet Source',
  'Job Search Site',
  'Internet',
  'Online',
  'Company Website',
  'Website',
  'Other',
];

/** Wording used for the dependent "please specify" box, when one accepts text. */
export const DISCOVERY_SOURCE_DETAIL = 'Internship Pilot';

/** True when the option is a prompt rather than an answer. */
function isPlaceholder(option: FieldOption): boolean {
  const label = option.label.trim().toLowerCase();
  return (
    label.length === 0 ||
    /^(please )?select\b/.test(label) ||
    /^choose\b/.test(label) ||
    label === '--' ||
    label === 'n/a'
  );
}

export interface DiscoverySourceChoice {
  option: FieldOption;
  /** Why this option, in the user's words. */
  reason: string;
  /** How well it fits: 1 for the best category on offer, lower for a fallback. */
  confidence: number;
}

/**
 * Picks the source option, having inspected every one the page offers.
 *
 * `savedPreference` — what the user configured — always wins when the form
 * carries a matching option, because a stated preference outranks a derived
 * category. Only when it is absent or unmatched does the ranking apply.
 *
 * Returns null rather than a guess when nothing on the list is a true
 * description, which is the case the "do not select the first option blindly"
 * rule exists for.
 */
export function chooseDiscoverySource(
  options: readonly FieldOption[],
  savedPreference?: string,
): DiscoverySourceChoice | null {
  const usable = options.filter((option) => !option.disabled && !isPlaceholder(option));
  if (usable.length === 0) return null;

  const preference = savedPreference?.trim();
  if (preference) {
    const normalized = preference.toLowerCase();
    const exact = usable.find(
      (option) =>
        option.label.trim().toLowerCase() === normalized ||
        option.value.trim().toLowerCase() === normalized,
    );
    if (exact) {
      return {
        option: exact,
        reason: `Your saved answer for how you found this job matches "${exact.label}".`,
        confidence: 1,
      };
    }
    const contains = usable.find((option) => option.label.toLowerCase().includes(normalized));
    if (contains) {
      return {
        option: contains,
        reason: `"${contains.label}" is this form's wording for your saved answer "${preference}".`,
        confidence: 0.9,
      };
    }
  }

  for (const [index, pattern] of DISCOVERY_SOURCE_PREFERENCES.entries()) {
    const match = usable.find((option) => pattern.test(option.label) || pattern.test(option.value));
    if (!match) continue;
    return {
      option: match,
      reason: `This job was found through an online job board, and "${match.label}" is the closest category this form offers.`,
      // Later entries are broader, so they are reported as the judgement calls
      // they are rather than as an exact answer.
      confidence: index === 0 ? 1 : index < 4 ? 0.9 : 0.8,
    };
  }

  return null;
}

/**
 * True when a dependent "please specify further" control is ready to receive
 * free text. A disabled or hidden one is not an invitation to type into it.
 */
export function detailFieldIsReady(field: {
  disabled: boolean;
  visible: boolean;
  fieldType: string;
}): boolean {
  return !field.disabled && field.visible && ['text', 'textarea', 'url'].includes(field.fieldType);
}
