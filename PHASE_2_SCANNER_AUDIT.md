# Phase 2 — scanner audit

What the "Autofill Application" command actually runs, what it got wrong, and where each
repair landed. Written from tracing the live path, not from reading the milestone plan.

## The active scanner path

There is exactly one, and every ATS adapter shares it.

| Stage                  | File                                          | Entry point                                    |
| ---------------------- | --------------------------------------------- | ---------------------------------------------- |
| popup                  | `extension/src/popup/useAutofillState.ts`     | Autofill button → `RUN_AUTOFILL`               |
| service worker         | `extension/src/background/index.ts`           | `startScan` → `askEveryFrame`                  |
| frame enumeration      | `extension/src/background/frames.ts`          | `executeScript({ allFrames: true })`           |
| content script         | `extension/src/content/index.ts`              | `SCAN_APPLICATION` handler                     |
| scan orchestration     | `extension/src/scanner/scanApplication.ts`    | `scanApplication`                              |
| adapter                | `extension/src/scanner/adapters.ts`           | `BrowserAdapter.scan` → `scanDom`              |
| **raw discovery**      | `extension/src/scanner/domScanner.ts`         | `collectRoots` + `CONTROL_SELECTOR`            |
| **filtering**          | `extension/src/scanner/domScanner.ts`         | `shouldIgnore`                                 |
| **label extraction**   | `extension/src/scanner/domScanner.ts`         | `extractAccessibleLabel`, `groupQuestionLabel` |
| **section context**    | `extension/src/scanner/domScanner.ts`         | `nearestHeading` → `contextualQuestionLabel`   |
| **required**           | `extension/src/scanner/domScanner.ts`         | `requiredEvidence`                             |
| **normalization**      | `extension/src/scanner/domScanner.ts`         | `fieldFromElements`                            |
| **in-document dedupe** | `extension/src/scanner/domScanner.ts`         | `scanOnce` → `questionIdentity`                |
| **cross-frame merge**  | `extension/src/background/mergeFrameScans.ts` | `mergeFrameScans`                              |
| Phase 1 trace          | `extension/src/autofill/orchestrator.ts`      | `FieldDiagnostic` → `runTraceSchema`           |

There is no alternate or unused scanner. `formAnalysis.ts` and `analysisMemo.ts` consume
`DetectedField[]`; they never touch the DOM. Adapters differ only in detection hints and
job-context selectors — all ten call the same `scanDom`.

### Where extension-created DOM can enter a scan

One place: `extension/src/content/highlighter.ts`, the only module that renders into an
employer page. Its Shadow DOM host is marked `data-internship-agent-owned="true"`, and
`isExtensionOwned` walks ancestors _and_ shadow hosts, so one mark covers the subtree.
The risk was never the existing code — it was the next badge built with a bare
`document.createElement`. That is now impossible to add silently (see repair 3).

## Root causes

### False controls — `nearestHeading` was not the root cause; `isPageFurniture` already held

The accordion headers (`Phones (1)* required.`, `Addresses (1)* required.`) are
`button[aria-expanded][aria-controls]`, which `CONTROL_SELECTOR` matches. They were already
rejected by `isPageFurniture` together with `opensOptionList`: a disclosure whose panel holds
no `[role="option"]` is an accordion, not a dropdown. Instructional prose, validation summaries
and headings never matched the control selector at all. **This half was already correct and is
now gated.**

What was _not_ correct: nothing asserted it. A future UI surface, or an ATS whose accordion
panel happens to contain a `[role="listbox"]`, would have reintroduced the failure with no
signal. Two runtime assertions now stand behind the filters.

### Section context — the real defect

`nearestHeading` walked up the ancestor chain asking each level for a direct-child heading
with `querySelector`, which returns the **first heading in the container regardless of where
the control sits**. On a form whose direct children include `<h2>Professional Experience</h2>`
and `<h2>Education</h2>`, _every_ control not wrapped in a `fieldset` came back headed
"Professional Experience" — the entire Phones block, the entire Addresses block, and all of
Education. Measured on the Phase 2 fixture: **18 of 25 fields carried the wrong heading.**

Consequences, all observed:

- "Type" under Phones never saw a phone heading → `contextualQuestionLabel` left it as "Type"
  → `canonicalKey: undefined`. Both "Type" controls were indistinguishable.
- Experience "Location" matched `current_location` — the applicant's _home_ address — which is
  the exact failure that made "Work-experience location = Clifton, NJ" the one field a whole
  run wrote, and wrongly.
- Every Education field was filed under section `experience`.
- A control in a frame whose heading was a sibling of its wrapper got no heading at all.

### Incorrect required status

`isRequired` treated four things as evidence that are not:

1. `aria-invalid="true"` — a control the page _rejected_, which says nothing about whether it
   is mandatory.
2. `REQUIRED_TEXT` matched against the whole enclosing container's text, including
   "information needed", "manual response required", "please complete", "cannot be blank" —
   every one of them a validation message.
3. A `[class*="required"]` container, without checking the container held only this control.
4. No record of _which_ rule fired, so an unearned requirement was indistinguishable from a
   `required` attribute.

