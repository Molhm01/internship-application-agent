# Control Classification Investigation

## Finding

The SuccessFactors adapter does not have a SuccessFactors-specific field scanner. `BrowserAdapter.scan()` in `extension/src/scanner/adapters.ts:131-141` calls the same `scanDom()` used by every adapter. Agent Mode does not call the selected adapter at all when it observes fields: `observePage()` calls `scanDom()` directly at `extension/src/agent/pageObserver.ts:805-818`. The adapter contributes ATS detection and final-submit wording, not control semantics.

The current source contains a real classification split:

1. `scanDom()` can normalize a role-only button as `fieldType: "combobox"` because `isCustomCombobox()` accepts `role="combobox"` (`domScanner.ts:488-497`, `556-584`).
2. The Agent observer reclassifies the same live node independently in `interactionTypeOf()` (`pageObserver.ts:180-241`). Its `HTMLButtonElement` branch runs before its generic ARIA-role branch and returns `CUSTOM_SELECT` only when `opensOptionList()` succeeds; otherwise it returns `BUTTON` (`pageObserver.ts:220-223`). A closed, lazily mounted button with `role="combobox"`, but without `aria-haspopup` and without a currently resolvable option container, is therefore normalized as a dropdown and then authoritatively downgraded to `BUTTON`.
3. A second failure shape exists for wrappers containing an editable `<input>`. If the outer wrapper does not match the scanner's known choice-root selectors, the inner input becomes the field. Unless that input itself has `aria-autocomplete="list|both"`, `aria-haspopup`, or `aria-controls` resolving to an actual option list, `isTypedTextControl()` wins before `isCustomCombobox()` and normalizes it as `text` (`domScanner.ts:541-560`). `interactionTypeOf()` then also returns `TEXT_INPUT` (`pageObserver.ts:185-217`). In that branch, typing is permitted and dropdown tools are refused.

Current source proves both defects are reachable. It does **not** contain a current live SuccessFactors DOM snapshot or current Agent observation showing which exact branch Education Type and State/Province take on Lincoln Electric now.

## End-to-end type path and every mutation point

| Stage | File/function | What happens to control semantics |
| --- | --- | --- |
| ATS adapter | `scanner/adapters.ts` `BrowserAdapter.scan` | No vendor classification. SuccessFactors delegates to `scanDom`. |
| Candidate selection | `scanner/domScanner.ts` `CONTROL_SELECTOR`, `shouldIgnore` | Chooses the DOM node that represents the field. It suppresses an inner input only when an ancestor matches a recognized React-select or ARIA choice root (`281-325`). Disabled native inputs/selects/textareas and any node with `aria-disabled="true"` are removed here rather than emitted as disabled fields. A custom button carrying only the native `disabled` attribute is not removed by this code. |
| Scanner type | `scanner/domScanner.ts` `inferType` | Creates normalized `fieldType`: `select`, `combobox`, `text`, or `unknown` (`556-617`). This is the first type assignment. |
| Normalized field | `scanner/domScanner.ts` `fieldFromElements` | Writes that result unchanged to `DetectedField.fieldType` (`1151-1215`). `detectedFieldSchema` validates but does not reinterpret it (`shared/schemas/fields.ts:193-230`). |
| Agent coarse kind | `agent/pageObserver.ts` `kindOf` | Coarsens `select`, `combobox`, and `multi_select` to Agent `kind: "dropdown"`; text-like field types become `kind: "text"` (`133-155`). |
| Agent authoritative type | `agent/pageObserver.ts` `interactionTypeOf` | Reclassifies from the live DOM independently of `fieldType`. This produces `TEXT_INPUT`, `NATIVE_SELECT`, `CUSTOM_SELECT`, `SEARCHABLE_COMBOBOX`, `BUTTON`, or `UNKNOWN` (`180-241`). This value, not `kind`, governs tools. |
| Open searchable menu | `agent/pageObserver.ts` `optionsOf`, `observePage` | The owner remains an option control, but its menu input is emitted as a second Agent element with `interactionType: "TEXT_INPUT"` and `searchInputFor` (`381-433`, `832-843`, `951-975`). This is the only intended text path inside a dropdown. |
| Safety allowlist | `agent/agentSafety.ts` `checkDecision` | Refuses `type` for every option interaction type (`157-170`), requires an opened/current option for `select_option` (`254-295`), and permits `open_dropdown` only for the three dropdown interaction types (`363-373`). |
| Execution-time recheck | `agent/agentToolExecutor.ts` `executeAgentTool` | Calls `interactionTypeOf()` again immediately before open, type, and selection (`150-180`, `231-292`, `482-560`). A DOM mutation can therefore change the effective type between observation and execution. |
| Separate dropdown pass | `dropdown/dropdownScanner.ts` `isDropdownLike` / `describeControl`; `executor/dropdownEngine.ts` `classifyDropdown` | Uses a separate taxonomy (`native_select`, `aria_combobox`, `searchable_combobox`, etc.). It is not the Agent's authoritative type. It can classify a role-only button as `aria_combobox` while Agent Mode classifies the same closed button as `BUTTON`. |
| Legacy option discovery | `scanner/optionDiscovery.ts` `controlTypeFor` | Yet another taxonomy (`native_select`, `combobox`, `autocomplete`, etc.), derived from both normalized field type and live DOM (`573-596`). It does not control Agent tool permission. |

