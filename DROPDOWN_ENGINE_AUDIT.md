# Dropdown Engine Audit

Traced against the working tree on `recovery/autofill-vertical-slice`, commit `05c2e82`,
build `05c2e82+dirty.s3.20260810010456`.

## 1. What the trace actually found

The premise this phase started from — "the option-control execution layer is unreliable" — was
true of the repository as it stood **two commits ago**, and the repair for it had already landed in
`extension/src/executor/dropdownEngine.ts` (commits `d78e484`, `1af0e56`, `05c2e82`). What was
actually broken in the working tree when this pass began was something different, and narrower:
the tree did not build, test, or lint.

So this audit records two separate things: the historical root cause of the global dropdown
failure (already fixed, re-verified here), and the live breakage found and fixed in this pass.

## 2. The active runtime path

```
Autofill Application (popup)
  → background/index.ts            worker owns the run
  → background/contentScript.ts    ensureContentScript, per frame
  → content/index.ts               handleMessage, frame-local
  → scanner/domScanner.ts          scanDom → DetectedField[]
  → planner/deterministicPlanner.ts  → select_option actions
  → executor/domExecutor.ts        executeDropdownWithRetry(...)
  → executor/dropdownEngine.ts     ← THE ACTIVE ENGINE
  → scanner/optionDiscovery.ts     openControl / enumerateAllOptions / revealOption
  → verifier/domVerifier.ts        observed DOM state → fieldStatus
```

`frameId` survives end to end: it is stamped by the worker at discovery (a frame cannot learn its
own id) and every later message about a control is routed by that number. The nested-frame control
on the master fixture executes in **frame 5**, not frame 0 — confirmed in the run evidence below.

### Historical root cause (fixed before this pass)

Two option paths existed. Custom comboboxes went through `comboboxExecutor`, which opened the
control and read what it was _currently_ offering. Everything the scanner called a `<select>` went
through `applyValue`, which matched against **the scanner's option snapshot** and then asserted
that snapshot's `value` still existed.

Any control whose choices changed between scan and fill therefore failed:

- a State list the page rebuilds after Country is chosen,
- an Education Country list populated by script after load,
- a School list that only exists once the control is opened.

All three reported "Autofill failed" over a page that was working correctly, with the answer known
the whole time. The fix — already in place — is that **options are read from the live control at
the moment of the attempt, for every widget shape**. The scan snapshot is a planning hint and is
never what selection matches against.

### Live breakage found in this pass

A second, parallel engine had been started and left unfinished and **completely orphaned**:

| File                                                           | State on entry                                          |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| `extension/src/dropdown/*` (7 files, ~1,400 lines)             | untracked, referenced only by its own test              |
| `extension/src/background/dropdownAcrossFrames.ts`             | untracked, `runDropdownAutofill`, referenced by nothing |
| `shared/logic/dropdownAliases.ts`, `dropdownIntendedAnswer.ts` | untracked, never exported from the barrel               |
| `shared/schemas/dropdownRun.ts`                                | untracked, never exported from the barrel               |

Three concrete defects, all fixed here:

1. **`shared/index.ts` never re-exported the three new modules.** Every symbol imported as
   `undefined`, so `tests/extension/dropdownAutofillEngine.test.ts` failed **39 of 50** tests with
   `toDropdownEngineTrace is not a function`. Fixed by adding `dropdownRun.js` to
   `shared/schemas/index.ts` and `dropdownAliases.js` / `dropdownIntendedAnswer.js` to
   `shared/logic/index.ts`.
2. **`selectorFor` was imported from `domScanner.ts` but never exported there.** Fixed by
   exporting it.
3. **`dropdownAcrossFrames.ts` imported two schemas that had never been written** —
   `dropdownsDiscoveredSchema` and `dropdownDirectivesCompleteSchema`. This broke `typecheck` and
   produced 15 `no-unsafe-*` lint errors downstream of the unresolved types. Fixed by writing both
   schemas (`.strict()`, bounded arrays) in `shared/schemas/dropdownRun.ts`.

## 3. Answers to the specific questions asked

| Question                              | Answer                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Active dropdown scanner               | `scanner/domScanner.ts` → `scanDom`; option reading in `scanner/optionDiscovery.ts`                                                  |
| Active classifier                     | `classifyDropdown` in `executor/dropdownEngine.ts`, from the element, not its label                                                  |
| Active SELECT_OPTION executor         | `executeDropdownWithRetry` → `executeDropdown` in `executor/dropdownEngine.ts`                                                       |
| Legacy/unused executors               | `comboboxExecutor` and `applyValue` already removed; the orphaned `extension/src/dropdown/` tree is the remaining duplicate (see §5) |
| Does frameId survive?                 | Yes — worker-stamped, routed per message; nested-frame control ran in frame 5                                                        |
| Does it assume native `<select>`?     | No — `<select>` is one of nine strategies                                                                                            |
| React/custom controls?                | Yes — `aria_combobox`, `button_menu`, `searchable_combobox`, `listbox`                                                               |
| Does it open menus?                   | Yes — `openControl`, with click, keypress and typing fallbacks                                                                       |
| Portalled menus?                      | Yes — `findListbox` follows `aria-controls`/`aria-owns` and `document.body` portals                                                  |
| Hidden/offscreen/virtualized options? | Yes — `enumerateAllOptions` + `revealOption`                                                                                         |
| Scrolls option containers?            | Yes — the menu's own viewport, never the page                                                                                        |
| Searchable dropdowns?                 | Yes — `typeSearchNarrowing`, only when the control declares itself searchable                                                        |
| Verification reads real DOM state?    | Yes — `selectedIndex`/`value`/selected option for native; displayed text for custom                                                  |

