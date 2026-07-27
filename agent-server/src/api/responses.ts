import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  DEFAULT_ERROR_GUIDANCE,
  ERROR_HTTP_STATUS,
  type AgentError,
  type ErrorCode,
} from '@internship-agent/shared';

export interface FailOptions {
  code: ErrorCode;
  message: string;
  fieldId?: string;
  recoverable?: boolean;
  suggestedAction?: string;
  debugContext?: Record<string, unknown>;
  statusOverride?: number;
}

export function buildAgentError(options: FailOptions): AgentError {
  return {
    code: options.code,
    message: options.message,
    ...(options.fieldId ? { fieldId: options.fieldId } : {}),
    recoverable: options.recoverable ?? true,
    suggestedAction: options.suggestedAction ?? DEFAULT_ERROR_GUIDANCE[options.code],
    debugContext: options.debugContext ?? {},
  };
}

/** Sends the standard failure envelope. Never send a bare string. */
export function fail(reply: FastifyReply, options: FailOptions): FastifyReply {
  const status = options.statusOverride ?? ERROR_HTTP_STATUS[options.code] ?? 500;
  return reply.status(status).send({ ok: false, error: buildAgentError(options) });
}

/**
 * Validates the payload against its documented schema before it leaves the
 * process. A response that does not match its contract is a server bug, and the
 * client is told so rather than being handed malformed data.
 */
export function sendValidated<T>(
  reply: FastifyReply,
  schema: z.ZodType<T>,
  payload: T,
  status = 200,
): FastifyReply {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail(reply, {
      code: 'VALIDATION_FAILED',
      message: 'The server produced a response that did not match its own schema.',
      recoverable: false,
      debugContext: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  return reply.status(status).send({ ok: true, data: parsed.data });
}
