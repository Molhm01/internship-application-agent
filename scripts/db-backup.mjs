import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDirectory, databasePath, timestamp } from './data-paths.mjs';

mkdirSync(backupsDirectory, { recursive: true });
const requested = process.argv[2];
const destination = requested
  ? resolve(requested)
  : resolve(backupsDirectory, `agent-${timestamp()}.db`);
const database = new DatabaseSync(databasePath, { readOnly: false });
try {
  const escaped = destination.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escaped}'`);
} finally {
  database.close();
}
const verification = new DatabaseSync(destination, { readOnly: true });
try {
  const result = verification.prepare('PRAGMA quick_check').get();
  if (result.quick_check !== 'ok') throw new Error('Backup failed SQLite integrity validation.');
} finally {
  verification.close();
}
process.stdout.write(`Database backup: ${destination}\nSource database: ${databasePath}\n`);
