import { z } from 'zod';
import { ERROR_CODES } from '../constants/errors.js';

export const errorCodeSchema = z.enum(ERROR_CODES);

/**
 * The one error shape used by the server, the background worker, and the UI.
 * `recoverable` tells the UI whether to offer a retry control; `suggestedAction`
 * is required so no surface can render a bare failure message.
 */
export const agentErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  fieldId: z.string().min(1).optional(),
  recoverable: z.boolean(),
  suggestedAction: z.string().min(1),
  /** Non-sensitive diagnostic detail. Never place raw answer text here. */
  debugContext: z.record(z.string(), z.unknown()).default({}),
});

export type AgentError = z.infer<typeof agentErrorSchema>;

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: agentErrorSchema,
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Wraps a payload schema in the success envelope every endpoint returns. */
export function successResponseSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({ ok: z.literal(true), data: payload });
}
