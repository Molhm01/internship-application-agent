# Unified Application Architecture — Phase A Audit

Status: **audit only.** No feature code was written for this document. Every claim below was
checked against the running source in both repositories on 2026-07-29, not against previous
plans or reports.

Repositories inspected:

| Repository                                | Git                                                    | Role                                            |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `C:\Users\Molhm\Desktop\Internship-Agent` | branch `fix/unresolved-field-resolver`, HEAD `9095a04` | Chrome MV3 extension + local Node agent         |
| `C:\Users\Molhm\Desktop\Internship-AI`    | **not a Git repository**                               | Next.js job discovery site (`internship-pilot`) |

The repositories stay separate. Nothing in this plan merges them.

---

## 1. Headline finding

**There are two complete, independent application agents, and they do not talk to each other.**

Internship-AI does not merely discover jobs. It contains its own Manifest V3 extension
(`extension/dist/`, 41 KB of built JS), its own extension protocol
(`src/app/api/extension/{profile,approved-answers,documents,fill-plan,report,runs,health}`),
its own form filler, its own ATS adapters, and its own Playwright browser automation
(`src/lib/applications/`, 3,992 lines across 21 modules).

```
src/lib/applications/formFiller.ts        494 lines
src/lib/applications/worker.ts            432
src/lib/applications/extensionApi.ts      332
src/lib/applications/browserManager.ts    314
src/lib/applications/extensionFiller.ts   293
src/lib/applications/browserAgent.ts      240
src/lib/applications/navigation.ts        136
src/lib/applications/adapters.ts           51
```

This directly contradicts the boundary this repository's `CLAUDE.md` declares:

> The website does job discovery, scoring, and tracking; it must never contain browser
> automation, DOM manipulation, form detection, Ollama runtime logic, or ATS adapters.

That rule describes an intended architecture, not the current one. Any handoff design that
ignores the second agent will produce two extensions fighting over the same application page.

**This is the single most important decision to make before Phase E**, and it is the user's
call, not mine. See §9.

---

## 2. Current website architecture (Internship-AI)

Next.js App Router, Prisma + SQLite (`dev.db`), local Ollama, Playwright worker.

**Pages:** `jobs`, `documents`, `tracker`, `profile`, `assessments`, `watchlist`, `nearby`,
`approved-employers`, `diagnostics`, `agent-diagnostics`, `quarantine`, `security-quarantine`,
`new-employer-review`, `local-firms`.

**Data model** (22 Prisma models): `Job`, `MatchResult`, `Company`, `ResumeFact`,
`ResumeDocument`, `ResumeBullet`, `GeneratedDocument`, `ApplicationProfile`, `ApprovedAnswer`,
`ApplicationRun`, `AuditLogEntry`, `GmailAccount`, `TrackedEmail`, and others.

### What genuinely works

- **Job discovery, scoring, verification.** `/api/match`, `/api/jobs/[id]/verify`, company
  watchlist, nearby-firm search, Gmail tracking.
- **Document tailoring — already sophisticated.** `POST /api/jobs/[id]/generate-documents`
  → `generateDocumentsForJob()`. `GeneratedDocument` stores `keywordClassification`
  (`supported` / `confirmationRequired` / `developmentGap` / `unsupported`), `tailoringAudit`
  with evidence and intentionally-omitted requirements, `qaStatus`, `identityVerified`, and
  `bulletIdsUsed` tying every bullet to a verified `ResumeBullet`.

  **Phase 13 is mostly already built.** It needs exposing to the extension, not reimplementing.

- **A truthfulness posture that matches this project's.** `ApplicationProfile` comments state
  that `workAuthorization`, `requiresSponsorship`, `clearanceEligible`, `eeoGender`,
  `eeoRaceEthnicity`, `eeoVeteranStatus`, `eeoDisabilityStatus` are _all null until explicitly
  set_, and null means stop for `NEEDS_USER_ACTION` rather than guess.

### What does not exist

- **No user accounts.** No `User` model, no `/api/auth`, no session, no sign-in, sign-out, or
  password reset. `ApplicationProfile` is a **singleton row with `id = "default"`**. The whole
  product is single-user and local. The only OAuth present is Gmail, for email tracking.
- **No "Apply with Agent".** A search across `src/` for `Apply with Agent`, `applyWithAgent`,
  `application-session`, and `internship-agent-session` returns nothing.
