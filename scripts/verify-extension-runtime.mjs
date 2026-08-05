#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the browser cannot be running an unidentified build.
 *
 * This exists because of the failure that made every earlier repair look
 * ineffective: `extension/dist` was built from `4e16cea` while the source — and
 * the green test suite — was at `bbe99dc`, two commits later. Chrome ran code
 * that genuinely still had the reported bugs, and nothing anywhere could say so.
 *
 * `verify-extension-build.mjs` answers "is this bundle loadable and newer than
 * its sources?". This answers the different question: "is every bundle in this
 * folder stamped, stamped identically, and stamped with the commit that is
 * checked out right now?". A build that fails this must not be loaded.
 *
 * Exit code is non-zero for any failure, so it is usable as a build gate.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension', 'dist');
const BUILD_INFO_SOURCE = join(ROOT, 'extension', 'src', 'generated', 'buildInfo.ts');
const RUNTIME_SOURCE = join(ROOT, 'shared', 'constants', 'runtime.ts');

/**
 * The entry bundles Chrome loads independently.
 *
 * These three are the ones that must agree: they are separate top-level bundles
 * with separate caches and separate lifetimes, and a mismatch between any two
 * of them is invisible from inside the extension. Shared chunks are reached
 * *through* them and cannot be stale on their own.
 */
const ENTRIES = {
  worker: 'background.js',
  content: 'content.js',
  popup: 'popup.js',
};

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The build id and schema version the source currently declares. */
async function sourceStamp() {
  const source = await readFile(BUILD_INFO_SOURCE, 'utf8').catch(() => null);
  if (source === null) {
    fail(
      `${relative(ROOT, BUILD_INFO_SOURCE)} is missing. Run "node scripts/write-build-info.mjs".`,
    );
    return null;
  }
  const buildId = /"buildId":\s*"([^"]+)"/.exec(source)?.[1];
  const commit = /"commit":\s*"([^"]+)"/.exec(source)?.[1];
  const schemaVersion = /"schemaVersion":\s*(\d+)/.exec(source)?.[1];
  if (!buildId || !commit || !schemaVersion) {
    fail(`${relative(ROOT, BUILD_INFO_SOURCE)} does not carry a full stamp. Regenerate it.`);
    return null;
  }
  return { buildId, commit, schemaVersion: Number(schemaVersion) };
}

/** The schema version the one declaring file holds. */
async function declaredSchemaVersion() {
  const source = await readFile(RUNTIME_SOURCE, 'utf8').catch(() => null);
  const found = source && /RUNTIME_SCHEMA_VERSION\s*=\s*(\d+)/.exec(source);
  if (!found) {
    fail(`${relative(ROOT, RUNTIME_SOURCE)} no longer declares RUNTIME_SCHEMA_VERSION.`);
    return null;
  }
  return Number(found[1]);
}

/**
 * Every build id literal a bundle carries.
 *
 * A bundle legitimately holds exactly one — the stamp is a single generated
 * constant. Two distinct ids in one bundle means two copies of `buildInfo` were
 * linked in, which is the same stale-copy fault one level down.
 */
function buildIdsIn(source) {
  // The stamp's shape: <sha>[+dirty].s<schema>.<utc digits>
  const found = source.match(/[0-9a-f]{7,40}(?:\+dirty)?\.s\d+\.\d{14}/g) ?? [];
  return [...new Set(found)];
}

/**
 * Every chunk an entry bundle can reach, closed transitively.
 *
 * Chunks import each other, so a single pass over the entry file finds only the
 * first level — and a constant hoisted two levels deep would look absent. The
 * loop runs until nothing new is found, which terminates because the chunk list
 * is finite and names are only ever added.
 */
async function reachableChunks(entrySource, chunkDir, chunks) {
  const reachable = new Set();
  const add = (source) => {
    let found = false;
    // Deliberately loose, because Vite's hashes are base64url and can end in
    // `-` or `_`. A name that is not really a chunk is rejected by the
    // `chunks.includes` test below rather than by the pattern.
    for (const match of source.matchAll(/([A-Za-z0-9_.-]+\.js)/g)) {
      if (chunks.includes(match[1]) && !reachable.has(match[1])) {
        reachable.add(match[1]);
        found = true;
      }
    }
    return found;
  };
  add(entrySource);
  for (let growing = true; growing;) {
    growing = false;
    for (const name of [...reachable]) {
      const source = await readFile(join(chunkDir, name), 'utf8').catch(() => '');
      if (add(source)) growing = true;
    }
  }
  return reachable;
}

