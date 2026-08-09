# Dropdown executor — root cause

Written from a real run of the built extension against
`tests/fixtures/lab/dropdown-master.html`, not from reading the source. The
evidence is `local-data/dropdown-run-evidence.json`, produced by
`tests/e2e/dropdown-master.spec.ts`.

## The active path

```
popup "Autofill Application"
  → background/autofill orchestrator          extension/src/autofill/orchestrator.ts
  → deterministic planner                     extension/src/planner/deterministicPlanner.ts
  → frame routing, grouped by frameId         extension/src/background/fillAcrossFrames.ts
  → content script EXECUTE_FILL_PLAN          extension/src/content/index.ts:341
  → adapter.executeAction                     extension/src/scanner/adapters.ts:148
  → executeDomAction                          extension/src/executor/domExecutor.ts:438
  → executeDropdownWithRetry                  extension/src/executor/dropdownEngine.ts:823
  → executeNativeSelect / executeCustomDropdown
  → open, enumerate, match, click, verify     extension/src/scanner/optionDiscovery.ts
```

**Active executor:** `executeDropdownWithRetry` → `executeDropdown` in
`extension/src/executor/dropdownEngine.ts`. It is reached from exactly one call
site (`domExecutor.ts:614`) for all three option actions — `select_option`,
`select_suggested_option`, `select_resolved_option`.

**Competing implementations:** none survive. `applyValue` in `domExecutor.ts`
throws `UNSUPPORTED_CONTROL` if an option action ever reaches it, and
`discoverLiveOptions` in `optionDiscovery.ts` is called only by tests. Frame
routing is intact: actions are grouped by the `frameId` the field was discovered
in and dispatched to that frame, and the nested-frame control in the fixture
executed in frame 5.

## What was actually wrong

The engine itself was largely sound. Every failure found in this run happened
either **before** the engine was reached, or in a rule the engine relies on. All
four are the same mistake in different places: **a decision made from the scan's
option snapshot rather than from the list the control actually opens with.**

### 1. A planner rule refused a control because its unopened list looked empty

`deterministicPlanner.ts`, the `how_did_you_hear` branch, called
`chooseDiscoverySource(field.options ?? [], …)`. A custom combobox builds its
menu when it opens, so the scan recorded no options, the ranking had nothing to
rank, and the field was planned as `missing_information` — "none of this form's
source options truthfully describes how this job was found" — about a list
nobody had read. The control was never executed at all: no dropdown record in
the trace, `executorAttempted: false`, and an orange "Information needed" badge
on a control plainly offering the answer.

**Fixed** by handing the ranked categories to the engine when the snapshot is
empty, so the choice is made against the list the control really opens with.
`DISCOVERY_SOURCE_CANDIDATES` in `shared/logic/discoverySource.ts` is the ranking
written out as literal wordings, and `tests/extension/discoverySourceCandidates.test.ts`
asserts wording _n_ is matched by pattern _n_, so the two cannot drift.

### 2. Ids inside an open shadow root were resolved against the document

`domScanner.ts` resolved `aria-labelledby`, `label[for]`, `aria-controls` and
`aria-owns` through `element.ownerDocument.getElementById`, and
`optionDiscovery.ts` did the same for the popup. Ids are scoped per tree, so
inside an open shadow root none of those lookups can ever succeed. A custom
combobox in a web component was therefore unlabelled and **dropped from the scan
entirely** — not failed, not outstanding, simply absent from the report while
sitting unanswered on the page. A `<select>` in a shadow root worked, because it
needs no id to be understood.

**Fixed** with `scopeOf` / `elementById` in `optionDiscovery.ts`, used by both
modules: the element's own tree first, the document second (a shadow-rooted
control may still portal its menu into the page).

### 3. A searchable control was sent one query, and it was the wrong one

A searchable list renders only what the query matches. The engine typed the whole
saved value — "Clifton, New Jersey, United States" — into a control whose own
entry reads "Clifton, NJ, United States". Nothing rendered, and an empty list is
indistinguishable from a control that never opened, so it reported
`DROPDOWN_OPEN_FAILED` about a widget that works for anyone who types "Clifton".

**Fixed** with `searchQueriesFor` / `typeSearchNarrowing`: the whole value, then
the part before the first comma, then its longest word. Each is a prefix of what
was saved, nothing is invented, and choosing among what comes back is still the
matcher's job — which is what keeps Clifton, Colorado from being selected.
`openControl` also now returns a declared-but-empty container, so "opened onto
nothing" is reported as `NO_OPTIONS_FOUND` rather than as a failure to open.

### 4. The prompt filter ate a real answer

`isPlaceholderLabel` treated any label starting "choose" or "select" as a prompt.
A Greenhouse ethnicity list offers **"Choose not to disclose"**, which was
filtered out of its own control's option list — so the one answer the agent is
permitted to give on a protected question became unsayable, and the field
reported `OPTION_NOT_FOUND` for "Decline to answer" while that option sat in the
open menu.

