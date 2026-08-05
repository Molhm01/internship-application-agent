# Full autofill diagnostic

Written before any code was changed, so that what follows is a record of the state
that produced the failure rather than a description of the repair.

## 1. The state this was written from

| Fact                    | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Source commit           | `bbe99dc` — _fix(autofill): a stage marker is not a verdict_ |
| Branch                  | `fix/unresolved-field-resolver`                              |
| Working tree            | Clean. Nothing unfinished needed a checkpoint commit.        |
| `extension/dist` stamp  | **`4e16cea`**, built `2026-08-04T02:12:10Z`                  |
| Test suite at `bbe99dc` | 1196 passed, 1 skipped, 71 files — **green**                 |

### The first finding, and it is the important one

`extension/dist` was produced from `4e16cea`. `HEAD` is `bbe99dc`. **The build
Chrome was loading was two commits behind the source**, and those two commits are
exactly the ones that fix what the live run got wrong:

- `87caef9` teaches the planner the control-type contract — the fix for
  _"No option on the page matched Molhm"_.
- `4e16cea` maps the experience section and stops the address filling it.
- `bbe99dc` stops a pending stage marker being rendered as a verdict — the fix
  for the eighteen cards reading _"is waiting on the page analysis"_.

Only the first of those three was in the bundle. So the browser was running code
that genuinely still had the reported bugs, while the repository's own test suite
— run against the source — was green. That is the whole shape of "different
source files, tests, dist builds, and browser runtime versions being out of sync".

Nothing in the extension could have revealed this: `BUILD_INFO` existed, but it
reached **only the popup**. The service worker and the content script — the two
components that actually scan, plan, and fill — carried no build identity at all,
so a stale `content.js` or `background.js` beside a fresh `popup.js` was
undetectable from inside the running extension. Phase 1 closes that.

## 2. Active runtime path

The path a click actually takes. Every entry here was confirmed by reading the
call, not inferred from the file name.

| Stage                    | Module                                                                                              | Entry point                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Manifest                 | `extension/manifest.json` → `extension/dist/manifest.json`                                          | —                                                  |
| Popup entry              | `extension/src/popup/main.tsx` → `App.tsx`                                                          | `popup.html`                                       |
| Popup run controller     | `extension/src/popup/useAutofillState.ts`                                                           | `run()` → `RUN_APPLICATION_AUTOFILL`               |
| Background worker entry  | `extension/src/background/index.ts`                                                                 | `background.js` (module worker)                    |
| Run acceptance           | `extension/src/background/index.ts`                                                                 | `acceptAutofillRun()`                              |
| Orchestrator             | `extension/src/autofill/orchestrator.ts`                                                            | `runApplicationAutofill()`                         |
| Content-script entry     | `extension/src/content/index.ts`                                                                    | `content.js`                                       |
| Scanner                  | `extension/src/scanner/domScanner.ts`                                                               | `scanDom()`                                        |
| Scan assembly / adapters | `extension/src/scanner/scanApplication.ts`, `adapters.ts`                                           | `scanApplication()`                                |
| Option enumeration       | `extension/src/scanner/optionDiscovery.ts`                                                          | —                                                  |
| Normalization            | `shared/logic/normalizeQuestion.ts`, `questionModel.ts`, `sectionContext.ts`, `questionIdentity.ts` | —                                                  |
| Deterministic matcher    | `extension/src/matcher/deterministicMatcher.ts`                                                     | `matchField()`                                     |
| Deterministic planner    | `extension/src/planner/deterministicPlanner.ts`                                                     | `buildDeterministicPlan()`                         |
| Action contract          | `shared/logic/actionContract.ts`                                                                    | `contractViolation()`, `repairActionFor()`         |
| AI planner (batched)     | `extension/src/analysis/formAnalysis.ts`                                                            | `buildAnalysisRequest()` / `applyAnalysisToPlan()` |
| AI transport             | `extension/src/background/agentClient.ts` → `agent-server/src/ai/*`                                 | `analyzeForm()`                                    |
| Approval policy          | `extension/src/autofill/approvalPolicy.ts`                                                          | `decideApproval()`                                 |
| Executor                 | `extension/src/executor/domExecutor.ts`                                                             | `executeDomAction()`                               |
| Combobox executor        | `extension/src/executor/comboboxExecutor.ts`                                                        | —                                                  |
| Account/credential fill  | `extension/src/background/accountForm.ts`, `accounts/accountExecutor.ts`                            | `fillAccountForm()`                                |
| Verification             | `extension/src/verifier/domVerifier.ts`                                                             | —                                                  |
| Run state (durable)      | `extension/src/storage/runState.ts`                                                                 | `startRun` / `recordState` / `finishRun`           |
| Popup result rendering   | `extension/src/popup/AutofillPanel.tsx`                                                             | —                                                  |
| Required-field audit     | `shared/logic/requiredFieldAudit.ts`                                                                | `auditRequiredFields()`                            |
| Coverage diagnostic      | `extension/src/autofill/coverage.ts`                                                                | `buildCoverage()`                                  |

