#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the engines are reachable from the button the user presses.
 *
 * This exists because of a failure no other check in this repository could see.
 * The Dropdown Engine was complete: a worker pass that discovered controls in
 * every frame, resolved an answer for each from saved facts, drove them in
 * dependency order and retried what a parent unblocked; a frame-side executor
 * that opened, enumerated, matched, selected and verified; strict schemas for
 * every message between them; and a test suite covering all of it. It built. It
 * passed. `verify:extension-runtime` passed. And on a live application eight
 * menus in a row came back reading "No Selection", because *nothing imported
 * it* — `runDropdownAutofill` had exactly one caller in the repository and that
 * caller was a test file, and the content script had no handler for either of
 * the two messages the pass sends.
 *
 * An engine that exists, builds, and is tested is not an engine that runs. This
 * checks the difference, in three ways that fail independently:
 *
 *  1. the worker's import graph actually reaches each engine;
 *  2. the orchestrator is *given* each engine, and awaits it;
 *  3. the frame answers the messages each engine sends.
 *
 * And, when a build is present, that the shipped bundles contain the same
 * wiring — because a green source check over a stale `dist` is the other half
 * of the same failure.
 *
 * Exit code is non-zero for any failure, so it is usable as a build gate.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension', 'src');
const DIST = join(ROOT, 'extension', 'dist');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

/**
 * Every module the given entry can reach, following static imports only.
 *
 * Static imports are the point: a module reached only by a test's import, or by
 * a dynamic import nobody calls, is not wired into the extension Chrome runs.
 */
