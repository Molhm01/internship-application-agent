import { normalizeOptionText } from './optionMatcher.js';
import { aliasesMatch } from './dropdownAliases.js';
import { isPlaceholderLabel } from './dropdownOptionMatch.js';

/**
 * Deciding whether what a control *displays* is the answer that was wanted.
 *
 * This is the one comparison the whole dropdown engine's honesty rests on, and
 * it used to be `shown.includes(wanted)`. That reading produced the worst
 * possible outcome available to this project: a "Graduated?" control sitting on
 * its own placeholder, "No Selection", was asked whether it displayed "No" —
 * and "No Selection" contains "No", so the engine reported the question as
 * already answered and moved on. The applicant's page said "No Selection" and
 * the run said verified.
 *
 * A substring test cannot be repaired by adding placeholders to a deny-list
 * alone, because the same rule silently approves "Not Applicable" for "No",
 * "United Kingdom" for "United", and "New Hampshire" for "New". So containment
 * is not the rule any more; it is a narrow, boundary-checked last resort that a
 * short answer can never reach.
 *
 * ## The order
 *
 * 1. A placeholder never satisfies anything. Checked first, before any
 *    comparison, because a placeholder that happens to contain the answer is
 *    exactly the failure this module exists to end.
 * 2. Exact equality of the normalized texts.
 * 3. An explicit, hand-written alias — `no`/`false`, `yes`/`true`. A closed set
 *    of spellings for one real-world answer, never a similarity score.
 * 4. The same answer wearing the control's own decoration: "United States of
 *    America (US)" for "United States of America", "New Jersey ✕" for "New
 *    Jersey". The decoration is *removed* and equality is retried, so nothing is
 *    approved on the strength of merely appearing somewhere in the string.
 * 5. A contiguous token run, and only for an answer long enough that finding it
 *    inside a longer phrase is evidence rather than coincidence.
 *
 * Anything else is not verified. "Not verified" is a perfectly good answer here:
 * it produces a field the applicant is told to check, which is enormously better
 * than a field the run claims to have answered.
 */

/**
 * The wordings a control uses to say it holds no answer.
 *
 * Listed in addition to `isPlaceholderLabel`'s own rule rather than instead of
 * it: that function was written to filter *option lists*, and it is deliberately
 * generous about entries like "Choose not to disclose" which are real answers
 * when offered as a choice. A control *displaying* one of these is a different
 * question, and the answer is always the same — it is showing a prompt.
 */
const PLACEHOLDER_DISPLAYS: readonly string[] = [
  'no selection',
  'none selected',
  'nothing selected',
  'make a selection',
  'make selection',
  'select',
  'select one',
  'select an option',
  'select option',
  'select a value',
  'please select',
  'please select one',
  'please choose',
  'choose',
  'choose one',
  'choose an option',
  'pick one',
  'n a',
  'none',
  'not selected',
  'no option selected',
  'select ...',
  '--',
  '-',
];

/**
 * True when what the control shows is a prompt rather than an answer.
 *
 * Note the deliberate asymmetry with `isPlaceholderLabel`: the decline
 * phrasings it protects ("Choose not to disclose") are longer than the prompts
 * here and never reduce to one of these strings, so a control genuinely
 * displaying a decline is not mistaken for an empty one.
 */
export function isPlaceholderSelection(shown: string): boolean {
  const text = normalizeOptionText(shown);
  if (text.length === 0) return true;
  if (PLACEHOLDER_DISPLAYS.includes(text)) return true;
  // Trailing ellipsis and leading/trailing dashes are how the same prompts are
  // written in markup: "Select…", "-- Select --".
  const stripped = text.replace(/^[-–—.\s]+|[-–—.\s]+$/g, '').trim();
  if (stripped.length === 0) return true;
  if (PLACEHOLDER_DISPLAYS.includes(stripped)) return true;
  return isPlaceholderLabel(shown, '') && !isDeclineAnswer(text);
}

/** A real answer that happens to start with a prompt verb. */
function isDeclineAnswer(normalizedText: string): boolean {
  return /\b(not to disclose|decline|prefer not)\b/.test(normalizedText);
}

/**
 * An answer short enough that finding it inside a longer phrase says nothing.
 *
 * "No" inside "No Selection", "US" inside "United States", "NJ" inside "NJ
 * Transit". Two characters of coincidence is not evidence, and this is the rule
 * that makes the original defect unreachable rather than merely patched.
 */
const MIN_CONTAINMENT_CHARS = 8;

function tokensOf(value: string): string[] {
  return normalizeOptionText(value).split(' ').filter(Boolean);
}

