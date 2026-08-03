import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_POLICY,
  describePolicy,
  detectPasswordPolicy,
  generatePassword,
  policyViolations,
  satisfiesPolicy,
  type PasswordPolicy,
  type RandomSource,
} from '@internship-agent/shared';
import type { DetectedField } from '@internship-agent/shared';

function passwordField(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-password',
    pageId: 'page-1',
    label: 'Password',
    normalizedLabel: 'password',
    question: 'Password',
    fieldType: 'password',
    selector: '#password',
    required: true,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: ['label'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

describe('reading a site password policy', () => {
  it('assumes a strong policy when the site states nothing', () => {
    const policy = detectPasswordPolicy(passwordField(), '');
    expect(policy).toMatchObject({
      minLength: DEFAULT_PASSWORD_POLICY.minLength,
      requiresUppercase: true,
      requiresDigit: true,
    });
  });

  it("reads Taleo's wording", () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'The password must be between 8 and 20 characters long. The password must contain at least one upper case letter and one number.',
    );
    expect(policy.minLength).toBe(8);
    expect(policy.maxLength).toBe(20);
    expect(policy.requiresUppercase).toBe(true);
    expect(policy.requiresDigit).toBe(true);
  });

  it("reads Workday's wording", () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Password must be at least 8 characters. Password must contain at least 1 upper case letter, 1 number and 1 symbol.',
    );
    expect(policy.minLength).toBe(8);
    expect(policy.requiresSymbol).toBe(true);
  });

  it('reads a minimum written as a word', () => {
    expect(
      detectPasswordPolicy(passwordField(), 'Your password must be at least eight characters.')
        .minLength,
    ).toBe(8);
  });

  it('reads a hyphenated range', () => {
    const policy = detectPasswordPolicy(passwordField(), 'Password: 10-16 characters.');
    expect(policy.minLength).toBe(10);
    expect(policy.maxLength).toBe(16);
  });

  it("trusts the input's own attributes", () => {
    const policy = detectPasswordPolicy(
      passwordField({ minLength: 14, maxLength: 64 }),
      'Choose a password.',
    );
    expect(policy.minLength).toBe(14);
    expect(policy.maxLength).toBe(64);
  });

  it('reads a rule stated only in the field help text', () => {
    const policy = detectPasswordPolicy(
      passwordField({
        helpText: 'Must be at least 15 characters and include a special character.',
      }),
      '',
    );
    expect(policy.minLength).toBe(15);
    expect(policy.requiresSymbol).toBe(true);
  });

  it('honours a prohibition on symbols instead of the default demanding one', () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Password must be at least 8 characters. No special characters are permitted.',
    );
    expect(policy.requiresSymbol).toBe(false);
    expect(generatePassword(policy)).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('honours an "alphanumeric only" prohibition', () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Passwords may use letters and numbers only.',
    );
    expect(policy.requiresSymbol).toBe(false);
  });

  it('uses only the symbols a site says it allows', () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Password must contain a special character. Allowed characters: ! @ # $',
    );
    expect(policy.allowedSymbols).toBe('!@#$');
    const password = generatePassword(policy);
    const used = [...password].filter((character) => /[^A-Za-z0-9]/.test(character));
    expect(used.length).toBeGreaterThan(0);
    for (const character of used) expect('!@#$').toContain(character);
  });

  it('takes the minimum from "between X and Y", never the maximum', () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Choose a password between 6 and 12 characters.',
    );
    expect(policy.minLength).toBe(6);
    expect(policy.maxLength).toBe(12);
  });

  it('discards a maximum that came out below the minimum', () => {
    const policy = detectPasswordPolicy(passwordField({ minLength: 20 }), 'Up to 8 characters.');
    expect(policy.minLength).toBe(20);
    expect(policy.maxLength).toBeUndefined();
  });

  it('keeps the sentences it read the rules from, so the user can check them', () => {
    const policy = detectPasswordPolicy(
      passwordField(),
      'Welcome to the careers site. Your password must be at least 9 characters.',
    );
    expect(policy.sources.join(' ')).toContain('at least 9 characters');
  });
});

describe('generating a password for a policy', () => {
  const policies: Array<[string, PasswordPolicy]> = [
    ['the default', DEFAULT_PASSWORD_POLICY],
    [
      'a short Taleo policy',
      {
        minLength: 8,
        maxLength: 20,
        requiresUppercase: true,
        requiresLowercase: true,
        requiresDigit: true,
        requiresSymbol: false,
        allowedSymbols: '',
        sources: [],
      },
    ],
    [
      'a long policy with a restricted symbol set',
      {
        minLength: 24,
        maxLength: 32,
        requiresUppercase: true,
        requiresLowercase: true,
        requiresDigit: true,
        requiresSymbol: true,
        allowedSymbols: '!@',
        sources: [],
      },
    ],
    [
      'a policy with an exact length',
      {
        minLength: 10,
        maxLength: 10,
        requiresUppercase: true,
        requiresLowercase: true,
        requiresDigit: true,
        requiresSymbol: true,
        allowedSymbols: '',
        sources: [],
      },
    ],
  ];

  for (const [name, policy] of policies) {
    it(`satisfies ${name}, every time`, () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const password = generatePassword(policy);
        expect(policyViolations(password, policy), password).toEqual([]);
      }
    });
  }

  it('never returns the same password twice', () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt += 1) seen.add(generatePassword());
    expect(seen.size).toBe(200);
  });

  it('does not leave the required characters at the front', () => {
    // With no shuffle the first four characters would be upper, lower, digit,
    // symbol in that order on every single call.
    const firstIsUppercase = Array.from({ length: 100 }, () => generatePassword()).filter(
      (password) => /[A-Z]/.test(password[0]!),
    ).length;
    expect(firstIsUppercase).toBeLessThan(90);
  });

  it('refuses rather than returning a password that breaks the policy', () => {
    const impossible: PasswordPolicy = {
      minLength: 2,
      maxLength: 2,
      requiresUppercase: true,
      requiresLowercase: true,
      requiresDigit: true,
      requiresSymbol: true,
      allowedSymbols: '',
      sources: [],
    };
    expect(() => generatePassword(impossible)).toThrow(/cannot be met/i);
  });

  it('draws from a CSPRNG rather than Math.random', () => {
    let calls = 0;
    const counting: RandomSource = (count) => {
      calls += count;
      return crypto.getRandomValues(new Uint32Array(count));
    };
    generatePassword(DEFAULT_PASSWORD_POLICY, counting);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('checking a password the user supplied', () => {
  it('names every rule it breaks rather than just failing', () => {
    const problems = policyViolations('abc', {
      minLength: 12,
      requiresUppercase: true,
      requiresLowercase: true,
      requiresDigit: true,
      requiresSymbol: true,
      allowedSymbols: '',
      sources: [],
    });
    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).toMatch(/shorter than/);
    expect(problems.join(' ')).toMatch(/uppercase/);
  });

  it('accepts one that meets every rule', () => {
    expect(satisfiesPolicy('Str0ng!Passw0rd', DEFAULT_PASSWORD_POLICY)).toBe(true);
  });
});

describe('explaining a policy to the user', () => {
  it('reads as a sentence rather than a struct dump', () => {
    const description = describePolicy(
      detectPasswordPolicy(
        passwordField(),
        'Password must be between 8 and 20 characters and contain one upper case letter and one number.',
      ),
    );
    expect(description).toContain('at least 8 characters');
    expect(description).toContain('at most 20');
    expect(description).toContain('an uppercase letter');
  });
});
