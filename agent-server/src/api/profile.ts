import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeProfileCompleteness,
  profileCompletenessSchema,
  profileSchema,
  profileUpdateSchema,
  successResponseSchema,
} from '@internship-agent/shared';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';
import { ProfileCorruptError } from '../profile/repository.js';

const profileResponseSchema = z.object({
  profile: profileSchema,
  completeness: profileCompletenessSchema,
});

export type ProfileResponse = z.infer<typeof profileResponseSchema>;

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async.
export async function registerProfileRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): Promise<void> {
  app.get('/profile', (_request, reply) => {
    let profile;
    try {
      profile = ctx.profiles.find();
    } catch (cause) {
      if (cause instanceof ProfileCorruptError) {
        return fail(reply, {
          code: 'VALIDATION_FAILED',
          message: `The stored profile could not be read: ${cause.issues.slice(0, 3).join('; ')}`,
          recoverable: false,
          suggestedAction:
            'The profile record is inconsistent with the current schema. Re-enter the affected sections in settings, or reset the profile.',
          debugContext: { issueCount: cause.issues.length },
        });
      }
      throw cause;
    }

    if (!profile) {
      // No profile is a legitimate state, not a server error. Returning an empty
      // shell here would be fabricating data the user never entered.
      return fail(reply, {
        code: 'PROFILE_MISSING',
        message: 'No profile has been created yet.',
        recoverable: true,
        suggestedAction:
          'Open the extension settings and fill in at least your name and contact details.',
      });
    }

    return sendValidated(reply, profileResponseSchema, {
      profile,
      completeness: computeProfileCompleteness(profile),
    });
  });

  app.put('/profile', (request, reply) => {
    const parsed = parseBody(profileUpdateSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    const saved = ctx.profiles.save(parsed.data);
    ctx.logger.info('profile saved', {
      // Never the contents: counts only.
      educationEntries: saved.education.length,
      experienceEntries: saved.experience.length,
      projectEntries: saved.projects.length,
      sensitivePolicies: saved.sensitivePolicies.length,
    });

    return sendValidated(reply, profileResponseSchema, {
      profile: saved,
      completeness: computeProfileCompleteness(saved),
    });
  });
}

/** Exported so the docs and tests can reference the exact success envelope. */
export const profileSuccessEnvelope = successResponseSchema(profileResponseSchema);