**Fixed:** a documented decline phrasing is never a placeholder.

### 5. A control already displaying the answer was driven anyway

`executeNativeSelect` compares before it writes; the custom path did not. The
combined phone widget renders "US +1" from the number beside it and has no menu
behind it at all. The engine clicked at it, found nothing, and painted
`FAILED_EXECUTION` over a correct answer.

**Fixed:** what the control displays is offered to the same matcher as a
one-entry option list, and a literal, aliased, or region-suffixed correspondence
means the question is already answered. A semantic near-miss does not count.

## Control types now supported

| Shape                                               | Driven as             | Evidence                           |
| --------------------------------------------------- | --------------------- | ---------------------------------- |
| `<select>`                                          | `native_select`       | Country, State/Province, Graduated |
| `<select>` in an open shadow root                   | `native_select`       | Graduated                          |
| ARIA combobox, listbox on open                      | `aria_combobox`       | Employment Type                    |
| React-style controlled div, menu in `document.body` | `aria_combobox`       | Education Type                     |
| Button menu, portalled, 160 options, scrollable     | `button_menu`         | Education Country                  |
| Button menu, disabled until its parent populates it | `button_menu`         | Education State                    |
| Searchable input combobox                           | `searchable_combobox` | School                             |
| Virtualized listbox, 114 options                    | `aria_combobox`       | Area of Study                      |
| Custom combobox in an open shadow root              | `aria_combobox`       | Degree in Progress                 |
| Keyboard-only widget (options ignore clicks)        | `aria_combobox`       | How did you hear                   |
| Custom combobox two frames down                     | `aria_combobox`       | Reason for Leaving (frame 5)       |

**Closed shadow roots** remain unsupported and cannot be otherwise: the scanner
sees only the host element, so no control is detected and there is nothing to
report a failure about. No error code is raised for it, because inventing one
that can never fire would be worse than saying so here.

## Failure vocabulary

`shared/schemas/dropdownExecution.ts` already carries one member per stage. The
names differ from the `DROPDOWN_*` list in the brief; the meanings are the same,
and these are the names the report, the trace, and `ERROR_CODES` already speak:

| Brief                               | This repository                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DROPDOWN_CONTROL_NOT_FOUND`        | `CONTROL_NOT_FOUND`                                                                                                                    |
| `DROPDOWN_DISABLED`                 | `CONTROL_DISABLED`                                                                                                                     |
| `DROPDOWN_OPEN_FAILED`              | `OPEN_FAILED`                                                                                                                          |
| `DROPDOWN_MENU_NOT_FOUND`           | `OPTION_CONTAINER_NOT_FOUND`                                                                                                           |
| `DROPDOWN_OPTIONS_EMPTY`            | `NO_OPTIONS_FOUND`                                                                                                                     |
| `DROPDOWN_TARGET_NOT_FOUND`         | `OPTION_NOT_FOUND`, `NO_SEMANTIC_OPTION_MATCH`                                                                                         |
| `DROPDOWN_OPTION_CLICK_FAILED`      | `OPTION_CLICK_FAILED`, `OPTION_DISABLED`                                                                                               |
| `DROPDOWN_VALUE_NOT_UPDATED`        | `SELECTION_NOT_ACCEPTED`                                                                                                               |
| `DROPDOWN_VERIFICATION_FAILED`      | `VERIFICATION_FAILED`                                                                                                                  |
| `DEPENDENCY_NOT_READY`              | `DEPENDENT_CONTROL_NOT_REFRESHED`                                                                                                      |
| `DROPDOWN_FRAME_NOT_REACHABLE`      | `FIELD_NOT_FOUND` from `unreachable()` in `fillAcrossFrames.ts`, whose message names the frame and whose `debugContext` carries its id |
| `DROPDOWN_SCROLL_EXHAUSTED`         | folded into `OPTION_NOT_FOUND` — the list was read to its end and the answer was not on it, which is the same fact                     |
| `DROPDOWN_SHADOW_ROOT_INACCESSIBLE` | not raised; see above                                                                                                                  |

Renaming the enum would touch the report, the trace schema, `ERROR_CODES`,
`DEFAULT_ERROR_GUIDANCE` and every test that reads them, without changing what
any of them can express. The mapping above is the reconciliation.

## Acceptance

`npx playwright test tests/e2e/dropdown-master.spec.ts` — 35 assertions, all
twelve controls opened, enumerated, matched, selected and DOM-verified through
the built extension on one popup click. Slowest control 1578 ms (the keyboard
fallback, which waits out the click that can never land); slowest ordinary
control 722 ms (160 options, scrolled); whole run 5.4 s.