async function reachableFrom(entry) {
  const seen = new Set();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = await readFile(file, 'utf8').catch(() => '');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      // TypeScript source imports its siblings with a `.js` extension that the
      // bundler rewrites; the file on disk is `.ts` or `.tsx`.
      const specifier = match[1].replace(/\.js$/, '');
      const base = resolve(dirname(file), specifier);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

function short(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

/**
 * The three engines, each named by the module that owns its production pass and
 * by the orchestrator dependency the worker must supply to reach it.
 *
 * The dependency key matters as much as the import. `growRepeatedSections` was
 * imported, declared, documented, and never passed — the optional chaining read
 * `undefined`, the whole stage was skipped without a warning, and every run
 * filled whatever blocks the page happened to load with. An import alone proves
 * nothing.
 */
const ENGINES = [
  {
    name: 'Dropdown Engine',
    module: join(SRC, 'background', 'dropdownAcrossFrames.ts'),
    dependencyKey: 'runDropdownStage',
    workerCall: 'runDropdownAutofill(',
    frameModule: join(SRC, 'dropdown', 'dropdownEngine.ts'),
    frameMessages: ['DISCOVER_DROPDOWNS', 'RUN_DROPDOWN_DIRECTIVES'],
    markers: ['DROPDOWN_ENGINE_STARTED', 'DROPDOWN_ENGINE_FINISHED'],
  },
  {
    name: 'Dependency Engine',
    module: join(SRC, 'background', 'dependenciesAcrossFrames.ts'),
    dependencyKey: 'resolveDependencies',
    workerCall: 'runDependencyResolution(',
    frameModule: join(SRC, 'dependencies', 'dependencyEngine.ts'),
    frameMessages: ['RUN_DEPENDENCY_RESOLUTION'],
    markers: ['DEPENDENCY_ENGINE_STARTED', 'DEPENDENCY_ENGINE_FINISHED'],
  },
  {
    name: 'Repeater Engine',
    module: join(SRC, 'background', 'repeatersAcrossFrames.ts'),
    dependencyKey: 'growRepeatedSections',
    workerCall: 'runRepeaterAutofill(',
    frameModule: join(SRC, 'repeaters', 'repeaterEngine.ts'),
    frameMessages: ['RUN_REPEATER_AUTOFILL'],
    markers: ['REPEATER_ENGINE_STARTED', 'REPEATER_ENGINE_FINISHED'],
  },
];

const workerEntry = join(SRC, 'background', 'index.ts');
const contentEntry = join(SRC, 'content', 'index.ts');
const orchestrator = join(SRC, 'autofill', 'orchestrator.ts');

const workerGraph = await reachableFrom(workerEntry);
const contentGraph = await reachableFrom(contentEntry);
const workerSource = await readFile(workerEntry, 'utf8');
const contentSource = await readFile(contentEntry, 'utf8');
const orchestratorSource = await readFile(orchestrator, 'utf8');

if (!workerGraph.has(resolve(orchestrator))) {
  fail('The worker does not reach the autofill orchestrator at all.');
}

for (const engine of ENGINES) {
  const owned = short(engine.module);

  if (!workerGraph.has(resolve(engine.module))) {
    fail(
      `${engine.name}: ${owned} is not reachable from the worker's import graph, so the ` +
        '"Autofill Application" button cannot invoke it. It is dead code.',
    );
  }
  if (!workerSource.includes(engine.workerCall)) {
    fail(`${engine.name}: the worker never calls ${engine.workerCall.replace('(', '')}.`);
  }
  if (!workerSource.includes(`${engine.dependencyKey}:`)) {
    fail(
      `${engine.name}: the worker does not supply \`${engine.dependencyKey}\` to the ` +
        'orchestrator, so the stage is skipped silently.',
    );
  }
  if (!orchestratorSource.includes(`dependencies.${engine.dependencyKey}`)) {
    fail(`${engine.name}: the orchestrator never reads \`${engine.dependencyKey}\`.`);
  }
  for (const marker of engine.markers) {
    if (!orchestratorSource.includes(marker)) {
      fail(`${engine.name}: the orchestrator emits no ${marker} marker.`);
    }
  }

  if (!contentGraph.has(resolve(engine.frameModule))) {
    fail(
      `${engine.name}: ${short(engine.frameModule)} is not reachable from the content script, ` +
        'so an action the worker sends can never reach the DOM.',
    );
  }
  for (const message of engine.frameMessages) {
    if (!contentSource.includes(`'${message}'`)) {
      fail(
        `${engine.name}: the content script has no handler for ${message}, so the worker ` +
          'would be talking to a frame that cannot answer.',
      );
    }
  }
  notes.push(`${engine.name}: reachable from the worker, awaited, and answered by the frame.`);
}

/**
 * Each engine must be *awaited*.
 *
 * A stage that is started and not waited for lets the run reach a terminal
 * status while the page is still being driven — the summary is printed over
 * menus that are still opening, and it is simply wrong. `withEngine` is the one
 * wrapper that marks both sides and awaits in between; requiring it here means
 * a future edit cannot quietly drop the await.
 */
for (const engine of ENGINES) {
  const pattern = new RegExp(`await withEngine\\([\\s\\S]{0,400}?${engine.markers[0]}`);
  const alternate = new RegExp(`${engine.markers[0]}[\\s\\S]{0,400}?${engine.markers[1]}`);
  if (!pattern.test(orchestratorSource) && !alternate.test(orchestratorSource)) {
    fail(`${engine.name}: its stage does not go through the awaited \`withEngine\` wrapper.`);
  }
}

if (!orchestratorSource.includes('enginesInFlight > 0')) {
  fail(
    'The orchestrator has no assertion forbidding COMPLETED while an engine invocation is ' +
      'still active.',
  );
}

/**
 * The same wiring, in the bundles Chrome actually loads.
 *
 * Skipped when there is no build, because this script runs before one exists in
 * a clean checkout. When there is one, a bundle missing a marker or a message
 * type is a stale `dist` — the exact condition that made three rounds of
 * repairs look ineffective.
 */
if (existsSync(join(DIST, 'background.js'))) {
  const worker = await readFile(join(DIST, 'background.js'), 'utf8');
  const content = await readFile(join(DIST, 'content.js'), 'utf8').catch(() => '');
  for (const engine of ENGINES) {
    for (const marker of engine.markers) {
      if (!worker.includes(marker)) {
        fail(`The built worker bundle does not contain ${marker}. The build is stale.`);
      }
    }
    for (const message of engine.frameMessages) {
      if (!worker.includes(message)) {
        fail(`The built worker bundle never sends ${message}. The build is stale.`);
      }
      if (!content.includes(message)) {
        fail(`The built content bundle cannot answer ${message}. The build is stale.`);
      }
    }
  }
  notes.push('The built worker and content bundles carry the same wiring as the source.');
} else {
  notes.push('No build present; source wiring checked alone.');
}

for (const note of notes) console.log(`  ${note}`);
if (problems.length > 0) {
  console.error('\nEngine wiring verification failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nEvery engine is reachable from "Autofill Application", awaited, and answered.');