## 4. Control strategies implemented

| Strategy             | Mechanism                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Native `<select>`    | Native setter → `input` + `change` + `blur`; verified on `selectedIndex`, `value`, `selectedOptions[0]` |
| ARIA combobox        | Open, wait for listbox, enumerate, match, click, verify displayed text                                  |
| Button menu          | `aria-haspopup="menu"` trigger, portal-aware menu discovery                                             |
| Searchable combobox  | Types the **label**, never the option `value`; narrowing retry per candidate wording                    |
| Portalled menu       | `aria-controls` / `aria-owns` / `document.body` scan, associated to the active trigger                  |
| Long scrollable list | Menu-viewport scrolling, bounded; 160 options read past 6 visible rows                                  |
| Virtualized list     | Scroll-and-accumulate with dedup; 114 options accumulated                                               |
| Keyboard fallback    | Reads `aria-activedescendant`/highlight after each press, bounded at 60 steps, wrap-detected            |
| Shadow DOM           | Trigger resolution crosses shadow roots                                                                 |
| Dependent control    | Empty list on a dependent control reports `DEPENDENT_CONTROL_NOT_REFRESHED`, not a generic failure      |

Selection is verified in every path. "Already correct" is treated as success without re-firing
`change` — re-selecting an already-selected Country would make the page rebuild its region list and
discard the State chosen moments earlier.

## 5. Outstanding decision: the orphaned duplicate engine

`extension/src/dropdown/` + `background/dropdownAcrossFrames.ts` now **compile, lint, typecheck and
pass all 50 of their own unit tests** — but they are still wired to nothing. The runtime does not
call them.

They were left in place rather than deleted, because deleting ~1,400 lines of uncommitted work from
a previous session is not a call to make silently. The spec's requirement of "one active engine" is
met in the sense that exactly one engine is active; it is not met in the sense that a duplicate
definition still sits in the tree.

Two coherent resolutions, both deliberately **not** taken unilaterally:

- **Remove the duplicate.** The active engine already satisfies every functional gate, and already
  emits the required per-dropdown trace (`kind`, `optionCount`, `frameId`, `failureCode`,
  `durationMs`) through `GET_RUN_TRACES`.
- **Wire the duplicate in as a second pass** after the deterministic fill. This is what its own
  documentation says it is for — starting discovery from the page so a planner gap cannot hide a
  menu. It is a real behavioural gain, but it means two passes driving the same controls, and it
  would need its own acceptance run before being trusted.

## 6. Run evidence — built extension, one Autofill click

Fixture `tests/fixtures/lab/dropdown-master.html`, spec `tests/e2e/dropdown-master.spec.ts`.
Report: `status=completed`, `fieldsVerified=19`, `failedFields=0`. Wall clock 5,401 ms.

| Field                 | Opened | Options | Target | Selected | Verified | n   | ms   | Strategy            | Frame |
| --------------------- | ------ | ------- | ------ | -------- | -------- | --- | ---- | ------------------- | ----- |
| Country               | yes    | yes     | yes    | yes      | yes      | 3   | 4    | native_select       | 0     |
| State/Province        | yes    | yes     | yes    | yes      | yes      | 3   | 2    | native_select       | 0     |
| Employment Type       | yes    | yes     | yes    | yes      | yes      | 5   | 3    | aria_combobox       | 0     |
| Reason for Leaving    | yes    | yes     | yes    | yes      | yes      | 4   | 3    | aria_combobox       | **5** |
| Education Type        | yes    | yes     | yes    | yes      | yes      | 4   | 4    | aria_combobox       | 0     |
| Education Country     | yes    | yes     | yes    | yes      | yes      | 160 | 723  | button_menu         | 0     |
| Education State       | yes    | yes     | yes    | yes      | yes      | 3   | 2    | button_menu         | 0     |
| School                | yes    | yes     | yes    | yes      | yes      | 1   | 2    | searchable_combobox | 0     |
| Area of Study         | yes    | yes     | yes    | yes      | yes      | 114 | 622  | aria_combobox       | 0     |
| Graduated             | yes    | yes     | yes    | yes      | yes      | 2   | 2    | native_select       | 0     |
| Degree in shadow root | yes    | yes     | yes    | yes      | yes      | 4   | 2    | aria_combobox       | 0     |
| How did you hear      | yes    | yes     | yes    | yes      | yes      | 5   | 1574 | aria_combobox       | 0     |

12 discovered, 12 selected, 12 verified, 0 failed. Slowest control 1,574 ms — inside the 5 s
budget. The final Submit was never clicked.

## 7. Verification run in this pass

- `npm run validate` — format:check, lint, typecheck, 1,900 unit tests, production build: **pass**
- `npx playwright test` — **198 passed**
- `tests/extension/dropdownAutofillEngine.test.ts` — 39 failures → **50 passed**
