# Internship Application Agent

A local-first Chrome extension that reads an online job application, works out what each question
is asking, answers it from your saved profile using a model running on your own machine, attaches
the right resume, and verifies that every field actually took the value.

**It never submits an application.** Review and the final click are always yours.

This is a standalone product. It does not depend on, and is not part of, the Internship-AI website.
The extension works with the website closed; optional integration comes much later (Milestone 8).

---

## Current status: Milestone 4 — grounded local AI answer generation

What works right now, verified end to end:

- The monorepo, TypeScript project references, lint, format, type check, tests, and builds.
- A local agent server on `http://127.0.0.1:4317` with `/health`, `/version`, `/models`,
  `/profile`, `/documents`, and `/answers`.
- A live Ollama connectivity probe, plus `npm run check:ollama` to confirm the configured model can
  satisfy a JSON-schema-constrained request.
- A full profile editor in the extension settings page: name, contact, address, links, education,
  work experience, projects, skills, certifications, activities, eligibility, sponsorship,
  relocation, availability, salary, and target roles and locations.
- Per-category sensitive-answer policies, defaulting to "ask me every time".
- A reusable approved-answer library with create, edit, and delete.
- Document registration into a controlled local folder, with a default resume per type.
- Profile completeness and the selected resume shown in the popup.
- SQLite persistence, structured JSON logging, and sensitive-value redaction.
- Read-only Generic, Greenhouse, Lever, and Workday application scanning.
- Deterministic accessible-label extraction, canonical normalization, section grouping, ATS
  confidence detection, job-context extraction, and bounded dynamic-field observation.
- A scan review page with statistics, search, filters, collapsible sections, sanitized JSON copy
  and export, rescan, cancellation, and clear.
- Deterministic matching from scanned fields to saved profile values, explicitly approved answers,
  and user overrides. No model is consulted.
- A persisted fill-plan review page with per-field approval, safe bulk approval, editing, reset,
  skip, filters, and exact source/reason/confidence details.
- Verified text, textarea, email, telephone, number, URL, native select, radio, checkbox/group, and
  native date execution for Generic, Greenhouse, Lever, and the Workday fixture.
- Mandatory post-fill verification, at most one safe retry, page-change protection, cancellation,
  and a persisted action-level fill report.
- Local Ollama generation for eligible custom text questions, with deterministic classification
  first and model fallback only for genuinely uncertain questions.
- Evidence retrieval from the saved profile, approved-answer library, selected/default resume
  extraction, job title, company, and description; every factual claim must cite retrieved evidence.
- PDF, DOCX, and TXT resume text extraction performed locally and cached by document id/content hash.
- Prompt-injection screening, closed structured output, one repair/retry, grounding and length
  validation, explicit review, per-answer approval, regeneration modes, batch progress, and cancel.
- AI drafts are never pre-approved. Only a validated, explicitly approved draft becomes a
  `fill_generated_text` action, and the existing deterministic executor remains the only DOM writer.

**Not implemented yet, by design:** resume attachment, custom combobox automation, multi-page
navigation, and submission. Reserved server endpoints for later capabilities still return HTTP 501. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the milestone plan.

---

## Requirements

| Tool    | Version             | Notes                                                              |
| ------- | ------------------- | ------------------------------------------------------------------ |
| Node.js | 22.5+ (24.x tested) | Uses the built-in `node:sqlite`, so no C++ build tools are needed. |
| npm     | 10+ (11.x tested)   | Workspaces.                                                        |
| Chrome  | 116+                | Manifest V3 with a module service worker.                          |
| Ollama  | any recent version  | Optional to build and test; required for Milestone 4 onward.       |

---

## Setup on Windows

Open **PowerShell** in the repository root (`C:\Users\<you>\Desktop\Internship-Agent`):

```powershell
npm install
npm run build
```

`npm run build` compiles the shared schemas, the server, and the extension into
`extension\dist`.

### 1. Start the local agent server

```powershell
npm run dev:server
```

On first start it generates an access token, prints it, and stores it at
`local-data\agent-token.txt`:

```text
  Internship Application Agent — local server
  URL:    http://127.0.0.1:4317
  Ollama: connected
  Token:  273f83ce...9699
```

Leave this window running. Confirm it works:

```powershell
curl.exe http://127.0.0.1:4317/health
```

### 2. Start Ollama (required for AI generation)

```powershell
ollama serve
ollama pull qwen3.5:9b
```

Confirm the configured model can actually produce schema-constrained JSON, which Milestone 4 needs:

```powershell
npm run check:ollama
```

The popup reports Ollama's real state either way. If the configured model is not installed, the
popup says so explicitly rather than failing later. To point the server at a model you already
have, set the environment variable before starting it:

```powershell
$env:OLLAMA_MODEL = "qwen3.5:9b"; npm run dev:server
```

