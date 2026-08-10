# Autofill runtime wiring audit

What actually happens when the user presses **Autofill Application** — traced from call sites and
imports, not from filenames — and what was found disconnected.

## 1. The production path, in execution order

| #   | Stage                 | File : symbol                                                                                                                                                                                                                                                                                           |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Button                | `extension/src/popup/AutofillPanel.tsx:487` — `onClick={() => void state.run()}`                                                                                                                                                                                                                        |
| 2   | Popup handler         | `extension/src/popup/useAutofillState.ts:211` — `run()` sends `RUN_APPLICATION_AUTOFILL`                                                                                                                                                                                                                |
| 3   | Worker message router | `extension/src/background/index.ts:2063` — `case 'RUN_APPLICATION_AUTOFILL'`                                                                                                                                                                                                                            |
| 4   | Run admission         | `extension/src/background/index.ts:1593` — `acceptAutofillRun()` (build check, one-run lock, acknowledges immediately)                                                                                                                                                                                  |
| 5   | Detached run          | `extension/src/background/index.ts:1675` — `runAutofill()` builds the dependency set                                                                                                                                                                                                                    |
| 6   | Orchestrator          | `extension/src/autofill/orchestrator.ts:448` — `runApplicationAutofill()`                                                                                                                                                                                                                               |
| 7   | Scan                  | `dependencies.scan` → `startScan` → content `SCAN_APPLICATION` → `scanner/scanApplication.ts`                                                                                                                                                                                                           |
| 8   | Repeater Engine       | `orchestrator.ts:1280` → `background/index.ts:1854 growRepeatedSections` → `repeatersAcrossFrames.ts:runRepeaterAutofill` → frame `RUN_REPEATER_AUTOFILL` → `repeaters/repeaterEngine.ts`                                                                                                               |
| 9   | Deterministic plan    | `dependencies.plan` → `planner/deterministicPlanner.ts`                                                                                                                                                                                                                                                 |
| 10  | Text stage            | `orchestrator.ts:1560` `applyPlan(plan,'deterministic')` → `dependencies.execute` → content `EXECUTE_FILL_PLAN` → `executor/domExecutor.ts`                                                                                                                                                             |
| 11  | **Dropdown Engine**   | `orchestrator.ts:1598` → `background/index.ts:1884 runDropdownStage` → `dropdownAcrossFrames.ts:217 runDropdownAutofill` → frames `DISCOVER_DROPDOWNS` / `RUN_DROPDOWN_DIRECTIVES` → `content/index.ts` → `dropdown/dropdownScanner.ts` + `dropdown/dropdownEngine.ts` → `dropdown/dropdownExecutor.ts` |
| 12  | **Dependency Engine** | `orchestrator.ts:1628` → `background/index.ts:1925 resolveDependencies` → `dependenciesAcrossFrames.ts:176 runDependencyResolution` → frame `RUN_DEPENDENCY_RESOLUTION` → `dependencies/dependencyEngine.ts` → `dependencies/dependencyExecutor.ts` → `dropdown/dropdownEngine.ts:runOneDropdown`       |
| 13  | Analysis (optional)   | `dependencies.analyze` → `analyzePlan`                                                                                                                                                                                                                                                                  |
| 14  | Final audit           | `orchestrator.ts` — `auditRequiredFields`, marks redrawn, `report()`                                                                                                                                                                                                                                    |
| 15  | Report to popup       | `saveAutofillReport` → popup polls `GET_AUTOFILL_RUN` / `GET_AUTOFILL_REPORT`                                                                                                                                                                                                                           |

Every stage from 8 onward goes through `withEngine(...)`, which marks both sides and **awaits** the
work in between.

## 2. What was disconnected

### Dropdown Engine — **was dead code**

- Definition: `extension/src/background/dropdownAcrossFrames.ts:217` (`runDropdownAutofill`), frame
  half in `extension/src/dropdown/dropdownEngine.ts` (`runDropdownDirectives`, `runOneDropdown`).
- Production call site **before repair**: none. The only importer of `runDropdownAutofill` in the
  entire repository was `tests/extension/dropdownAutofillEngine.test.ts`.
- Worse, the two messages it sends — `DISCOVER_DROPDOWNS` and `RUN_DROPDOWN_DIRECTIVES` — did not
  exist as message types at all: not in `shared/schemas/messages.ts`, not in
  `extension/src/messaging/messages.ts`, and with no handler in `extension/src/content/index.ts`.
  Even if something had called the pass, every frame would have failed to answer and every control
  would have been reported `CONTROL_NOT_FOUND`.
- Reachable from the popup before repair: **no**.