The fieldset exclusion added earlier stopped the worst case (Middle Name inheriting First
Name's asterisk through a shared `<fieldset>`), but a shared `.field`-class wrapper, a
validation summary rendered inside the field container, or an `aria-invalid` left over from a
failed submit all still fabricated a requirement.

### Duplicate controls — one real duplicate, at the merge layer

In-document dedupe (`questionIdentity`, keyed on `name`/`elementId`/`canonicalKey` + frame
path) was already correct: the fixture's Highest Level of Education select, named three ways
at once (`label[for]`, `aria-labelledby`, adjacent section text), produced one field.

The duplicate was one layer up. `collectRoots` walks into every same-origin iframe it can
reach, so the **top frame's scan legitimately contains the child's controls** — and the
child's own content script scans that same document, correctly routed. `mergeFrameScans`
concatenated both. One `<input id="addressLine1">` in a nested frame therefore arrived as
**two questions**: one stamped `frameId: 0` and one stamped `frameId: 3`. The frame-0 copy
would have been written to a document that does not contain it, and both would have been
reported. Caught by the built-extension fixture; invisible to any jsdom test, because jsdom
has one content script.

The same concatenation summed `statistics.supported` across frames, so a 25-question page
reported **26 supported fields** — more supported fields than fields.

## Unused / competing paths

None found. Specifically checked and confirmed single-implementation:

- `scanDom` is the only DOM scanner; all ten adapters delegate to it.
- `collectNavigationControls` is deliberately separate and never returns fields.
- `countFieldStatistics` (new, `shared/logic/scanStatistics.ts`) is now the only field-count
  implementation; the content script and the frame merge previously had one each, which is
  how the merged `supported` count drifted from the field list.

## Repairs

1. **`nearestHeading`** — resolves in order: the control's own fieldset legend → the accessible
   name of the nearest `SECTION_CONTAINER_SELECTOR` ancestor (`aria-labelledby`/`aria-label`,
   which is the only way to reach an ATS accordion header that is a `<button>`) → the nearest
   heading _preceding_ the control, walking outward through earlier siblings. Extension-owned
   nodes can supply a heading at no step.
2. **`requiredEvidence`** — replaces `isRequired`. Returns `{ required, source }` over the closed
   `REQUIRED_SOURCES` vocabulary, strictly ordered: `native_required` → `aria_required` →
   `ats_metadata` → `group_requirement` → `associated_visual_marker` → `none`. A visual marker
   counts only inside a caption the platform binds to this exact control (`label[for]`, a
   wrapping `<label>`, `aria-labelledby`) or inside an `exclusiveContainer` — a container proven
   to hold this control (or this whole group) and nothing else answerable. `aria-invalid` and
   all validation wording are gone. `requiredSource` travels on `DetectedField` and into the
   Phase 1 field trace.
3. **Central ownership marker** — `extension/src/content/ownedDom.ts` is the only place a content
   script may create a node, and it marks what it creates.
   `tests/extension/contentDomOwnership.test.ts` fails the build if any content module calls
   `createElement` directly.
4. **Two runtime assertions in `scanOnce`** — `extensionOwnedViolation` drops any group whose
   element is extension-owned and records a warning; `claimControls` **throws** if two fields
   would address one control, because writing a control twice and verifying neither is not a
   degraded result, it is a false report.
5. **`mergeFrameScans`** — `ownFields` drops a field whose source document (`metadata.frameUrl`)
   belongs to a _different_ frame that was also scanned, keeping the correctly-routed copy. When
   the owning frame was never scanned (injection failed, frame navigated), the parent's copy is
   kept — an imperfectly routed field beats a control nobody knows about. Dropped fields are
   counted into `duplicateControlsRemoved` rather than vanishing.
6. **`countFieldStatistics`** — one shared counter, used by both the content script and the merge,
   deriving every per-field number from the fields being reported.
7. **`sectionContext.ts`** — `experience` and `education` domains added, so "Location",
   "Position or Title", "Start Date" and "End Date" resolve against the block they sit in.

## Result on the fixture (`tests/fixtures/phase2-candidate-profile.html`)

| Measure                                         | Before  | After   |
| ----------------------------------------------- | ------- | ------- |
| Raw controls matched                            | 31      | 31      |
| False controls removed                          | 4       | 4       |
| Duplicate controls removed                      | 0       | 1       |
| Normalized fields (built extension, all frames) | 26      | 25      |
| Fields with a wrong section heading             | 18      | 0       |
| Fields with no required evidence recorded       | 25      | 0       |
| Reported "supported" vs actual field count      | 26 / 25 | 25 / 25 |

## Not touched

Document generation, document delivery, résumé/cover-letter upload execution, deterministic
field answers, saved application preferences, company-specific answers, legal acknowledgments,
demographic answers, subjective AI generation, job ingestion, sorting, scoring, AI Match, and
the Internship-AI website. This phase changed how controls are found and described, never what
is written into them. No code path clicks a final submit control.
