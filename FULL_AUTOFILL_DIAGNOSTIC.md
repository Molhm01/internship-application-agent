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

## 5. What this diagnostic does not claim

It does not claim the live iCIMS page is fixed. A local fixture passing is not
evidence about a third-party page behind authentication. The manual smoke test
and the run-trace export exist for exactly that reason.
