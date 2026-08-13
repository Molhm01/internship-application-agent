# Forensic Final Verdict

Date: 2026-08-13 (America/New_York)

## Scope and evidentiary boundary

This verdict replaces the pre-council verdict. It incorporates all four council reports and independently checks their claims against the current production source at HEAD `63f0b063fcc4217b8a4db5642a6ce5d74f6e1e24`.

The default production route is Agent Mode:

`background/index.ts` `acceptAutofillRun` → `runAgentAutofill` → `background/agentController.ts` `runAgentApplication` → `agent/agentLoop.ts` `runAgentLoop` → content `executeAgentTool`.

The legacy whole-page pipeline runs only when both `developerMode` and `autofill.legacyWholePageAutofill` are true (`extension/src/background/index.ts:1628-1642`). It is not the repair target unless a live trace proves that setting was active.

Current provenance checks found:

- no production-source diff under `extension`, `shared`, or `agent-server`;
- Recovery HEAD is `63f0b06`;
- the server currently listening on `127.0.0.1:4317` is running `src/index.ts` through Recovery's TSX installation;
- the generated extension stamp names Recovery but is commit-stale (`51fee56+dirty.s3.20260813025212`);
- no Chrome/Chromium process is running, so the unpacked-extension path used by the normal browser profile is not currently observable.

The local `agent-run-evidence.json` is a localhost Lincoln fixture run, not a live SuccessFactors run. It cannot establish the real widget branch. Focused current-source tests passed (80/80), but those tests likewise prove behavior only for their modeled DOM shapes.

## Controlling conclusion

The current source does **not** support the theory that the production choice model invents `BS` or `New Jersey` and types it into a correctly classified dropdown. The wired model receives a trusted per-field answer plus actual, non-placeholder webpage choices and can return only an offered `optionId` or `ASK_USER` (`extension/src/agent/choiceMatcher.ts:151-197`; `agent-server/src/api/ai.ts:26-68`). Safety and the executor independently reject `type` on an observed option control (`extension/src/agent/agentSafety.ts:145-170`; `extension/src/agent/agentToolExecutor.ts:231-285`).

The source proves multiple reachable defects, but it does not prove which mutually exclusive branch the real Education Type and State/Province controls took. Therefore a unique live first incorrect transition cannot honestly be named from source alone. The exact conditional first transitions are identified below.

## Real production pipeline

| Transition | Production implementation | Verified result |
| --- | --- | --- |
| scanner → classification | `scanner/domScanner.ts` `scanDom`, `inferType`; then `agent/pageObserver.ts` `interactionTypeOf` | Two classifiers can disagree. The observer's `interactionType` governs tools. |
| classification → observation | `agent/pageObserver.ts` `observePage` | Emits `interactionType`, `dropdownState`, `optionsKnown`, current value, commitment, and validation state. |
| observation → options enumeration | `agent/agentDecision.ts` `decideDeterministically`; `agentToolExecutor.ts` `open_dropdown`; `dropdownOptionCollector.ts` `collectCustomOptions` | Native options are immediate. Custom controls are opened and fully enumerated, including scrolling/virtualization. |
| options enumeration → AI decision | `agentLoop.ts` re-observation; `pageObserver.ts` `optionsOf`; `choiceMatcher.ts` | Broken for virtualized custom lists: the full executor result is discarded and only the currently rendered slice is re-read. |
| AI decision → tool validation | `choiceMatcher.ts`; `agentSafety.ts` `checkDecision` | Sound option-ID membership checks. No arbitrary answer-text selection. |
| tool validation → actual option selection | `agentToolExecutor.ts` `select_option` | Native select uses `selectedIndex`; custom select clicks the registered current DOM node. Stale/missing IDs are rejected. |
| actual option selection → framework commit | `agentToolExecutor.ts` `clickActualOption`; employer widget handlers | Not guaranteed. Custom selection relies on generic synthetic pointer/mouse/click events and has no SuccessFactors-specific framework-state signal. |
| framework commit → verification | `pageObserver.ts` `holdsCommittedValue`, `validationErrorFor`, `commitmentOf`; `agentLoop.ts` `verify` | Broken for some custom controls: visible input text or absence of a discoverable backing store can be treated as commitment, and an error attached outside the scanned root can be missed. |

## Education Type: first incorrect transition

**LIVE FIRST TRANSITION: NOT PROVEN.** Two mutually exclusive current-source paths can produce the reported `BS` display while the employer still says Education Type is required:

