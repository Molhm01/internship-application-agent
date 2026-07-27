# Development

## First run

```powershell
npm install
npm run build
```

`npm install` needs no C++ toolchain: SQLite comes from Node's built-in `node:sqlite`.

## Daily loop

Two terminals:

```powershell
# terminal 1 — agent server, restarts on change
npm run dev:server

# terminal 2 — extension watch build into extension\dist
npm run dev:extension
```

Or `npm run dev` for both in one window.

After an extension change: reload the extension card at `chrome://extensions`. After a content
script change: reload the extension **and** the web page. After a shared schema change: rebuild
shared (`npm run build:shared`) — the watch builds consume its compiled output.

## VS Code

Recommended extensions (offered on open): ESLint, Prettier, Vitest, Playwright.

- `Ctrl+Shift+B` — default build task.
- **Run and Debug → Agent server** — starts the server with breakpoints attached.
- **Run and Debug → Vitest current file** — debugs the open test file.
- Format-on-save is enabled for TS, TSX, JSON, CSS, and Markdown.

## Validation

Run before considering anything finished:

```powershell
npm run validate     # format:check → lint → typecheck → test → build
npm run test:e2e     # after a build; starts the agent server itself
```

Individual steps:

| Command             | Covers                                                         |
| ------------------- | -------------------------------------------------------------- |
| `npm run lint`      | Type-aware ESLint over every workspace.                        |
| `npm run typecheck` | `tsc --build` for packages, plus a standalone pass over tests. |
| `npm run test`      | Vitest projects: `server`, `integration`, `extension`.         |
| `npm run test:e2e`  | Playwright with the real unpacked extension in Chromium.       |
| `npm run build`     | Shared → server → extension.                                   |

`npx playwright install chromium` once, before the first e2e run.

`npm run check:ollama` confirms the configured model exists and can satisfy a JSON-schema
constrained request — the capability Milestone 4's planner depends on. Run it after changing
`OLLAMA_MODEL`.

## Test layout

```text
tests/
  server/       Fastify via inject: profile, documents, answers, database, security primitives
  integration/  Shared schema contracts
  extension/    React popup and options page, background client, jsdom
  e2e/          Playwright against the built extension
  fixtures/     Application pages for scanner and executor tests (Milestone 2+)
```

The `server` suite uses an in-memory database, a temporary documents directory, and an injected
`fetch`, so it never touches `local-data/` and never needs Ollama running.

## Writing tests that mean something

- Assert observed behavior, not that a function was called.
- For every failure path, assert the error **code** and that the message names the real cause.
- Never assert a field was filled without asserting the verification result too.
- Fixtures should reproduce real markup, including the awkward parts.

## Milestones

Work on one at a time. Do not build ahead.

| #   | Deliverable                                                                                              | Status       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------ |
| 0   | Monorepo, scaffolds, shared schemas, SQLite, logging, `/health`, Ollama probe, popup status, docs, tests | **Complete** |
| 1   | Profile schema and API, options-page editor, approved answers, documents, resume selector                | **Complete** |
| 2   | Generic/Greenhouse/Lever/Workday read-only scanning, review and JSON export                              | **Complete** |
| 3   | Deterministic autofill: text, email, phone, textarea, select, radio, checkbox, date — all verified       | **Complete** |
| 4   | Ollama planning: classification, matching, strict JSON, Zod validation, confidence, repair logic         | Not started  |
| 5   | Resume upload with filename verification                                                                 | Not started  |
| 6   | Generated written answers with limits, grounding, save-as-approved                                       | Not started  |
| 7   | Adapters: Greenhouse → Lever → Workday → Ashby → iCIMS                                                   | Not started  |
| 8   | Optional Internship-AI website handoff                                                                   | Not started  |

## Definition of done

Not "the code is written". A feature is done when:

- Implementation, schema validation, and error handling all exist.
- Unit, integration, and Playwright tests pass — and would fail if the feature broke.
- `npm run typecheck`, `npm run lint`, and `npm run build` pass without weakened rules.
- Success is verified against real behavior, not assumed from a return value.
- Failure states are visible in the UI with a cause and a suggested action.
- Documentation is updated, including this file's status table.

## Conventions

- Strict TypeScript; `any` is a lint error. If unavoidable, document why on the line above.
- Never weaken tsconfig or ESLint to make a build pass, and never delete a test to make a suite pass.
- Shared contracts live in `shared/`. Do not duplicate a type across packages.
- Server logging goes through the structured logger — it redacts sensitive keys.
- Keep modules small and single-purpose.

## Troubleshooting

**Popup says "Agent Server: Disconnected".** Is `npm run dev:server` running? Check
`curl.exe http://127.0.0.1:4317/health`. The popup shows the underlying cause under the row.

**Popup says "Ollama: Disconnected".** Start `ollama serve`. The detail line reports the URL tried
and the error.

**Model shows "(not installed)".** `ollama pull <model>`, or start the server with
`$env:OLLAMA_MODEL = "<a model you have>"`.

**Options page says "Token accepted: no".** Re-copy the token from the server's startup output or
`local-data\agent-token.txt`, then save again.

**"Content script is not reachable".** Expected on `chrome://` pages and the Web Store. On a normal
page, reload the tab — content scripts do not inject into pages that were already open.

**Service worker looks inactive at `chrome://extensions`.** Normal; MV3 workers idle out and wake on
demand. Click **service worker** to open its console.

