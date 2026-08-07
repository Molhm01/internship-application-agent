# Phase 3.5 — Dropdown audit and repair

Why dropdowns failed across unrelated sections of a live application while text fields filled
reliably, what the active code path actually was, and what was changed.

Everything below was read off the code and confirmed by running the pipeline against a fixture. No
claim here rests on inference alone.

---

## 1. The systemic root cause

**Option resolution was bound to the scan-time snapshot, and only one narrow widget family ever
re-read the live control.**

There were two option paths, not one:

| Control the scanner called… | Path taken                     | Options matched against    |
| --------------------------- | ------------------------------ | -------------------------- |
| `combobox`                  | `comboboxExecutor` → live read | the choices the page shows |
| `select`, `radio`, anything | `domExecutor.applyValue`       | **the scan snapshot**      |

`applyValue`'s `select_option` branch did this:

```ts
const exists = Array.from(element.options).some((o) => o.value === action.matchedOption?.value);
if (!exists) throw new Error('OPTION_NOT_FOUND');
```

`action.matchedOption.value` came from `field.options`, recorded by the scanner. Any control whose
choices change between the scan and the fill therefore failed with a known answer in hand:

- a **State** list the page rebuilds after Country is chosen,
- an **Education Country** list a script populates after load,
- a **School** list that does not exist until the control is opened,
- any control the framework **replaces** rather than mutates.

And the planner had the mirror of the same defect. `deterministicPlanner` matched the saved value
against `field.options` and, on no match, returned `manual_review`:

```ts
const option = matchOption(match.formattedValue, options, {...});
if (!option.matched || !option.option) {
  return { ...base, action: 'manual_review', requiresReview: true, ... };
}
```

A snapshot that was stale, incomplete, or empty produced a dead end **before the executor ever saw
the field**. Only `fieldType === 'combobox'` had an escape hatch (defer to a live read), and that
hatch set `requiresReview: true`, so the approval policy declined it and it was never executed
either.

Four separate stage failures then collapsed onto one badge. `resolveFinalFieldStatus` maps every
`verification: 'failed' | 'unverified'` to `FAILED_EXECUTION`, and `ANNOTATION_BADGES` renders that
as **"Autofill failed"** — the same red mark whether the list never opened, opened empty, offered no
corresponding answer, or was simply waiting on the field above it.

### Two further discovery defects found while tracing

1. **`isPageFurniture` dropped lazily-mounted dropdowns entirely.** A `<button aria-expanded>` whose
   `aria-controls` names a listbox the page has not created yet fails `opensOptionList`, so it was
   classified as an accordion header. The question never reached the planner, never reached the
   executor, and was **absent from the report** while sitting unanswered on the page.
2. **`readOptions` only recognised `[role="option"]`.** A button-driven React select renders
   `role="menuitem"` inside `role="menu"`, so those controls reported "no choices" over a list the
   user could see.

---

## 2. The active path, traced

```
domScanner.scanDom
  → shouldIgnore / isPageFurniture / isCustomCombobox   ← lazy dropdowns were dropped here
  → inferType                                            → fieldType: select | combobox | radio
  → field.options (a SNAPSHOT, static DOM only)
deterministicPlanner.planAction
  → isDependentControl(field)        → missing_information (correct, but snapshot-driven)
  → matchOption(value, field.options) ← THE SNAPSHOT AGAIN
  → manual_review on no match         ← dead end with a known answer
  → enforceContract
approvalPolicy.decideApproval
  → requiresReview ⇒ not approved     ← the combobox escape hatch died here
domExecutor.executeDomAction
  → contractViolation / elementContractViolation / isVisible / disabled
  → select_suggested|resolved  → comboboxExecutor  (live read: the only correct path)
  → select_option              → applyValue        (snapshot; threw OPTION_NOT_FOUND)
domVerifier.verifyDomAction
orchestrator: verification → resolveFinalFieldStatus → annotationFor → "Autofill failed"
```

### Why each reported field failed

| Field                      | Cause                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| **State/Province**         | `<select>` rebuilt by Country's `change`; `applyValue` asserted the _old_ value  |
| **Education Country**      | portal-rendered `role="menu"`; `readOptions` saw no `[role=option]` → no choices |
| **Education State**        | same, plus a cascade whose parent had not been driven                            |
| **School / Area of Study** | list does not exist until opened; scan snapshot empty → planner dead end         |
| **Graduated?**             | lazily-mounted popup → `isPageFurniture` classified it as an accordion, dropped  |
| **Yes/No questions**       | either no saved fact (mis-reported as failed) or a snapshot with no match        |
| **Employment Type, etc.**  | genuinely unknown answers, reported as `FAILED_EXECUTION` instead of the user's  |