- **No `ApplicationSession` concept** in any form.
- **No application presets.** `ApprovedAnswer` is `questionText` → `answer`, unique on the
  question string. There is no policy, no canonical category, no `prefer_not_to_answer`.

---

## 3. Current extension architecture (Internship-Agent)

npm workspaces: `shared/` (Zod contracts), `agent-server/` (Fastify on `127.0.0.1:4318`,
`node:sqlite`), `extension/` (MV3, Vite two-pass build).

**Runtime path today:**

```
popup "Analyze Application"
  → content/index.ts scanApplication → domScanner (static DOM read)
  → ApplicationScanResult (fields, options as found in static DOM)
popup "Build Fill Plan"
  → deterministicPlanner.buildDeterministicPlan
      → matcher/deterministicMatcher.matchField   (profile / approved answer / sensitive policy)
      → shared/logic/optionMatcher.matchOption    (literal → alias → region-suffix)
      → shared/logic/locationMatcher              (city+state+country)
  → DeterministicFillPlan (every action starts approved: false)
popup "Review Fill Plan" → chrome.tabs.create('fill-plan.html')
  → user approves actions individually, or "Approve All Safe"
popup "Fill Approved Fields"
  → executor/domExecutor.executeDomAction
      → executor/comboboxExecutor.selectComboboxOption  (opens control, reads real options)
      → verifier/domVerifier.verifyDomAction
  → FillRunReport (submitted: z.literal(false))
```

**Server endpoints that exist:** `/health`, `/version`, `/models`, `/profile`, `/documents`,
`/answers`, `/ai/*`. **`/application-sessions` does not exist and is not even in
`api/planned.ts`.**

**What Phase 1 and the last commit delivered and verified:** canonical intents, 34 decline
phrasings, `SemanticOptionDecision` (a selected option that is not in `availableOptions` fails
Zod), application-preset schema, structured location matching, phone dialling-code derivation,
autocomplete typing, adaptive waits. 369 unit/integration tests and 20 Playwright tests pass.

---

## 4. Root cause — "Apply with Agent" handoff failure

**There is no bug to fix. The feature was never implemented, on either side.**

| Piece                                        | Exists? |
| -------------------------------------------- | ------- |
| Website "Apply with Agent" button            | No      |
| Website session-creation call                | No      |
| `POST /application-sessions` on agent server | No      |
| `ApplicationSession` schema anywhere         | No      |
| Extension fragment reader / claim            | No      |
| Popup display of tailored documents          | No      |

What _does_ exist is a **different** handoff: Internship-AI's own extension authenticates to
`localhost:3000` with a token from `npm run extension:token`, posts a form description to
`/api/extension/fill-plan`, and injects its own "Autofill with Internship Pilot" button into
the page. That path works, but it belongs to the other agent and bypasses everything in this
repository.

So the observed failure is two systems that were never connected, plus a third partially-built
one competing for the same job.

---

## 5. Root cause — unknown and select questions are skipped

