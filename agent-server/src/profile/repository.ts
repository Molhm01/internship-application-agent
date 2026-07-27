import { profileSchema, type Profile, type ProfileUpdate } from '@internship-agent/shared';
import type { AgentDatabase } from '../database/db.js';

const PROFILE_ID = 'primary';

export class ProfileCorruptError extends Error {
  constructor(readonly issues: string[]) {
    super(`Stored profile failed validation: ${issues.join(', ')}`);
    this.name = 'ProfileCorruptError';
  }
}

export interface ProfileRepository {
  /** Null when the user has not created a profile yet — never a blank stand-in. */
  find(): Profile | null;
  save(update: ProfileUpdate): Profile;
  exists(): boolean;
}

/**
 * The profile is stored as one validated JSON document rather than a wide table.
 * It is a single-row, deeply nested, frequently reshaped structure, and Zod is
 * already the source of truth for its shape — a column per field would duplicate
 * that contract and force a migration for every new profile question.
 */
export function createProfileRepository(db: AgentDatabase): ProfileRepository {
  const selectStatement = db.handle.prepare('SELECT data FROM profile WHERE id = ?');

  const upsertStatement = db.handle.prepare(
    `INSERT INTO profile (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  );

  return {
    exists(): boolean {
      return selectStatement.get(PROFILE_ID) !== undefined;
    },

    find(): Profile | null {
      const row = selectStatement.get(PROFILE_ID) as { data: string } | undefined;
      if (!row) return null;

      let raw: unknown;
      try {
        raw = JSON.parse(row.data);
      } catch (cause) {
        throw new ProfileCorruptError([
          `stored JSON is unparseable: ${cause instanceof Error ? cause.message : String(cause)}`,
        ]);
      }

      // Data on disk is validated on the way out as well as in: a schema change
      // or hand-edited file must surface as a clear error, not silently flow
      // into an application form.
      const parsed = profileSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProfileCorruptError(
          parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        );
      }
      return parsed.data;
    },

    save(update: ProfileUpdate): Profile {
      const profile: Profile = {
        ...update,
        id: PROFILE_ID,
        updatedAt: new Date().toISOString(),
      };

      // Validate the assembled record before it reaches disk.
      const verified = profileSchema.parse(profile);
      upsertStatement.run(PROFILE_ID, JSON.stringify(verified), verified.updatedAt);
      return verified;
    },
  };
}
