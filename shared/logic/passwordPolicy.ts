import type { DetectedField } from '../schemas/fields.js';

/**
 * Reading an employer site's password rules, and generating a password that
 * satisfies them.
 *
 * Employer portals state their policy in prose next to the box — "at least 8
 * characters, one uppercase letter and one number" — and then reject anything
 * that misses it, usually after wiping the form. A generic random string is
 * therefore not good enough: it has to be built to the stated rules.
 *
 * Two things this module deliberately does not do:
 *
 * - It never sends the policy text, or the password, to a model. Detection is
 *   regular expressions over text the scanner already collected, and generation
 *   is arithmetic over a character set. There is no path from here to a prompt.
 * - It never returns a password it has not itself verified against the policy
 *   it parsed. `generatePassword` asserts before returning, so a bug in the
 *   builder surfaces here rather than as a rejected registration.
 */

export interface PasswordPolicy {
  minLength: number;
  maxLength?: number;
  requiresUppercase: boolean;
  requiresLowercase: boolean;
  requiresDigit: boolean;
  requiresSymbol: boolean;
  /** Symbols the site said it allows. Empty means "no stated restriction". */
  allowedSymbols: string;
  /** The sentences the rules were read from, for showing the user. */
  sources: string[];
}

/**
 * What to assume when a site states nothing.
 *
 * Twelve characters with one of everything is comfortably above every policy
 * seen in the wild, so the safe default is also the strong one. The risk of
 * over-satisfying is a site that forbids symbols, which is why a stated
 * restriction always overrides this.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresDigit: true,
  requiresSymbol: true,
  allowedSymbols: '',
  sources: [],
};

/** Symbols that survive most sites' allow-lists and no shell or CSV quoting. */
const SAFE_SYMBOLS = '!@#$%^&*-_=+';
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  sixteen: 16,
  twenty: 20,
};

function numberFrom(token: string | undefined): number | null {
  if (!token) return null;
  const digits = Number.parseInt(token, 10);
  if (Number.isFinite(digits)) return digits;
  const word = NUMBER_WORDS[token.toLowerCase()];
  return word ?? null;
}

const NUMBER = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|sixteen|twenty)';

/**
 * Minimum length. Ordered so the more specific phrasing wins: "between 8 and
 * 20" states a minimum of 8, and a looser rule reading "20" from it would build
 * a password the site rejects for being too long.
 */
const MIN_LENGTH_RULES: readonly RegExp[] = [
  new RegExp(`between\\s+${NUMBER}\\s+and\\s+${NUMBER}\\s+characters`, 'i'),
  new RegExp(`(?:at least|minimum(?: of)?|no fewer than|must (?:be|contain|have)(?: at least)?)\\s+${NUMBER}\\s+characters`, 'i'),
  new RegExp(`${NUMBER}\\s*(?:-|to|–)\\s*${NUMBER}\\s+characters`, 'i'),
  new RegExp(`${NUMBER}\\s+characters?\\s+(?:or more|minimum|long)`, 'i'),
];

const MAX_LENGTH_RULES: readonly RegExp[] = [
  new RegExp(`between\\s+${NUMBER}\\s+and\\s+${NUMBER}\\s+characters`, 'i'),
  new RegExp(`(?:at most|maximum(?: of)?|no more than|up to)\\s+${NUMBER}\\s+characters`, 'i'),
  new RegExp(`${NUMBER}\\s*(?:-|to|–)\\s*${NUMBER}\\s+characters`, 'i'),
];

const UPPERCASE_RULE = /\b(upper[\s-]?case|capital)\b/i;
const LOWERCASE_RULE = /\b(lower[\s-]?case|small letter)\b/i;
const DIGIT_RULE = /\b(number|numeral|digit|numeric)\b/i;
const SYMBOL_RULE =
  /\b(symbol|special character|punctuation|non[\s-]?alphanumeric)\b/i;

/**
 * A negation such as "no special characters" or "letters and numbers only".
 * Checked before the positive rule so a prohibition is never read as a demand.
 */
const SYMBOL_PROHIBITED =
  /\b(no|cannot|can not|must not|may not|without)\b[^.]{0,40}\b(symbols?|special characters?|punctuation)\b|\b(letters and numbers|alphanumeric characters?) only\b/i;