### Effective Agent tool matrix

| Authoritative `interactionType` | `type()` | `open_dropdown` | `select_option` |
| --- | --- | --- | --- |
| `TEXT_INPUT` | Yes, for a trusted value | No | No |
| `NATIVE_SELECT` | No | Yes; options are already observable | Yes, with a current observed `optionId` |
| `CUSTOM_SELECT` | No | Yes | Yes, after current options are observed |
| `SEARCHABLE_COMBOBOX` | No on the owner; yes only on its separately emitted search element | Yes | Yes, after a real result is observed |
| `BUTTON` | Not rejected by the option-type rule alone, but the deterministic text pass will not choose it and the executor rejects typing into a non-input | No | No |
| `UNKNOWN` | No usable deterministic path | No | No |

## Wrapper containing an `<input>`

The scanner does try to prefer an outer choice control:

- An input beneath `[role="combobox"]`, `[role="listbox"]`, or a recognized React-select root is discarded by `shouldIgnore()` (`domScanner.ts:298-315`).
- A recognized outer root is then scanned as the field.

That protection is conditional on the wrapper matching the hard-coded root shapes. An unrecognized SuccessFactors wrapper plus an inner `input[role="combobox"]` leaves the input as the candidate. Role alone is deliberately insufficient for an editable input: `answersFromList()` recognizes only `aria-autocomplete=list|both` or `opensOptionList()` (`domScanner.ts:549-553`). When the list is lazy and absent while closed, the input becomes `fieldType: "text"` and Agent `TEXT_INPUT`.

The dedicated dropdown scanner does not rescue this exact shape. `isDropdownLike()` calls `isTypedTextControl()` first and drops the editable input as non-dropdown (`dropdown/dropdownScanner.ts:122-136`). Because dropdown seeds are created only from normalized option fields (`background/dropdownAcrossFrames.ts:105-113`), a main scan that called it `text` supplies no seed either.

## EDUCATION TYPE

**scanner source:** SuccessFactors `BrowserAdapter.scan()` -> generic `scanDom()` for the ordinary scan; Agent observation independently calls the same `scanDom()` directly.

**DOM/control assumption:** The repository's prior live-markup audit (`DROPDOWN_REPEATABLE_ROOT_CAUSE.md:23-37`) describes a non-native wrapper with an inner button carrying `role="combobox"`, with options inserted only after opening. That document is secondary evidence, not a current DOM capture. Under that shape, the scanner selects the inner role-bearing button. A current SuccessFactors variant exposing an unrecognized wrapper and inner editable input would take the alternative text branch described above.

**normalized type:** Under the audited inner-button shape, `combobox`. Under the unrecognized-wrapper/inner-input shape, `text` unless the input itself exposes list behavior. It is never `select` unless the selected DOM node is an actual `<select>`.

**Agent control type:**

