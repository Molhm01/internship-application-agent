# Runtime Provenance Investigation

Date: 2026-08-12 (America/New_York)

Scope: current source, Git metadata, package/build configuration, generated artifacts, source maps, and observed processes in `C:\Users\Molhm\Desktop\Internship-Agent-Recovery`. Existing audit markdown was not used as proof. No production file was changed.

## Executive finding

The repository being inspected and the build exercised by repository E2E tests are rooted in `Internship-Agent-Recovery`. The current live agent-server listener is also executing Recovery source. Recovery's present extension bundles embed source-map copies that exactly match the current Recovery files: 291 of 291 embedded inputs across all 14 extension source maps matched after newline normalization, with zero mismatches and zero missing inputs.

That does **not** prove the user's normal Chrome profile is loading Recovery. There are two simultaneously valid unpacked-extension directories:

- `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\extension\dist`, stamped with source root `Internship-Agent-Recovery` and build ID `51fee56+dirty.s3.20260813025212`.
- `C:\Users\Molhm\Desktop\Internship-Agent\extension\dist`, stamped with source root `Internship-Agent` and build ID `60f166f.s3.20260805070159`.

No Chrome/Chromium process was running during this investigation, so the unpacked-extension path selected in the user's normal browser could not be observed from a live process. Repository tests cannot settle that question: they construct an absolute path to Recovery's own `extension/dist`, while a manually installed Chrome extension can independently point at the sibling tree.

There is also more than one autofill/choice implementation inside the shipped bundles. The normal button routes to Agent Mode, but the legacy whole-page pipeline remains compiled and selectable behind persisted developer settings. The content bundle contains the Agent Mode `select_option` implementation as well as both the old in-executor dropdown engine and the newer directive-based Dropdown Engine.

## Required provenance summary

**ACTIVE SOURCE ROOT:** `C:\Users\Molhm\Desktop\Internship-Agent-Recovery` for the inspected worktree, repository commands, Recovery build artifacts, and the currently listening agent server. The normal Chrome unpacked-extension root was not observable because no Chrome process was running.

**ACTIVE EXTENSION ENTRY:** `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\extension\dist\manifest.json` for repository tests and for a Chrome installation explicitly loaded from Recovery. Its source is `extension/manifest.json`; `copyManifest()` in `extension/vite.config.ts` copies it to `extension/dist/manifest.json`. Source and built manifest are byte-identical (SHA-256 `833D51DFB97782C400C5719DF2A881DB264EDC82A20960D9CC2275853D36361C`). A user's manually loaded path remains unverified.

**ACTIVE CONTENT SCRIPT:** Manifest `content_scripts[0].js = ["content.js"]`; build input `extension/src/content/index.ts`; content Vite input at `extension/vite.content.config.ts:21`; IIFE output `extension/dist/content.js` at `extension/vite.content.config.ts:24`. `extension/src/background/contentScript.ts:98-103` can reinject that same emitted file with `chrome.scripting.executeScript`.

**ACTIVE BACKGROUND WORKER:** Manifest service worker `background.js` (`type: module`) at `extension/manifest.json:23-26`; Rollup input `extension/src/background/index.ts` at `extension/vite.config.ts:50`; output `extension/dist/background.js` via stable `[name].js` entry naming at `extension/vite.config.ts:55`.

**ACTIVE AGENT SERVER:** Observed listener `127.0.0.1:4317`, PID 27700. Its command line is Node with TSX loaded from `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\node_modules\tsx\...`, executing `src/index.ts`. The launch chain is root `npm run dev:server` -> workspace `npm run dev` -> `tsx watch src/index.ts`. Production/start mode is separately `node dist/index.js` (`agent-server/package.json:9-11`). Current logs resolve the database to `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\local-data\agent.db`.

**ACTIVE BUILD OUTPUT:** `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\extension\dist`. Main application/UI/worker output and content-script output are two Vite passes writing into this same directory. `extension/dist-types` contains TypeScript declaration/typecheck output only and is not referenced by the manifest or a runtime import. `agent-server/dist` is the server's production output, but the observed listener is in TSX dev mode and is not executing it.

