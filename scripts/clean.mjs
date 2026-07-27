import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'shared/dist',
  'agent-server/dist',
  'extension/dist',
  'extension/dist-types',
  'tests/dist',
  'coverage',
  'test-results',
  'playwright-report',
];

for (const target of targets) {
  await rm(join(root, target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}
