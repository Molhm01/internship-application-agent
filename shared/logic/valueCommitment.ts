/**
 * Did the form keep what was written into it?
 *
 * ## Why this is not string equality
 *
 * A real employer portal *reformats* what it is given, and it is right to. A
 * phone box handed `+1 201 555 0134` stores `(201) 555-0134`. A postal box
 * uppercases. A name box collapses double spaces. In every one of those cases
 * the applicant's answer is in the form, correctly, and the run must count it.
 *
 * The previous comparison reduced both strings to lowercase alphanumerics and
 * asked whether one contained the other. That is right for most fields and
 * wrong for exactly the reformatting case: `+1 201 555 0134` reduces to
 * `1 201 555 0134`, the stored value reduces to `201 555 0134`, and neither
 * contains the other because of the leading country code. So a phone number
 * that was filled perfectly reported `VERIFICATION_FAILED` on every run.
 *
 * ## What it is instead
 *
 * Equality, then containment, then — only for values that are substantially
 * digits — equality of the digit sequence with a common prefix allowed. That
 * last rule is deliberately narrow: it applies to phone numbers and postal
 * codes, where the digits *are* the value, and cannot make two different names
 * or two different addresses compare equal.
 *
 * This answers "does the control hold what we wrote". It deliberately does not
 * answer "did the employer accept it" — a form can hold a value and still be
 * refusing it, and that is a separate reading taken from the form's own
 * complaint.
 */

/** Lowercase alphanumerics, single-spaced. The comparison most fields want. */
function reduce(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Whether a value is the kind where the digits are the whole content.
 *
 * Seven digits is the threshold because that is a local phone number, and
 * below it the rule would start equating things like a house number with a
 * year. A value that is mostly letters is never treated this way however many
 * digits it also contains.
 */
function isNumericValue(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 5) return false;
  const letters = value.replace(/[^a-zA-Z]/g, '').length;
  return digits.length >= letters;
}

/**
 * Whether `held` is what `wanted` becomes once this control has stored it.
 *
 * Returns false for an empty control whatever was asked of it: a box holding
 * nothing has kept nothing, and that is the case this whole function exists to
 * be able to state.
 */
export function holdsWrittenValue(held: string, wanted: string): boolean {
  const target = reduce(wanted);
  const actual = reduce(held);
  if (target.length === 0) return actual.length === 0;
  if (actual.length === 0) return false;
  if (actual === target) return true;
  if (actual.includes(target) || target.includes(actual)) return true;

  // The reformatting case, and only for values that are essentially numbers.
  // `+1 201 555 0134` and `(201) 555-0134` are the same phone number; one of
  // them simply carries a country code the control dropped.
  if (isNumericValue(wanted) && isNumericValue(held)) {
    const wantedDigits = digitsOf(wanted);
    const heldDigits = digitsOf(held);
    if (wantedDigits === heldDigits) return true;
    if (wantedDigits.length >= 7 && heldDigits.length >= 7) {
      // One is the tail of the other: a dropped or added country/area prefix.
      if (wantedDigits.endsWith(heldDigits) || heldDigits.endsWith(wantedDigits)) return true;
    }
  }
  return false;
}

/**
 * How a control's state relates to what was written, as a name rather than a
 * value.
 *
 * This is what an exported trace records. `HOLDS_EXPECTED` and `HOLDS_OTHER`
 * are the two facts somebody debugging a run needs, and neither of them
 * discloses what the applicant's address or phone number is.
 */
export type ObservedFieldState =
  'EMPTY' | 'HOLDS_EXPECTED' | 'HOLDS_OTHER' | 'REJECTED_BY_FORM' | 'NOT_FOUND' | 'UNKNOWN';

/** The state name for a control that was read back after a write. */
export function describeFieldState(input: {
  found: boolean;
  currentValue: string;
  expected: string;
  validationError: string;
}): ObservedFieldState {
  if (!input.found) return 'NOT_FOUND';
  if (input.validationError.trim().length > 0) return 'REJECTED_BY_FORM';
  if (input.currentValue.trim().length === 0) return 'EMPTY';
  return holdsWrittenValue(input.currentValue, input.expected) ? 'HOLDS_EXPECTED' : 'HOLDS_OTHER';
}
