import type { z } from 'zod';
import type { AgentError } from '@internship-agent/shared';
import { buildAgentError } from '../api/responses.js';

export interface ParseSuccess<T> {
  ok: true;
  data: T;
}

export interface ParseFailure {
  ok: false;
  error: AgentError;
}

/**
 * Validates a request body and, on failure, produces an error that names each
 * offending field. A caller must never see a generic "invalid request".
 */
export function parseBody<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body: unknown,
): ParseSuccess<T> | ParseFailure {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };

  const issues = parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  const summary = issues
    .slice(0, 5)
    .map((issue) => `${issue.field}: ${issue.message}`)
    .join('; ');

  return {
    ok: false,
    error: buildAgentError({
      code: 'VALIDATION_FAILED',
      message: `The request did not match its schema — ${summary}${
        issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''
      }`,
      recoverable: true,
      suggestedAction: 'Correct the highlighted fields and save again.',
      // Field *names* only. Rejected values are frequently the sensitive part.
      debugContext: { fields: issues.map((issue) => issue.field) },
    }),
  };
}
