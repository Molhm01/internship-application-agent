# Council Member 3 — Dropdown DOM Execution Investigation

**Scope:** current working tree at commit `63f0b06`; source-only, read-only forensic review. No production code was changed.

## Executive finding

The current default button path is Agent Mode:

`background/index.ts:1636-1641` → `runAgentAutofill` → `runAgentApplication` → `runAgentLoop` → `AGENT_EXECUTE_TOOL` → `executeAgentTool`.

The older whole-page pipeline still exists but is selected only when both `developerMode === true` and `autofill.legacyWholePageAutofill === true` (`extension/src/background/index.ts:1636-1641`; the latter setting defaults false in `shared/schemas/autofill.ts:77`). It uses the separate `dropdown/*` engine. A third implementation, `executor/dropdownEngine.ts`, remains callable from `domExecutor.ts`, but the wired legacy whole-page run defers option actions to the dedicated `dropdown/*` stage.

The default Agent Mode has strong option-ID and stale-node guards. It does **not** successfully execute `select_option` from free text or from an invented/missing option ID. The unresolved correctness defect is later: custom-control commitment can be inferred from the visible trigger input itself. A closed, non-empty input is treated as backing commitment even when it is only a search/display string. That inferred commitment is then used both as proof that an option is selected and as proof that the form kept it.

This is sufficient to produce the live contradiction:

`trigger.value === "BS"` → `commitment.committed === true` → `select_option.executed === true`, while SuccessFactors' actual model remains empty and the form still regards Education Type as required—particularly if the error is not attached to the exact scanned root through native validity, `aria-errormessage`, or `aria-invalid`.

---

## OPEN DROPDOWN PATH:

### Default Agent Mode

1. `decideDeterministically` sees an outstanding option control with `element.options.length === 0` and emits `open_dropdown` (`extension/src/agent/agentDecision.ts:300-320`).
2. `checkDecision` permits `open_dropdown` only for `DROPDOWN_INTERACTION_TYPES` (`extension/src/agent/agentSafety.ts:364-375`).
3. `executeAgentTool`, `case 'open_dropdown'`, resolves the current element by observation handle, reclassifies it from the live element, then:
   - native `<select>` → `collectNativeOptions`;
   - custom/selectable input/button/div → `collectCustomOptions(element)`.
   See `extension/src/agent/agentToolExecutor.ts:150-223`.
4. `collectCustomOptions` calls `openControl(resolveTrigger(root))`, enumerates the opened menu, waits once for an asynchronously filled empty menu, and leaves it open (`extension/src/dropdown/dropdownOptionCollector.ts:177-215`).
5. `openControl` (`extension/src/scanner/optionDiscovery.ts:775-875`) tries, in order:
   - an already-associated open popup;
   - for autocomplete **only when search text was supplied**, `typeSearchNarrowing`;
   - `pressPointer(trigger)`;
   - ArrowDown `KeyboardEvent`s;
   - `typeSearchNarrowing` when a `searchText` argument exists and the trigger is an input;
   - mutation-based structural-menu discovery;
   - a declared but empty `aria-controls`/`aria-owns` container.
6. `pressPointer` dispatches synthetic `pointerdown`, `mousedown`, `pointerup`, `mouseup`, then calls `target.click()` (`extension/src/scanner/optionDiscovery.ts:672-678`).

Important default-path fact: Agent Mode calls `collectCustomOptions(element)` **without** a search string (`agentToolExecutor.ts:197`). Therefore an autocomplete that creates no list container until text is entered can fail discovery before Agent Mode can expose a separate search-input handle.

### Developer-gated whole-page path

`runOneDropdown` → `attempt` → `collectNativeOptions` or `collectCustomOptions(root, directive.searchText)` (`extension/src/dropdown/dropdownEngine.ts:139-222`). Here `openControl` may type `directive.searchText` into the trigger as part of opening.

### Open failure/empty result