There is **one** orchestrator, and it is the one above. `runApplicationAutofill`
is imported exactly once outside tests — by `runAutofill()` in the worker.

## 3. Duplicate and unused implementations

Checked specifically, because two competing pipelines is the failure mode this
diagnostic was asked to rule out.

| Candidate                             | Verdict                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `autofill/orchestrator.ts`            | **Active.** The only pipeline.                                                                                                                |
| `planner/deterministicPlanner.ts`     | **Active.** The only deterministic planner.                                                                                                   |
| `analysis/formAnalysis.ts`            | **Active**, and reached only from inside `buildPlan()` — not a second path.                                                                   |
| `executor/domExecutor.ts`             | **Active.** The only executor. `comboboxExecutor` is a strategy it calls, not a rival.                                                        |
| `accounts/accountExecutor.ts`         | **Active**, deliberately outside the plan: an employer password must never enter a stored, popup-visible `DeterministicFillPlan`.             |
| `fill-plan/App.tsx`, `review/App.tsx` | **Review surfaces**, not fill paths. They render and approve; they do not execute.                                                            |
| `answers/generatedActions.ts`         | **Active**, reconciles generated answers into the one plan.                                                                                   |
| `shared/dist/**`                      | Build output of `shared/`, committed. Not a second implementation, but it _is_ a second copy on disk and must be regenerated with the source. |

No duplicate planners, schemas, executors, or run-state implementations were
found. The competing-pipeline hypothesis is **not** the cause here.

## 4. Why only one or two fields filled

The confirmed mechanism, in order:

1. The bundle Chrome ran predated `4e16cea` and `bbe99dc`.
2. In that bundle, `enforceContract` did not yet rewrite an option action on a
   text control, so `First Name` was handed to the option-matching executor and
   answered _"No option on the page matched Molhm"_ — a text box searched for a
   list that does not exist.
3. In that bundle, the experience-section mapping was absent, so the one control
   that _did_ fill was `expLocation` with the applicant's own address — the
   "Clifton, NJ" that was the single visible success.
4. In that bundle, a pending stage marker was rendered verbatim, producing the
   eighteen _"is waiting on the page analysis"_ cards beside a summary claiming
   nothing had failed.
5. Nothing displayed a build identity for the worker or the content script, so
   every reload appeared to change nothing and the state was diagnosed as a code
   bug rather than a stale bundle.

The repository at `bbe99dc` already passes an end-to-end test that drives the
real scanner, real planner, and real DOM executor over the iCIMS fixture and
asserts on the fixture's own DOM values. What it did not have was any way to
prove the browser was running that code. That is the first thing repaired.

## 5. What was repaired, and what it measures

### The second root cause, found while building the gates

The stale bundle explains why earlier fixes appeared to do nothing. It does not
explain the twenty-seven-second wait, and that had a separate cause: **the one
batched model call lived inside `plan()`**. Nothing at all was written until the
model answered — including the two dozen fields the saved profile could fill in
under a second. When the analysis then failed or timed out, the page was still
blank and the run reported eighteen unresolved questions, which reads as "it
could not answer anything" rather than "it never tried".

The pass is now two stages: `plan()` is deterministic only, and `analyze()` runs
after those answers are written and verified on the page. An analysis that fails
now costs the user nothing they had already been given, and a run with no local
model at all fills the same profile fields it always could.

### Measured on the fixture, one click, no second click

| Measure                          | Value            |
| -------------------------------- | ---------------- |
| Raw controls matched             | 40               |
| Rejected as not questions        | 5                |
| Collapsed as duplicates          | 0                |
| Normalized questions             | 35 (15 required) |
| Filled and verified              | 26               |
| Correctly left blank (optional)  | 2                |
| Failed execution                 | 0                |
| Actions rejected by the contract | 0                |
| Grounded fields with no mapping  | 0                |
| Outstanding, by policy           | 5                |
| Passes                           | 3                |
| Wall clock                       | ~2.5 s           |

The five outstanding fields are outstanding **on purpose**, and each now says so
in its own words rather than blaming a stage that did not run:

- `Login`, `Password`, `Password Re-enter` — credentials never enter a stored,
  popup-rendered plan. The account path writes them from the vault, and only
  with explicit permission.
- `Resume` — an upload is never attached without approval.
- `I Agree to the Policies` — a consent is never ticked on anyone's behalf.

## 6. The second pass: what a real browser said that jsdom could not

Everything above was measured in jsdom, against the source. Section 5 closed by
saying a local fixture passing is not evidence about the browser. So the
acceptance gates were re-stated as a Playwright suite that loads
`extension/dist` in Chromium, opens the employer fixture, clicks the popup's own
**Autofill Application** button once, and reads the employer page's DOM —
`tests/e2e/autofill-acceptance.spec.ts`. Nothing in it imports from
`extension/src`.