This is a precise, single-line cause in
[deterministicPlanner.ts:107-115](../extension/src/planner/deterministicPlanner.ts#L107-L115):

```ts
if (!match.matched || match.formattedValue === undefined) {
  if (match.requiresReview) return { ...base, action: 'manual_review' };
  return { ...base, action: match.sensitive ? 'missing_information' : 'skip' };
}
```

The chain that gets there:

1. `resolvedCanonical(field)` in `deterministicMatcher.ts` tries `canonicalKey`, then
   `semanticType`, then a 19-entry `LABEL_SYNONYMS` table. No match → `{ canonical: null }`.
2. `matchField` returns `unmatched(field, 'No deterministic field rule matched.')`.
3. `unmatched()` defaults **`requiresReview: false`** and **`sensitive: false`**.
4. The planner therefore returns **`action: 'skip'`**.
5. `classifyAction` files it under `skipped`; `approveSafeActions` cannot approve it; the
   executor never sees it.

**An unrecognized question is silently discarded before anything looks at it.** No AI is
consulted, no options are read, and the review screen shows it as skipped rather than as
something needing an answer. This applies identically to unknown dropdowns and unknown free
text.

The fix is not a bigger synonym table. It is that "unclassified" must route to the resolver as
an outcome in its own right, never to `skip`.

---

## 6. Root cause — available options are not opened and inspected

Option discovery happens in exactly one place: `selectComboboxOption()`, inside the executor,
**after** an action has been built and explicitly approved.

Consequences:

- `domScanner` reads options from the **static DOM only**. A custom combobox whose listbox is
  portal-mounted and rendered on open contributes `options: []` at scan time.
- The planner's deferred branch (`options.length === 0 && fieldType === 'combobox'`) is reached
  **only when `match.formattedValue !== undefined`** — that is, only when the field was already
  matched to a saved value. An unknown question fails at step 5 above and never arrives.
- Therefore a control's real choices are read only for questions that were already answered
  without needing them. **The one case where seeing the options actually matters — an
  unrecognized dropdown — is exactly the case where they are never read.**

There is no scan-phase pass that opens each control, records its real options, and closes it.
That is the missing capability, and it is what Phase C must add.

---

## 7. Root cause — the user is sent to a review page

Not a redirect to the website. It is the extension's own page:

- [popup/App.tsx:15-17](../extension/src/popup/App.tsx#L15-L17) —
  `openFillPlan()` calls `chrome.tabs.create({ url: chrome.runtime.getURL('fill-plan.html') })`.
- The popup renders **six** buttons: Analyze Application, Review Scan, Build Fill Plan, Review
  Fill Plan, Fill Approved Fields, Open Settings.
- "Fill Approved Fields" is disabled while `approvedCount === 0`, and every action is created
  with `approved: false`. The review page is therefore not optional — it is the only way to
  reach a non-zero approved count.

This is a deliberate Milestone-3 design ("only explicitly approved deterministic actions can
change fields"). Phase D changes _where_ approval happens, not whether it happens: approval
moves onto the application page itself as highlights, and the review page moves under Advanced
Diagnostics.

---

## 8. Current versus proposed workflow

**Current (Internship-Agent), 9 user steps:**

open popup → Analyze Application → Review Scan → Build Fill Plan → Review Fill Plan → approve
each action → Fill Approved Fields → read report → submit manually

**Current (Internship-AI), separate and parallel:** find job → generate documents → paste
extension token → press the injected "Autofill with Internship Pilot" → submit manually

**Proposed, 5 clicks:**

| #   | Where     | Click                              | What happens                                                                                                           |
| --- | --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Website   | select job                         | eligibility score shown                                                                                                |
| 2   | Website   | **Tailor Résumé and Cover Letter** | existing `generateDocumentsForJob`                                                                                     |
| 3   | Website   | **Apply with Agent**               | creates `ApplicationSession`, opens application URL with `#internship-agent-session=<id>`                              |
| 4   | Extension | **Autofill Application**           | claim → scan → classify → discover options → resolve → generate → fill → attach → verify → rescan → highlight → scroll |
| 5   | Page      | **Submit** (user, manually)        | never automated                                                                                                        |

Everything between steps 4 and 5 is internal. `submitted: z.literal(false)` and the
`CHECK (submitted = 0)` constraint stay exactly as they are.

---

## 9. Decision required before Phase E

`Internship-AI` is **not a Git repository** (~5,195 files). Its `.gitignore` covers `.env*`,
`/node_modules`, `/.next/` but **not `dev.db`**, and the folder holds `dev.db`, `dev.db.bak`,
three further `.bak` files, `probe.db`, and five `test-*.db` files. A naive `git init` plus
commit would capture real personal data. It needs `git init` with `*.db*` ignored first.

Second, and larger: **which agent fills forms?**

| Option                                                                                          | Consequence                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Internship-Agent fills; website discovers and tailors** (matches this repo's `CLAUDE.md`) | Retire the website's `extension/dist`, `browserAgent`, `formFiller`, `extensionFiller`, `adapters`, `navigation`, and `/api/extension/*`. Largest deletion, cleanest result. |
| **B — Keep both, gate by session**                                                              | Two extensions on one page; they will collide. Not recommended.                                                                                                              |
| **C — Website fills; retire this repository's executor**                                        | Discards the verified combobox, location, phone, and decline work.                                                                                                           |

I recommend **A**, but the deletion is substantial and not mine to make unilaterally.

---

## 10. Files needed per phase

### Phase B — taxonomy, presets, semantic resolver

_Modify:_ `shared/constants/questions.ts` (add `transgender`, `enrollment_status`, `cv`,
`achievements`, `leadership`, `teamwork`, `challenge`, `goals`, `technical_skills`,
`other_custom`; the rest of the Phase-4 list already exists under existing names —
`race_ethnicity`, `veteran_status`, `disability_status`, `medical_information`,
`salary_expectation`, `terms_attestation`, `why_this_company`, `why_this_role`,
`willing_to_relocate`, `earliest_start_date`, `job_board_source`, `how_did_you_hear`,
`pronouns`, `signature`) · `shared/constants/intents.ts` · `shared/logic/synonyms.ts` (add
"I don't wish to answer" contraction form) · `shared/logic/normalizeQuestion.ts` ·
`shared/schemas/semanticOption.ts` · `shared/schemas/profile.ts` (presets on the profile) ·
`agent-server/src/api/profile.ts` · `agent-server/src/database/migrations.ts` (append-only) ·
`extension/src/options/sections/` (presets UI).
_New:_ `shared/logic/presetLibrary.ts` · `tests/extension/presets.test.ts`.

### Phase C — live option discovery

_Modify:_ `extension/src/scanner/domScanner.ts` · `extension/src/content/index.ts` ·
`extension/src/executor/comboboxExecutor.ts` (export a discovery-only entry point) ·
`extension/src/planner/deterministicPlanner.ts` (**remove the `skip` fallback — this is the
Phase-5 root cause**) · `extension/src/matcher/deterministicMatcher.ts` ·
`shared/schemas/fields.ts` (`optionsDiscoveredAt`, `optionsComplete`).
_New:_ `extension/src/scanner/optionDiscovery.ts` · fixtures for Lever, Workday, Ashby,
multi-select, "mark all that apply" · `tests/extension/optionDiscovery.test.ts`.

### Phase D — one-button autofill and highlighting

_Modify:_ `extension/src/popup/App.tsx` (six buttons → one) ·
`extension/src/popup/usePopupState.ts` · `extension/src/background/index.ts` (orchestrator) ·
`shared/schemas/messages.ts` (`AUTOFILL_APPLICATION`) · `shared/schemas/settings.ts`
(`allowGroundedNonSensitiveGuesses`) · `extension/src/fill-plan/App.tsx` (move under Advanced
Diagnostics).
_New:_ `extension/src/autofill/orchestrator.ts` · `extension/src/content/highlighter.ts` +
`highlighter.css` · `extension/src/content/reviewNavigator.ts` ·
`shared/schemas/uncertainty.ts` · `tests/e2e/autofill-one-button.spec.ts`.

### Phase E — website profile source and session API

_Internship-Agent, new:_ `shared/schemas/applicationSession.ts` ·
`agent-server/src/api/applicationSessions.ts` · `agent-server/src/sessions/store.ts` ·
migration adding `application_sessions` · `extension/src/session/claimSession.ts` ·
`tests/server/applicationSessions.test.ts`.
_Internship-Agent, modify:_ `agent-server/src/api/index.ts` · `api/planned.ts` (register then
remove) · `shared/constants/errors.ts` · `extension/src/content/index.ts` (fragment read +
`history.replaceState`).
_Internship-AI, new:_ `src/lib/agentHandoff/client.ts` · `src/components/ApplyWithAgentButton.tsx` ·
`src/app/api/agent-handoff/route.ts` · presets and policy Prisma models + migration.
_Internship-AI, modify:_ `prisma/schema.prisma` · the job detail page.
_Blocked on:_ the two decisions in §9.

Accounts (Phase 1 of the product spec) are a much larger change than the rest — every model is
currently single-user with a singleton profile. If this stays a local single-user tool, that
phase can be dropped; if not, it needs its own gate.

---

## 11. Constraints that do not move

- No code path clicks Submit, Finish, Sign, Certify, or Agree and Submit.
- `application_runs.submitted` keeps `CHECK (submitted = 0)`; `applicationRunSchema` keeps
  `z.literal(false)`.
- The model never touches the DOM, never returns executable code, and every model response is
  Zod-validated before use.
- Content scripts make no network requests. The server binds `127.0.0.1` only.
- Protected traits come only from an explicit stored policy or an explicit user override —
  never from a name, résumé, location, school, nationality, or perceived hiring advantage.
- No handoff token in an external URL; no résumé text or profile data in query parameters.