- No container: `collectCustomOptions` returns `opened: false`, no choices. Agent Mode returns `DROPDOWN_OPEN_FAILED` and `executed: false` (`agentToolExecutor.ts:207-224`).
- Container found but empty: collector returns `opened: true`, zero choices. Agent Mode reports `executed: true` at executor level because the container opened, but loop verification rejects the read because `execution.options.length === 0` (`extension/src/agent/agentLoop.ts:756-768`).
- Agent Mode retries the same `open_dropdown` until `AgentHistory.exhausted` reaches the repeated-failure ceiling; it never converts the desired answer into a selection fallback (`agentDecision.ts:310-320`, `agentHistory.ts:215-216`).
- The developer-gated engine reports `OPEN_FAILED`, `NO_OPTIONS_FOUND`, or `DEPENDENT_CONTROL_NOT_REFRESHED`; it does not select or claim verified (`extension/src/dropdown/dropdownEngine.ts:224-266`).

---

## GET OPTIONS PATH:

### Default Agent Mode

`get_options` shares the executor branch with `open_dropdown` (`agentToolExecutor.ts:150-223`).

- Native select: reads `Array.from(select.options)` via `collectNativeOptions`; no browser popup is needed.
- Radio/checkbox group: reads already observed group inputs through `optionsOf`.
- Custom control: physically opens and collects exactly as above, then `get_options` closes it with Escape/outside-pointer/blur (`agentToolExecutor.ts:201-203`; `optionDiscovery.ts:912-929`).

Options are created only from DOM nodes:

- native: actual `HTMLOptionElement`s;
- ARIA/menu: visible `[role="option"]`, `[role="menuitem"]`, `[role="menuitemradio"]`, or `[role="menuitemcheckbox"]` nodes (`optionDiscovery.ts:299-310`, `451-454`, `499-516`);
- role-less menu: mutation-scoped structural candidates (`structuralMenu.ts`).

The result returned by `open_dropdown/get_options` includes generated handles, but the authoritative selectable references are minted on the fresh post-action observation. `optionsOf` stores the actual node, owner, label, value, index, element handle, and observation ID in the registry (`extension/src/agent/pageObserver.ts:280-432`). Handles are `element::observation-token::option::index` (`pageObserver.ts:446-467`).

### Structural option target caveat

For role-less menus, `STRUCTURAL_OPTION_SELECTOR` includes `li,button,a,...`, and `outermost()` removes a candidate contained by another candidate (`extension/src/scanner/structuralMenu.ts:54-55,164-167,201-209`). Thus markup such as `<li><button>BS</button></li>` registers/clicks the outer `li`, not the inner interactive `button`. This is an exact branch where the enumerated “option node” can be a wrapper rather than the framework's event-owning node.

---

## SELECT OPTION PATH:

### Default Agent Mode

1. A choice is selected only after an observation exposes options. Deterministic matching returns one of those option handles; the optional model fallback also returns only an `optionId`, and its response is checked for membership in the exact offered list (`extension/src/agent/choiceMatcher.ts:151-205`; `agentLoop.ts:129-202`).
2. Safety rejects:
   - wrong control type;
   - zero observed options;
   - missing `optionId`;
   - any `optionId` not in the current observation.
   See `extension/src/agent/agentSafety.ts:257-295`.
3. Executor repeats the checks. `staleOption/currentOption` rejects an earlier observation ID, wrong owner, disconnected node/owner, changed native index, or changed label (`extension/src/agent/agentToolExecutor.ts:98-121,482-562`).
4. Native select branch (`agentToolExecutor.ts:563-568`):
   - assign `element.selectedIndex = reference.node.index`;
   - dispatch `input`, `change`, synthetic `blur` through `dispatchValueEvents`;
   - call real `element.blur()`.
5. Custom/selectable-node branch (`agentToolExecutor.ts:569-571`):
   - `clickActualOption(reference.node)`;
   - scroll/focus node;
   - dispatch the synthetic pointer/mouse sequence and `.click()`.
6. The executor waits up to 1200 ms for either a checked input or `commitmentOf(field, true)` to say the list control is committed, then performs its own commitment check (`agentToolExecutor.ts:572-613`).

### What `select_option` does not do in Agent Mode

- It does not accept label text as the selection argument.
- It does not create an option from desired text.
- It does not write desired text into the dropdown trigger.
- It does not write a search input inside the `select_option` case.
- It does not successfully mutate without a current registered option node.
- It refuses stale references rather than trying to rediscover by label.