- Closed role-only inner button, no `aria-haspopup`, and no resolvable option container: `BUTTON`.
- Same button with `aria-haspopup`, or with a resolvable list/menu containing options: `CUSTOM_SELECT`.
- Editable inner input with `aria-autocomplete=list|both` or other positive list evidence: `SEARCHABLE_COMBOBOX`.
- Editable inner input with only `role="combobox"` and no positive list evidence: `TEXT_INPUT`.
- Actual `<select>`: `NATIVE_SELECT`.

**type() permitted:** For the suspected bad inner-input branch, yes. For a correctly classified custom/searchable/native choice owner, no. For the role-only-button `BUTTON` branch, the safety option rule does not itself reject `type`, but the normal decider will not issue it and the executor rejects the non-input target.

**open_dropdown permitted:** Yes only when the authoritative result is `NATIVE_SELECT`, `CUSTOM_SELECT`, or `SEARCHABLE_COMBOBOX`. It is refused for `TEXT_INPUT` and `BUTTON`.

**select_option permitted:** Yes only for the option types and only after the current observation contains real option handles. It is refused for `TEXT_INPUT` and `BUTTON`.

The observed "BS" display with continuing employer validation is a separate commitment failure, not proof of any one classification. Current source attempts to catch it: `commitmentOf()` checks a descendant hidden input and form validation, and `observePage()` blanks `currentValue` when the control displays a choice but has not committed one (`pageObserver.ts:643-692`, `847-901`). If the live form still displays BS while Agent treats it as answered, the missing evidence is whether the scanned root actually contains the backing hidden input and whether `aria-invalid`/`aria-errormessage` is attached to that root. A backing input outside the selected root is not found by `holdsCommittedValue()`.

## STATE

**scanner source:** The same generic `scanDom()` path; there is no SuccessFactors-specific State rule.

**normalized type:** Under the prior audited custom shape (inner button with `aria-haspopup="menu"`), `combobox`. If it is a native `<select>`, `select`. While a native select is disabled, or a custom trigger reports `aria-disabled="true"`, the main scanner emits no normalized State field at all because `shouldIgnore()` removes it (`domScanner.ts:316-325`). A custom button carrying only the native `disabled` attribute is not filtered here, so its exact disabled markup matters.

**Agent control type:** Under the audited enabled button-menu shape, `CUSTOM_SELECT`, because `aria-haspopup` makes `opensOptionList()` true even before the popup exists. Under a native shape, `NATIVE_SELECT`. While the control is filtered as disabled, there is no Agent element and therefore no Agent control type or allowed tools.

For an enabled `CUSTOM_SELECT` or `NATIVE_SELECT`, `type` is forbidden, `open_dropdown` is permitted, and `select_option` is permitted only against observed current options. The source therefore does **not** support a claim that enabled State is intrinsically misclassified as text under the audited markup. Its failure may instead occur because it remains disabled/omitted, because Country did not trigger the dependency refresh the page expects, or because the live markup differs from the audited shape. The exact current State node and its disabled/ARIA state before and after Country are required to decide among those.

This also explains an important scanner disagreement: the dedicated dropdown scanner can retain a visible disabled custom control and mark `dependencyState: "awaiting_parent"` (`dropdownScanner.ts:183-215`, `296-327`), while the Agent's main `scanDom()` removes that same control before normalization. Agent Mode uses the latter.

## AREA OF STUDY

**why behavior differs:** The label normalizes cleanly to canonical `major` (`shared/logic/normalizeQuestion.ts:436-438`), and the trusted value is the saved education `major` (`deterministicMatcher.ts:454`). A page option such as "Electrical Engineering" is usually an exact match. Education Type instead normalizes to `education_type` and commonly needs the Bachelor's/BS alias path (`agent/choiceMatcher.ts:21-36`). That makes Area of Study easier to resolve after its list is visible, but it does not by itself change control type.

At the DOM layer, Area of Study succeeds when its trigger exposes positive popup evidence (`aria-haspopup`, or a resolvable `aria-controls` list) at observation time. It then becomes normalized `combobox`, Agent `CUSTOM_SELECT`, and follows open -> observe options -> `select_option`. Education Type can fail when its otherwise similar button exposes only `role="combobox"` while closed, producing the `combobox` -> `BUTTON` split, or when an inner input becomes the scanned field.

