# Extension autofill audit

Audit performed before any code was changed. Every claim below names the file and
line range it came from, so the "before" state stays checkable after the rewrite.

## 1. Inventory of the active path

| Concern              | File                                                | State at audit time                                            |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Manifest             | `extension/manifest.json`                           | MV3, one content script, `all_frames: false`, no web-accessible resources, no `externally_connectable` |
| Service worker       | `extension/src/background/index.ts` (1213 lines)    | Message router. Owns scan → plan → approve → execute.           |
| Server client        | `extension/src/background/agentClient.ts`           | Only network client. Per-request `fetch`.                       |
| Content script       | `extension/src/content/index.ts`                    | Handles `SCAN_APPLICATION`, `EXECUTE_FILL_PLAN`, cancel.        |
| Handoff              | `extension/src/content/applicationSessionHandoff.ts`| Legacy: reads `#internship-agent-session` from the URL fragment.|
| Scanner              | `extension/src/scanner/domScanner.ts` (630 lines)   | Canonical scanner. Details in §3.                               |
| Adapters             | `extension/src/scanner/adapters.ts`                 | 9 adapters, but 5 are `supported: false` and add nothing.       |
| Label → question     | `shared/logic/normalizeQuestion.ts`                 | 80+ regex rules. Not exact-match only.                          |
| Matcher              | `extension/src/matcher/deterministicMatcher.ts`     | Canonical key → profile value.                                  |
| Planner              | `extension/src/planner/deterministicPlanner.ts`     | Builds `DeterministicFillAction[]`.                             |
| Executor             | `extension/src/executor/domExecutor.ts`             | Native setters, 2 attempts, verification.                       |
| Combobox executor    | `extension/src/executor/comboboxExecutor.ts`        | Open → read → match → click → verify.                           |
| Verifier             | `extension/src/verifier/domVerifier.ts`             | Re-reads DOM after each action.                                 |
| Popup                | `extension/src/popup/App.tsx` + `usePopupState.ts`  | Multi-step: Analyze → Build plan → Approve safe → Fill.         |
| Profile / documents  | agent server via `agentClient.ts`                   | Server-owned; no extension-owned document bytes.                |
| Tests                | `tests/extension/*`, `tests/e2e/*`                  | 20 extension suites, 5 Playwright specs.                        |

## 2. Root cause of the ~20 % fill rate

The low fill rate is **not** one bug. It is five independent gates, each of which
drops a large share of fields before anything is typed. In order of impact:

### 2.1 The one-button autofill engine is orphaned and the repository does not compile

`extension/src/autofill/orchestrator.ts` implements the full one-pass autofill
loop (scan → plan → generate → approve → execute → highlight, bounded at 5
iterations). It is referenced by **nothing except `tests/extension/autofillPolicy.test.ts`**:

```
$ grep -rn "runApplicationAutofill" extension/src
extension/src/autofill/orchestrator.ts:130:export async function runApplicationAutofill(
```

Worse, `shared/schemas/autofill.ts` — which defines `AutofillSettings`,
`ReviewReason`, `REVIEW_BADGES`, `applicationAutofillReportSchema` — is **not
exported** from `shared/schemas/index.ts`, and the 8 autofill error codes
(`AUTOFILL_DISABLED`, `AUTOFILL_CANCELLED`, `SCAN_FAILED`, `RESOLUTION_FAILED`,
`CAPTCHA_DETECTED`, `MFA_DETECTED`, `FINAL_SUBMISSION_STAGE`,
`MAX_ITERATIONS_REACHED`) are absent from `shared/constants/errors.ts`.
`npm run typecheck` fails with 28 errors in `orchestrator.ts`,
`approvalPolicy.ts`, `content/highlighter.ts` and `popup/App.tsx`.

A half-reverted refactor (commit `16e1e43` added it, `69daf93`…`f9435b3`
reverted the shared half) left the product on the **older multi-step path**:
Analyze → Build plan → Approve safe → Fill. `approveSafeActions()`
(`deterministicPlanner.ts:514`) only approves actions with
`confidence >= 0.8 && !requiresReview && !sensitive && source !== 'ai_suggestion'`.
Everything else is *planned* but never *executed*. This alone accounts for the
majority of unfilled-but-answerable fields.

