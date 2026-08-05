import {
  CURRENT_PROFILE_VERSION,
  migrateProfile,
  mergeProfiles,
  profileSchema,
  profileVersionProblem,
  type Profile,
  type ProfileSource,
  type ProfileSyncEntry,
  type ProfileUpdate,
} from '@internship-agent/shared';
import type { AgentDatabase } from '../database/db.js';

const PROFILE_ID = 'primary';

export class ProfileCorruptError extends Error {
  constructor(readonly issues: string[]) {
    super(`Stored profile failed validation: ${issues.join(', ')}`);
    this.name = 'ProfileCorruptError';
  }
}

export interface ProfileImportResult {
  profile: Profile;
  report: ProfileSyncEntry[];
  /** False when the merge found nothing the stored profile did not already have. */
  changed: boolean;
  /** The version the stored profile was migrated up from, or null. */
  migratedFrom: number | null;
}

export interface ProfileRepository {
  /** Null when the user has not created a profile yet — never a blank stand-in. */
  find(): Profile | null;
  save(update: ProfileUpdate): Profile;
  exists(): boolean;
  /**
   * Merges profiles from elsewhere into the stored one and persists the result.
   *
   * Non-destructive by construction: `mergeProfiles` cannot replace a populated
   * value with an empty one, so this is safe to call on every settings load and
   * on every bundle handoff without asking the user to confirm anything.
   */
  importFrom(sources: readonly ProfileSource[]): ProfileImportResult;
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

      // A profile written by a newer build is refused rather than parsed: Zod
      // would strip the keys this build does not know, and a stripped fact is
      // indistinguishable from one the user never entered.
      const declared = (raw as { version?: unknown } | null)?.version;
      const problem = profileVersionProblem(typeof declared === 'number' ? declared : 1);
      if (problem) throw new ProfileCorruptError([problem]);

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
        // Stamped on every write, so a profile saved by this build is never
        // later mistaken for one that predates the fields it now carries.
        version: CURRENT_PROFILE_VERSION,
        updatedAt: new Date().toISOString(),
      };

      // Validate the assembled record before it reaches disk.
      const verified = profileSchema.parse(profile);
      upsertStatement.run(PROFILE_ID, JSON.stringify(verified), verified.updatedAt);
      return verified;
    },

    importFrom(sources: readonly ProfileSource[]): ProfileImportResult {
      const row = selectStatement.get(PROFILE_ID) as { data: string } | undefined;

      // No stored profile yet is the ordinary first-run case, not an error: the
      // merge starts from an empty one, and every field it ends up with is a
      // field a source actually held.
      let stored: Profile;
      let migratedFrom: number | null = null;
      if (row) {
        const migrated = migrateProfile(JSON.parse(row.data));
        stored = migrated.profile;
        migratedFrom = migrated.migratedFrom;
      } else {
        stored = profileSchema.parse({
          version: CURRENT_PROFILE_VERSION,
          updatedAt: new Date(0).toISOString(),
        });
      }

      const merged = mergeProfiles(stored, sources);
      // Written only when something actually changed. An unconditional write
      // would move `updatedAt` forward on every settings load, and the merge
      // order depends on that timestamp meaning "when the user last saved".
      if (merged.changed || migratedFrom !== null) {
        const verified = profileSchema.parse({
          ...merged.profile,
          id: PROFILE_ID,
          version: CURRENT_PROFILE_VERSION,
          updatedAt: merged.changed ? new Date().toISOString() : merged.profile.updatedAt,
        });
        upsertStatement.run(PROFILE_ID, JSON.stringify(verified), verified.updatedAt);
        return { profile: verified, report: merged.report, changed: merged.changed, migratedFrom };
      }

      return { profile: merged.profile, report: merged.report, changed: false, migratedFrom };
    },
  };
}