async function main() {
  const stamp = await sourceStamp();
  const schema = await declaredSchemaVersion();
  if (stamp && schema !== null && stamp.schemaVersion !== schema) {
    fail(
      `The build stamp says schema v${stamp.schemaVersion} but shared/constants/runtime.ts declares v${schema}. ` +
        'Rebuild so the stamp is regenerated.',
    );
  }

  const entries = await readdir(DIST).catch(() => null);
  if (entries === null) {
    fail('extension/dist does not exist. Run "npm run build:extension".');
    report();
    return;
  }

  // 1. The manifest names the files this check expects to find.
  const manifestRaw = await readFile(join(DIST, 'manifest.json'), 'utf8').catch(() => null);
  if (manifestRaw === null) {
    fail('extension/dist/manifest.json is missing.');
  } else {
    const manifest = JSON.parse(manifestRaw);
    const declared = {
      worker: manifest.background?.service_worker,
      content: manifest.content_scripts?.[0]?.js?.[0],
      popup: manifest.action?.default_popup,
    };
    if (declared.worker !== ENTRIES.worker) {
      fail(`The manifest's service worker is "${declared.worker}", expected "${ENTRIES.worker}".`);
    }
    if (declared.content !== ENTRIES.content) {
      fail(
        `The manifest's content script is "${declared.content}", expected "${ENTRIES.content}".`,
      );
    }
    // The popup is an HTML page that loads popup.js; the page is what the
    // manifest names, so the indirection is checked rather than assumed.
    if (declared.popup !== 'popup.html') {
      fail(`The manifest's popup page is "${declared.popup}", expected "popup.html".`);
    } else {
      const page = await readFile(join(DIST, 'popup.html'), 'utf8').catch(() => '');
      if (!page.includes(ENTRIES.popup)) {
        fail(`popup.html does not load ${ENTRIES.popup}. The popup bundle would never run.`);
      }
    }
  }

  // 2. Every entry resolves to the source's build id, and to only one.
  //
  // Resolved transitively rather than read off the entry file, because Vite
  // hoists a constant shared by several entries into a common chunk. `popup.js`
  // and `background.js` therefore reach `BUILD_ID` through `chunks/`, while
  // `content.js` — built by a separate config into a self-contained bundle —
  // carries it inline. What matters is the id each entry resolves to at
  // runtime, and that is what this walks.
  const chunkDir = join(DIST, 'chunks');
  const chunks = await readdir(chunkDir).catch(() => []);
  const seen = new Map();
  /** Every chunk reached from any entry, for the orphan check below. */
  const reachableFromAnyEntry = new Set();

  for (const [component, file] of Object.entries(ENTRIES)) {
    const source = await readFile(join(DIST, file), 'utf8').catch(() => null);
    if (source === null) {
      fail(`extension/dist/${file} is missing. The ${component} would not load.`);
      continue;
    }
    const closure = await reachableChunks(source, chunkDir, chunks);
    for (const name of closure) reachableFromAnyEntry.add(name);

    const ids = new Set(buildIdsIn(source));
    for (const name of closure) {
      const chunk = await readFile(join(chunkDir, name), 'utf8').catch(() => '');
      for (const id of buildIdsIn(chunk)) ids.add(id);
    }

    if (ids.size === 0) {
      fail(
        `${file} reaches no build id, in itself or in any chunk it imports. ` +
          'It predates build stamping and must be rebuilt.',
      );
      continue;
    }
    if (ids.size > 1) {
      fail(`${file} reaches ${ids.size} different build ids (${[...ids].join(', ')}).`);
      continue;
    }
    const [id] = ids;
    seen.set(component, id);
    if (stamp && id !== stamp.buildId) {
      fail(`${file} resolves to ${id} but the source is ${stamp.buildId}. This bundle is stale.`);
    }
  }

  // 3. The three components agree with each other.
  const distinct = [...new Set(seen.values())];
  if (distinct.length > 1) {
    fail(
      `The entry bundles disagree: ${[...seen].map(([name, id]) => `${name}=${id}`).join(', ')}.`,
    );
  } else if (distinct.length === 1 && seen.size === Object.keys(ENTRIES).length) {
    notes.push(`All three entry bundles resolve to ${distinct[0]}.`);
  }

  // 4. No leftover bundle from an older build is sitting in the folder.
  //
  // A stale chunk is not merely clutter: Vite's entry files import chunks by
  // hashed name, and a folder that was never emptied keeps every chunk from
  // every previous build. One of them being loaded instead is precisely the
  // class of failure this repair began from.
  const orphans = chunks.filter((name) => name.endsWith('.js') && !reachableFromAnyEntry.has(name));
  if (orphans.length > 0) {
    fail(
      `extension/dist/chunks holds ${orphans.length} bundle(s) no entry point reaches ` +
        `(${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', …' : ''}). ` +
        'Delete extension/dist and rebuild — a folder that was never emptied can serve an old chunk.',
    );
  }

  // 5. The build came from the commit that is checked out now.
  const head = git('rev-parse', '--short', 'HEAD');
  if (stamp && head) {
    const stampCommit = stamp.buildId.split('.')[0].replace('+dirty', '');
    if (stampCommit !== head) {
      fail(
        `extension/dist was built from ${stampCommit} but HEAD is ${head}. ` +
          'Rebuild before loading it, or the browser runs code the tests never covered.',
      );
    }
    if (stamp.buildId.includes('+dirty')) {
      notes.push(
        `Built from a modified working tree (${stamp.buildId}). Fine for development; ` +
          'commit before treating this build as the one the tests describe.',
      );
    }
  }

  report();
}

function report() {
  for (const note of notes) console.log(`  OK    ${note}`);
  if (problems.length === 0) {
    console.log('  OK    extension/dist is current, stamped, and internally consistent.');
    return;
  }
  for (const problem of problems) console.error(`  FAIL  ${problem}`);
  process.exitCode = 1;
}

await main();
