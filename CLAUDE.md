# CLAUDE.md

Guidance for coding agents working in this repository.

## What this project is

A standalone Chrome extension (Manifest V3) plus a local Node agent server that analyzes job
application forms and fills them from a saved profile, using a locally hosted model via Ollama.

**It must never submit an application.** No code path may click a final submit control. The
`application_runs.submitted` column carries a `CHECK (submitted = 0)` constraint and
`applicationRunSchema` types the field as `z.literal(false)`. Do not relax either.

This is **not** part of the Internship-AI website. The website does job discovery, scoring, and
tracking; it must never contain browser automation, DOM manipulation, form detection, Ollama
runtime logic, or ATS adapters. This repository owns all of that and must work with the website
closed.

## Milestones

Work on exactly one milestone at a time and do not build ahead.

| #   | Scope                                              | Status       |
| --- | -------------------------------------------------- | ------------ |
| 0   | Architecture and scaffold                          | Complete     |
| 1   | Profile, approved answers, and document management | Complete     |
| 2   | Form analysis and scan review                      | Complete     |
| 3   | Deterministic reviewed autofill                    | Complete     |
| 4   | Grounded Ollama answer generation                  | Complete     |
| 5   | Explicitly approved resume upload                  | Complete     |
| 6   | Production hardening, diagnostics, and recovery    | Complete     |
| 7   | Generic, Greenhouse, Lever, and Workday adapters   | Complete     |
| 8   | Optional external website integration              | Out of scope |

Endpoints belonging to a future milestone are registered in `agent-server/src/api/planned.ts` and
return HTTP 501 naming that milestone. When you implement one, delete its entry from that list —
never leave a route that answers 501 and a route that works for the same path.

## Hard architectural rules

1. **The model never touches the DOM.** It receives normalized `DetectedField` objects and returns
   an `ApplicationPlan`. `FillAction` has no field capable of expressing a selector, a script, or
   any executable instruction, and Zod strips unknown keys. Keep it that way.
2. **The model never returns executable code**, and nothing in this repo evaluates model output.
3. **Content scripts never make network requests.** They talk to the background worker; the
   background worker is the only client of the agent server; the server is the only client of
   Ollama.
4. **Every model response is validated with Zod before use.** On failure: do not execute, log the
   raw response to the private debug log only, attempt exactly one structured repair, then surface
   a clear error. Never execute malformed output.
5. **The server binds to `127.0.0.1` only.** The host is a hard-coded constant, not configuration.
6. **Never infer or fabricate profile data.** A missing value is unanswerable, not a gap to fill.
7. **Sensitive questions are never guessed.** Race, ethnicity, gender, disability, veteran status,
   religion, sexual orientation, citizenship, sponsorship, criminal history, medical information,
   salary expectations, and security clearance require an explicit stored policy; with no policy,
   the answer is `review_required`.
8. **A function returning successfully is not evidence a field was filled.** Every action is
   verified against observed DOM state and reported with one of the statuses in `fieldStatusSchema`.

## Error handling

Never surface a bare failure. Every error is an `AgentError`: a code from `ERROR_CODES`, a message
naming the actual cause, `recoverable`, a `suggestedAction`, and non-sensitive `debugContext`.
`DEFAULT_ERROR_GUIDANCE` in `shared/constants/errors.ts` holds the fallback remedy for each code,
and a test asserts every code has one.

## Where things go

- Anything used by both sides → `shared/`. Never duplicate a type across packages. Pure shared
  logic (e.g. profile completeness) lives in `shared/logic/` so the popup and the server can never
  compute it differently.
- Server-only logic → `agent-server/src/<area>/`.
- Browser-only logic → `extension/src/<area>/`.
- Adapters extend shared scanning and execution utilities rather than reimplementing them.

## Conventions

- Strict TypeScript. `any` is a lint error; if one is unavoidable, document why on the line above.
- Do not weaken tsconfig or ESLint rules to make a build pass. Fix the code.
- Do not delete or skip tests to make a suite pass.
- SQLite access goes through `node:sqlite` (built into Node) — do not add a native SQLite addon.
  Migrations in `agent-server/src/database/migrations.ts` are append-only; never edit a shipped one.
- Every row read from SQLite is re-validated with its Zod schema before use. Row-shape assertions go
  through `asRow`/`asRows` in `database/db.ts` so they stay auditable.
- All filesystem access goes through `resolveInsideRoot` in `security/paths.ts`, which proves the
  resolved path is inside the documents directory. No caller ever supplies a path.
- Log through the structured logger, never bare `console` on the server. The logger redacts
  sensitive keys; do not bypass it for "just this one" debug line.

## Definition of done

A feature is complete only when implementation, schema validation, and error handling exist; unit,
integration, type, lint, production build, and relevant Playwright checks all pass; success is
verified against real behavior; failure states are visible in the UI; and documentation is updated.

Report the actual result of every command you run. Do not claim browser behavior works without
having observed it.

## Validation

```bash
npm run validate      # format:check, lint, typecheck, test, build
npm run test:e2e      # requires a completed build; starts the server itself
```

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