**CURRENT BRANCH:** `recovery/autofill-vertical-slice`, HEAD `63f0b063fcc4217b8a4db5642a6ce5d74f6e1e24` (`63f0b06`, “Forensic checkpoint before dropdown AI council”). The worktree was clean before this report was created.

**WORKTREE RELATIONSHIP:** `Internship-Agent-Recovery` is a linked worktree of the repository whose main worktree is `C:\Users\Molhm\Desktop\Internship-Agent`. Recovery's `.git` file points to `C:/Users/Molhm/Desktop/Internship-Agent/.git/worktrees/Internship-Agent-Recovery`. Its common Git directory is `C:/Users/Molhm/Desktop/Internship-Agent/.git`. The trees share Git objects and refs, but have separate working directories, worktree administrative HEAD/index state, branches, ignored build directories, installed extension paths, and runtime data. Main worktree: branch `fix/unresolved-field-resolver`, HEAD `60f166ff46571ee155c50851fc00b9f497b5ce12`. Recovery worktree: branch `recovery/autofill-vertical-slice`, HEAD `63f0b063fcc4217b8a4db5642a6ce5d74f6e1e24`.

## Binary conclusions

### WRONG TREE POSSIBLE: YES

Exact evidence:

1. Both worktrees contain a directly loadable `extension/dist/manifest.json`, `background.js`, and `content.js`.
2. Recovery's emitted `chunks/buildInfo-CCK7QWvG.js:2-5` says build ID `51fee56+dirty.s3.20260813025212` and source root `C:\Users\Molhm\Desktop\Internship-Agent-Recovery`.
3. The sibling tree's generated build info says build ID `60f166f.s3.20260805070159` and source root `C:\Users\Molhm\Desktop\Internship-Agent`; its separate `extension/dist/background.js` and `extension/dist/content.js` exist.
4. Chrome's unpacked-extension installation is an absolute directory selection external to package.json and Git. No repository setting redirects or pins a user's normal Chrome profile to Recovery.
5. E2E tests do not test the user's installed path. For example, `tests/e2e/agent-lincoln.spec.ts:23` calculates `EXTENSION_PATH` relative to that test file, and lines 148-149 pass that Recovery-local directory to `--disable-extensions-except` and `--load-extension`. The same pattern is repeated across the E2E suite.
6. No Chrome/Chromium process was present during process inspection, so there is no current process evidence that selects one of the two directories. Therefore wrong-tree loading is possible, but was not observed or disproved for the normal browser profile.

### MIXED OLD/NEW RUNTIME POSSIBLE: YES

Exact evidence:

1. Extension development is two independent watch builds into one folder. `extension/package.json:8` writes the build stamp once, cleans once, then starts `vite build --watch` and `vite build --watch --config vite.content.config.ts` concurrently. `extension/vite.config.ts:25-41` and `extension/vite.content.config.ts:17-18` both set `emptyOutDir: false` and both target `extension/dist`.
2. Because `scripts/write-build-info.mjs` runs only before the two watchers start, a later source edit may rebuild only the worker/application graph or only the content graph while both continue to carry the same pre-watch `BUILD_ID`. The worker/content equality check at `extension/src/background/index.ts:1580-1595` detects unequal IDs, but cannot detect different code vintages that retained one ID. This is an actual same-ID mixed-runtime path in dev/watch mode.
3. Chrome may retain a content script in an already-open page while the extension worker is reloaded. `extension/src/background/contentScript.ts:75-103` explicitly pings and, if needed, reinjects `content.js`; `extension/src/background/index.ts:1580-1595` contains a refusal for an observable worker/content ID mismatch. Thus cross-version component state is anticipated by current production source. The refusal limits execution when IDs differ; it does not eliminate the same-ID watch case above.
4. Recovery's current three runtime entry bundles all resolve to one ID, `51fee56+dirty.s3.20260813025212`, but `npm run verify:extension-runtime` fails because that stamp names commit `51fee56` while current HEAD is `63f0b06`. The stamp was generated from a dirty tree before the later checkpoint commit.
5. This stamp failure is **not evidence that the current bundle text is old**. A direct forensic comparison of every `sources[]`/`sourcesContent[]` input in all 14 maps under Recovery `extension/dist` against its resolved disk file found 291 exact matches, zero differences, and zero missing sources. The bundles therefore match the current Recovery source text even though the commit identity is stale. The risk here is provenance ambiguity and future watch-mode divergence, not a demonstrated current content mismatch inside Recovery `dist`.

