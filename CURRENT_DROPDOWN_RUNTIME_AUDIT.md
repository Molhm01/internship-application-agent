# Current dropdown runtime audit

**Date:** 2026-08-10
**Branch:** `recovery/autofill-vertical-slice`
**Method:** read from current TypeScript source, not from the older audit files in this
repository.

> Several `*_AUDIT.md` files here describe states this project has since left. `DROPDOWN_ENGINE_AUDIT.md`
> and `AUTOFILL_RUNTIME_WIRING_AUDIT.md` in particular describe a build in which the Dropdown Engine
> was not production-wired. That has not been true since `extension/src/background/index.ts` began
> supplying `runDropdownStage`. **This file is the current one. Where it disagrees with an older
> audit, the older audit is stale.**

---

## 1. What actually runs when the user presses "Autofill Application"

`extension/src/autofill/orchestrator.ts`, per pass:

| #   | Stage                   | Driven by                                                              |
| --- | ----------------------- | ---------------------------------------------------------------------- |
| 1   | Repeaters (first pass)  | `growRepeatedSections` → `background/repeatersAcrossFrames.ts`         |
| 2   | Deterministic text fill | `applyPlan(plan, 'deterministic')` → `EXECUTE_FILL_PLAN`               |
| 3   | **Dropdowns**           | `runDropdownStage(scan)` → `background/dropdownAcrossFrames.ts`        |
| 4   | Dependencies            | `resolveDependencies(scan)` → `background/dependenciesAcrossFrames.ts` |
| 5   | Analysis + AI fill      | `applyPlan(plan, 'ai')`                                                |
| 6   | Final audit             | in-orchestrator                                                        |

All five engine dependencies are supplied by `extension/src/background/index.ts`. Each is bracketed
by a `*_STARTED` / `*_FINISHED` marker pair in the run trace, so "the button reached this engine and
waited for it" is a fact a finished run states about itself rather than something read off imports.

---

## 2. The five defects found, and what changed

### 2.1 Two live dropdown execution paths — **fixed**

**Was:** the deterministic plan's `select_option` actions went through
`executor/domExecutor.ts` → `executor/dropdownEngine.ts`, and stage 3 then drove the same controls
again through `dropdown/*`. Both reported success. This is worse than duplicated work: re-selecting a
value a control already holds fires `change`, and a page that rebuilds a dependent list on that event
discards the answer chosen moments earlier — so the second engine could undo the first one's work.

**Now:** `shared/logic/actionContract.ts` defines `DROPDOWN_ENGINE_ACTIONS`
(`select_option`, `select_suggested_option`, `select_resolved_option`) as the boundary. Both the
executor and the orchestrator read that one list, so they cannot disagree.

When `dependencies.runDropdownStage` exists, `applyPlan` puts every such action in
`deferredToDropdownEngine`: it is never approved, so the content script reports it `skipped`, and the
old path is not entered. The deferred action gets **no verdict** from the text stage — the dropdown
stage in the same pass writes the only record. Text, date, checkbox and radio actions are untouched.

`choose_radio` and `toggle_checkbox` are deliberately _not_ deferred: a radio group's choices are
already in the DOM, there is nothing to open, and the ordinary executor drives it correctly.

The deferral is conditional. Without a wired dropdown stage there is one engine again — the old one —
and deferring to a stage that will never run would simply stop answering dropdowns.

**Retired, not deleted:** `executor/dropdownEngine.ts` keeps `classifyDropdown` (used by the dropdown
scanner) and its execution path, which is now unreachable in production but still exercised by
`tests/extension/dropdownEngine.test.ts`. Its substring verifications were replaced along with
everything else's (§2.3).

**Evidence:** `runTrace.legacyOptionExecutions` counts `FillExecutionResult`s carrying a `dropdown`
trace — only the old engine produces those. It must be `0`.

#### 2.1a Deferring execution must not discard the answer

