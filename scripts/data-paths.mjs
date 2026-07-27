import { isAbsolute, resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '..');

function fromRoot(value) {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}

export const dataDirectory = fromRoot(process.env.AGENT_DATA_DIR || 'local-data');
export const databasePath = fromRoot(
  process.env.AGENT_DB_PATH || resolve(dataDirectory, 'agent.db'),
);
export const documentsDirectory = resolve(dataDirectory, 'documents');
export const backupsDirectory = resolve(dataDirectory, 'backups');
export const exportsDirectory = resolve(dataDirectory, 'exports');

export function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}