### 2.2 No semantic layer runs in production — two implementations exist and neither is wired

- `shared/logic/unresolvedResolver.ts` (435 lines, 5-tier resolution incl. an AI
  suggestion tier) — referenced only by `tests/extension/unresolvedResolver.test.ts`.
- `shared/logic/semanticOptionResolver.ts` — referenced only by
  `tests/extension/semanticOptionResolver.test.ts`.

The production chain is `domScanner → matchCanonicalQuestion → matchField →
actionFor`. `resolvedCanonical()` (`deterministicMatcher.ts:137`) consults, in
order: `field.canonicalKey`, `field.semanticType`, then a **17-entry exact-string
map** `LABEL_SYNONYMS`. If the regex rules in `normalizeQuestion.ts` miss, the
only remaining chance is an exact normalized-string hit in that 17-entry map.
There is no similarity scoring, no alias expansion, and no model consulted.

Concretely: `matchCanonicalQuestion` has a rule for `/\b(legally )?authoriz(ed|ation) to work\b/`
but nothing matches *"Do you currently have permission to work in the country of
employment?"* or *"Can you provide evidence of employment eligibility?"*. Those
become `canonicalKey: undefined` → `missing_information` → never filled.

### 2.3 One model request per field, and only for prose

`agentClient.generateAnswer()` posts one `/ai/generate-answer` per field.
`generateAnswerBatch()` posts an array to `/ai/generate-batch`, but
`ctx.aiAnswers.generateBatch()` loops and issues one Ollama call per request —
it is a batched *transport*, not a batched *analysis*.

There is **no** page-level analysis endpoint at all. `POST /applications/analyze`
is registered in `agent-server/src/api/planned.ts` and answers **HTTP 501**.
So the model is only ever asked "write prose for this one textarea", never
"here are 40 questions and my saved facts — map them".

`isAiEligibleField` further restricts generation to long-form question types, so
short-answer and option fields never reach the model at all.

### 2.4 Approval policy blocks option controls and anything flagged for review

`decideApproval()` (`approvalPolicy.ts:68`) and `approveSafeActions()` both
require `!requiresReview`. The planner sets `requiresReview: true` for:

- every `combobox` whose options were not visible at scan time (`deterministicPlanner.ts:228`)
- every location match that did not confirm a region (`:255`)
- every `region_suffix` option match (`:288`)
- every `upload_file` action (`:132`, unconditionally)
- every field that already holds a different value (`:192`)
- every `profile` match with `confidence < 0.8`, which includes **every one of
  the 17 `LABEL_SYNONYMS` hits** (`MATCH_CONFIDENCE.synonym = 0.7`,
  `deterministicMatcher.ts:495`)

The last one is a silent trap: a synonym match is *correct* and still can never
auto-fill.

### 2.5 Control coverage gaps in the scanner

`CONTROL_SELECTOR` (`domScanner.ts:20`) is:

```
input:not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"]
```

Not scanned: `[role="listbox"]`, React-Select roots
(`.select__control`, `[class*="-control"]`), `button[aria-haspopup="listbox"]`,
`button[aria-expanded]` acting as a combobox trigger, `[role="radiogroup"]`
without native inputs, `[role="switch"]`, and custom date pickers whose visible
control is a `button`.

`optionsFor()` (`:239`) returns `undefined` for a `combobox` unless it carries
`aria-controls` pointing at an *already-rendered* listbox. Most ATS comboboxes
render their popover only on open, so options arrive empty and the planner
downgrades to `select_suggested_option` + `requiresReview: true` (see §2.4).

### 2.6 Field-context gaps sent downstream

`DetectedField` does capture label, help text, validation text, options, section
and required. It does **not** capture: `autocomplete`, `name`/`id` as separate
signals, the iframe path, the shadow-root path, sibling paragraph text beyond one
`previousElementSibling`, or nearby file-upload instructions. `frameUrl` is
stashed in free-form `metadata` and read by nothing.

## 3. Explicit checklist requested

