# Autofill continuation audit

What is actually wired into the running extension, and why the popup showed
`Ready` / Cancel / 2-of-27 / 0s all at once.

## The active runtime

| Role                  | File                                                               | Wired in                     |
| --------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Popup entry point     | `extension/src/popup/useAutofillState.ts` → `run()`                | yes                          |
| Popup rendering       | `extension/src/popup/AutofillPanel.tsx`                            | yes                          |
| Background handler    | `background/index.ts` `acceptAutofillRun()` / `runAutofill()`      | yes                          |
| Run state             | `storage/runState.ts`                                              | yes                          |
| Orchestrator          | `autofill/orchestrator.ts` `runApplicationAutofill()`              | yes — the only one           |
| Deterministic planner | `planner/deterministicPlanner.ts` `buildDeterministicPlan()`       | yes, via `buildPlan()`       |
| Deterministic matcher | `matcher/deterministicMatcher.ts` `matchField()`                   | yes                          |
| AI planner            | `analysis/formAnalysis.ts` + `background/index.ts` `analyzePage()` | yes, inside `buildPlan()`    |
| Analysis memo         | `analysis/analysisMemo.ts`                                         | yes, scoped per run          |
| Executor              | `executor/domExecutor.ts` `executeDomAction()`                     | yes, via `executeApproved()` |
| Verification          | `verifier/domVerifier.ts` `verifyDomAction()`                      | yes, inside the executor     |
| Scanner               | `scanner/domScanner.ts` `scanDom()`                                | yes                          |

## Shared logic — connection status

| File                          | Reached from                                                     | Status |
| ----------------------------- | ---------------------------------------------------------------- | ------ |
| `logic/actionContract.ts`     | `deterministicPlanner.enforceContract()` **and** `domExecutor`   | wired  |
| `logic/sectionContext.ts`     | `domScanner.fieldFromElements()`                                 | wired  |
| `logic/degreeLevel.ts`        | `deterministicMatcher.profileValue()` (`highest_degree_awarded`) | wired  |
| `logic/discoverySource.ts`    | `deterministicPlanner.planAction()` (`how_did_you_hear`)         | wired  |
| `constants/extensionDom.ts`   | `domScanner.isExtensionOwned()` + `content/highlighter.ts`       | wired  |
| `logic/questionIdentity.ts`   | `domScanner.scanOnce()` dedup + `QuestionLedger`                 | wired  |
| `logic/requiredFieldAudit.ts` | `orchestrator.report()`                                          | wired  |

No partial file is orphaned. There is exactly one autofill implementation.

## Why the popup showed `Ready` at 2/27 with 0s elapsed

One function, `useAutofillState`'s mount effect. It adopted a run that was
already in flight — the case that exists because "Apply with Agent" auto-starts
one — and did only this:

```ts
if (existing.progress) setProgress(existing.progress);
if (existing.status === 'running') setRunning(true);
```

Three consequences, which are the three symptoms:

1. **`Ready`** — `runState` was never set, so it stayed at its `'IDLE'` initial
   value, whose label is `Ready`. The primary button rendered
   `RUN_STATE_LABELS[runState]`.
2. **`0s`** — `startedAt` was set only inside `run()`. An adopted run never went
   through `run()`, so `startedAt` stayed `null` and the clock had nothing to
   subtract from.
3. **Cancel stuck at 2/27** — no polling was started. `progress` was copied once
   and never again, and nothing ever observed the run reaching a terminal state,
   so `running` stayed `true` forever. Cancel is drawn from `running`.

The `2/27` itself is honest: the run really did record 27 results and verify 2.
It stopped there because the remaining 25 were `missing_information` /
`manual_review` — correctly classified, but the popup never got to show the
summary that would have said so.

## Fixes applied

1. `adopt()` copies **every** field of the worker's run into the popup, and
   `follow()` polls to a terminal state. Both the click path and the adoption
   path use them, so the two can no longer diverge.
2. `startedAt` and the new `completedAt` are worker timestamps. The clock reads
   `Date.now() - startedAt` while running and `completedAt - startedAt` after,
   so it survives the popup closing and freezes when the run ends.
3. Cancel, the progress bar, the timer and the primary button are all derived
   from `runState` alone. `IDLE` is not in `ACTIVE_RUN_STATES`, so `Ready`
   beside a live Cancel button is unconstructible.
4. `run()` sets `SCANNING` synchronously before the accept round trip, so there
   is no window in which a starting run reads as idle.
5. Cancel now aborts an `AbortController` threaded into `analyzeForm`, so it
   reaches an in-flight model call instead of waiting for the next phase.
6. The orchestrator backfills a status for any scanned field that produced no
   action, so a run cannot finish with unaccounted questions.
7. `assertOneQuestionPerField` throws if two normalized questions claim the same
   field — the regression that produced a duplicated education dropdown.
8. The planner's generic `No saved answer applies to "X" yet` is gone; a field
   the deterministic pass could not settle now says which stage it is waiting
   on, and only a question nobody may reason about is described as needing the
   user.