1. If the live closed control is an editable `input[role=combobox]` without `aria-autocomplete=list|both`, `aria-haspopup`, or a resolvable popup, the first incorrect transition is **scanner → classification**. `domScanner.ts` `answersFromList` returns false and `inferType` emits `text`; `pageObserver.ts` `interactionTypeOf` reinforces it as `TEXT_INPUT`. The deterministic text pass can then legally issue `type("BS")`, skipping enumeration and selection entirely (`extension/src/scanner/domScanner.ts:541-584`; `extension/src/agent/pageObserver.ts:180-241`; `extension/src/agent/agentDecision.ts:249-265`).

2. If the live control is correctly classified and the trace shows a valid `select_option`, the first incorrect transition is **actual option selection → framework commit**. The exact observed option node was clicked, but the SuccessFactors backing form state did not accept it. The subsequent **framework commit → verification** transition is also unsafe because `holdsCommittedValue` accepts a closed non-empty input and returns true when it finds no backing store; `select_option` then reuses that same boolean as evidence that the option itself selected (`extension/src/agent/pageObserver.ts:643-674`; `extension/src/agent/agentToolExecutor.ts:581-605`).

A third classification shape exists: `domScanner.ts` can normalize a role-only button as `combobox`, while `pageObserver.ts` handles `HTMLButtonElement` before its generic ARIA-combobox branch and emits `BUTTON` when the lazy popup is absent. In that branch the first incorrect transition is **classification → observation**, and all dropdown tools are disabled (`extension/src/scanner/domScanner.ts:488-497,556-584`; `extension/src/agent/pageObserver.ts:220-239`).

Nothing in current source chooses among these live branches. The displayed string alone does not prove whether it was typed, produced by an option click, or accepted only in the widget's display layer.

## State/Province: first incorrect transition

### Personal-address State/Province

**LIVE FIRST TRANSITION: NOT PROVEN.** The source supplies `profile.personal.address.state`, filters disabled controls until Country enables them, and has an explicit New Jersey/NJ alias. A native `<select>` follows a complete and tested path. Therefore “State remains No Selection” does not by itself identify a source transition.

For a correctly classified custom/virtualized State menu, the earliest source-proven incorrect transition is **options enumeration → observation/AI decision**:

1. `collectCustomOptions` calls `enumerateAllOptions` and returns the complete scrolled list (`extension/src/dropdown/dropdownOptionCollector.ts:177-214`; `extension/src/scanner/optionDiscovery.ts:351-399`).
2. `agentToolExecutor.ts` returns those options from `open_dropdown` (`extension/src/agent/agentToolExecutor.ts:150-227`).
3. `runAgentLoop` immediately re-observes and does not carry `execution.options` into that observation (`extension/src/agent/agentLoop.ts:1389-1419`).
4. `pageObserver.ts` `optionsOf` calls only `readOptions(menu)` and registers the DOM rows visible at the restored scroll position (`extension/src/agent/pageObserver.ts:381-433`).

Thus the decision layer—and any choice-model request—can receive only the current rendered slice, not the complete list production just enumerated. If New Jersey is outside that slice, selection is impossible even though enumeration found it.

When re-observation has zero rows, `decideDeterministically` compounds the loss: it tests only `element.options.length === 0`, ignores `optionsKnown` and `dropdownState`, and retries `open_dropdown`/`get_options` until history exhausts the read action (`extension/src/agent/agentDecision.ts:297-322`). There is no distinct Agent Mode `OPTIONS_EMPTY` or `MENU_NOT_FOUND` escalation.

If the real State control is native, or New Jersey is already in the rendered slice, this handoff is not its first failure; the first failure would instead be classification, dependency activation after Country, menu discovery, or framework commitment. Current source cannot choose among those without the live trace.

### Education State/Province is a separate data problem

If “State/Province” means the education-section control, the first unsatisfiable transition is **observation/profile context → decision**. `trustedValuesFor` deliberately returns `undefined` for `state` and `country` in education sections (`extension/src/background/agentController.ts:104-111`), because `educationEntrySchema` has no country or state fields (`shared/schemas/profile.ts:84-110`). Production correctly classifies it as an unknown fact and will not guess. This is not an option-selection defect.

## Root causes ranked by confidence

These scores combine direct source proof with fit to the reported symptoms; they do not pretend that the absent live trace has already selected a branch.

### #1 — Complete custom-option enumeration is lost before choice (confidence 0.97)