### 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the folder `C:\Users\<you>\Desktop\Internship-Agent\extension\dist` — the folder that
   contains `manifest.json`, **not** the `extension` folder itself.
5. The card "Internship Application Agent" appears. Pin it from the puzzle-piece menu.

After any code change, run `npm run build:extension`, then press the **reload** arrow on the
extension card. Changes to the content script also need a reload of the web page itself.

### 4. Connect the extension to the server

1. Click the extension icon. The popup shows **Agent Server: Connected** and the real Ollama state.
2. Click **Open Settings**.
3. Go to the **Connection** tab, paste the token from step 1 into **Access token**, click **Save**,
   then **Test connection**. You should see "Token accepted: yes".
4. Fill in your profile on the remaining tabs and press **Save profile**. Blank fields stay blank —
   the agent treats them as unanswered rather than guessing.

The token is required for every endpoint except `/health` and `/version`, which stay open so the
popup can report a truthful connection state before setup.

### 5. Analyze and fill an application

1. Open a normal HTTP(S) application page and wait for its fields to appear.
2. Open the extension popup and click **Analyze Application**.
3. Confirm the detected ATS and field count, then click **Review Scan**.
4. Inspect grouped fields or use **Copy JSON** / **Export JSON**.
5. Click **Build Fill Plan**, inspect every proposed action, then approve individual actions or
   **Approve All Safe**.
6. For eligible custom questions, choose **Generate answer** or **Generate all eligible**. Inspect
   the evidence, warnings, factual claims, limits, and validation result. Edit/regenerate if needed,
   then explicitly approve each draft.
7. Edit or skip anything necessary. Edited values become `user_override` and need approval.
8. Click **Fill Approved Fields**. Confirm each attempted action is reported as verified or with an
   exact failure reason.
9. Review the application and continue manually. The extension never clicks Next, Continue, or
   Submit and never uploads a file.

Detailed fixture and real-ATS checks are in [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

---

## Setup in VS Code

1. `File → Open Folder…` → the repository root.
2. Install the recommended extensions when prompted (ESLint, Prettier, Vitest, Playwright).
3. `Ctrl+Shift+` `opens a terminal at the root;`npm install`then`npm run build`.
4. `Ctrl+Shift+B` runs the default build task.
5. Use **Run and Debug → Agent server** to start the server with the debugger attached.

---

## Commands

| Command                  | What it does                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `npm install`            | Installs every workspace.                                        |
| `npm run dev`            | Server and extension watch builds together.                      |
| `npm run dev:server`     | Agent server with `--watch`.                                     |
| `npm run dev:extension`  | Vite watch build into `extension/dist`.                          |
| `npm run start:fixtures` | Serves scanner fixtures on `http://127.0.0.1:4173`.              |
| `npm run build`          | Shared schemas, then server, then extension.                     |
| `npm run lint`           | ESLint, type-aware, across every workspace.                      |
| `npm run format`         | Prettier write. `npm run format:check` in CI.                    |
| `npm run typecheck`      | `tsc --build` for the packages, plus a separate pass over tests. |
| `npm run test`           | Vitest: server, integration, and extension projects.             |
| `npm run test:e2e`       | Playwright, loading the built extension in Chromium.             |
| `npm run validate`       | format:check → lint → typecheck → test → build.                  |
| `npm run clean`          | Removes build output.                                            |
| `npm run check:ollama`   | Confirms the configured model exists and honours a JSON schema.  |

`npm run test:e2e` needs `npm run build` first and starts the agent server itself.

---

## Layout

```text
extension/      Manifest V3 extension: popup, options, background worker, content script
agent-server/   Local Fastify server: Ollama, SQLite, logging, security
shared/         Zod schemas, types, and constants used by both sides
tests/          Vitest suites and Playwright e2e, with fixture pages
local-data/     Your profile, documents, database, and logs — git-ignored
docs/           Architecture, API, ATS support, security, development
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow and the boundaries the model cannot cross
- [docs/API.md](docs/API.md) — every endpoint and its schema
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and the guarantees that back it
- [docs/ATS_SUPPORT.md](docs/ATS_SUPPORT.md) — adapter status per applicant tracking system
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — workflow, milestones, definition of done
- [docs/AI_ANSWER_GENERATION.md](docs/AI_ANSWER_GENERATION.md) — classification, evidence, validation, and review
- [docs/OLLAMA_SETUP.md](docs/OLLAMA_SETUP.md) — local model installation and troubleshooting
- [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/PROMPT_INJECTION.md](docs/PROMPT_INJECTION.md) — AI-specific safeguards

## Privacy

Everything stays on your machine. The agent server binds to `127.0.0.1` only, inference runs
through your local Ollama, and no profile data, document, or answer is sent to any remote service.
`local-data/` is git-ignored in full.

## Independence

This project is an independent implementation. It contains no code, branding, assets, text, private
APIs, or proprietary logic from any commercial application-assistant product.
