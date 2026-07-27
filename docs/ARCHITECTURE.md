# Architecture

## Two products, one boundary

The **Internship-AI website** finds jobs: search, filtering, scoring, saved jobs, application
tracking, company information, official links, resume recommendations. It contains no browser
automation, no DOM manipulation, no form detection, no Ollama runtime, and no ATS adapters.

The **Internship Application Agent** — this repository — fills applications: page analysis, field
detection, ATS detection, profile-based autofill, model reasoning, resume attachment, verification,
logs, and the review workflow. It runs entirely without the website. Optional handoff from the
website is Milestone 8 and must never become a prerequisite.

## Data flow

```text
Application page
  ↓ content script        (extension/src/content)
  ↓ ATS detector          (extension/src/scanner/adapters.ts)
  ↓ selected adapter      (Generic / Greenhouse / Lever / Workday)
  ↓ DOM scanner           (extension/src/scanner/domScanner.ts)
  ↓ DetectedField[]       (shared/schemas/fields.ts)
  ↓ job context           (extension/src/scanner/jobContext.ts)
  ↓ Background worker     (extension/src/background)
  ↓ chrome.storage.local  (latest validated scan only)
  ↓ Review screen         (extension/src/review)
  ↓ sanitized JSON export
```

Milestone 3 preserves that scan path and adds a separate deterministic path:

```text
Validated scan
  ↓ background retrieves saved profile + approved answers from 127.0.0.1:4317
  ↓ matcher              (extension/src/matcher)       — fixed rules and confidence bands
  ↓ formatters/options   (shared/logic)                — exact deterministic transformations
  ↓ planner              (extension/src/planner)       — Zod-validated DeterministicFillPlan
  ↓ fill-plan review     (extension/src/fill-plan)     — explicit approvals and overrides
  ↓ ATS executor         (extension/src/executor)      — scanned selectors only
  ↓ verifier             (extension/src/verifier)      — observed post-rerender state
  ↓ reporter/storage     (extension/src/reporter, storage)
```

Each arrow crosses a process or trust boundary, and every payload that crosses one is described by
a schema in `shared/`.

Milestone 4 keeps deterministic matching for known profile fields and adds a narrowly scoped answer
generation path:

```text
Eligible custom text field
  → deterministic classification (Ollama fallback only when uncertain)
  → local profile/answer/resume/job evidence retrieval
  → controlled structured Ollama prompt
  → schema parse + one repair/retry
  → deterministic grounding/claim/limit/injection validation
  → persisted unapproved review card
  → explicit user approval
  → fill_generated_text action
  → existing deterministic executor + verifier
```

The AI service (`agent-server/src/ai`) can write generation records but cannot access the page.
The executor cannot call Ollama. A generated answer crosses the AI/executor boundary only as
reviewed text plus validation and approval metadata; actions still cannot name a selector, script,
XPath, click target, file path, navigation, or submit operation.

## What the model can and cannot do

The language model is a planner, not an actor.

**It receives** one normalized question, constraints, bounded verified evidence snippets, safe job
context, style preferences, and a regeneration mode. It never receives raw HTML, page scripts,
cookies, credentials, DOM selectors, file paths, or resume bytes.

**It returns** one `GeneratedAnswerCandidate`: inert answer text, cited evidence ids, factual-claim
mappings, missing information, warnings, confidence, and counts. The candidate schema has no
selector, script, XPath, element, click, upload, navigation, or submission vocabulary.

**It cannot** manipulate the DOM, run JavaScript, choose a file, invent profile data, answer
sensitive/legal questions, approve its own answer, or submit.

If a model response fails parsing or grounding, it is never executed. One deterministic JSON repair
and at most one bounded retry are permitted; failure surfaces a structured error. Prompts and raw
responses are not written to the general log.

## Component responsibilities

### `extension/`

