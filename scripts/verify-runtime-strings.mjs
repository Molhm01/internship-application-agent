#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Checks the *generated* extension, not the TypeScript source.
 *
 * Chrome runs `extension/dist/`. Twice now a fix has been verified against
 * `extension/src/` and reported as live while the browser was still executing
 * an older bundle — so the messages that named the two worst bugs are asserted
 * against the built artefact, where the user actually meets them.
 */

const DIST = new URL('../extension/dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Every emitted script, including lazily-loaded chunks. */
async function scripts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await scripts(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

const BANNED = [
  {
    // The generic ordinary-field fallback. It stated the rule that was wrong:
    // that an everyday question needs an exact saved answer whose wording
    // matches the page's. Only the semantic *option* resolver may still say
    // something like it, and only when a control really offers choices.
    pattern: /No saved answer applies to "/,
    reason:
      'The generic "No saved answer applies to <question>" fallback is back in the built runtime.',
  },
];

const files = await scripts(DIST);
if (files.length === 0) {
  console.error('No built scripts found. Run `npm run build` first.');
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const rule of BANNED) {
    if (rule.pattern.test(source)) {
      console.error(`  FAIL  ${relative(DIST, file)} — ${rule.reason}`);
      failed = true;
    }
  }
}

// The option-matching message may exist — an option control that genuinely has
// no match must be able to say so — but it must not reach the content script's
// text-writing path. That is asserted behaviourally in
// tests/extension/icimsFixtureCompletion.test.ts; here we only record where it
// lives, so a move is visible in the build log.
const optionMatch = files.filter((file) =>
  readFileSync(file, 'utf8').includes('No option on the page matched'),
);

const popup = join(DIST, 'popup.js');
const identifier = createHash('sha256').update(readFileSync(popup)).digest('hex').slice(0, 12);

console.log(`  OK    ${files.length} generated scripts checked`);
console.log(
  `  OK    "No option on the page matched" confined to ${optionMatch
    .map((file) => relative(DIST, file))
    .join(', ')}`,
);
console.log(`  popup build identifier: ${identifier}`);

if (failed) process.exit(1);
