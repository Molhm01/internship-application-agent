# Dropdown execution and repeatable sections — root cause

Why every dropdown on the live portal reported "Autofill failed" while the same
page filled its text fields correctly, and why a profile holding three jobs and
two schools reached the employer as one job and one school.

Two defects, independent of each other, each affecting an entire class of field.

---

## Part 1 — What the failing controls actually are

Inspected against the live portal's markup, reproduced in
`tests/fixtures/lab/lincoln-custom-controls.html` and
`tests/fixtures/lab/lincoln-repeaters.html`.

The failing controls are **not one widget type**. That was the first wrong
assumption: the field list looked like a mapping problem because State,
Employment Type, Education Type, School and Area of Study appeared unrelated. In
fact they share exactly one property — **none of them is a `<select>`** — and
that property alone determined whether the field worked.

| Property                                | Personal State                     | Employment Type / Reason | Education Type | Education Country | Education State            | School                                  | Area of Study  | Graduated?     |
| --------------------------------------- | ---------------------------------- | ------------------------ | -------------- | ----------------- | -------------------------- | --------------------------------------- | -------------- | -------------- |
| Element type                            | `div` wrapper                      | `div` wrapper            | `div` wrapper  | `div` wrapper     | `div` wrapper              | `div` wrapper                           | `div` wrapper  | `div` wrapper  |
| Clickable trigger                       | inner `button`                     | inner `button`           | inner `button` | inner `button`    | inner `button`             | inner `input`                           | inner `button` | inner `button` |
| `role` on trigger                       | — (`aria-haspopup="menu"`)         | `combobox`               | `combobox`     | `combobox`        | — (`aria-haspopup="menu"`) | `combobox` + `aria-autocomplete="list"` | `combobox`     | `combobox`     |
| Native `<select>` present               | **No**                             | **No**                   | **No**         | **No**            | **No**                     | **No**                                  | **No**         | **No**         |
| Options in DOM before opening           | **No**                             | **No**                   | **No**         | **No**            | **No**                     | **No**                                  | **No**         | **No**         |
| Options inserted on open                | Yes                                | Yes                      | Yes            | Yes               | Yes                        | Yes (after query)                       | Yes            | Yes            |
| Rendered in a portal on `document.body` | **Yes**                            | No                       | No             | No                | **Yes**                    | No                                      | No             | No             |
| Inside a shadow root                    | No                                 | No                       | No             | No                | No                         | No                                      | No             | No             |
| Keyboard interaction required           | No                                 | No                       | No             | No                | No                         | No                                      | No             | No             |
| Setting `.value` ignored                | **Yes** — no value property exists | Yes                      | Yes            | Yes               | Yes                        | Yes                                     | Yes            | Yes            |
| Synthetic `input`/`change` ignored      | **Yes**                            | Yes                      | Yes            | Yes               | Yes                        | Yes                                     | Yes            | Yes            |
| Framework-controlled                    | Yes                                | Yes                      | Yes            | Yes               | Yes                        | Yes                                     | Yes            | Yes            |
| Disabled until a parent changes         | **Yes** (Country)                  | No                       | No             | No                | **Yes** (Ed. Country)      | **Yes** (Ed. State)                     | No             | No             |

Three structural facts follow, and each one breaks a different assumption the
old executor was built on:

1. **The control holds no value.** There is no `.value` to set and no
   `selectedIndex` to read. The answer exists only as the text the trigger
   renders. Any code that wrote a value wrote it to an object the page does not
   consult, and any code that read one read an empty string.
2. **The options do not exist until the control is opened.** A scan of the
   static DOM sees a button and nothing else. The option list is created on
   `mousedown`, and for State and Education State it is mounted into
   `document.body` — so it is not a descendant of the field at all.
3. **Three of them are populated by the field above them.** Education Country →
   Education State → School is a chain, and each link is empty and disabled
   until its parent is verified.

## Part 1b — Why the executor failed

The old code had two paths, and the split between them was the bug.

Anything the scanner labelled a `select` went through `applyValue`. That function
matched the desired answer against **the option snapshot the scanner had taken**,
then asserted that snapshot's `value` still existed on the element, then assigned
`element.value`. Against the controls above this fails three times over: the
snapshot was empty (options did not exist at scan time), there is no `value`
property to assign, and the assignment fires no event the framework observes.

The failure was reported as a generic `Autofill failed`, which is why the field
list looked like a mapping problem. It never was. **Every one of these fields had
the correct answer in hand and never attempted an option selection at all.**

Personal State failed for an additional, compounding reason: it is populated by
Country. Even a correct executor that ran it in plan order would find an empty,
disabled control, because Country had not yet been committed when State's options
were read.

### Failure-stage vocabulary

`Autofill failed` is no longer produced for any dropdown. Every attempt now ends
at a named stage, carried on `DropdownExecutionResult.failureCode` and surfaced
in the diagnostic trace. The names in this codebase and the stages Part 4 of the
brief asked for line up one-to-one:

| Stage asked for              | Code in `dropdownExecution.ts`                                             |
| ---------------------------- | -------------------------------------------------------------------------- |
| `OPTION_CONTROL_NOT_OPENED`  | `OPEN_FAILED`                                                              |
| `OPTION_CONTAINER_NOT_FOUND` | `OPTION_CONTAINER_NOT_FOUND`                                               |
| `OPTION_TARGET_NOT_FOUND`    | `OPTION_NOT_FOUND` / `NO_SEMANTIC_OPTION_MATCH` / `AMBIGUOUS_OPTION_MATCH` |
| `OPTION_CLICK_FAILED`        | `OPTION_CLICK_FAILED`                                                      |
| `OPTION_VALUE_NOT_UPDATED`   | `SELECTION_NOT_ACCEPTED`                                                   |
| `OPTION_VERIFICATION_FAILED` | `VERIFICATION_FAILED`                                                      |
| `DEPENDENCY_NOT_READY`       | `DEPENDENT_CONTROL_NOT_REFRESHED`                                          |

Two further codes distinguish cases that would otherwise be reported as
failures but are not: `ANSWER_UNKNOWN` (nothing saved answers this question — the
applicant's to answer, not a defect) and `CONTROL_DISABLED`.

---

## Part 2 — The repeatable sections

Separate defect, same page.

The Work Experience and Education sections each ship with **one** block and an
**Add** control. Nothing in the extension had ever pressed Add. The consequence
was worse than "only the first record was filled":

- Records 2..n did not appear in the report as unfilled, because a block that
  does not exist has no field to be unanswered. The run reported success.
- Every "Company Name" control on the page carries the same canonical question.
  With no notion of a block, field resolution returned the first match — so had a
  second block existed, it would have been filled from `experience[0]`.

That second point is why block isolation is a correctness requirement and not a
tidiness one. A repeater without scoping does not merely miss records; it
**duplicates one record across every block**, which is a fabricated employment
history on a real application.

### The repeat-run hazard

Pressing Autofill twice is ordinary — the applicant corrects a box and runs it
again. A repeater that decides how many times to press Add from the _record
count_ rather than from _record count minus blocks already present_ doubles the
section on every run. `planRepeatedSection` therefore takes the live block count
as input and returns `addPresses = max(0, records − blocks)`; a second run over a
grown page computes zero presses and maps every record to
`MATCHED_EXISTING_BLOCK`.

---

## What was changed

**One executor, three strategies, chosen from the DOM** —
`extension/src/executor/dropdownEngine.ts`. `classifyDropdown` decides from the
element what the control is, never from what it calls itself.

- **A — Native `<select>`.** Options re-read from the live control, set through
  the `HTMLSelectElement.prototype.value` setter so a framework observes it,
  `input`/`change`/`blur` dispatched, verified against `value`, `selectedIndex`
  and `selectedOptions[0]`. A value already correct is left alone rather than
  re-fired, because a redundant `change` on Country rebuilds the State list and
  discards the state chosen moments earlier.
- **B — Custom control.** Open the real trigger, wait for the list to hold
  entries, enumerate _all_ of them (scrolling a long or virtualized list, then
  restoring its position), match, re-find the element, click it with a full
  pointer sequence, wait for the trigger's text to show it, close. Options are
  found inside the container, as siblings, or in a portal on `document.body`.
- **C — Keyboard.** Reached when a click cannot be used: the matched row is no
  longer rendered, or the click landed and the control still shows nothing —
  the signature of a widget that commits only from its own `keydown` handler.
  The highlight is _read_ after each ArrowDown rather than counted towards, and
  the walk stops on a wrap, on the option count, or on a hard 60-press ceiling.

Every strategy ends in the same place: **the control's own displayed state is
read back, and that read alone decides the verdict.** A setter that did not throw
is not evidence.

**Two verification false-positives** were found while testing Strategy C and
fixed in `optionDiscovery.ts`, both in `readSelectedText`:

- `aria-activedescendant` was read as the committed answer. While a menu is open
  that attribute is the keyboard _cursor_. Walking the highlight onto "New
  Jersey" made the control report New Jersey as selected having accepted
  nothing. It is now trusted only while the control reports itself closed.
- The container-text fallback included the option list's own text. A hidden menu
  still contributes every label to `textContent`, so the string "contains"
  whichever answer was being verified — a verification that cannot fail. The
  option list is now excluded from that read.

**Repeaters** — `shared/logic/repeatedSections.ts` (pure arithmetic) and
`extension/src/content/repeatedSections.ts` (the interaction). Add is pressed one
press at a time, each waited for and counted before the next, bounded by
`ADD_WAIT_MS` and by a `MAX_BLOCKS` ceiling. A press that produces no block ends
the loop and is recorded as `FAILED_TO_CREATE_BLOCK` rather than retried.

**Dependency chains** — `extension/src/content/dependentOptions.ts`. A dependent
control is not read until its parent is verified and its own option list has
actually changed.