### Duplicate implementations found

- `extension/src/executor/comboboxExecutor.ts` — live-read path for comboboxes only. **Removed**;
  its behaviour (including location matching on city/state/country together) is in the engine, and
  its tests are ported to `tests/extension/dropdownEngine.test.ts`.
- `applyValue`'s `select_option` branch — snapshot path. **Removed**; it now throws
  `UNSUPPORTED_CONTROL` if an option action ever reaches it, so a regression cannot re-introduce a
  second implementation silently.

---

## 3. What replaced it

### Answer resolution and dropdown execution are now separate

The **resolver** (matcher + planner) decides the canonical intent, the desired semantic value, the
source, and whether the user must confirm. The **engine** receives only a field id, an element, a
desired value, and optional grounding — and cannot decide a personal fact. A question with no answer
never reaches it (`ANSWER_UNKNOWN`), and that is reported as the user's, not as a failure.

### `extension/src/executor/dropdownEngine.ts`

One engine for every widget shape: classify → open → **enumerate the choices offered now** → match →
click → verify → close. `executeDropdownWithRetry` gives custom widgets exactly one more attempt, on
a re-resolved element, and only for failures a retry could plausibly fix. A native select gets none:
retrying only fires another `change` at a page that may rebuild a dependent control.

| Before                  | After                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| native `<select>`       | native select, native multi-select, radio group, checkbox group, ARIA combobox, searchable combobox, button menu, listbox |
| ARIA combobox (partial) | …all driven by one implementation, all enumerated live, all verified against observed control state                       |

Portal-mounted and lazily-populated menus are handled by `findListbox` (aria-controls/owns first, the
element's own container next, a single visible portal last — never an ambiguous one) plus an open
sequence that waits for a list _with entries in it_ rather than for the container.

### Failure vocabulary

`shared/schemas/dropdownExecution.ts` defines the structured result — `fieldId`, `dropdownKind`,
`desiredSemanticValue`, `optionCount`, `matchMethod`, `matchedOptionText`, `executionAttempted`,
`verified`, `failureCode`, `reason`, `durationMs` — and the closed failure list: `CONTROL_NOT_FOUND`,
`CONTROL_DISABLED`, `OPEN_FAILED`, `OPTION_CONTAINER_NOT_FOUND`, `NO_OPTIONS_FOUND`,
`OPTION_NOT_FOUND`, `AMBIGUOUS_OPTION_MATCH`, `NO_SEMANTIC_OPTION_MATCH`, `OPTION_DISABLED`,
`OPTION_CLICK_FAILED`, `SELECTION_NOT_ACCEPTED`, `VERIFICATION_FAILED`,
`DEPENDENT_CONTROL_NOT_REFRESHED`, `ANSWER_UNKNOWN`.

`DROPDOWN_ERROR_CODES` in `domExecutor.ts` maps each one to its own `ERROR_CODES` member — written
out one-to-one rather than defaulted, because collapsing stages is exactly the damage being undone.
`ANSWER_UNKNOWN` and `DEPENDENT_CONTROL_NOT_REFRESHED` return `needs_review`, which the orchestrator
records as `not_attempted` → `USER_CONFIRMATION_REQUIRED`, never red.

### Option matching

`shared/logic/dropdownOptionMatch.ts`, four layers, each narrowing the list the page rendered:

1. literal wording, then a documented spelling alias (`matchOption`)
2. the intent behind a yes/no, read through the question
3. semantic equivalence scored **only across the offered labels**, with a stop-token filter and a
   tie-break that refuses rather than guesses
4. the form's own "Other", and only for the questions where it is the honest answer

Location controls are matched on city, state and country together, ahead of everything else.

Alias groups added: phone type (mobile/cell/cellular), employment type, "Other" spellings. Accents
are now folded — `normalizeOptionLabel` decomposed "México" into `me xico` and matched nothing.

---

## 4. Known limits

- **"Graduated?" is mapped to the `graduation_date` intent** by the scanner, so a date is offered to
  a Yes/No control. The engine correctly refuses it (`OPTION_NOT_FOUND` over two discovered
  options) rather than forcing something through. This is an answer-resolution defect in the
  education phase and is deliberately not touched here.
- **Semantic matching is deterministic**, not model-assisted. `NO_SEMANTIC_OPTION_MATCH` is returned
  where no offered option is defensibly equivalent. A model may assist later; the physical engine
  works without one, and makes no network call.
- The engine is proven against the fixture through the real pipeline in jsdom. Live-site behaviour
  on iCIMS has not been observed since this change.