/** An explicit allow-list, e.g. "may include ! @ # $". */
const ALLOWED_SYMBOLS_RULE =
  /(?:allowed|permitted|may (?:include|contain|use)|such as|these)\s*(?:characters?|symbols?)?\s*[:\s]\s*([!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|~`\s]{3,60})/i;

function extractSymbols(text: string): string {
  const match = ALLOWED_SYMBOLS_RULE.exec(text);
  if (!match?.[1]) return '';
  const symbols = [...new Set(match[1].replace(/\s+/g, '').split(''))].join('');
  return symbols.length >= 2 ? symbols : '';
}

/**
 * Every place a password rule hides, in one string.
 *
 * The field's own `helpText`, `validationText`, `placeholder` and `title` are
 * included alongside the surrounding page text, because Taleo states the rule
 * in a tooltip and Workday states it in a list above the form.
 */
export function passwordPolicyText(
  field: DetectedField | undefined,
  pageText: string | undefined,
): string {
  const metadata = field?.metadata ?? {};
  const parts = [
    field?.helpText,
    field?.validationText,
    field?.placeholder,
    typeof metadata.title === 'string' ? metadata.title : '',
    typeof metadata.ariaDescription === 'string' ? metadata.ariaDescription : '',
    typeof metadata.pattern === 'string' ? metadata.pattern : '',
    pageText,
  ];
  return parts.filter(Boolean).join(' \n ');
}

function sentencesMentioningPassword(text: string): string[] {
  return text
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length > 0 &&
        sentence.length <= 400 &&
        // Plurals matter: "Passwords may use letters and numbers only" is a
        // rule, and `\bpassword\b` does not match "Passwords".
        /\b(passwords?|characters?)\b/i.test(sentence),
    );
}

/**
 * Reads a policy from whatever the page said.
 *
 * Anything the page did not state keeps its default rather than being turned
 * off: a site that mentions only a minimum length still gets a password with an
 * uppercase letter and a digit, which no such site rejects.
 */
export function detectPasswordPolicy(
  field: DetectedField | undefined,
  pageText?: string,
): PasswordPolicy {
  const text = passwordPolicyText(field, pageText);
  const relevant = sentencesMentioningPassword(text);
  const haystack = relevant.join(' ');

  const policy: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY, sources: relevant.slice(0, 6) };

  // Minimums the page actually stated, kept apart from the default.
  //
  // The default must not participate in the maximum below: a site that says "at
  // least 8" has a policy of 8, and folding in a default of 12 would report a
  // rule the site never made — which then reads back to the user as the site's
  // requirement and, on a site capped at 10, becomes unsatisfiable.
  const statedMinimums: number[] = [];

  if (typeof field?.minLength === 'number' && field.minLength > 0) {
    statedMinimums.push(field.minLength);
  }
  if (typeof field?.maxLength === 'number' && field.maxLength > 0) {
    policy.maxLength = field.maxLength;
  }

  for (const rule of MIN_LENGTH_RULES) {
    const match = rule.exec(haystack);
    const value = numberFrom(match?.[1]);
    if (value !== null && value > 0 && value <= 128) {
      statedMinimums.push(value);
      break;
    }
  }

  // Where the page and the input disagree, the stricter statement wins.
  if (statedMinimums.length > 0) policy.minLength = Math.max(...statedMinimums);

  for (const rule of MAX_LENGTH_RULES) {
    const match = rule.exec(haystack);
    // The second capture is the maximum in "between X and Y" and "X-Y"; the
    // first is the maximum in "at most X".
    const value = numberFrom(match?.[2]) ?? numberFrom(match?.[1]);
    if (value !== null && value >= 4 && value <= 256) {
      policy.maxLength = policy.maxLength ? Math.min(policy.maxLength, value) : value;
      break;
    }
  }

  if (UPPERCASE_RULE.test(haystack)) policy.requiresUppercase = true;
  if (LOWERCASE_RULE.test(haystack)) policy.requiresLowercase = true;
  if (DIGIT_RULE.test(haystack)) policy.requiresDigit = true;

  if (SYMBOL_PROHIBITED.test(haystack)) {
    // A site that forbids symbols must not receive one, even though the default
    // asks for one. A prohibition always beats the default and the positive rule.
    policy.requiresSymbol = false;
    policy.allowedSymbols = '';
  } else {
    if (SYMBOL_RULE.test(haystack)) policy.requiresSymbol = true;
    // Read from the whole text, not the sentence-filtered haystack: a symbol
    // list such as "! @ # $" contains sentence terminators, so splitting into
    // sentences first cuts the list in half.
    policy.allowedSymbols = extractSymbols(text);
  }

  // A maximum shorter than the minimum is a misread, not a real rule. Dropping
  // the maximum is safer than generating a password too short to be accepted.
  if (policy.maxLength !== undefined && policy.maxLength < policy.minLength) {
    policy.maxLength = undefined;
  }

  return policy;
}

/** Every requirement this password fails, or an empty list. */
export function policyViolations(password: string, policy: PasswordPolicy): string[] {
  const symbols = policy.allowedSymbols || SAFE_SYMBOLS;
  const problems: string[] = [];
  if (password.length < policy.minLength) {
    problems.push(`shorter than the required ${policy.minLength} characters`);
  }
  if (policy.maxLength !== undefined && password.length > policy.maxLength) {
    problems.push(`longer than the permitted ${policy.maxLength} characters`);
  }
  if (policy.requiresUppercase && !/[A-Z]/.test(password)) problems.push('has no uppercase letter');
  if (policy.requiresLowercase && !/[a-z]/.test(password)) problems.push('has no lowercase letter');
  if (policy.requiresDigit && !/[0-9]/.test(password)) problems.push('has no digit');
  if (policy.requiresSymbol && ![...password].some((character) => symbols.includes(character))) {
    problems.push('has no permitted symbol');
  }
  if (!policy.requiresSymbol && policy.allowedSymbols === '' && /[^A-Za-z0-9]/.test(password)) {
    // Only meaningful when symbols were positively prohibited; the caller has
    // already cleared allowedSymbols in that case.
  }
  return problems;
}

export function satisfiesPolicy(password: string, policy: PasswordPolicy): boolean {
  return policyViolations(password, policy).length === 0;
}

/** A uniformly-distributed index, from the platform CSPRNG. Never Math.random. */
function randomIndex(limit: number, random: (count: number) => Uint32Array): number {
  // Rejection sampling: taking a modulus of a raw 32-bit value skews towards
  // low indices, which is a real (if small) reduction in entropy.
  const ceiling = Math.floor(0xffffffff / limit) * limit;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const value = random(1)[0]!;
    if (value < ceiling) return value % limit;
  }
  return random(1)[0]! % limit;
}

function pick(alphabet: string, random: (count: number) => Uint32Array): string {
  return alphabet[randomIndex(alphabet.length, random)]!;
}

export type RandomSource = (count: number) => Uint32Array;

const cryptoRandom: RandomSource = (count) => crypto.getRandomValues(new Uint32Array(count));

/**
 * A password built to satisfy `policy`, from the platform CSPRNG.
 *
 * One character of each required class is placed first and the rest is filled
 * from the permitted alphabet, then the whole thing is shuffled — otherwise the
 * required characters would always sit at the front, which is a pattern an
 * attacker can exploit and some sites reject.
 *
 * Throws rather than returning a password that fails its own policy. A caller
 * that cannot get one must stop and tell the user, not type something the site
 * will reject after clearing the form.
 */
export function generatePassword(
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  random: RandomSource = cryptoRandom,
): string {
  const symbols = policy.allowedSymbols || SAFE_SYMBOLS;

  const required: string[] = [];
  if (policy.requiresUppercase) required.push(pick(UPPERCASE, random));
  if (policy.requiresLowercase) required.push(pick(LOWERCASE, random));
  if (policy.requiresDigit) required.push(pick(DIGITS, random));
  if (policy.requiresSymbol) required.push(pick(symbols, random));

  const alphabet =
    UPPERCASE +
    LOWERCASE +
    DIGITS +
    (policy.requiresSymbol || policy.allowedSymbols ? symbols : '');

  // Comfortably above the minimum where the maximum allows it: length is the
  // cheapest strength there is.
  const target = Math.max(policy.minLength, required.length, 16);
  const length = policy.maxLength !== undefined ? Math.min(target, policy.maxLength) : target;

  if (length < required.length) {
    throw new Error(
      `This site's password rules cannot be met: it demands ${required.length} kinds of character but allows only ${length}.`,
    );
  }

  const characters = [...required];
  while (characters.length < length) characters.push(pick(alphabet, random));

  // Fisher-Yates, so position carries no information about character class.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1, random);
    [characters[index], characters[swap]] = [characters[swap]!, characters[index]!];
  }

  const password = characters.join('');
  const violations = policyViolations(password, policy);
  if (violations.length > 0) {
    throw new Error(`Generated a password that ${violations.join(', ')}. Refusing to use it.`);
  }
  return password;
}

/** How the policy reads to a person, for the confirmation the user is shown. */
export function describePolicy(policy: PasswordPolicy): string {
  const parts = [`at least ${policy.minLength} characters`];
  if (policy.maxLength !== undefined) parts.push(`at most ${policy.maxLength}`);
  if (policy.requiresUppercase) parts.push('an uppercase letter');
  if (policy.requiresLowercase) parts.push('a lowercase letter');
  if (policy.requiresDigit) parts.push('a digit');
  if (policy.requiresSymbol) {
    parts.push(policy.allowedSymbols ? `a symbol from ${policy.allowedSymbols}` : 'a symbol');
  }
  return parts.join(', ');
}
