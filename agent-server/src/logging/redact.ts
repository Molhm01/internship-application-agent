/**
 * Keys whose values must never reach a general log file. Application answers,
 * profile details, and credentials all pass through this server, and a debug
 * log is the easiest place for them to leak.
 */
const REDACTED_KEYS = new Set(
  [
    'token',
    'authToken',
    'authorization',
    'x-agent-token',
    'password',
    'secret',
    'apiKey',
    'answer',
    'value',
    'attemptedValue',
    'observedValue',
    'currentValue',
    'email',
    'alternateEmail',
    'phone',
    'address',
    'ssn',
    'dateOfBirth',
    'gpa',
    'salaryPreference',
    'personal',
    'profile',
    'filePath',
    'coverLetter',
    'description',
  ].map((key) => key.toLowerCase()),
);

export const REDACTED = '[redacted]';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

/**
 * Returns a copy of `input` safe to write to disk: known-sensitive keys are
 * replaced wholesale, long strings truncated, and cycles broken.
 */
export function redact(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    return input.length > MAX_STRING_LENGTH
      ? `${input.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : input;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return input;
  }

  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }

  if (depth >= MAX_DEPTH) return '[max depth]';

  if (Array.isArray(input)) {
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    const items = input.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
    if (input.length > MAX_ARRAY_ITEMS) items.push(`[+${input.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  if (typeof input === 'object') {
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redact(val, depth + 1, seen);
    }
    return output;
  }

  return `[${typeof input}]`;
}

/** Exposed for tests and for callers that want to check a key before logging. */
export function isSensitiveKey(key: string): boolean {
  return REDACTED_KEYS.has(key.toLowerCase());
}
