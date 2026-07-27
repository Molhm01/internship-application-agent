import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { databasePath } from './data-paths.mjs';

if (!existsSync(databasePath)) {
  throw new Error(`Database does not exist: ${databasePath}`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const check = database.prepare('PRAGMA quick_check').all();
  const migration = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get();
  if (check.length !== 1 || check[0].quick_check !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(check)}`);
  }
  process.stdout.write(
    `Database integrity: ok\nDatabase path: ${databasePath}\nSchema version: ${migration.version}\n`,
  );
} finally {
  database.close();
}
