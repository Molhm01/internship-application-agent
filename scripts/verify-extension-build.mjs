#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the built extension is loadable, current, and internally consistent
 * before anyone loads it.
 *
 * Three separate things can be wrong, and only the first used to be checked:
 *
 * 1. A manifest naming a file that is not there. Chrome rejects the extension
 *    with an error that does not say which file.
 * 2. A bundle older than the source it was built from. This is the failure that
 *    cost real time: the scanner learned `password`, the worker bundle did not
 *    get rebuilt, and every scan died at INVALID_SCAN_RESULT with a message
 *    that blamed the value rather than the build.
 * 3. Two bundles in the same folder holding different copies of the canonical
 *    field-type list, which is the same fault one step earlier.
 *
 * Exit code is non-zero for any of them, so this is usable as a build gate.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension', 'dist');

/** Sources whose changes must be reflected in the bundles. */
const SOURCE_DIRS = [
  join(ROOT, 'extension', 'src'),
  join(ROOT, 'shared'),
  join(ROOT, 'extension', 'manifest.json'),
];

/**
 * Members that must appear in every bundle that carries the field-type list.
 *
 * Not the whole list: a bundle legitimately tree-shakes members it never names.
 * These two are the ones whose absence has actually broken the extension —
 * `password` because a login page dies without it, `month` because it is the
 * newest member and therefore the one most likely to be missing from a stale
 * build.
 */
const REQUIRED_FIELD_TYPES = ['password', 'month'];

/**
 * Identifies an array literal as *the* canonical field-type list.
 *
 * Presence of a single member is not enough. `isAiEligibleField` holds
 * `['textarea', 'contenteditable', 'text']` — a legitimately different list
 * that correctly excludes `password`, and a looser check flagged it as a stale
 * bundle. These four members appear together only in the canonical list.
 */
const CANONICAL_LIST_MEMBERS = ['contenteditable', 'multi_select', 'file', 'unknown'];

/** Every bracketed literal in a bundle that is the canonical field-type list. */
function canonicalListLiterals(source) {
  const literals = source.match(/\[[^[\]]{0,800}\]/g) ?? [];
  return literals.filter((literal) =>
    CANONICAL_LIST_MEMBERS.every(
      (member) => literal.includes(`'${member}'`) || literal.includes(`"${member}"`),
    ),
  );
}

async function newestMtime(path) {
  let newest = 0;
  const info = await stat(path).catch(() => null);
  if (!info) return newest;
  if (info.isFile()) return info.mtimeMs;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    newest = Math.max(newest, await newestMtime(join(path, entry.name)));
  }
  return newest;
}

/** Every manifest key that names a file, flattened to a list of paths. */
function referencedFiles(manifest) {
  const paths = [];
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) paths.push(value);
  };

  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.background?.service_worker);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) add(file);
    for (const file of entry.css ?? []) add(file);
  }
  for (const resource of manifest.web_accessible_resources ?? []) {
    for (const file of resource.resources ?? []) add(file);
  }
  return [...new Set(paths)];
}

async function main() {
  const problems = [];

  const manifestPath = join(DIST, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    console.error(`FAIL  extension/dist/manifest.json is missing or unreadable: ${cause.message}`);
    console.error('      Run "npm run build" first.');
    process.exit(1);
  }

  const files = referencedFiles(manifest);
  for (const relative of files) {
    const absolute = join(DIST, relative);
    try {
      const info = await stat(absolute);
      // A zero-byte bundle is a build that failed quietly, not a build.
      if (info.size === 0) problems.push(`${relative} exists but is empty`);
    } catch {
      problems.push(`${relative} is referenced by the manifest but was not emitted`);
    }
  }

  // The content script is the only code that touches an application page, so
  // its absence is a silent, total failure of the extension's purpose.
  for (const required of ['content.js', 'background.js']) {
    if (!files.includes(required)) {
      problems.push(`${required} is not referenced by the manifest`);
    }
  }

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
  }

  // Freshness. A bundle older than its source is the stale-build failure, and
  // it is completely invisible from the file list alone.
  let newestSource = 0;
  for (const dir of SOURCE_DIRS) newestSource = Math.max(newestSource, await newestMtime(dir));
  for (const relative of files) {
    if (!relative.endsWith('.js')) continue;
    const info = await stat(join(DIST, relative)).catch(() => null);
    if (!info) continue;
    if (info.mtimeMs < newestSource) {
      const behind = Math.round((newestSource - info.mtimeMs) / 1000);
      problems.push(
        `${relative} is ${behind}s older than the newest source file — it was not rebuilt. Run "npm run build:extension".`,
      );
    }
  }

  // Schema consistency. Every bundle carrying the field-type list must carry
  // the same one; a bundle that has the list but is missing a member is a build
  // from before that member existed.
  const bundles = [];
  for (const relative of files) {
    if (relative.endsWith('.js')) bundles.push(relative);
  }
  const chunkDir = join(DIST, 'chunks');
  for (const entry of await readdir(chunkDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.js')) bundles.push(join('chunks', entry.name));
  }

  let carriers = 0;
  for (const relative of bundles) {
    const source = await readFile(join(DIST, relative), 'utf8').catch(() => null);
    if (source === null) continue;
    for (const literal of canonicalListLiterals(source)) {
      carriers += 1;
      for (const member of REQUIRED_FIELD_TYPES) {
        if (!literal.includes(`'${member}'`) && !literal.includes(`"${member}"`)) {
          problems.push(
            `${relative} carries a copy of the field-type list without "${member}" — it is a stale bundle and will reject that field type at runtime. Run "npm run build:extension".`,
          );
        }
      }
    }
  }
  if (carriers === 0) {
    problems.push(
      'No built bundle contains the field-type list. The build did not include the shared schemas.',
    );
  }

  if (problems.length > 0) {
    console.error('Extension build integrity: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`Extension build integrity: OK (${files.length} manifest-referenced files present)`);
  for (const relative of files) console.log(`  - ${relative}`);
  console.log(
    `Field-type contract: OK (${carriers} bundle(s) carry the list, each with ${REQUIRED_FIELD_TYPES.join(', ')})`,
  );
  console.log('Freshness: OK (every bundle is newer than the newest source file)');
}

await main();