If the two current live controls have byte-for-byte equivalent tag/role/ARIA/list state, source does not explain why one classifies differently; their behavioral difference must then be in option matching or commitment. The current live attributes and Agent observation are missing.

## Do different scanners classify the same visible widget differently?

Yes.

- Main scanner: a role-only closed button -> normalized `combobox`.
- Dedicated dropdown walk alone: the same role-only button is also dropped because its button branch requires `opensOptionList()`.
- Dedicated dropdown pass after merging the main scan's `combobox` seed: the seed bypasses that walk disagreement, and `classifyDropdown()` then calls the same trigger `aria_combobox` (`dropdownScanner.ts:338-355`, `424-445`; `dropdownEngine.ts:133-157`).
- Agent observer: the same `HTMLButtonElement` -> `BUTTON` if `opensOptionList()` cannot prove the popup at that instant.
- Disabled dependent control: dedicated dropdown scanner may emit `awaiting_parent`; main scanner/Agent may emit nothing.

Classification can also change over time without the element's role changing. Once a lazy list is mounted and `aria-controls` resolves to a list containing options, `opensOptionList()` can flip from false to true, changing Agent `BUTTON` to `CUSTOM_SELECT` on the next observation. The executor calls the same classifier again, so it can disagree with the observation if the DOM changes between them.

## Exact first incorrect point

For the prior audited Education Type button shape, the normalized scanner semantics are still correct. The first incorrect point is the Agent's authoritative reclassification:

**PRIMARY CLASSIFICATION ROOT CAUSE:** A role-bearing choice button is classified through the tag-specific `HTMLButtonElement` branch before the ARIA-combobox branch. A closed lazy popup can therefore erase correct scanner semantics (`combobox` -> Agent `BUTTON`), disabling every choice tool. The system has multiple nominally authoritative classifiers with different evidence thresholds.

**FILE:** `extension/src/agent/pageObserver.ts`

**FUNCTION:** `interactionTypeOf`

**CODE PATH:** scanned role-bearing button -> `inferType()` / `isCustomCombobox()` -> `DetectedField.fieldType = "combobox"` -> `kindOf() = "dropdown"` -> `interactionTypeOf(HTMLButtonElement)` -> `opensOptionList() === false` while the lazy popup is absent -> `BUTTON` -> `open_dropdown` refused and `select_option` refused.

**CONFIDENCE:** High (0.95) that this source-level classifier split exists; medium (0.65) that it is the current live Education Type cause because the current live node/attributes and Agent observation were not captured in the repository. If live evidence instead shows the scanned node is an editable inner input, the earlier first incorrect point is `domScanner.ts` `inferType()` -> `isTypedTextControl()` -> `answersFromList() === false` -> `text`, with the same result reinforced as Agent `TEXT_INPUT`.

## Exact live evidence still missing

To prove the live branch rather than infer it, capture these facts for Education Type, personal State/Province, and Area of Study in the same run, both closed and immediately after opening:

1. The normalized field's `selector`, `metadata.tagName`, `metadata.role`, and `fieldType`.
2. Outer wrapper and selected node `outerHTML` with values redacted, including `role`, `type`, `class`, `aria-haspopup`, `aria-expanded`, `aria-controls`, `aria-owns`, `aria-autocomplete`, `aria-disabled`, `disabled`, `readonly`, and `aria-invalid`.
3. Whether the selected node is the outer wrapper, inner button, or inner input; whether the backing hidden input is inside that selected root.
4. Whether the `aria-controls`/`aria-owns` target exists while closed, and whether it contains `[role="option"]` after opening.
5. The emitted Agent element's `kind`, `interactionType`, `dropdownState`, `searchInputId`, `optionsKnown`, `selectionCommitted`, and `validationError`.
6. For State, the selected node and disabled/ARIA state before Country, immediately after Country commits, and after the next observation.
7. The executed tool and the executor's second `interactionTypeOf()` result.

Without those facts, current source proves the classification hazards and the scanner disagreement, but it does not prove that either specific live control currently becomes `TEXT_INPUT`, `BUTTON`, `CUSTOM_SELECT`, `NATIVE_SELECT`, or `SEARCHABLE_COMBOBOX`.
