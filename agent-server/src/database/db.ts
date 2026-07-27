import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logging/logger.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

/**
 * `node:sqlite` types every column as `SQLOutputValue`, so a row must be
 * asserted to its expected shape. That assertion is safe only because every
 * repository immediately re-validates the row through its Zod schema — these
 * helpers exist so the assertion is written once and is easy to audit.
 */
export function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}

export function asRow<T>(row: unknown): T | undefined {
  return row as T | undefined;
}

export interface AgentDatabase {
  readonly handle: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  profileExists(): boolean;
  close(): void;
}

/**
 * Uses Node's built-in `node:sqlite` rather than a native addon so a fresh
 * Windows checkout never needs MSVC build tools.
 */
export function openDatabase(path: string, logger: Logger): AgentDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const handle = new DatabaseSync(path);
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = handle.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    handle.exec('BEGIN');
    try {
      handle.exec(migration.sql);
      handle
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      handle.exec('COMMIT');
      logger.info('applied migration', { version: migration.version, name: migration.name });
    } catch (cause) {
      handle.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  }

  const versionRow = handle
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number } | undefined;

  const schemaVersion = versionRow?.version ?? 0;
  if (schemaVersion !== LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${schemaVersion} does not match expected ${LATEST_SCHEMA_VERSION}.`,
    );
  }

  logger.info('database ready', { path, schemaVersion });

  return {
    handle,
    path,
    schemaVersion,
    profileExists(): boolean {
      const row = handle.prepare('SELECT COUNT(*) AS count FROM profile').get() as
        { count: number } | undefined;
      return (row?.count ?? 0) > 0;
    },
    close(): void {
      handle.close();
    },
  };
}