### Searchable combobox path

Search is a separate `type` action, not `select_option`:

- Observer exposes an open menu's search input as `ownerHandle::search` (`pageObserver.ts:835-842`).
- If an open dropdown has offered options but none matches, `decideDeterministically` emits `type(searchInputId, element.proposedValue)` (`agentDecision.ts:326-348`).
- Safety allows it only while its owner is open and only when the query is the trusted intended answer or a permitted narrowing of it (`agentSafety.ts:211-250`).
- Executor uses the native input setter and dispatches generic `Event('input')` and `Event('change')`; it does not dispatch `InputEvent` or character `KeyboardEvent`s (`agentToolExecutor.ts:288-301`).
- This action verifies only that the search input holds the string. It intentionally does not select an option.

There is an ordering defect when the menu is open but contains zero visible results: `decideDeterministically` checks `element.options.length === 0` before the searchable branch, so it emits `open_dropdown` again instead of typing into the exposed search input (`agentDecision.ts:310-348`).

### Text-driven legacy selection

The developer-gated `dropdown/*` engine has no option-ID contract. It matches `directive.intendedAnswer`/alternatives against enumerated labels and values, then locates the live node by `data-value` or normalized `textContent` (`dropdownMatcher.ts`; `dropdownExecutor.ts:107-122`). This is label/value-based selection, although it still clicks an enumerated DOM option when it proceeds.

The older `executor/dropdownEngine.ts` likewise receives `desiredSemanticValue`, matches by text, and locates the option by value/label. Its custom precheck synthesizes a one-entry in-memory option list from the control's already displayed text and can return success without opening or clicking (`extension/src/executor/dropdownEngine.ts:485-497`). In the currently wired whole-page pipeline this execution path is displaced by the dedicated dropdown stage, but the production module remains callable.

### Stale references

- Agent Mode: stored node references exist between observation and action, but every material stale condition is checked and returns `STALE_OPTION_REFERENCE`; no label fallback is attempted.
- Dedicated legacy engine: the collector passes a container reference into `executeCustom`. The first click lookup and keyboard fallback can use that same container; unlike Agent Mode, there is no observation token. A remount can therefore produce a stale-container attempt, normally ending as click/verification failure.
- Older executor engine: prefers `findListbox(trigger)` but falls back to the collector's stored `container` (`executor/dropdownEngine.ts:595`).

---

## VERIFY PATH:

### Native select

Native verification is materially stronger than custom verification:

- Agent executor requires the referenced `HTMLOptionElement.selected`, then `commitmentOf` requires non-empty `select.value`, valid `selectedIndex`, and a non-placeholder selected label (`agentToolExecutor.ts:591-600`; `pageObserver.ts:643-647`).
- Outer loop re-observes the page after execution and requires no validation error, `selectionCommitted === true`, non-empty current value, and display equivalence to the chosen label (`agentLoop.ts:586-670`).
- Dedicated legacy verifier requires three facts to agree: `select.value`, `select.selectedIndex`, and `select.selectedOptions[0] === target` (`dropdown/dropdownVerifier.ts:38-56`).

All native implementations notify with generic `input` + `change` events and a synthetic blur; Agent Mode additionally calls `element.blur()`. None constructs an `InputEvent`.

### Custom select — default Agent Mode

`holdsCommittedValue` checks, in order (`pageObserver.ts:643-674`):

1. nested native `<select>`;
2. checked radio/checkbox;
3. `input[type="hidden"][name]` non-empty;
4. any descendant marked `aria-selected=true`, `aria-checked=true`, or `data-selected=true`;
5. closed trigger with `aria-activedescendant`;
6. **closed visible input trigger with non-empty `trigger.value`;**
7. **if none of those structures exists, return `true`.**

Branches 6 and 7 are not backing-state evidence. Branch 6 is visible/search text. Branch 7 is absence of evidence treated as commitment.

`select_option` then defines a custom node as selected when its own ARIA marker is true **or `commitment.committed` is true**, and defines success as `selected && commitment.committed && !commitment.saysUnanswered` (`agentToolExecutor.ts:591-605`). Because `selected` falls back to the same `commitment.committed`, one weak input-text reading supplies both nominally separate proofs.