The first version of this deferral did, and it cost three answers. The planner and the Dropdown
Engine's own `resolveIntendedAnswer` do not know the same things: the planner has the scan's intent,
the adapter's reading of the page, and the structural rules that answer **Phone Type**, **Address
Type** and **How did you hear about us** — and it has already mapped a saved "LinkedIn" onto _this
form's_ own `internet` entry. Deferring those actions with nothing attached left all three blank on a
form that had been filling them correctly.

So `plannedOptionAnswerSchema` travels with the deferral, worker-side only, keyed by scan field id:

- The **planner** decides what the answer is; this engine decides how to get it into the control.
- The engine's own resolution is kept as an **alternative**, so a plan built from a stale scan cannot
  cost an answer the live resolver knows.
- Only answers the approval policy would have executed are offered. `decideApproval` runs for every
  deferred action exactly as if it were about to be written, and a sensitive or unapproved action is
  not laundered into the dropdown stage by being deferred to it.
- A planned answer can never promote a question past the confirmation rule.

#### 2.1b Two reporting gaps the duplicate executor had been masking

Neither is a new defect; both were invisible while a second engine was redundantly driving the same
controls and supplying the numbers.

- **A dependency-driven control had no option count.** A control the Dependency Engine answers is
  never opened by the dropdown stage — before its parent is set it is empty, and afterwards it
  already holds the answer and is correctly left alone. `dependencyTrace.dependentOptionCount` now
  records what the engine read _while driving_, because fingerprinting a button-menu widget
  afterwards counts nothing (its menu is closed). The orchestrator also carries forward the most
  choices a control was ever seen to offer, keyed by frame and question, since the pass that drove a
  dependent control held a scan that did not yet contain it.
- **A driven result could fail to tie back to a scanned field.** `mergeDropdownResults` now matches
  on `scanFieldId`, then `frameId::selector`, then `frameId + question + recordIndex` — the last only
  where that question is unambiguous within its frame and block, so a form that repeats a heading
  gets no guess.

And one precedence rule: a dropdown result that **never opened** no longer overwrites a result
another stage verified. A control the engine could not open has told it nothing about what the
control holds, and the combined phone widget — whose country code is rendered from the number beside
it, with no menu behind it at all — is exactly that case.

### 2.2 `runDropdownStage` ignored the authoritative scan — **fixed**

**Was:** `runDropdownStage: async () => { … }`. The `scan` argument was in the orchestrator's
signature and unused. Every frame rediscovered the page with `dropdown/dropdownScanner.ts`'s own
`CANDIDATE_SELECTOR`, which recognises `select`, ARIA roles, `aria-haspopup`, React-Select class
shapes and `button[aria-expanded]` — and nothing else. A control the application scan classified as
an option field whose markup that list does not match reached the engine through **neither** route:
not through the plan (deferred or not), and not through the walk.

**Now:**

- `runDropdownStage: async (scan) => …` calls `dropdownSeedsByFrame(scan)`.
- A seed carries `fieldId`, `selector`, `label`, `sectionContext`, `canonicalQuestion`, `required`,
  `recordIndex` and `knownOptions` — and no instruction.
- `DISCOVER_DROPDOWNS` carries this frame's seeds only, so a selector is never resolved in the wrong
  document.
- `scanDropdowns(document, seeds)` resolves each seed **in-frame**, under the frame's own ownership
  and visibility rules, and mints its own `dropdownId` for it. The worker still learns nothing but
  the handle it is given back.
- Deduplication: a control both sources found is described **once** and marked `both`, keeping the
  walk's live reading of the element and the seed's ids and intent. Walk-only is `dropdown_scan`;
  seed-only is `main_scan` and bypasses `isDropdownLike`, because the scan already classified it.
- Frame routing is unchanged: the worker stamps `frameId`, and a control discovered in one frame is
  only ever driven there.
- `mergeDropdownResults` now ties a result back to its scanned field by `scanFieldId` first, falling
  back to `frameId::selector`. Matching on selector alone relied on two independent computations
  agreeing.

`radio` and `checkbox` fields are excluded from seeding: they answer from a list and are not menus.

**Evidence:** `discoverySource` on every live trace row. A `main_scan` row is a control the walk
would have dropped.