| Symptom asked about                | Present? | Evidence                                                                                     |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| Exact-label-only matching          | **Partly** | Regex rules exist (`normalizeQuestion.ts`), but the fallback tier is a 17-entry exact map (`LABEL_SYNONYMS`). No similarity scoring anywhere. |
| Unsupported control types          | **Yes**  | React-Select, ARIA listbox, combobox trigger buttons, custom date pickers, `role="switch"` are not in `CONTROL_SELECTOR`. `contenteditable` is scanned but the planner returns `unsupported` for it (`deterministicPlanner.ts:159`). |
| Missing semantic analysis          | **Yes**  | `unresolvedResolver` and `semanticOptionResolver` are dead code; no AI analysis of short/option fields. |
| Missing option analysis            | **Yes**  | Options read only from `<select>`, radio/checkbox groups, and an already-rendered `aria-controls` listbox. |
| Missing iframe support             | **Partly** | `collectRoots()` walks same-origin `iframe.contentDocument`. Cross-origin frames are only *warned* about — `manifest.json` sets `all_frames: false`, so no content script runs in them. |
| Missing shadow-DOM support         | **No**   | `collectRoots()` walks open shadow roots (`:497`). Closed roots are unreachable by design. |
| Missing rerender handling          | **Partly** | `waitForDomSettled()` gives one 120 ms-quiet / 400 ms-max settle window and at most **one** rescan. There is no long-lived `MutationObserver`, so fields revealed after a click (Add Education, country change) are never picked up unless the user rescans. |
| Missing file handling              | **Yes**  | Uploads require a server-registered `SavedDocument`; there is no extension-owned document store, so tailored PDFs from the website cannot be attached. Only `resume` is ever matched (`deterministicPlanner.ts:123`) — no cover-letter branch exists. |
| Duplicate/conflicting fill engines | **Yes**  | (a) multi-step popup path — live; (b) `autofill/orchestrator.ts` — orphaned, does not compile; (c) `shared/logic/unresolvedResolver.ts` — orphaned. |
| Model request behavior             | One request **per field**, prose only. `/applications/analyze` returns 501. |
| Field context incomplete           | **Yes**  | See §2.6. |

## 4. Handoff architecture at audit time (to be replaced)

`POST /api/application-sessions` on the website → session row in the agent
server DB → `#internship-agent-session=<id>` appended to the employer URL →
`content/applicationSessionHandoff.ts` reads and strips it →
`APPLICATION_SESSION_CLAIM` → background calls the agent server to claim it.

Failure modes: requires the local agent server to be running before the
extension can do anything with a website job; leaks an opaque id through the
employer URL; and the extension has no document bytes of its own — it still has
to fetch them back through the agent server.

## 5. What must not be replaced

These are correct and stay:

- `executor/domExecutor.ts` native-setter + event + verify + one-retry loop.
- `executor/comboboxExecutor.ts` open → read → match → click → verify sequence.
- `verifier/domVerifier.ts` fingerprint check before acting.
- `shared/logic/normalizeQuestion.ts` regex rule table (extended, not replaced).
- `shared/logic/optionMatcher.ts` / `semanticOptionResolver.ts` decline-phrasing
  and polarity handling (wired in, not rewritten).
- Honeypot detection (`domScanner.ts:72`) and disabled-field skipping.
- The no-submit contract: `application_runs.submitted` `CHECK (submitted = 0)`,
  `submissionPrevented: z.literal(true)`.

## 6. Remediation plan (implemented in the commits that follow this file)

1. Make the repository compile: export `shared/schemas/autofill.ts`, add the
   8 missing error codes, fix `highlighter.ts` and `popup/App.tsx`.
2. Delete the ApplicationSession handoff from the extension; replace it with an
   origin-validated `window.postMessage` bridge into extension-owned IndexedDB.
3. One canonical scanner: widen `CONTROL_SELECTOR`, add a debounced
   `MutationObserver`, capture the full context list, record frame/shadow paths.
4. Normalized question model with `likelyIntent`, grouping radios and combobox
   trigger + popover into one question.
5. Batched page-level analysis: `POST /ai/analyze-form` (replaces the 501
   `/applications/analyze`), one request per page, validated fill plan.
6. Executor: bundle-backed uploads that tell résumé from cover letter.
7. Adapters for the remaining six ATS vendors, hints only.
8. Local test lab + tests for every claim above.