The outer verifier re-observes, but it consumes the same `selectionCommitted` calculation. It therefore does not add an independent backing-state read. It does reject a validation error when one is found (`agentLoop.ts:617-670`).

Validation discovery is conditional (`pageObserver.ts:560-634`):

- native constraint validation always counts;
- `aria-errormessage` counts when it yields unanswered wording;
- `aria-describedby` and nearby error nodes count only when the **scanned element itself** has `aria-invalid="true"`.

If SuccessFactors marks an inner trigger, sibling wrapper, or remote field container rather than the exact scanned root, the visible “Education Type is required” can be missed. In that situation `saysUnanswered` remains false and the weak commitment fallback can pass.

### Custom select — developer-gated legacy engine

The legacy verifier is display-only. `verifyDisplayedSelection` calls `readSelectedText` and approves `displaysSelection(text, optionLabel/value)` (`dropdown/dropdownVerifier.ts:71-84`). `alreadyDisplays` uses the same display read and can return `SKIPPED_ALREADY_VALID` before the menu is opened (`dropdownVerifier.ts:120-122`; `dropdownEngine.ts:167-185`).

`readSelectedText` returns `trigger.value` before inspecting hidden values or selected markers (`scanner/optionDiscovery.ts:130-177`). Thus a typed search string can satisfy both the “already answered” precheck and post-click verification with no backing selection proof.

The older `executor/dropdownEngine.ts` repeats this display-only pattern in `keyboardSettled`, the custom precheck, and `holdsAnswer` (`lines 346-352, 485-497, 657-724`).

### Timing

No verifier requires the selection to remain stable for a minimum interval. Agent Mode's `waitFor` returns on its first truthy read, and native DOM mutation is truthy immediately. The outer re-observation is a second task/message round-trip and is better evidence, but it can still precede a delayed framework rollback. Legacy display verification similarly returns as soon as the desired text appears.

---

## Exact desired-answer → type paths

**Yes, such paths exist.**

1. **Default Agent Mode search branch:** `extension/src/agent/agentDecision.ts`, `decideDeterministically`, when an opened searchable dropdown has visible options but no match and exposes `searchInputId`, emits `type` with `value: element.proposedValue` (`lines 326-348`). This is trusted profile/approved-answer text, not raw choice-model prose, and it targets the search input rather than `select_option`.
2. **Older executor fallback:** `extension/src/executor/dropdownEngine.ts`, `executeCustomDropdown`, sets `searchText = input.searchText ?? input.desiredSemanticValue` (`line 509`), passes it to `openControl`, and later retries `typeSearchNarrowing(trigger, candidate)` for `desiredSemanticValue` and alternatives when no option matched (`lines 552-576`).
3. **Shared open fallback:** `extension/src/scanner/optionDiscovery.ts`, `openControl`, when `(autocomplete && searchText)` or `(searchText && trigger instanceof HTMLInputElement)`, calls `typeSearchNarrowing`; `typeSearch` writes through `HTMLInputElement.prototype.value` and dispatches `input/change` (`lines 602-612, 792-799, 828-835`).
4. **Developer-gated dedicated engine:** `dropdownEngine.attempt` passes `directive.searchText` to `collectCustomOptions` unless user confirmation is required (`dropdown/dropdownEngine.ts:214-222`). This is not an implicit fallback to `intendedAnswer` in that engine; it types only the separately resolved `searchText`.

---

## Required DOM primitive census

### Writes capable of changing dropdown-visible state

