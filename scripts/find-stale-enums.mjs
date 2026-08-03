#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds every copy of the field-type list anywhere in the repository, in source
 * and in generated output, and reports which copies are stale.
 *
 * The point is to answer one question with evidence rather than reasoning:
 * *which file still rejects `password`*. A list is identified structurally —
 * four members that co-occur only in the canonical list — so a different list
 * that happens to mention `contenteditable` is not mistaken for this one.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'graphify-out', 'test-results', 'local-data']);

/** Members that co-occur only in the canonical field-type list. */
const SIGNATURE = ['contenteditable', 'multi_select', 'file', 'unknown'];
const REQUIRED = ['password', 'month'];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function has(literal, member) {
  return literal.includes(`'${member}'`) || literal.includes(`"${member}"`);
}

/**
 * Every bracketed literal in `source` that is the canonical list.
 *
 * The signature members must all be present *and* the literal must be long
 * enough to be the real thing. Without the length floor this matches the
 * four-member `SIGNATURE` array in this very file and in the two checkers that
 * use it, which is a false positive that makes the tool cry wolf about itself.
 */
const MINIMUM_MEMBERS = 10;

function canonicalLiterals(source) {
  return (source.match(/\[[^[\]]{0,1200}\]/g) ?? []).filter(
    (literal) =>
      SIGNATURE.every((member) => has(literal, member)) &&
      (literal.match(/['"][a-z_]+['"]/g) ?? []).length >= MINIMUM_MEMBERS,
  );
}

const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|map)$/;

async function main() {
  const copies = [];
  for await (const path of walk(ROOT)) {
    if (!TEXT_EXTENSIONS.test(path)) continue;
    const info = await stat(path);
    if (info.size > 12 * 1024 * 1024) continue;
    const source = await readFile(path, 'utf8').catch(() => null);
    if (source === null) continue;
    for (const literal of canonicalLiterals(source)) {
      copies.push({
        file: relative(ROOT, path).replace(/\\/g, '/'),
        missing: REQUIRED.filter((member) => !has(literal, member)),
        members: (literal.match(/['"]([a-z_]+)['"]/g) ?? []).length,
      });
    }
  }

  const stale = copies.filter((copy) => copy.missing.length > 0);

  console.log(`Field-type list copies found: ${copies.length}`);
  for (const copy of copies) {
    const verdict =
      copy.missing.length === 0 ? 'OK  ' : `STALE (missing ${copy.missing.join(', ')})`;
    console.log(`  ${verdict}  ${copy.file}  [${copy.members} members]`);
  }

  if (stale.length > 0) {
    console.error(`\n${stale.length} stale copy/copies of the field-type list.`);
    console.error('Each of these rejects a field type the scanner emits.');
    process.exit(1);
  }
  console.log('\nEvery copy of the field-type list is current.');
}

await main();
