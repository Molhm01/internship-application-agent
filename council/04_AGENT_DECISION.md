# Council Member 4 — Agent Decision Contract Investigation

## Scope and conclusion

Read-only source analysis of the current production Agent Mode path:

`background/index.ts` → `background/agentController.ts` → `agent/pageObserver.ts` → `agent/agentDecision.ts` / `agent/agentLoop.ts` → `agent/choiceMatcher.ts` → `agent-server/api/ai.ts` → `agent/agentSafety.ts` → `agent/agentToolExecutor.ts` → re-observation and verification.

The current production choice-model contract does **not** choose from answer text and does **not** receive a dropdown before real options have been observed. It receives the field question, one trusted candidate answer, and an allow-list of actual webpage `optionId`/label pairs. A selection must return one of those IDs. `type` on a correctly classified choice control is blocked twice: before execution and again in the executor.

This means the hypothesis “the current production option model freely decides `BS`/`New Jersey` and types it into the dropdown without seeing the webpage choices” is **not supported by current source**.

There are, however, two source-proven defects/gaps relevant to the live symptoms:

1. The decision loop conflates every zero-option state with “not opened yet.” It ignores `optionsKnown` and `dropdownState`, has no Agent Mode `OPTIONS_EMPTY` or `MENU_NOT_FOUND` branch, and simply retries `open_dropdown`/`get_options` until history exhausts the tool. Thus a menu the observer fails to recognize, and a menu genuinely opened with zero choices, receive the same ineffective fallback.
2. Education entries cannot store country or state. Production deliberately supplies no trusted answer for Education Country or Education State/Province, so no model or deterministic matcher is permitted to select them.

The known “Education Type visibly says BS while the site still says required” is a **selection-commitment/executor boundary symptom**, not proof of a bad option decision. Current source explicitly detects that state and must not count it complete.

## Required answers

### MODEL RECEIVES QUESTION: YES

Production builds `AgentChoiceRequest.question` from `element.label` in `extension/src/agent/choiceMatcher.ts:151-163`. The server sends the parsed request verbatim to the model in `agent-server/src/api/ai.ts:26-42`.

### MODEL RECEIVES PROFILE CONTEXT: YES

For the one field being decided, the request contains:

- `trustedAnswerAvailable`
- `trustedAnswer`, when present
- `fieldIntent`, when recognized

These are built from `ObservedElement.proposedValue`, which the background worker resolves from the saved profile/approved answers before decision in `extension/src/background/agentController.ts:72-204` and attaches in `agentController.ts:286-360`.

This is trusted **per-field candidate context**, not the entire profile.

### MODEL RECEIVES ACTUAL OPTIONS: CONDITIONAL

When the production choice model is called, **yes**: `choiceRequestFor` takes `element.options`, removes disabled choices and placeholders, and sends only `{ optionId, label }` pairs (`extension/src/agent/choiceMatcher.ts:151-163`). Those option handles were minted from live DOM option nodes by `extension/src/agent/pageObserver.ts:281-433`.

The condition is important: the choice model is not called on every decision or every dropdown. `decideWithChoiceFallback` calls it only after:

1. the deterministic decision has reached `ASK_USER/DROPDOWN_TARGET_NOT_FOUND`;
2. the field is `KNOWN_FACT`; and
3. `element.options.length > 0`.

Source: `extension/src/agent/agentLoop.ts:129-149`.

If exact/alias/bounded-semantic matching succeeds, the model is never called. If option discovery returns zero, the model is never called.

### WHEN OPTIONS ARE PROVIDED: both

- Native `<select>`, radio groups, and checkbox groups: options are readable in the initial observation, so they can be supplied without an `open_dropdown` action (`pageObserver.ts:281-378`).
- Custom/select-like controls: a closed observation contains no options; `open_dropdown` runs first, the menu is left open, and the **next observation** enumerates/mints option handles (`pageObserver.ts:381-433`; `agentToolExecutor.ts:150-227`).

Therefore the required categorical answer is **both**, with custom dropdowns specifically **after open**.