The first real-browser run filled the page correctly and **reported one field
verified out of twenty-eight**. Three defects, all invisible from jsdom:

### A. A refusal was counted as an attempt

The content script returns one result per action in the plan, including the ones
it deliberately did nothing about: an unapproved action comes back `skipped`, a
`manual_review` action `needs_review`, an undriveable control `unsupported`. The
orchestrator treated any result as an execution outcome.

So: pass 1 filled and verified twenty-five fields. Pass 2 re-approved only the
one dependent control the page had just revealed; every other action came back
`skipped`, which read as *executed and not verified* — downgrading twenty-four
verified fields to failed. Pass 3 executed nothing, and rewrote those to
unverified. The page was correctly filled the entire time and the summary said
otherwise. `executorAttempted` was wrong for the same reason: the run trace
claimed the executor had been invoked on both password boxes, which it never
touches.

Fixed in `wasExecuted` in `autofill/orchestrator.ts`: only `verified`,
`filled_unverified`, and `failed` are attempts. The jsdom harness in
`acceptanceGates.test.ts` now returns a result for every action exactly as the
content script does — it previously returned results only for what it executed,
which is why the suite stayed green over this.

### B. "Documents uploaded: 0" beside two attached files

`documentsAttached` was in the report schema with a default of `0` and was never
assigned. The popup rendered that default under a heading claiming to count
uploads. It is now counted from the results that verified.

### C. The popup opened as a tab described itself

`readActiveTab` asked for the active tab in the current window. That is right for
a real popup, which floats over the page; opened as a tab it returns the popup's
own `chrome-extension://` page, and the panel read "No supported application form
detected on this page" about itself. It now falls back to the most recently
accessed http(s) tab when — and only when — the active tab is this extension's
own page.

### Measured in Chromium, one click, no second click

| Measure                              | Value                                    |
| ------------------------------------ | ---------------------------------------- |
| Raw controls matched                 | 41                                       |
| Rejected as not questions            | 5                                        |
| Normalized questions                 | 36 (15 required)                         |
| Filled and verified                  | 28                                       |
| Documents attached                   | 2 (tailored résumé and cover letter)     |
| Correctly left blank (optional)      | 2                                        |
| Failed execution                     | 0                                        |
| Outstanding, by policy               | 4 — login, both passwords, policy consent |
| Analysis requests                    | 1                                        |
| First saved value visible on the page| 451 ms                                   |
| Whole run, click to terminal state   | 3.8 s                                    |

## 7. What this diagnostic does not claim

It does not claim the live iCIMS page is fixed. A local fixture passing is not
evidence about a third-party page behind authentication, and the live page could
not be driven here: reaching it needs a real account, and the account-creation
step is exactly the one gated behind credentials and a policy agreement that the
agent will not supply on its own.

What replaces that evidence is the build gate and the run trace. The first makes
it impossible to repeat the mistake of testing one build and running another;
the second makes one live click self-describing.

### Clean reinstall

```bash
git pull
npm ci
npm run validate          # format, lint, typecheck, 1270 tests, full build
npm run verify:extension-runtime
```

`npm run build:extension` deletes `extension/dist` before every build, so a
stale chunk cannot survive one. Then, in Chrome:

1. `chrome://extensions` → Developer mode on.
2. **Remove** any existing copy of Internship Application Agent. This matters:
   the original failure involved an unpacked extension loaded from a _sibling_
   copy of the repository.
3. **Load unpacked** → `C:\Users\Molhm\Desktop\Internship-Agent\extension\dist`.
4. Open the popup and read the footer. It shows `Build <sha>.s<schema>.<time>`
   and the folder it was built from. Both must match this checkout.
5. **Reload any employer tab that was already open.** A tab open across an
   extension reload keeps the old content script; the run will now refuse rather
   than half-work, but reloading avoids the refusal entirely.

### Manual smoke test, and how to collect the evidence

1. Start the agent server (`npm run start:server`) and confirm the popup reports
   the agent and model as connected.
2. Open the employer application page and click **Autofill Application** once.
3. Watch the stage label. Within the first few seconds it must pass through
   _Filling saved answers_ and _Verifying saved answers_ — **before** it reaches
   _Analyzing custom questions_. Fields should be visibly changing during that
   first stage. If the form is still untouched when the analysis label appears,
   the ordering fix is not in the build being run: check the footer build id.
4. Let it finish. Read the summary, then open **Settings → Diagnostics**.
5. Press **Export run traces**. That file is the whole diagnosis: raw controls
   versus normalized questions, what was removed as not a question, what
   collapsed as a duplicate, what the contract accepted or repaired or rejected,
   what the executor was actually invoked for, what verified, how many analysis
   requests were made, and how long each stage took. It contains no field
   values, no credentials, no document contents, and no profile data — a test
   asserts that, and the schema is strict, so it is safe to attach to a report.
