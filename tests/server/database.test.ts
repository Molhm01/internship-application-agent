import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../agent-server/src/database/db.js';
import { LATEST_SCHEMA_VERSION } from '../../agent-server/src/database/migrations.js';
import { silentLogger } from './helpers.js';

describe('database initialization', () => {
  it('creates every table the later milestones write to', () => {
    const db = openDatabase(':memory:', silentLogger);
    const tables = (
      db.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    for (const expected of [
      'schema_migrations',
      'profile',
      'documents',
      'approved_answers',
      'application_runs',
      'application_actions',
    ]) {
      expect(tables).toContain(expected);
    }

    expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent across reopens of the same file', () => {
    const first = openDatabase(':memory:', silentLogger);
    const applied = first.handle
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
      .get() as {
      count: number;
    };
    expect(applied.count).toBe(LATEST_SCHEMA_VERSION);
    first.close();
  });

  it('reports whether a profile exists', () => {
    const db = openDatabase(':memory:', silentLogger);
    expect(db.profileExists()).toBe(false);

    db.handle
      .prepare('INSERT INTO profile (id, data, updated_at) VALUES (?, ?, ?)')
      .run('primary', '{}', new Date().toISOString());
    expect(db.profileExists()).toBe(true);
    db.close();
  });

  it('refuses to record a submitted application run', () => {
    const db = openDatabase(':memory:', silentLogger);
    const insert = db.handle.prepare(
      `INSERT INTO application_runs (id, started_at, url, domain, ats, status, submitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // The product invariant is enforced in the schema, not just in code paths.
    expect(() =>
      insert.run(
        'run-1',
        new Date().toISOString(),
        'https://x.test/a',
        'x.test',
        'generic',
        'completed',
        1,
      ),
    ).toThrow();

    expect(() =>
      insert.run(
        'run-2',
        new Date().toISOString(),
        'https://x.test/a',
        'x.test',
        'generic',
        'completed',
        0,
      ),
    ).not.toThrow();

    db.close();
  });
});
