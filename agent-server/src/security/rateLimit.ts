export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  reset(): void;
}

/**
 * Fixed-window counter, per client key. In-memory is sufficient: the server is
 * loopback-only and single-process, and the limit exists to contain a runaway
 * extension loop rather than a hostile network.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; startedAt: number }>();

  return {
    check(key: string): RateLimitDecision {
      const timestamp = now();
      const window = windows.get(key);

      if (!window || timestamp - window.startedAt >= options.windowMs) {
        windows.set(key, { count: 1, startedAt: timestamp });
        return { allowed: true, remaining: options.max - 1, retryAfterSeconds: 0 };
      }

      window.count += 1;
      if (window.count > options.max) {
        const elapsed = timestamp - window.startedAt;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((options.windowMs - elapsed) / 1000)),
        };
      }

      return { allowed: true, remaining: options.max - window.count, retryAfterSeconds: 0 };
    },

    reset(): void {
      windows.clear();
    },
  };
}