The collector fully enumerates a long/virtualized list, but the loop discards that result, re-observation registers only currently rendered nodes, and the decider treats every zero-option state as “open it again.” This is an internally contradictory source path and the strongest explanation for custom State/Province and other long-list failures. It does not explain a native State control.

Files/functions: `extension/src/dropdown/dropdownOptionCollector.ts` `collectCustomOptions`; `extension/src/agent/agentToolExecutor.ts` `executeAgentTool` (`open_dropdown` and `select_option`); `extension/src/agent/agentLoop.ts` `runAgentLoop`; `extension/src/agent/pageObserver.ts` `optionsOf`; `extension/src/agent/agentDecision.ts` `decideDeterministically`.

### #2 — Custom selection commitment is not independently proven (confidence 0.94)

Custom execution sends a generic synthetic pointer sequence, then commitment can be inferred from the visible trigger input or from finding no known backing store. The executor uses that same weak commitment boolean as the fallback proof that the option selected, and outer verification consumes the same observer reading. This is capable of the exact `BS` visible + employer-required contradiction.

Files/functions: `extension/src/agent/agentToolExecutor.ts` `clickActualOption` and `executeAgentTool` (`select_option`); `extension/src/agent/pageObserver.ts` `holdsCommittedValue`, `validationErrorFor`, and `commitmentOf`; `extension/src/agent/agentLoop.ts` `verify`.

### #3 — Scanner and Agent control classifiers disagree (confidence 0.65)

A role-only input can become `TEXT_INPUT`; a role-only button can be scanner `combobox` but Agent `BUTTON`. Either classification prevents the correct open/read/select path and can make typing legal for the input shape. The defect is reachable, but the real closed Education Type and State nodes were not captured, so its live ranking is lower.

Files/functions: `extension/src/scanner/domScanner.ts` `shouldIgnore`, `answersFromList`, `isCustomCombobox`, and `inferType`; `extension/src/agent/pageObserver.ts` `interactionTypeOf`.

The education-location context gap has confidence 1.00 for **Education State/Province**, but it is kept outside this ranking because it does not explain personal State/Province or Education Type.

## Exact modification surface — do not patch yet

For the source-proven dropdown defects:

- `extension/src/agent/agentLoop.ts` — `runAgentLoop`: preserve the complete `open_dropdown/get_options` result across re-observation or replace it with an equivalent durable choice snapshot.
- `extension/src/agent/pageObserver.ts` — `optionsOf`: do not reduce a completed virtualized enumeration to the currently rendered slice; `holdsCommittedValue`, `validationErrorFor`, and `commitmentOf`: require positive backing/form acceptance rather than visible text or absence of evidence.
- `extension/src/agent/agentDecision.ts` — `decideDeterministically`: distinguish never-opened, menu-not-found, opened-empty, and searched-empty using `optionsKnown` and `dropdownState`; stop the blind reopen loop.
- `extension/src/agent/agentToolExecutor.ts` — `executeAgentTool` cases `open_dropdown`/`select_option` and `clickActualOption`: retain/reveal the chosen virtualized row and verify an independent committed framework state after the click.
- `extension/src/dropdown/dropdownOptionCollector.ts` — `collectCustomOptions`: return selection-usable enumeration state rather than diagnostics that the Agent loop throws away.

Only if the live trace proves classification is the first failure:

- `extension/src/scanner/domScanner.ts` — `shouldIgnore`, `answersFromList`, `isCustomCombobox`, `inferType`.
- `extension/src/agent/pageObserver.ts` — `interactionTypeOf`.

Only if product policy authorizes autonomous Education State/Province answers:

- `shared/schemas/profile.ts` — `educationEntrySchema`.
- `extension/src/options/sections/HistorySection.tsx` — the education-entry editor.
- `extension/src/background/agentController.ts` — `trustedValuesFor`.
- `shared/logic/profileAvailability.ts` — `describeProfileAvailability`.

Do not modify `extension/src/dropdown/dropdownEngine.ts` or `extension/src/executor/dropdownEngine.ts` for the default Agent Mode symptom unless the live trace proves the developer-gated legacy path ran.

## Final recommendation

PATCH NOW: NO

The exactly one missing live runtime fact is **one exported Agent Run Trace from a failing real SuccessFactors run containing the first Education Type and personal State/Province attempt**, so the existing `dropdown.controlType`, requested tool, option count, chosen option ID, click, commitment, validation, and verification fields identify which mutually exclusive transition actually failed.