### DUPLICATE PRODUCTION PATHS FOUND: YES

Exact evidence:

1. There is one manifest worker entry, but it compiles two whole-application autofill implementations. `extension/src/background/index.ts` imports `runAgentApplication` at line 109 and `runApplicationAutofill` at line 146. The built `extension/dist/background.js` contains both functions (approximately lines 4447 and 6787 in the current unminified bundle).
2. The one production message `RUN_APPLICATION_AUTOFILL` reaches `acceptAutofillRun()` (`extension/src/background/index.ts:2247-2248`). That function selects between new Agent Mode and the legacy whole-page pipeline using `settings.developerMode && settings.autofill.legacyWholePageAutofill` (`index.ts:1635-1641`). Agent Mode enters `runAgentAutofill()` -> `runAgentApplication()` (`index.ts:1717-1739`); legacy enters `runAutofill()` -> `runApplicationAutofill()` (`index.ts:1814-1829`). They are guarded from simultaneous execution, but both are shipped and selectable.
3. The legacy selector is part of the persisted schema: `shared/schemas/autofill.ts:69-77` declares `legacyWholePageAutofill`; `shared/schemas/settings.ts:42` declares `developerMode`; `extension/src/storage/settings.ts:131-133` restores both settings families.
4. Three choice-control mutation implementations coexist in `extension/dist/content.js`:
   - Agent Mode: `extension/src/agent/agentToolExecutor.ts:482-616` implements `select_option` directly from a freshly observed option node and verifies commitment.
   - Old in-executor path: `extension/src/executor/domExecutor.ts:23,663-664` calls `executeDropdownWithRetry()` from `extension/src/executor/dropdownEngine.ts:749-873`.
   - Directive-based Dropdown Engine: `extension/src/content/index.ts:38,518-519` calls `runDropdownDirectives()` from `extension/src/dropdown/dropdownEngine.ts:344-475`; the worker reaches it through `runDropdownAutofill()` in `extension/src/background/dropdownAcrossFrames.ts:328` when the legacy whole-page orchestrator's `runDropdownStage` is active (`background/index.ts:2039-2049`).
5. The current unminified `extension/dist/content.js` contains `executeDropdown`, `executeDropdownWithRetry`, `runOneDropdown`, and `runDropdownDirectives` (approximately lines 14955, 15031, 15826, and 15927), proving these are not merely dead source files omitted from the shipped artifact.

## Detailed provenance chain

### 1. Git and worktrees

`git worktree list --porcelain` reports exactly two worktrees:

- `C:/Users/Molhm/Desktop/Internship-Agent`, branch `refs/heads/fix/unresolved-field-resolver`, HEAD `60f166f...`.
- `C:/Users/Molhm/Desktop/Internship-Agent-Recovery`, branch `refs/heads/recovery/autofill-vertical-slice`, HEAD `63f0b06...`.

Recovery's administrative files confirm:

- worktree HEAD: `ref: refs/heads/recovery/autofill-vertical-slice`
- `commondir: ../..`
- `gitdir: C:/Users/Molhm/Desktop/Internship-Agent-Recovery/.git`

The common Git directory does not make files or ignored outputs shared. In particular, `.gitignore` ignores every `dist/`, `dist-types/`, `.tsbuildinfo`, and `extension/src/generated/` path. A clean Git status therefore says nothing about which ignored bundle Chrome is running.

### 2. Package scripts and testing paths

Root scripts:

- `build`: shared -> server -> extension.
- `build:extension`: rebuild shared, run the extension's two Vite passes, then run `verify:extension` and `verify:extension-runtime`.
- `dev`: rebuild shared, then concurrently run server dev and extension dev.
- `dev:server`: workspace server `tsx watch src/index.ts`.
- `start:server`: workspace server `node dist/index.js`.
- `test`: rebuilds shared and runs Vitest; it does not build `extension/dist`.
- `test:e2e`: runs Playwright; it does not build or verify `extension/dist` first.

