#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the built extension is loadable before anyone loads it.
 *
 * Chrome rejects an unpacked extension whose manifest names a file that is not
 * there, and it does so with an error that says nothing about which file. This
 * reads the manifest, resolves every path it references, and reports the exact
 * missing or empty ones.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension', 'dist');

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

  if (problems.length > 0) {
    console.error('Extension build integrity: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`Extension build integrity: OK (${files.length} manifest-referenced files present)`);
  for (const relative of files) console.log(`  - ${relative}`);
}

await main();
