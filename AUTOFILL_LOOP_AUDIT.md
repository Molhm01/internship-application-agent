# Autofill loop audit

Traced against the live iCIMS account-creation failure: the popup shows
"Matching profile information", waits for minutes, changes nothing visible, and
returns to the same unresolved list.

## The path one click actually takes

| #   | Stage            | Code                                                                       | Notes                                                                                  |
| --- | ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Popup click      | `popup/useAutofillState.ts` `run()`                                        | sends `RUN_APPLICATION_AUTOFILL`, then polls `GET_AUTOFILL_RUN` every 700 ms           |
| 2   | Acceptance       | `background/index.ts` `acceptAutofillRun()`                                | writes run state, returns `{accepted, runId}` in ms, starts `runAutofill` **detached** |
| 3   | Orchestration    | `autofill/orchestrator.ts` `runApplicationAutofill()`                      | loops up to `MAX_ITERATIONS = 5`                                                       |
| 4   | Scan             | `dependencies.scan()` → `startScan()` → content script `scanApplication()` | phase `scanning`                                                                       |
| 5   | Plan             | `dependencies.plan()` → `background/index.ts` `buildPlan()`                | phase `resolving`                                                                      |
| 5a  | — deterministic  | `planner/deterministicPlanner.ts`                                          | fast                                                                                   |
| 5b  | — **batched AI** | `buildPlan()` → `analyzePage()` → `analyzeForm()`                          | **`timeoutMs` defaults to 60 000**                                                     |
| 6   | Approval         | `dependencies.approve()` → `mutatePlan()`                                  | phase `planning`                                                                       |
| 7   | Execute          | `dependencies.execute()` → `executeApproved()` → `executor/domExecutor.ts` | phase `filling`                                                                        |
| 8   | Verify           | `verifier/domVerifier.ts`, inside the executor                             | phase `verifying`                                                                      |
| 9   | Report           | `report()` + `auditRequiredFields()`                                       | written to run state                                                                   |

## Root cause 1 — the AI batch is inside the per-pass plan step

`analyzePage()` is called from `buildPlan()`. `buildPlan()` is what
`dependencies.plan(scan.id)` calls. The orchestrator calls
`dependencies.plan(scan.id)` **once per pass**, and the loop runs up to five
passes.

So one click can issue **up to five full batched AI requests over the same
page**, each with a 60-second ceiling. Nothing memoises the analysis, and
nothing compares the question set between passes — a pass that learned nothing
re-asks the model everything.

That is both the excessive delay and the "repeated full AI analysis":

```
worst case = 5 × 60 s AI + 5 × scan + 5 × execute ≈ 5+ minutes
```

The popup sits on `resolving` ("Matching profile information") for all of it,
because the AI call happens _inside_ the stage that emits that label. There is
no phase for "analyzing", so the label is honest about the stage and silent
about the wait.

## Root cause 2 — nothing guards against concurrent runs

`acceptAutofillRun()` does not check whether a run is already active. It
unconditionally mints a `runId`, calls `startRun()` — which **overwrites** the
stored run — and starts a second detached `runAutofill`.

`runAutofill` assigns `activeAutofill = state`, so the second run displaces the
first as the cancellation target. The first orchestrator keeps going, invisible
and uncancellable, writing to the same stored plan through `mutatePlan()`.

Two independent entry points make this reachable:

- a second click while the first run is in flight;
- `maybeAutoStart()` (armed by "Apply with Agent") calling `runAutofill(url)`
  directly — with no run record at all — concurrently with a user click.

The popup's own `running` flag is local React state, so a popup that is closed
and reopened mid-run shows an enabled button.

## Root cause 3 — failure is not distinguishable from "not attempted"

`report()` derives `failedFields` from `reviewReason === 'failed'`, which is only
set when the executor actually ran and returned `failed`. A field that never got
an executable action has `reviewReason: 'missing_information'` and lands in the
review list, but contributes to no failure count — hence
`Could not fill: 0` above a list of unresolved fields.

There is no per-attempt record carrying `attemptedAction` + `durationMs`, so the
report cannot say what was tried.

## Root cause 4 — the stale symptoms in the live list

`No option on the page matched Molhm`, the duplicated
`Highest Level of Education`, and `Addresses (1)* required.` as a question were
all fixed in the scanner/planner in the previous change. They persist in the
live run because **the built extension was never reloaded** — the fixes are in
`extension/src/`, and Chrome runs `extension/dist/`. Verified: the current
fixture scan produces 24 questions, no duplicates, no headings, and First Name
plans `fill_text`.

## Measured stage costs (iCIMS fixture, jsdom, no model)

| Stage              | Before                   | Notes          |
| ------------------ | ------------------------ | -------------- |
| scan               | ~160 ms                  | one pass       |
| deterministic plan | ~15 ms                   |                |
| AI batch           | 0–60 000 ms **× passes** | the bottleneck |
| execute            | ~40 ms/field             |                |

## What this audit changed

1. One run lock keyed on run id; a second click is refused, not queued.
2. An explicit run state machine with the stage names the popup shows.
3. The batched analysis is memoised per stable page fingerprint, so a pass that
   learned nothing makes no model call.
4. An abortable AI call with its own ceiling; on timeout the deterministic
   fields still fill and the run continues instead of looping.
5. Truthful per-attempt results, so the completion summary reconciles.