Consequences:

- Unit tests generally import `extension/src` and `agent-server/src` directly.
- E2E tests explicitly load the Recovery-local `extension/dist`, but will use whatever ignored artifact is already there unless the caller built first.
- The full `build:extension` path is gated by runtime provenance. The standalone `verify:extension` command is not: it passed loadability/freshness/schema/wiring checks here, while the separate `verify:extension-runtime` correctly failed the stamped-commit/HEAD check.

### 3. Extension build and manifest

`extension/vite.config.ts` derives `root` from its own `import.meta.dirname`. It emits UI entries and `src/background/index.ts` into that root's `dist`. `copyManifest()` copies that same root's `manifest.json` to that same root's `dist/manifest.json`. `extension/vite.content.config.ts` also derives its root from its own directory and emits a single self-contained IIFE from `src/content/index.ts` to the same root's `dist/content.js`.

There is no build-config path to the sibling worktree. The Recovery NPM workspace links also resolve locally:

- `node_modules/@internship-agent/shared` -> `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\shared`
- `node_modules/@internship-agent/agent-server` -> `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\agent-server`
- `node_modules/@internship-agent/extension` -> `C:\Users\Molhm\Desktop\Internship-Agent-Recovery\extension`

No production component in Recovery imports a built file from `Internship-Agent`. `@internship-agent/shared` resolves through the Recovery-local workspace junction to `shared/dist/index.js`. Source-map paths are relative and resolve back into Recovery; no map input resolves into the sibling tree.

`extension/dist-types` is configured by `extension/tsconfig.json` as declaration-only output. It is ignored, absent from the manifest, absent from Vite inputs, and not a production load path. A TypeScript dry build reported shared and agent-server projects up to date, while extension declarations would be rebuilt; that does not affect browser execution.

### 4. Build ID and source maps

`scripts/write-build-info.mjs` calculates `ROOT` from the script's own location, obtains commit/branch/dirty state using Git with that `ROOT` as cwd, and writes `ROOT/extension/src/generated/buildInfo.ts`. It includes the absolute `sourceRoot`. Popup, worker, and content code import `BUILD_ID` from that generated module.

Current Recovery artifact facts:

- Generated/emitted source root: `C:\Users\Molhm\Desktop\Internship-Agent-Recovery`.
- Build ID: `51fee56+dirty.s3.20260813025212`.
- Built at: `2026-08-13T02:52:12.413Z` (2026-08-12 22:52 local).
- Stamped branch: `recovery/autofill-vertical-slice`.
- Stamped base commit: `51fee56` (“Checkpoint before multiple choice agent repair”).
- Current HEAD: `63f0b06`, committed later at 2026-08-12 23:29:33 local.

The commit between the stamp and HEAD changes the exact live area at issue: agent decision/loop/safety/tool execution, new `choiceMatcher.ts`, page observation, agent cross-frame/client/controller/worker wiring, option discovery, shared errors and agent schema, plus server AI choice handling. However, because the build was stamped `+dirty`, commit comparison alone cannot say whether those changes were already present. The source maps answer that: every embedded input matches current disk, including `choiceMatcher.ts`, Agent Mode files, worker entry, content entry, shared compiled inputs, and generated build info.

### 5. Agent server

Current observed runtime:

- `netstat`: one listener on `127.0.0.1:4317`, PID 27700.
- PID 27700 command line contains only Recovery TSX loader paths and executes `src/index.ts`.
- Recovery logs resolve the runtime database under Recovery `local-data`.
- A second Recovery dev-server launcher/watch chain exists, but it does not own a 4317/4318 listener. No running server process referenced the sibling `Internship-Agent` tree.

