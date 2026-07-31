import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN_BYTES = 32;

/**
 * Loads the extension's shared token, generating one on first run. The token is
 * the only thing standing between a random local process and the user's saved
 * profile, so it is generated with a CSPRNG and never logged.
 */
export function loadOrCreateToken(tokenPath: string): string {
  // INTERNSHIP_AGENT_TOKEN is the canonical name shared with Internship-AI's
  // .env; AGENT_TOKEN is kept as a same-repo alias for anyone already using it.
  const fromEnv =
    process.env['INTERNSHIP_AGENT_TOKEN']?.trim() || process.env['AGENT_TOKEN']?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file still lives in the user profile.
  }
  return token;
}

/** Constant-time comparison so a caller cannot recover the token byte by byte. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