This is diagnosis **A + D** from the brief: the engine existed as dead code, _and_ its actions had
no route to the content-script executor. It explains the live symptom exactly. Dropdowns were driven
only by the ordinary plan → `executor/domExecutor.ts` → `executor/dropdownEngine.ts` path, which
reaches a menu only when the scan classified the control, the classifier recognised the question,
and the matcher produced a value. A control that fell out at any of those three steps did not fail —
it disappeared, which is why eight menus read "No Selection" with nothing in the report against them.

### Dependency Engine — was wired

- Definition: `extension/src/background/dependenciesAcrossFrames.ts:176`, frame half in
  `extension/src/dependencies/dependencyEngine.ts`.
- Production call site: `extension/src/background/index.ts:1944`, supplied as the orchestrator's
  `resolveDependencies` dependency and awaited at `orchestrator.ts:1628`.
- Reachable from the popup before repair: **yes**.

### Repeater Engine — was wired

- Definition: `extension/src/background/repeatersAcrossFrames.ts`, frame half in
  `extension/src/repeaters/repeaterEngine.ts`.
- Production call site: `extension/src/background/index.ts:1865`, supplied as `growRepeatedSections`
  and awaited at `orchestrator.ts:1280`.
- Reachable from the popup before repair: **yes**.

### Test-only code, named so it is not mistaken for production

`extension/src/dropdown/dropdownScanner.ts`, `dropdownMatcher.ts`, `dropdownQuestionResolver.ts`,
`dropdownOptionCollector.ts`, `dropdownVerifier.ts` and `dropdownExecutor.ts` were reachable only
through `dropdownEngine.ts` and `dependencyExecutor.ts`. The dependency path did reach them, so they
were partially live; the page-first pass over them was not.

Note that `extension/src/executor/dropdownEngine.ts` is a **different** module from
`extension/src/dropdown/dropdownEngine.ts`. The first is the per-action dropdown driver the fill
executor has always used; the second is the page-first Dropdown Engine. Both are production now.

## 3. What was changed

1. **Messages that did not exist.** `DISCOVER_DROPDOWNS` and `RUN_DROPDOWN_DIRECTIVES` added to
   `shared/schemas/messages.ts` and `extension/src/messaging/messages.ts`, with handlers in
   `extension/src/content/index.ts` that call the existing `scanDropdowns` and
   `runDropdownDirectives`. No new engine was written.
2. **The stage.** `runDropdownStage` added to `AutofillDependencies` and invoked from
   `orchestrator.ts` after the deterministic text stage and before the dependency stage, awaited.
3. **The supply.** `background/index.ts` now imports `runDropdownAutofill` and passes
   `runDropdownStage`. Without this the optional chaining reads `undefined` and the stage is skipped
   in silence — the same failure that once made `growRepeatedSections` a no-op in production while
   its tests passed.
4. **Result precedence.** `commitResult(fieldId, result, stage, observed)` in the orchestrator. A
   stage that did not look at a control may not overwrite a verification another stage obtained from
   the DOM, and an older observation may not overwrite a newer proof. The Dropdown Engine also
   declines to write a verdict at all for a control it had no answer for.
5. **Markers.** `ENGINE_MARKERS` and `engineInvocations` in `shared/schemas/runTrace.ts`, emitted by
   `withEngine`. Per field, `dropdownEngineCalled` and `dropdownExecutorCalled` distinguish "the
   engine reached this control" from "the DOM was driven".
6. **Completion assertion.** The run throws rather than completing while `enginesInFlight > 0`.
7. **Cancellation.** Checked before each engine, so a cancel stops the next one opening anything.
8. **A build gate.** `scripts/verify-engine-wiring.mjs`, run by `npm run verify:extension`, fails if
   any engine stops being reachable from the worker's import graph, stops being supplied to the
   orchestrator, stops being awaited, or stops being answered by the content script — and, when a
   build is present, if the shipped bundles lack the same wiring.

## 4. Convergence and honesty corrections found on the way

- The dropdown pass visits every menu on every pass, including ones it correctly leaves alone. Those
  visits were counted as progress, so the loop burned all five iterations on a form it finished in
  one. Only a control the pass actually _selected_ now counts.
- "Already valid" was decided from a field's first sighting, which for a control revealed by a
  parent is already after an engine filled it — so a State the run drove and verified reported that
  it had needed no work. It is now decided from the fields present in the very first scan.
- The engine's own `SKIPPED_ALREADY_VALID` is relative to the moment it looked, and on a later pass
  it looks at a control an earlier stage of the same run filled. That is no longer reported as
  skipped work.
