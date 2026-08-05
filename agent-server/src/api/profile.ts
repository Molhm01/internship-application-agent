import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeProfileCompleteness,
  profileCompletenessSchema,
  profileImportRequestSchema,
  profileSchema,
  profileSyncEntrySchema,
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

/**
 * The import response. Carries the merged profile for the caller that asked for
 * it, plus a report that names only keys — so it can be rendered in Diagnostics,
 * logged, and pasted into a bug without disclosing anything about the applicant.
 */
const profileImportResponseSchema = z.object({
  profile: profileSchema,
  completeness: profileCompletenessSchema,
  report: z.array(profileSyncEntrySchema),
  changed: z.boolean(),
  migratedFrom: z.number().int().positive().nullable(),
});

export type ProfileImportResponse = z.infer<typeof profileImportResponseSchema>;

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

  /**
   * Merges profiles held elsewhere into the stored one.
   *
   * This is how the profile the user maintains on Internship Pilot reaches the
   * extension's settings page, which had no way of seeing it: the two stores
   * were independent and nothing had ever copied one into the other.
   *
   * Non-destructive, and safe to call repeatedly — the merge cannot replace a
   * populated value with an empty one, and reports `changed: false` when there
   * was nothing to take.
   */
  app.post('/profile/import', (request, reply) => {
    const parsed = parseBody(profileImportRequestSchema, request.body);
    if (!parsed.ok) {
      return reply.status(422).send({ ok: false, error: parsed.error });
    }

    let result;
    try {
      result = ctx.profiles.importFrom(parsed.data.sources);
    } catch (cause) {
      if (cause instanceof ProfileCorruptError) {
        return fail(reply, {
          code: 'VALIDATION_FAILED',
          message: `The stored profile could not be read, so nothing was imported: ${cause.issues.slice(0, 3).join('; ')}`,
          recoverable: false,
          suggestedAction:
            'The profile record is inconsistent with the current schema. Re-enter the affected sections in settings, or reset the profile.',
          debugContext: { issueCount: cause.issues.length },
        });
      }
      throw cause;
    }

    ctx.logger.info('profile imported', {
      // Key-level counts only; never a key's contents.
      sources: parsed.data.sources.map((source) => source.label),
      changed: result.changed,
      migratedFrom: result.migratedFrom,
      imported: result.report.filter((entry) => entry.status === 'imported').length,
      updated: result.report.filter((entry) => entry.status === 'updated').length,
      missing: result.report.filter((entry) => entry.status === 'missing').length,
    });

    return sendValidated(reply, profileImportResponseSchema, {
      profile: result.profile,
      completeness: computeProfileCompleteness(result.profile),
      report: result.report,
      changed: result.changed,
      migratedFrom: result.migratedFrom,
    });
  });
}

/** Exported so the docs and tests can reference the exact success envelope. */
export const profileSuccessEnvelope = successResponseSchema(profileResponseSchema);