### CAN THE MODEL DECIDE AN ANSWER BEFORE OPTIONS ARE ENUMERATED: NO (production)

The narrow production model is `chooseAgentOption`, wired in `extension/src/background/index.ts:1747-1762`. Its request schema requires at least one choice (`shared/schemas/agent.ts:356-375`), and the caller refuses to invoke it when `element.options.length === 0` (`agentLoop.ts:145-149`).

Before custom options exist, the deterministic layer can decide only to call `open_dropdown`; it cannot choose an answer (`agentDecision.ts:300-322`).

There is an unused/general `AgentLoopHost.decide` extension point and a full-action prompt in `agentDecision.ts:443-542`. That schema can parse a premature tool proposal, but production wiring supplies `chooseChoice`, not `decide`. Safety would reject a premature `select_option` anyway.

### SELECT_OPTION REQUIRES optionId: YES

Operationally yes, at three boundaries:

1. The choice-model `SELECT` schema requires `optionId` or `optionIds` (`shared/schemas/agent.ts:379-410`).
2. Safety rejects `select_option` with no `optionId`, or an ID absent from the current observed options (`extension/src/agent/agentSafety.ts:257-295`).
3. The executor independently rejects a missing/unregistered/stale ID (`extension/src/agent/agentToolExecutor.ts:482-543`).

The generic `agentToolCallSchema` makes fields optional because it represents all tools, but this does not make a missing `optionId` executable.

### ARBITRARY ANSWER TEXT ACCEPTED BY SELECT_OPTION: NO

`AgentToolCall.value` is structurally allowed on the generic union-like tool object, including beside `select_option`, but selection never resolves by that text. With no valid `optionId`, safety/execution rejects the call. With a valid `optionId`, the executor ignores arbitrary `value` and clicks the DOM node registered to the ID. Therefore arbitrary answer text cannot cause a selection.

### CAN THE MODEL LEGALLY EMIT `type(dropdown, "BS")`: NO in the production model contract; structurally YES in the latent full-action schema

The actually wired choice model can emit only `{decision: SELECT|ASK_USER, optionId(s), confidence, reason}`. It cannot emit a tool at all (`shared/schemas/agent.ts:379-410`; `background/index.ts:1747-1762`).

The generic/full-action `agentDecisionSchema` does not encode tool/control compatibility, so a hypothetical `host.decide` model can produce `type` targeting a dropdown handle and pass schema parsing. That proposal is not legal to execute: `checkDecision` rejects it.

### TYPE ON DROPDOWN BLOCKED IN PRODUCTION: YES

Two independent locks exist:

1. Decision safety checks `ObservedElement.interactionType` against `OPTION_INTERACTION_TYPES` and returns `WRONG_TOOL_FOR_CONTROL_TYPE` (`extension/src/agent/agentSafety.ts:145-170`).
2. The executor recomputes live `interactionTypeOf(element)` immediately before writing and returns the same error without writing (`extension/src/agent/agentToolExecutor.ts:231-285`).

The sole typing exception is the separately observed `TEXT_INPUT` search box inside an open searchable menu. Typing there narrows choices and does not mark the dropdown answered (`agentSafety.ts:210-251`).

### CAN THE AGENT MARK A FIELD COMPLETED WITHOUT A COMMITTED REAL OPTION: NO in current source

`completed[]` is appended only when post-action verification is `VERIFIED` (`extension/src/agent/agentLoop.ts:1525-1527`). For a list control, verification fails if:

- the form still exposes a validation error;
- `selectionCommitted` is false;
- current value is empty; or
- the displayed selection does not match the chosen observed option.

Source: `agentLoop.ts:585-671`. The executor likewise returns `executed: false` when the exact observed node was clicked but the form did not commit it (`agentToolExecutor.ts:581-616`).

An exhausted field can be removed from the agent's actionable remainder and handed to the user, but it is not appended to `completed` and is not a verified success.

## Production decision-provider caveat

The known trace fact `decisionProviderCalled: true` does **not** prove the option LLM was called.

