import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath, exportsDirectory, timestamp } from './data-paths.mjs';

if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
mkdirSync(exportsDirectory, { recursive: true });
const destination = process.argv[2] || resolve(exportsDirectory, `user-data-${timestamp()}.json`);
const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = (table) => database.prepare(`SELECT * FROM ${table}`).all();
try {
  const payload = {
    exportedAt: new Date().toISOString(),
    schemaVersion: database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get().version,
    profile: rows('profile').map((row) => JSON.parse(row.data)),
    approvedAnswers: rows('approved_answers').map((row) => ({
      ...row,
      answer: JSON.parse(row.answer),
      aliases: JSON.parse(row.aliases),
    })),
    documents: rows('documents').map(({ file_path: _privatePath, ...metadata }) => metadata),
    generations: rows('answer_generations').map((row) => JSON.parse(row.data)),
  };
  writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
} finally {
  database.close();
}
process.stdout.write(
  `User-data export: ${destination}\nDocument bytes and authentication token: excluded\n`,
);