- Direct `.value =`: no dropdown executor uses it. Production direct assignments are the unrelated account-field writer (`content/index.ts:209`) and an options-page file input clear (`options/sections/DocumentsSection.tsx:190`). Dropdown/search writes use prototype setters instead.
- `input.value`: read for radio labels/values and current state; critically read as selected text (`optionDiscovery.ts:136`) and as custom commitment (`pageObserver.ts:672`).
- `textContent =`: only extension UI/highlighter style/badge rendering (`content/highlighter.ts:96,215,218`), not employer dropdown selection.
- `innerText =`: no production occurrence.
- `InputEvent`: no production construction/use.
- `dispatchEvent`: dropdown-relevant uses are generic `input/change/blur`, pointer/mouse open/select sequences, ArrowDown/Enter/Escape keyboard sequences, and outside-pointer close. No custom option branch dispatches an explicit post-selection `input` or `change`; it relies on the option node's click handlers.
- `KeyboardEvent`: ArrowDown to open/walk, Enter to commit keyboard fallback, Escape to close. Search typing does not emit character key events.
- `.click()`: `pressPointer` ends with `target.click()`; Agent Mode generic click/navigation and unrelated upload/navigation/download code also call `.click()`.
- `mousedown` / `pointerdown`: only the shared pointer driver and outside-close path are dropdown relevant (`optionDiscovery.ts:672-678,926-927`).
- `selectedIndex`: Agent Mode assigns it for native selection (`agentToolExecutor.ts:566`); all native verifiers read it.
- `HTMLSelectElement`: native classification, enumeration, prototype value setter, selected-index/value verification, dependency scanning, and DOM verification. It is never given arbitrary non-option text by Agent Mode.
- `aria-selected`: read when enumerating choices, locating active/highlighted rows, inferring custom commitment, and judging whether a clicked custom option says it selected itself.
- `role=option`: first-choice option selector; actual role node is clicked.
- `role=listbox`: primary menu-container selector and custom listbox classification.

### Framework-event conclusion

Native select emits the conventional `input` and `change` events. Custom select emits only synthetic pointer/mouse/click events on the chosen candidate and relies entirely on the widget's listener topology. There is no SuccessFactors-specific event, no `InputEvent`, no native-setter synchronization for a custom widget's hidden backing input, and no confirmation that a framework model changed. This does not prove which exact SuccessFactors listener was missed, but it proves the executor has no event-level evidence beyond the visible DOM reaction.

---

## Nine requested determinations

1. **Writes desired text into a visible input:** `select_option` itself: **NO** in Agent Mode. Search paths: **YES**, separately, as listed above.
2. **Writes into a combobox search input and treats that as selection:** **YES under a concrete state transition.** The `type` action initially verifies only the search box; if typing closes or makes the popup undiscoverable, `holdsCommittedValue` branch 6 treats the retained trigger value as owner commitment on the next observation.
3. **Modifies visible text without clicking a real option:** Agent `select_option`: **NO**; search `type` and legacy already-display paths: **YES**.
4. **Synthesizes an option instead of using an enumerated DOM option:** Agent Mode: **NO**. Older `executor/dropdownEngine.executeCustomDropdown`: **YES**, the already-visible one-entry pseudo-list at lines 485-497.
5. **Selects via label text rather than optionId:** Agent Mode: **NO**. Both legacy engines: **YES**.
6. **Uses stale option references:** Agent Mode stores references but rejects them before use. Legacy container references can become stale and are not observation-token guarded.
7. **Fails to dispatch the framework event SuccessFactors expects:** **POSSIBLE and structurally unverified.** Custom selection sends generic synthetic pointer/mouse/click only; no framework-state event is checked.
8. **Clicks wrapper instead of actual option node:** **YES for the role-less structural branch** where `outermost()` keeps an `li` and discards its nested interactive button/link. ARIA-role options click the role node.
9. **Reports execution success before backing state changes:** **YES.** Custom success can be derived from visible trigger text; all waits accept the first truthy state and require no stable framework-state interval.

---

## Required binary answers

### CAN MODEL-GENERATED TEXT REACH A DROPDOWN INPUT: YES

Exact paths/conditions:

- `extension/src/agent/agentDecision.ts`, `decideDeterministically`, opened searchable dropdown + no deterministic match + exposed search input → `type(searchInputId, proposedValue)` (`326-348`). `proposedValue` can come from an approved answer; raw live choice-model output cannot, because the production model fallback returns only validated option IDs.
- `extension/src/executor/dropdownEngine.ts`, `executeCustomDropdown`, `searchText` absent → fallback to `desiredSemanticValue`, then `openControl/typeSearchNarrowing` (`509-511,552-576`). This is the non-default/legacy executor path.
- `extension/src/scanner/optionDiscovery.ts`, `openControl`, autocomplete or post-click input with `searchText` → `typeSearchNarrowing/typeSearch` (`602-612,792-799,828-835`).

