const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';

const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export interface OriginPolicy {
  /** Permit http://127.0.0.1 and http://localhost callers (curl, tests, docs). */
  allowLocalOrigins: boolean;
}

/**
 * A request with no Origin header is a same-process or CLI caller (curl, the
 * health probe) and is still subject to token auth, so it is allowed here.
 */
export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  if (!origin || origin === 'null') return true;
  if (origin.startsWith(EXTENSION_ORIGIN_PREFIX)) return true;
  if (policy.allowLocalOrigins && LOCAL_ORIGIN_PATTERN.test(origin)) return true;
  return false;
}