### 2.3 "No Selection" satisfied "No" — **fixed**

**Was:** `alreadyDisplays` returned `shown === wanted || shown.includes(wanted)`;
`verifyDisplayedSelection` used `.includes`; `executor/dropdownEngine.ts` had four more. `"No
Selection".includes("No")` is `true`, so a `Graduated?` control sitting on its own placeholder was
reported `SKIPPED_ALREADY_VALID` — never opened, never driven — while the page plainly showed "No
Selection". The same rule silently approved "Not Applicable" for "No" and "United Kingdom" for
"United".

**Now:** `shared/logic/selectionDisplay.ts` is the one comparison, used by all three sites. Order:

1. **A placeholder never satisfies anything** — checked first, before any comparison.
   `isPlaceholderSelection` covers `No Selection`, `Make a Selection`, `Select`, `Select...`,
   `Select One`, `Choose`, `Choose...`, `Please Select`, `None Selected`, `-- Select --`, empty, and
   the leading/trailing dash and ellipsis forms.
2. Exact equality of the normalized texts.
3. An explicit hand-written alias group (`no`/`false`, `yes`/`true`) — never a similarity score.
4. The same answer with the control's own decoration _removed_ and equality retried: `United States
of America (US)`, `New Jersey ✕`, `Selected: New Jersey`.
5. A contiguous token run, and only for an answer of ≥2 tokens or ≥8 characters.
6. A short answer standing alone beside a **code**: every token outside the match is ≤3 characters.
   This exists for one real widget — a combined phone control displaying `US +1` whose answer is
   `+1`. Refusing it opened a control that has no menu behind it and reported a failed execution over
   a field showing exactly the right code. `NJ Transit` cannot reach this rule, because `transit` is
   a word rather than a code.

Rule 5 is what makes the original defect unreachable rather than patched: `No`, `US` and `NJ` can
never reach a general containment rule at all. Rule 6 cannot rescue `"No Selection"` either — a
placeholder is refused at step 1, before any comparison runs, whatever it happens to contain.

A decline (`Choose not to disclose`) is a real answer, not a prompt, and is preserved.

**Evidence:** `tests/extension/selectionDisplay.test.ts` — 39 assertions, including the exact
`"No Selection"` / `"No"` pair against both a native and a custom control.

### 2.4 Menus without ARIA roles were invisible — **fixed**

**Was:** `scanner/optionDiscovery.ts` located a popup only by `aria-controls`/`aria-owns`,
`[role=listbox]`, `[role=menu]`, `[data-portal-menu]` or `[data-dropdown-menu]`, and read entries
only by `[role=option]` and the menuitem roles. A vendor picker that mounts a plain `div` of `li`
elements under `document.body` reported `OPEN_FAILED` over a menu the applicant could see.

**Now:** `extension/src/scanner/structuralMenu.ts`, tried **last**, after every declared route.

- Before the press, `watchForMenu` starts a `MutationObserver` on the trigger's tree and the
  document — `childList` plus `style`/`class`/`hidden`/`aria-hidden`/`open`/`data-state`, so a menu
  that is _revealed_ counts as much as one that is mounted.
- After the press, `findStructuralMenu` ranks the mutated elements and their descendants: named by
  `aria-controls` (+100), pointed at by `aria-activedescendant` (+50), within 600px of the trigger
  (up to +40, and **rejected beyond it**), a menu-ish class name (+20), plus the candidate count.
- It then narrows to the most specific descendant still holding every entry, so the menu is the list
  rather than the overlay it sits in.
- Candidates inside that container only: `li, button, a, [data-value], [data-key], [data-option],
[data-item], [data-index]`, outermost-only; failing that, a sibling group of ≥3 same-tag
  `div`/`span`/`p` elements with their own short text and no nested entries.

Three rules keep this from becoming a page-wide sweep for clickable things: **scoped to the
mutation** (only what the click changed), **scoped to one container**, and **repetition is the
evidence** (one clickable div is never a menu).

The chosen container is held in a `WeakSet` and a trigger→menu `WeakMap` rather than marked in the
DOM — a page being read must look exactly as it did. `findListbox` consults the remembered menu
first, because a role-less menu is only recognisable at the moment it appears and every later step
asks for the popup again. `closeControl` forgets it.

Every consumer goes through one `optionItemsIn(container)`: enumeration, scrolling to a virtualized
row, finding the element to click, and the keyboard walk. Both kinds of menu are driven by identical
machinery.

**Diagnostics collected:** trigger tag, role, type, `aria-haspopup`, `aria-expanded` before and
after, whether `aria-controls` exists, a **class fingerprint** (a digest, never the classes), menu
detection strategy, option candidate strategy, option count, scroll iterations. No values.

### 2.5 Settings normalization dropped `autofill` and `developerMode` — **fixed**

**Was:** `normalizeStoredSettings` rebuilds the settings object key by key, and never named those
two. `extensionSettingsSchema` defaults both, so the omission did not fail — it silently **reset**.
Every autofill preference a user changed went back to its default on the next read, and
`developerMode` could be written and never observed. That is why the Diagnostics page permanently
said to turn on developer mode "in Preferences" — a control that did not exist, for a setting that
could not have survived if it had.

**Now:** both are parsed and preserved, in the same lenient shape as `employerAccounts` — a corrupt
block falls back to the shipped defaults, so the failure direction is always "off"/"default".
`saveSettings` merges `autofill` over what is stored rather than replacing it, so flipping one switch
does not reset the other eight. `neverSubmit` is `z.literal(true)`, so a stored `false` cannot
survive a parse.

A **"Show diagnostic tools"** checkbox now exists in Options → Diagnostics, where the message telling
users they need it lives.

---

## 3. The Live Dropdown Trace

`runTrace.dropdownEngineTraces`, one row per option control per pass. Sanitized at construction by
`toLiveDropdownTrace`, so a future caller cannot forget to.

**Field:** `dropdownId`, `scanFieldId`, `canonicalQuestion`, `question`, `frameId`,
`mainScannerFound`, `dedicatedScannerFound`, `discoverySource`.

**Control structure:** `triggerTag`, `triggerRole`, `triggerType`, `ariaHasPopup`,
`ariaExpandedBefore`, `ariaExpandedAfter`, `hasAriaControls`, `classFingerprint`, `controlStrategy`.

**Execution:** `engineCalled`, `executorInvoked`, `triggerResolved`, `openAttempted`,
`openSucceeded`, `menuDetection`, `menuFound`, `optionCandidates`, `optionsFound`, `scrolled`,
`scrollIterations`, `intendedAnswerSource`, `intendedAnswerResolved`, `targetFound`, `matchedOption`
(a **boolean** — which option was chosen is an answer), `clickAttempted`, `selected`,
`verificationObserved`, `verified`, `finalStatus`, `failureCode`, `durationMs`.

Plus two run-level counters: `optionActionsDeferred` and `legacyOptionExecutions`.

**What may never appear:** any option label, displayed value, answer, sensitive selection, password,
document content, or token. `liveDropdownTraceSchema` is `.strict()` and has no member able to hold
one. The question wording survives because it is the employer's own text — without it a trace of nine
dropdowns is nine indistinguishable rows.

`describeLiveDropdown` renders each row as one sentence naming the **first** stage that did not
happen, because everything after it is a consequence.

---

## 4. What this does _not_ prove

Every claim above is proved against fixtures — jsdom for the unit level, the built extension against
`tests/fixtures/lab/hostile-dropdowns.html` for the browser level. The hostile fixture was written
specifically because the previous master fixture was too friendly: it shipped `role="combobox"`,
`role="listbox"`, `role="option"` and explicit portal attributes, i.e. every declared route the code
already knew how to follow.

**A fixture is not an employer.** The live portal may differ in ways nothing here anticipates. The
Live Dropdown Trace exists so the next live failure can be diagnosed from a single exported file
instead of another architecture rewrite — that trace, not this document, is the next source of truth.