**Qualification:** unapproved arbitrary model prose cannot reach the default Agent Mode dropdown. The reachable text is a trusted/approved answer or a narrowing of it.

### CAN A SEARCH STRING BE MISTAKEN FOR A COMMITTED SELECTION: YES

Exact paths/conditions:

- `extension/src/agent/pageObserver.ts`, `holdsCommittedValue`, trigger is a visible input, popup is no longer discoverable, `trigger.value` is non-empty, and `aria-expanded !== "true"` (`663-672`).
- `extension/src/scanner/optionDiscovery.ts`, `readSelectedText`, any non-empty input trigger value wins before backing/selection markers (`130-136`), consumed by `dropdown/dropdownVerifier.verifyDisplayedSelection` and `alreadyDisplays` (`71-84,120-122`).

### CAN select_option RUN WITHOUT A REAL optionId: NO

For a successful/default Agent Mode DOM selection, no. The schema makes `optionId` optional syntactically, so malformed calls can be invoked and fail, but safety rejects a missing/nonmember ID (`agentSafety.ts:281-294`) and the executor independently rejects missing, stale, unregistered, wrong-owner, disconnected, index-changed, or label-changed references (`agentToolExecutor.ts:98-121,495-543`). No option DOM mutation occurs on those paths.

The developer-gated legacy dropdown engine is text-driven and has no option-ID protocol, but it is not the Agent Mode `select_option` tool. The older `domExecutor` action named `select_option` is deferred in the currently wired legacy run.

### CAN EXECUTION SUCCEED WITHOUT BACKING SELECTION CHANGE: YES

Exact path/condition:

- `extension/src/agent/agentToolExecutor.ts`, `case 'select_option'`, custom node has no checked/selected marker, so `selected` falls back to `commitment.committed`; `commitment.committed` came from closed non-empty trigger text or the no-known-store default; no detected unanswered validation error (`591-605`, fed by `pageObserver.ts:643-674`). Result: `executed: true` without independent backing state.
- Developer-gated legacy `dropdown/dropdownVerifier.verifyDisplayedSelection` and `alreadyDisplays` return verified from display text alone (`71-84,120-122`).

### CAN VERIFICATION PASS FROM VISIBLE TEXT ALONE: YES

Exact paths/conditions:

- Default Agent Mode: `holdsCommittedValue` input-trigger fallback or final `return true`, followed by the custom `selected` fallback to the same commitment and an undetected form error (`pageObserver.ts:663-674`; `agentToolExecutor.ts:591-605`; outer verification `agentLoop.ts:617-670`).
- Developer-gated legacy: `verifyDisplayedSelection`/`alreadyDisplays` consume `readSelectedText`; input trigger value is the first custom read (`optionDiscovery.ts:130-136`; `dropdownVerifier.ts:71-84,120-122`).
- Older executor engine: custom already-visible pseudo-option, `keyboardSettled`, and `holdsAnswer` all use display equivalence (`executor/dropdownEngine.ts:346-352,485-497,657-724`).

---

## PRIMARY EXECUTOR ROOT CAUSE:

**Custom dropdown commitment is not actually a backing-state test.** `holdsCommittedValue` treats a closed non-empty trigger input—or total inability to locate a backing store—as committed. `select_option` then reuses that same weak boolean as both “the option is selected” and “the control committed it.” The outer verifier reuses the same observation logic, so it is not independent. This directly permits visible `BS` + employer-required/empty state.

## SECONDARY ROOT CAUSE:

**The custom interaction has no guaranteed framework-owning target/event.** Role-less structural discovery can select an outer wrapper instead of its nested interactive child, and custom execution relies on generic untrusted pointer/mouse/click events with no post-click framework-state signal. The first visible text reaction is accepted immediately, with no stability interval. In the developer-gated legacy engine this is compounded by explicitly display-only verification.

## CONFIDENCE:

**High (0.94)** that visible-text-based commitment/verification is a present code defect capable of the exact symptom. **Medium (0.72)** that the initiating SuccessFactors failure is specifically wrapper/event targeting rather than a vendor-side delayed rollback, because no captured live SuccessFactors DOM/event trace was included in this investigation.