Architecture still permits a wrong-tree server on a different run: both worktrees have the same `dev:server`/`start:server` scripts and default loopback port 4317. The extension defaults to `http://127.0.0.1:4317` (`shared/constants/network.ts:1-4`) and sends requests to `settings.serverUrl` (`extension/src/background/agentClient.ts:130`). `/health` and `/version` identify service/version/milestone, but do not return source root, commit, or build ID (`agent-server/src/api/health.ts:55-102`). Whichever tree binds 4317 first can therefore look valid to the extension. This possibility is not the current observed state.

### 6. Absolute path search

The requested repository-wide searches covered `Internship-Agent`, `Internship-Agent-Recovery`, `extension/dist`, `dist-types`, `background`, `contentScript`, and `BUILD_ID`, including ignored generated/build outputs and excluding `node_modules` and old audit markdown as evidence.

Relevant absolute references found:

- `.git`: required linked-worktree pointer into `Internship-Agent/.git/worktrees/Internship-Agent-Recovery`.
- `extension/src/generated/buildInfo.ts` and emitted/map/type artifacts: deliberately generated Recovery source-root stamp.
- `local-data/logs/agent.log`: runtime-resolved Recovery database path.
- NPM workspace junction metadata: absolute targets, all into Recovery.

No hard-coded absolute `Internship-Agent` or `Internship-Agent-Recovery` path was found in tracked production TypeScript, manifest, Vite config, package scripts, or server source. Runtime/build paths are derived from the executing file/cwd. Existing markdown references were not treated as evidence.

## Direct answers to the investigation questions

1. Git worktree layout: two worktrees, shared common Git directory, separate working/output directories.
2. Current branch: `recovery/autofill-vertical-slice`.
3. Common Git directory: `C:\Users\Molhm\Desktop\Internship-Agent\.git`.
4. Tree relationship: Recovery is a linked worktree of Internship-Agent, not a filesystem copy imported at runtime.
5. Package scripts: root/workspace scripts are relative; unit/E2E/build behavior differs as documented above.
6. Extension build directory: `extension/dist`; ignored and per-worktree.
7. Manifest source: `extension/manifest.json`, copied byte-for-byte by Vite.
8. Background production entry: `extension/src/background/index.ts` -> `extension/dist/background.js`.
9. Content production entry: `extension/src/content/index.ts` -> `extension/dist/content.js` IIFE.
10. Source-map/build-ID generation: Vite source maps enabled for both passes; build stamp generated once per build/dev start by `scripts/write-build-info.mjs`.
11. Dev-server entry: `tsx watch agent-server/src/index.ts`; production start entry: `agent-server/dist/index.js`.
12. Hard-coded absolute tree references: none in tracked production/build configuration; only Git metadata, generated provenance, workspace-link metadata, and runtime logs/artifacts.
13. Cross-tree production imports: none found; Recovery workspace realpaths point back to Recovery.
14. Could Recovery `extension/dist` be built by configured scripts from another tree: no. Config roots are file-relative. It could be manually copied/replaced because it is ignored, but its current stamp and all source-map inputs prove Recovery provenance.
15. Could agent-server run another tree: architecturally yes; currently no. The current 4317 listener is Recovery PID 27700, while the protocol exposes no source/build identity that would reject a sibling server.
16. Multiple legacy/new production paths: yes; one manifest entry contains both application pipelines and three choice-control execution implementations.

## Bottom line for the live SAP SuccessFactors / Lincoln Electric problem

The current Recovery `extension/dist` is not secretly compiled from `Internship-Agent`; its embedded sources match current Recovery. Repository E2E tests also force-load Recovery's `dist`. The remaining provenance uncertainty is outside those tests: the normal Chrome profile can be pointed at the sibling tree's older, separately loadable `dist`, and no live Chrome process was available to establish which directory it uses.

Even when Chrome loads Recovery, “the dropdown code” is not one path. The observed evidence language (approximately 29 fields, decision provider called, agent actions/observations) maps to Agent Mode, whose choice mutation is `agentToolExecutor.select_option`. Repairs or tests centered on the legacy whole-page `runDropdownStage`, `dropdown/dropdownEngine`, or `executor/dropdownEngine` do not by themselves prove the Agent Mode path changed. That coexistence is concrete runtime provenance evidence, not a diagnosis of which selection algorithm is wrong.
