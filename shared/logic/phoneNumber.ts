import { canonicalCountryName } from './optionMatcher.js';

/**
 * Deterministic phone handling for forms that split the dialling code into its
 * own control.
 *
 * The dialling code is derived from the country the profile already states —
 * never from the digits, and never guessed. The saved phone number itself is
 * never modified; these helpers only decide what to type into each control.
 */

/** Closed list. An unlisted country yields null rather than a guess. */
const DIAL_CODES: Readonly<Record<string, string>> = {
  'united states': '+1',
  canada: '+1',
  'united kingdom': '+44',
  india: '+91',
};

export function dialCodeForCountry(country: string | undefined): string | null {
  if (!country) return null;
  const canonical = canonicalCountryName(country);
  return canonical ? (DIAL_CODES[canonical] ?? null) : null;
}

/** Digits only, so "+1 (929) 264-3117" and "9292643117" compare equal. */
function digitsOf(value: string): string {
  return value.replace(/\D+/g, '');
}

export interface SplitPhone {
  /** What belongs in a separate country-code control, e.g. "+1". */
  dialCode: string | null;
  /** What belongs in the phone-number control, with no duplicated code. */
  localNumber: string;
  /** True when a leading dialling code was removed from the local number. */
  strippedDialCode: boolean;
}

/**
 * Splits a saved number for a form that has a separate country-code control.
 *
 * A leading dialling code is removed only when what remains is still a
 * plausible local number, so a number that merely happens to start with the
 * same digits is left intact.
 */
export function splitPhoneNumber(phone: string, dialCode: string | null): SplitPhone {
  const digits = digitsOf(phone);
  if (!dialCode) return { dialCode: null, localNumber: phone.trim(), strippedDialCode: false };

  const codeDigits = digitsOf(dialCode);
  const hasExplicitPlus = phone.trim().startsWith('+');
  const startsWithCode = digits.startsWith(codeDigits);
  const remainder = digits.slice(codeDigits.length);

  // 7 is the shortest real subscriber number; below it the leading digits were
  // part of the number, not a country code.
  if (startsWithCode && remainder.length >= 7) {
    return { dialCode, localNumber: remainder, strippedDialCode: true };
  }
  return {
    dialCode,
    localNumber: hasExplicitPlus ? digits : phone.trim(),
    strippedDialCode: false,
  };
}

/**
 * The value for a phone-number control when the form has no separate
 * country-code control: the complete saved number, unchanged.
 */
export function wholePhoneNumber(phone: string): string {
  return phone.trim();
}

/** True when the saved number already carries the dialling code. */
export function containsDialCode(phone: string, dialCode: string | null): boolean {
  if (!dialCode) return false;
  return phone.trim().startsWith('+') && digitsOf(phone).startsWith(digitsOf(dialCode));
}