**"The background worker did not answer …. Its build is probably older than this page."** The
service worker running in Chrome predates the page asking it — the usual cause is rebuilding the
extension without pressing **Reload** on the extension card, so the popup and options page come from
the new bundle while the worker is still the old one. Chrome resolves `sendMessage` with `undefined`
when no listener handles a message type, which is what produces this. Reload the extension at
`chrome://extensions`, then reopen the page. **After every `npm run build:extension`, press Reload on
the extension card.**

**Tracing a flow that crosses the extension boundary.** The popup, the options page, the service
worker, and the server are separate realms, so a stall in the middle is invisible from any one of
them. Every stage writes a breadcrumb through `extension/src/utils/trace.ts` at `console.debug`
(enable **Verbose** in the DevTools console) with failures at `console.warn`. A healthy profile load
reads:

```text
[agent] options: page mounted
[agent] profile: load started {attempt: 1}
[agent] messaging: sending message to background {type: PROFILE_GET}
[agent] worker: received request {type: PROFILE_GET}
[agent] http: requesting {method: GET, path: /profile}
[agent] http: received response {path: /profile, status: 200}
[agent] http: response validated {path: /profile}
[agent] worker: responding {type: PROFILE_GET}
[agent] messaging: received response {type: PROFILE_GET}
[agent] profile: existing profile loaded
[agent] profile: load finished, loading=false
```

The last line printed is the last stage that completed. Open the worker's own console from
`chrome://extensions` → **service worker** to see its half.

**Type errors after editing `shared/`.** Run `npm run build:shared`; the other packages consume its
compiled declarations.

## Known limitations in this build

- Grounded custom-answer generation is implemented for eligible native text and textarea fields.
  General model-authored application plans remain deliberately unimplemented.
- `/applications/*` endpoints remain reserved and return `501`; M3 planning runs in the extension.
- Documents are registered by uploading a copy into `local-data/documents`. The stored file is
  immutable — replacing a resume means registering a new document and deleting the old one.
- `resumeSelectionRules` exists in the profile schema but nothing consults it yet; automatic
  role/industry resume matching lands with Milestone 5.
- Existing popup Playwright checks remain read-only against port 4317. Fill and AI tests use an
  isolated server on port 4318, a deterministic mock Ollama, a fixed token, and synthetic profile.
- Workday is commonly multi-step; scan and fill only the currently visible rendered step.
- Cross-origin frames, closed shadow roots, and unrendered virtualized options can require manual
  inspection.
- File upload and custom/virtualized combobox execution are intentionally unsupported in M4.
- `npm audit` reports 5 high advisories, all in ESLint's transitive `brace-expansion` dependency
  (development-only, not shipped). Clearing them requires ESLint 10, which `typescript-eslint` 8
  does not yet support.

## Using the settings page

Open it from the popup's **Open Settings** button, or from `chrome://extensions` → Internship
Application Agent → **Details** → **Extension options**.

The page includes an **AI answers** tab in addition to the profile, Documents, Approved answers, and
Connection tabs. Profile sections share **Save profile**; the other sections save independently.

1. **Connection** — do this first. Paste the token the server printed at startup (also in
   `local-data\agent-token.txt`), click **Save**, then **Test connection**. You want
   "Token accepted: yes". Until the token is set, the other tabs cannot read or write anything.
2. **Name and contact** — legal name, preferred name, pronouns, email, phone, address, and links.
3. **Education**, **Work experience**, **Projects** — **Add school** / **Add role** / **Add project**
   creates a blank entry. Dates accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. **Remove** deletes an
   entry.
4. **Skills and activities** — comma-separated skills, spoken languages, certifications, and
   activities/volunteering.
5. **Eligibility** — work authorization, sponsorship, relocation, travel, licence, age, earliest
   start date, and internship availability. Yes/no questions have an explicit **Not answered** option;
   leaving it there means the agent treats the question as unanswered rather than assuming "no".
6. **Preferences** — target roles, industries, preferred locations, remote preference, salary.
7. **Sensitive answers** — one policy per category, all starting at "no policy set (ask me every
   time)". Choosing _Fill automatically_ also requires typing the exact answer to use; without it the
   question still goes to review.
8. Press **Save profile**. Invalid fields are reported inline and in the footer, and **nothing is
   saved** until they are fixed. The header shows the completeness percentage, which counts required
   sections only.
9. **Documents** — give a display name, pick a type, optionally add tags and target roles, choose a
   file, then **Register document**. The file is copied into `local-data\documents`; the agent never
   reads from anywhere else. The first resume becomes the default automatically. **Make default**
   changes it, **Use next** picks a specific resume for the next application, and **Delete** removes
   the record and the file.
10. **Approved answers** — reusable answers to repeated questions. Set the canonical question, any
    alternate wordings, the answer type and value, and the permission flags. Marking an answer
    sensitive forces "always show me before filling" on, because the server rejects the alternative.
11. **AI answers** — enable local generation, choose an installed model, tune bounded
    temperature/tokens/timeout/retry/concurrency, answer length, tone, and regeneration behavior.
    The page states explicitly that generation runs locally.

## Milestone 4 test workflow

`npm run validate` covers formatting, lint, types, unit/integration suites, and production builds.
`npm run test:e2e` then exercises the built MV3 extension against local fixtures and mock Ollama.
To opt into a real local daemon smoke test using only synthetic evidence:

```powershell
$env:RUN_LIVE_OLLAMA = "1"
npm run test -- tests/server/ollamaLive.test.ts
```

The default suite skips this single environment-dependent test so CI never reads a developer's
local profile or requires a multi-gigabyte model.

Everything you save is visible in the popup: the **Profile** row shows the completeness percentage and
names any missing required section, and **Selected Resume** shows which document would be attached
and why.
