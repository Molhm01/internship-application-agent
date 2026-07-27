import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { databasePath, documentsDirectory, repositoryRoot } from './data-paths.mjs';

const required = [
  'package.json',
  'shared/package.json',
  'agent-server/package.json',
  'extension/package.json',
  'shared',
  'agent-server',
  'extension',
  'extension/dist/manifest.json',
  'agent-server/dist/index.js',
];
const missing = required.filter((entry) => !existsSync(resolve(repositoryRoot, entry)));
const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
if (resolve(topLevel) !== repositoryRoot) {
  throw new Error(`Repository root mismatch: expected ${repositoryRoot}, received ${topLevel}`);
}
if (missing.length) throw new Error(`Backup verification missing: ${missing.join(', ')}`);
if (!existsSync(databasePath))
  throw new Error(`Database path is known but missing: ${databasePath}`);
process.stdout.write(
  [
    'Backup verification: ok',
    `Repository: ${repositoryRoot}`,
    `Commit: ${commit}`,
    `Database: ${databasePath}`,
    `Documents: ${documentsDirectory}`,
    'Build outputs: present',
    'Temporary workspace dependency: none',
    '',
  ].join('\n'),
);
