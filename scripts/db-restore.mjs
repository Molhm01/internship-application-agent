import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDirectory, databasePath, timestamp } from './data-paths.mjs';

const explicitIndex = process.argv.indexOf('--from');
const explicit = explicitIndex >= 0 ? process.argv[explicitIndex + 1] : undefined;
const candidates = existsSync(backupsDirectory)
  ? readdirSync(backupsDirectory)
      .filter((name) => name.endsWith('.db'))
      .sort()
      .reverse()
  : [];
const source = explicit
  ? resolve(explicit)
  : candidates[0]
    ? resolve(backupsDirectory, candidates[0])
    : undefined;
if (!source || !existsSync(source)) {
  throw new Error('No backup found. Pass `--from <backup.db>` or run npm run db:backup first.');
}

const sourceDatabase = new DatabaseSync(source, { readOnly: true });
try {
  const result = sourceDatabase.prepare('PRAGMA quick_check').get();
  if (result.quick_check !== 'ok') throw new Error('Refusing to restore an invalid SQLite backup.');
} finally {
  sourceDatabase.close();
}

mkdirSync(dirname(databasePath), { recursive: true });
const staged = `${databasePath}.restore-${process.pid}.tmp`;
const safety = `${databasePath}.pre-restore-${timestamp()}.bak`;
copyFileSync(source, staged);
if (existsSync(databasePath)) renameSync(databasePath, safety);
for (const suffix of ['-wal', '-shm']) {
  const sidecar = `${databasePath}${suffix}`;
  if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}
renameSync(staged, databasePath);
process.stdout.write(
  `Database restored from: ${source}\nDatabase path: ${databasePath}\nPre-restore copy: ${
    existsSync(safety) ? safety : 'not needed (no prior database)'
  }\nBackup name: ${basename(source)}\n`,
);