| Directory     | Responsibility                                                      |
| ------------- | ------------------------------------------------------------------- |
| `popup/`      | Connection status, run summary, action entry points.                |
| `options/`    | Settings; profile, document, and answer editors from Milestone 1.   |
| `background/` | The only network client. Owns all agent-server communication.       |
| `content/`    | Page-side scanning and execution. Makes no network requests, ever.  |
| `scanner/`    | ATS detection, read-only adapters, DOM and job-context extraction.  |
| `review/`     | Scan summary, grouped field diagnostics, filtering and JSON export. |
| `fill-plan/`  | Deterministic action review, approval, overrides, and run report.   |
| `matcher/`    | Pure profile/approved-answer/user-override matching rules.          |
| `planner/`    | Converts matches into a validated deterministic action vocabulary.  |
| `executor/`   | Deterministic browser-side fill operations. Never model-authored.   |
| `verifier/`   | Reads post-rerender page state and decides verified or failed.      |
| `reporter/`   | Produces exact terminal counts and the non-submission reminder.     |
| `messaging/`  | The closed message union crossing extension boundaries.             |
| `storage/`    | `chrome.storage` access.                                            |

### `agent-server/`

| Directory                                                        | Responsibility                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `api/`                                                           | Routes, response envelopes, outgoing schema validation.               |
| `ollama/`                                                        | The only code that contacts Ollama. Timeouts, probes, model listing.  |
| `database/`                                                      | `node:sqlite` connection and forward-only migrations.                 |
| `logging/`                                                       | Structured JSON logging with sensitive-key redaction.                 |
| `security/`                                                      | Token generation and constant-time comparison, origin policy, limits. |
| `profile/`, `answers/`, `documents/`, `planning/`, `validation/` | Reserved for Milestones 1–6.                                          |

### `shared/`

Zod schemas, inferred types, and constants. Both sides import from here so a contract change is a
compile error rather than a runtime surprise. Nothing here may import from `extension/` or
`agent-server/`.

## Why a separate local server

The content script could technically call Ollama directly. It must not, because:

- The server keeps the token, the database, and the document paths out of page-adjacent code.
- Timeouts, retries, rate limiting, and schema repair belong in one place.
- Ollama's origin checks and CORS behavior are not designed for extension callers.
- A single choke point means one place to audit what leaves the machine — which is nothing.

## Storage

SQLite via `node:sqlite`, which ships with Node 22.5+, so a fresh Windows checkout never needs MSVC
build tools. The database lives at `local-data/agent.db`. Migrations in
`agent-server/src/database/migrations.ts` are append-only and run at startup inside a transaction.

Schema v1 creates `profile`, `documents`, `approved_answers`, `application_runs`, and
`application_actions` — tables that later milestones populate. `application_runs.submitted` carries
`CHECK (submitted = 0)`: the product's central promise is enforced by the database, not only by
application code.

The extension stores `lastApplicationScan`, `latestDeterministicFillPlan`,
`latestAnswerGenerationStore`, and `latestFillRunReport` in `chrome.storage.local`. This
matches the existing extension-local settings architecture. It must pass
`applicationScanResultSchema` and contains normalized fields and job context, never raw HTML,
authentication tokens, cookies, document bytes, or raw HTML. New scans invalidate stale plans,
reports, and generated drafts; overrides and approvals live in validated stores.

Schema v3 adds cached document extractions, answer generations, and grounding/scope metadata on
approved answers. Extractions are local normalized text/sections keyed by document and content
hash; generation audit rows retain structured state and safe errors, not executable output.

## Read-only scanning invariant

Milestone 2 scanner modules use DOM query/read APIs only. They do not assign values or checked/
selected state, dispatch events, click controls, submit forms, or attach files. Dynamic fields use
a `MutationObserver` with a short quiet window and a hard maximum; there is no permanent polling.

## Verification model

A function that returns without throwing proves nothing about the page. Every action is checked
against observed state — input value, selected option, checked state, visible text, uploaded
filename, or a cleared validation message — and reported as `pending`, `filled`, `verified`,
`skipped`, `needs_review`, `unsupported`, or `failed`. A failed action is retried at most once
unless an adapter documents a safe retry strategy. The run report distinguishes "we set it" from
"the page kept it".

Milestone 3 supports native text-like controls, native select, radio, single/grouped checkbox, and
native date. It uses browser prototype value/checked setters, dispatches input/change/blur, allows
framework state to rerender, then reads the control and browser validation state.