When AI generation is enabled, `host.chooseChoice` exists. `runAgentLoop` then labels the provider `model` on every cycle (`extension/src/agent/agentLoop.ts:1065-1067`) and sets `decisionProviderCalled = true` after `decideWithChoiceFallback` returns (`agentLoop.ts:1071-1084`), even when that function returned the deterministic decision without calling `chooseChoice`.

The authoritative per-field evidence is `step.dropdown.llmCalled`, populated from the precomputed `choiceLlmCalled` condition (`agentLoop.ts:1051-1057`, `1492-1503`). A trace with `decisionProviderCalled: true` and all relevant `dropdown.llmCalled: false` means no model ever received those choices.

## Deterministic matching order

Current Agent Mode matching is in `extension/src/agent/choiceMatcher.ts`:

1. **EXACT** — normalized equality.
2. **ALIAS** — explicit closed alias groups, including New Jersey/NJ, US spellings, bachelor/BS, selected employment-type aliases, and explicit Boolean aliases.
3. **SEMANTIC** — bounded display/decoration equivalence through `displaysSelection`; this is not free-form similarity.
4. **LLM** — only if the three deterministic levels return no unique match, the opened/current list is nonempty, and a trusted fact exists.
5. Otherwise **ASK_USER**.

There is **no fuzzy matcher** in the current Agent Mode path. Older dropdown modules contain other matching machinery, but the production Agent loop imports `matchActualChoice`, `choiceRequestFor`, and `validateModelChoiceDecision` from `agent/choiceMatcher.ts` (`agentLoop.ts:43-47`).

Ambiguous matches are rejected: more than one match at a level returns `UNKNOWN`, not the first result (`choiceMatcher.ts:124-133`).

### Verification that “No Selection” cannot answer “No”

Confirmed.

- `safeChoiceEquivalent` first calls `isPlaceholderSelection(offered)` and returns `UNKNOWN` before exact/alias/semantic logic (`choiceMatcher.ts:98-115`).
- `matchActualChoice` filters placeholder options out (`choiceMatcher.ts:118-133`).
- `choiceRequestFor` filters placeholders before the LLM request (`choiceMatcher.ts:151-163`).
- `displaysSelection` rejects placeholders before any comparison and disallows short substring containment (`shared/logic/selectionDisplay.ts:86-106`, `197-235`).

Thus “No Selection” cannot be selected, matched, sent as an LLM choice, or verified as “No” by current source.

## Exact fallback behavior

### WRONG_TOOL fallback: exact behavior

There is no automatic execution of `suggestedTool`.

If safety rejects a proposed action with `WRONG_TOOL_FOR_CONTROL_TYPE`:

1. no browser action runs;
2. a trace step is recorded with `executed: false`, `NOT_VERIFIED`, the rejection code, and `toolAllowed: false` for list controls;
3. the failed tool/label attempt is added to `AgentHistory`;
4. the page is re-observed;
5. the decider is called again;
6. after 12 total rejected actions the run blocks; a single tool/label also becomes exhausted after the shared repeated-failure threshold.

Source: `extension/src/agent/agentLoop.ts:1151-1260`; history behavior in `agentHistory.ts:52-90` and `178-210`.

If the page changes control type after validation and the executor itself returns `WRONG_TOOL_FOR_CONTROL_TYPE`, the normal post-execution path re-observes, records a nonverified failed attempt, and decides again. Again, no error-specific replacement tool is invoked.

In ordinary production this error can occur only if the observer misclassified the control as text, the DOM changed type between validation and execution, or a non-production/general decider supplied the action. The narrow choice model cannot request `type`.

### OPTIONS_EMPTY fallback: exact behavior

There is no `OPTIONS_EMPTY` error code in current source. The closest global code is `DROPDOWN_NO_OPTIONS_FOUND`, but Agent Mode does not emit it.

Current Agent Mode behavior for an opened/read operation returning zero choices is:

1. `collectCustomOptions` may return `opened: true, choices: []` after a 750 ms settle wait (`extension/src/dropdown/dropdownOptionCollector.ts:177-214`).
2. `open_dropdown` reports `executed: true` and no executor error when `opened` is true, even with zero choices (`agentToolExecutor.ts:204-227`).
3. The verifier converts zero `execution.options` to `NOT_VERIFIED` with `DROPDOWN_OPEN_FAILED` (`agentLoop.ts:756-768`), not `DROPDOWN_NO_OPTIONS_FOUND`.
4. History counts the open as a failed attempt.
5. Re-observation normally again exposes zero options.
6. `decideDeterministically` sees only `element.options.length === 0` and calls `open_dropdown` again (`agentDecision.ts:300-322`).
7. After repeated failure exhausts `open_dropdown` for that label, the dropdown pass skips the field. There is no choice-model call, no text fallback, and no direct `ASK_USER` produced by this branch.

### MENU_NOT_FOUND fallback: exact behavior

There is no `MENU_NOT_FOUND` error code in current Agent Mode or the shared error schema.

If `collectCustomOptions` cannot find/recognize a menu, it returns `opened: false, choices: []` (`dropdownOptionCollector.ts:181-190`). `open_dropdown` maps this to `executed: false`, `DROPDOWN_OPEN_FAILED` (`agentToolExecutor.ts:204-227`). The loop re-observes and retries the same open until history exhausts it. There is no keyboard/typing fallback in Agent Mode and no LLM call because no options exist.

The detailed collector diagnostics (`menuDetection`, `optionCandidates`) are not preserved by `ToolExecutionResult`; Agent Mode collapses menu-not-found and open-failed into the same outcome.

### TARGET_NOT_FOUND fallback: exact behavior

There is no bare `TARGET_NOT_FOUND` code. Current Agent Mode uses `DROPDOWN_TARGET_NOT_FOUND` when a nonempty observed list has no deterministic match (`agentDecision.ts:323-365`).

- With AI disabled: it becomes an `ASK_USER`, is queued, and the loop continues to other fields.
- With AI enabled: `decideWithChoiceFallback` first sends the question, trusted answer, and current real choices to the choice LLM. A valid returned ID becomes `select_option`; `ASK_USER` remains a queued question (`agentLoop.ts:129-193`).
- No branch types the desired answer into the dropdown.

### INVALID_OPTION fallback: exact behavior

Production has two boundaries:

1. **Server boundary:** if the model returns a `SELECT` ID outside the request choices, `agent-server/src/api/ai.ts:49-60` rejects the response with `INVALID_OPTION_ID`. The background wrapper then supplies an `ASK_USER` decision because `result.data` is absent (`extension/src/background/index.ts:1749-1759`). The extension queues the question and continues.
2. **Extension boundary:** if an invalid raw choice reaches `validateModelChoiceDecision`, it returns `INVALID_OPTION_ID` (`choiceMatcher.ts:170-197`). `decideWithChoiceFallback` deliberately constructs a selection call carrying `invalid-option-id` (`agentLoop.ts:150-162`); safety rejects it before execution, records the rejected action, re-observes, and decides again. This preserves the invalid-ID fact in the action trace rather than clicking anything.

If an ID becomes invalid/stale only at execution, the executor returns `INVALID_OPTION_ID` or `STALE_OPTION_REFERENCE`, the normal verification records no execution, and the next cycle re-observes. There is no answer-text fallback.

### Is there any fallback that turns desired answer text into typing: NO for the dropdown

The only related behavior is searchable-list narrowing: after a menu is open, the agent may type a trusted query into a separately observed search input (`searchInputId`). It must still select a real returned `optionId`, and typing the query does not complete the owner dropdown (`agentDecision.ts:328-351`; `agentSafety.ts:210-251`).

No fallback types `BS`, `No`, a state, or another desired answer into the dropdown itself.

## EDUCATION TYPE DECISION CHAIN

Exact current source path:

1. `extension/src/background/agentController.ts:286-360` calls `observeAcrossFrames`, resolves trusted values, and attaches `policy: KNOWN_FACT` plus `proposedValue`.
2. `extension/src/agent/pageObserver.ts:805-923` calls `scanDom`, finds the live element, and computes `interactionTypeOf` from behavior rather than scanner kind (`pageObserver.ts:180-218`).
3. The canonical intent is expected to be `education_type`; `trustedValuesFor` maps `education_type`/`degree` to `education.degree ?? education.degreeLevel` (`agentController.ts:154-163`).
4. Native options are observed immediately. A custom Education Type control initially has no options; `decideDeterministically` calls `open_dropdown`; the executor opens and reads it; the next observation mints current option IDs.
5. `matchActualChoice` compares the saved degree answer only against current real options: exact → alias (the explicit education alias group includes bachelor/BS) → bounded semantic (`choiceMatcher.ts:21-39`, `118-133`).
6. If matched, the local decider emits `select_option(elementId, optionId)` and the AI is not called.
7. If not matched, and the list is nonempty, the production AI input is:
   - `fieldType`: observed interaction type;
   - `question`: “Education Type”;
   - candidate context containing the trusted degree answer and `education_type` intent;
   - actual current non-placeholder, enabled `{optionId,label}` choices.
8. AI output can only be `SELECT` with an offered ID or `ASK_USER` (`agent-server/src/api/ai.ts:26-68`).
9. `validateModelChoiceDecision` and `checkDecision` enforce ID membership (`choiceMatcher.ts:170-197`; `agentSafety.ts:257-295`).
10. `executeAgentTool/select_option` resolves the registered exact DOM option node, clicks/selects it, and checks the form's commitment (`agentToolExecutor.ts:482-616`).
11. A fresh observation verifies `validationError`, `selectionCommitted`, nonempty current value, and displayed equivalence (`agentLoop.ts:585-671`). Only `VERIFIED` adds “Education Type” to completed.

**FIRST INCORRECT TRANSITION:** Current source alone cannot prove which transition occurred in the live run. For the specific observed state “trigger displays BS + Education Type is required,” if the current path did issue `select_option`, the first incorrect transition is:

`exact observed option node clicked` → **website did not commit that option to its backing form state**.

That is the executor/page boundary detected at `agentToolExecutor.ts:590-613`, not the AI input/output boundary. Current code returns `SELECTION_NOT_COMMITTED` and must keep the field incomplete.

If the live step instead shows requested tool `type`, the earlier incorrect transition is observation/classification: the control reached the decision layer as `TEXT_INPUT`, because current safety cannot allow `type` when the observation says it is a choice control.

There is a separate semantic risk: `trustedValuesFor` equates `education_type` with the saved degree (`agentController.ts:157-159`). Some forms use “Education Type” for institution kind rather than degree. Whether that mapping is wrong for this exact Lincoln menu cannot be established without the actual choices. The observed “BS” makes a degree taxonomy plausible, but visual text alone does not prove commitment or taxonomy.

## STATE DECISION CHAIN

### Home-address State/Province

Exact current source path:

1. Observation/classification follows the same `scanDom` → `interactionTypeOf` path.
2. `trustedValuesFor` maps canonical `state` to `profile.personal.address.state` outside the education section (`extension/src/background/agentController.ts:104-107`).
3. Before Country is selected, a disabled State control is excluded from the live decision set (`agentDecision.ts:218-221`).
4. Country is selected one action at a time. The loop re-observes.
5. Once State is enabled, a native list is immediately readable; a custom list first receives `open_dropdown`.
6. Current choices are matched exact → New Jersey/NJ alias → bounded semantic (`choiceMatcher.ts:21-25`, `118-133`).
7. Only after those fail can the LLM receive the State question, trusted answer, and actual current choices.
8. A valid offered `optionId` is checked by safety, executed against its exact DOM node, and verified after re-observation.

**FIRST INCORRECT TRANSITION:** Not provable from source plus “State remains No Selection.” The first failing transition must be one of:

- Country did not actually cause State to enable/populate;
- the State control was misclassified;
- `open_dropdown` could not find/recognize the menu;
- the post-open observer returned zero options and the decision loop entered its reopen cycle;
- a real State option was selected but not committed.

The model cannot be blamed without a trace step showing `dropdown.llmCalled: true`; if State never had a nonempty observed option list, the production LLM was never called for it.

### Education State/Province

The chain stops earlier. `trustedValuesFor` explicitly returns `undefined` for `state` in the education section (`agentController.ts:104-107`). `shared/logic/profileAvailability.ts:37-59,93-110` confirms that the education schema has no country or state field.

**FIRST INCORRECT/UNSATISFIABLE TRANSITION:** candidate/profile context construction. There is no trusted education-state fact, so production correctly classifies it as not agent-answerable and cannot legally select any option. This field requires a profile-schema/context change or user input; better option discovery alone cannot solve it.

## PRIMARY DECISION-LAYER ROOT CAUSE

**Exact description:** The choice decision uses `element.options.length === 0` as the sole test for “has not been opened,” ignoring `optionsKnown` and `dropdownState`. Consequently unopened, menu-not-found, and opened-empty controls all produce another `open_dropdown`/`get_options`; the choice LLM is never called, there is no `OPTIONS_EMPTY`/`MENU_NOT_FOUND` escalation, and history eventually exhausts the read tool.

**File:** `extension/src/agent/agentDecision.ts`

**Function:** `decideDeterministically`

**Relevant condition:** `if (element.options.length === 0) { ... return ACTION(open_dropdown|get_options) }` at `agentDecision.ts:300-322`; neither `element.optionsKnown` nor `element.dropdownState` is used to distinguish failure states.

**Confidence:** 97/100 that this defect exists in current source; 72/100 that it is the cause of the live State/Employment/Education no-selection cluster. Live causality needs the one trace observation specified below.

This root cause does **not** permit an invented answer. It prevents the decision layer from advancing to a real-option choice when discovery reports zero.

## SECONDARY ROOT CAUSE

**Exact description:** The trusted-context layer has no education country/state fact to provide. It explicitly suppresses home address country/state for education-section controls, because the education profile schema cannot store those fields. Therefore Education Country and Education State/Province cannot be autonomously answered, regardless of model quality or dropdown execution.

**File:** `extension/src/background/agentController.ts` (corroborated by `shared/logic/profileAvailability.ts`)

**Function:** `trustedValuesFor`

**Relevant conditions:**

- `case 'state': return element.section === 'education' ? undefined : address?.state;`
- `case 'country': return element.section === 'education' ? undefined : address?.country;`

at `agentController.ts:104-111`.

**Confidence:** 100/100 for Education Country/State. This is independently necessary to explain why those two controls remain unanswered; it does not explain home State, Employment Type, Education Type, or Graduated.

## The one exact runtime observation required

Current source cannot prove which live transition failed. Obtain **one exported Agent Run Trace from a failing run**, and inspect every `trace.steps[]` entry whose `targetLabel/question` is `Education Type` or `State/Province`. The required fields already exist:

`tool`, `errorCode`, `executed`, `verification`, and `dropdown.{controlType, knownAnswerAvailable, requestedTool, toolAllowed, rejectionCode, openAttempted, opened, menuFound, optionCount, matchingStrategy, llmCalled, optionIdChosen, actualOptionNodeFound, clickExecuted, displayedSelectionChanged, selectionCommitted, validationErrorPresent, verified, finalStatus}`.

One trace conclusively separates:

- classification failure: `controlType: TEXT_INPUT` / requested `type`;
- discovery failure: open attempted with `menuFound: false` or `optionCount: 0`;
- model involvement: `llmCalled: true`;
- invalid model choice: `INVALID_OPTION_ID` rejection;
- execution/commitment failure: actual node found/click attempted, followed by `selectionCommitted: false` and/or `validationErrorPresent: true`;
- successful committed selection: `verified: true`.

Without that single trace, any stronger claim about the live first failing transition would exceed what current source proves.