/**
 * The displayed text with the control's own decoration removed.
 *
 * Three kinds, all of them things a widget adds around an answer rather than
 * parts of it: a parenthesised code ("United States of America (US)"), a clear
 * affordance ("New Jersey ✕", "New Jersey ×"), and a trailing separator. The
 * answer itself is never altered.
 */
function undecorated(shown: string): string[] {
  const raw = shown.replace(/[✕✖✗×⨯]/g, ' ');
  const variants = [raw, raw.replace(/\([^)]*\)/g, ' '), raw.replace(/[[{][^\]}]*[\]}]/g, ' ')];
  // A leading "Selected:" style prefix, which several widgets render for
  // screen readers and leave in the accessible text.
  variants.push(raw.replace(/^[^:]{0,20}:\s*/, ''));
  return [...new Set(variants.map((variant) => normalizeOptionText(variant)).filter(Boolean))];
}

/**
 * The longest token a *code* is allowed to be.
 *
 * Used to tell a control displaying an answer beside a code — "US +1" for a
 * dialling code of "+1" — from a control displaying an unrelated phrase that
 * happens to contain the answer as a word — "NJ Transit" for a state of "NJ".
 * In the first the surrounding token is an abbreviation; in the second it is an
 * ordinary word, and ordinary words are what coincidence is made of.
 */
const MAX_CODE_TOKEN_CHARS = 3;

/**
 * True when a short answer is the whole of what a control shows, once its codes
 * are set aside.
 *
 * The narrow exception to the length rule above, and it exists for a real
 * widget: a combined phone control renders "US +1" and its answer is "+1".
 * Requiring ≥8 characters refused that, and the control — which has no menu
 * behind it at all — was then opened, failed to open, and reported as a failed
 * execution over a field displaying exactly the right code.
 *
 * "No Selection" cannot reach this: a placeholder is refused before any
 * comparison runs. "NJ Transit" cannot reach it either, because "transit" is a
 * word rather than a code.
 */
function isDecoratedCode(shown: string, wanted: string): boolean {
  const haystack = tokensOf(shown);
  const needle = tokensOf(wanted);
  if (needle.length === 0 || needle.length >= haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (!needle.every((token, offset) => haystack[start + offset] === token)) continue;
    const surrounding = [...haystack.slice(0, start), ...haystack.slice(start + needle.length)];
    if (surrounding.every((token) => token.length <= MAX_CODE_TOKEN_CHARS)) return true;
  }
  return false;
}

/** True when `wanted`'s tokens appear as a contiguous run inside `shown`'s. */
function containsTokenRun(shown: string, wanted: string): boolean {
  const haystack = tokensOf(shown);
  const needle = tokensOf(wanted);
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
}

export interface SelectionDisplayOptions {
  /**
   * Other wordings of the *same saved fact*, from the directive that asked for
   * it. Never synonyms this module invented.
   */
  aliases?: readonly string[];
}

/**
 * Whether a control displaying `shown` is holding the answer `wanted`.
 *
 * The single comparison every verification path in the dropdown engine goes
 * through. Returns false whenever the evidence is thin, because a false
 * negative costs the applicant one glance at a field and a false positive costs
 * them a wrong answer on a submitted application.
 */
export function displaysSelection(
  shown: string,
  wanted: string,
  options: SelectionDisplayOptions = {},
): boolean {
  const target = normalizeOptionText(wanted);
  if (target.length === 0) return false;

  // 1. A prompt is never an answer — whatever it happens to contain.
  if (isPlaceholderSelection(shown)) return false;

  const displayed = normalizeOptionText(shown);
  if (displayed.length === 0) return false;

  const candidates = [wanted, ...(options.aliases ?? [])]
    .map((value) => normalizeOptionText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    // 2. Exact.
    if (displayed === candidate) return true;
    // 3. An explicit alias group.
    if (aliasesMatch(displayed, candidate)) return true;
    // 4. The same answer under the control's decoration.
    if (undecorated(shown).includes(candidate)) return true;
  }

  // 5. A contiguous token run, for an answer long enough to mean something.
  //
  // Bounded by both measures on purpose. A two-token answer is specific enough
  // ("New Jersey" inside "New Jersey, United States"); a single token has to be
  // long as well, so "No" and "US" can never reach this rule no matter what the
  // control is showing.
  for (const candidate of candidates) {
    const tokens = tokensOf(candidate);
    const substantial =
      tokens.length >= 2 || (tokens.length === 1 && candidate.length >= MIN_CONTAINMENT_CHARS);
    if (!substantial) continue;
    if (containsTokenRun(displayed, candidate)) return true;
  }

  // 6. A short answer standing alone beside a code. See `isDecoratedCode`.
  for (const candidate of candidates) {
    if (isDecoratedCode(shown, candidate)) return true;
  }

  return false;
}
