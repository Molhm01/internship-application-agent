# Phase 3.6 — dropdown selection and repeated sections

Two release-blocking failures, traced through the active runtime and repaired. Every root cause
below was reproduced against a fixture before it was fixed and re-run after; the "after" column is
observed behaviour.

No field value, saved answer, credential, or token appears here or in the run trace this describes.

---

## Part A — dropdowns that open but do not select

### A1. The option list was read once, at the moment it opened

**Active path.** `domScanner` → `deterministicPlanner` → `domExecutor` → `dropdownEngine` →
`optionDiscovery.readOptions` → `matchDropdownOption` → click → verify.

`readOptions` performs one `querySelectorAll` over the popup. That is the complete list for a short
menu and is _not_ the complete list for a long one:

- a **scrollable** list has every option in the DOM, most outside the visible box;
- a **virtualized** list has only the visible rows as elements at all.

The Area of Study control is the second kind. "Electrical Engineering" sits ~46 entries down a
66-entry list, so it was not an element when the list was read, the match failed, and — because
`major` permits the escape hatch — the engine selected nothing and the run fell through to the
"If other" box. That is the live symptom exactly: a free-text field carrying the answer beside a
dropdown reading **No Selection**.

**Repair.** `enumerateAllOptions` reads, scrolls one viewport, reads again, deduplicates by
normalized label and value, and stops at the bottom or when a step reveals nothing new. Bounded by
`MAX_SCROLL_STEPS` (40) and by that no-progress rule; a list that is already complete costs one read
and no scrolling. The scroll position is restored afterwards.

A second defect fell out of the first: restoring the scroll position **un-renders the matched row**
on a virtualized list, so the click then failed with `OPTION_CLICK_FAILED`. `revealOption` scrolls
the match back into existence before clicking it.

|                                                | before                     | after                 |
| ---------------------------------------------- | -------------------------- | --------------------- |
| options enumerated (66-entry virtualized list) | 8                          | 66                    |
| Electrical Engineering                         | `OPTION_NOT_FOUND` → Other | selected and verified |

### A2. Education Type was answered in the wrong vocabulary

The live list names **degree programmes**:

```
High School or GED · Trade or Vocational · Associate Degree Program (or equivalent)
Bachelor's Degree Program (or equivalent) · Master's Degree Program (or equivalent)
```

`educationTypeFor()` proposed `"College/University"` — a kind of _institution_. Measured directly:

```
"College/University" -> NONE      (no match against the live list)
"Bachelor's Degree"  -> Bachelor's Degree Program (or equivalent)   (semantic)
```

So the answer was never wrong; it was the wrong _reading_ of the record. Another employer's list
names institutions, where the reverse is true — a single proposed value cannot answer both.

**Repair.** `educationTypeAlternatives()` supplies both readings of the same record, most specific
first (`degreeLevel`, `degree`, institution kind), carried on `MatchHint.alternativeValues` — a
values-only channel with no field able to express a selector or an index. `matchWithAlternatives`
tries each against the page's own list and the first that matches wins. "Other" is tried only after
every real reading has failed, so a form that _does_ list the answer is never sent to Other because
the first wording missed.

### A3. Searchable lists that never render everything

Some lists fetch on a query and show a truncated set until they get one; no amount of scrolling
reaches the rest. After enumeration and matching both fail, a control that declares itself
searchable is typed into, re-enumerated, and re-matched. Only searchable controls — typing into one
that is not leaves a query in a box with nothing selected, which is its own live failure.

### A4. Country → State, Education Country → Education State

One generic engine, unchanged from Phase 3.5 and verified again here against a 20-country list that
needs scrolling: select Country, verify, discard the old element, re-query, enumerate the _fresh_
list, select, verify. No stale element, no stale option snapshot, no fixed sleep.

---

## Part B — repeated sections that only ever held one record

### B1. Nothing ever pressed Add

**Active path.** `profile.experience[]` → planner → `domExecutor`. There was no repeat-block
discovery, no Add-control discovery, and no code path anywhere that clicked one. A page offering one
Work Experience block held one job regardless of how many were saved — and the missing two did not
appear in the report either, because a block that does not exist has no field to be unanswered.

**Repair, in two pieces so the arithmetic can be read on its own.**

- `shared/logic/repeatedSections.ts` — pure. Given record count, block count, and whether an Add
  control exists, it produces the number of presses, the record-to-block assignment, and a status
  per record: `MATCHED_EXISTING_BLOCK`, `CREATED_NEW_BLOCK`, `BLOCK_LIMIT_REACHED`,
  `SKIPPED_NO_PAGE_SECTION`, `FAILED_TO_CREATE_BLOCK`.
- `extension/src/content/repeatedSections.ts` — browser. Finds the Add control, presses it once per
  missing block, and **observes each press before the next**. A press that produces nothing stops the
  loop and is recorded as `FAILED_TO_CREATE_BLOCK` rather than retried.

Two rules are load-bearing: never create a block for a record that does not exist, and never map one
record into two blocks. A page already showing more blocks than there are records is never pressed
at all, and the surplus blocks are left completely alone.

The Add control must **name its own section** ("Add Another Employer"). A bare "Add" is ambiguous, a
submit control is never an Add control, and two equally plausible candidates are refused rather than
guessed between.

### B2. Every block was answered from record [0]

`profileValue()` read `profile.experience[0]` unconditionally, and education read
`activeEducationEntry(profile)` — a page-global choice. Correct for a page with one block; for every
block after the first it repeats the same school, degree, and graduation status, which is a
fabricated history.

**Repair.** Experience, education, and projects all resolve `record[field.recordIndex]`. Education
keeps `activeEducationEntry` only when the field carries no index, so a single-block page still
answers "current degree" from the record the applicant is actually in.

### B3. Blocks were numbered by occurrence, and that was too blunt

The first implementation numbered the Nth occurrence of each canonical question as the Nth record.
That is true of "Company Name" and false of "graduation date": a form asking for one graduation
twice — once as a date picker, once as free text — was read as **two education records**, and the
second control was reported as a block the applicant had no record for. This regression was caught
by the existing Phase 4 tests.

**Repair.** Blocks are found from an **anchor** — the question a block of that kind cannot be
without (`employer`, `school`, `project_name`, with documented fallbacks). The block container is the
outermost ancestor holding exactly one anchor; every field inside it belongs to that record. A
section with fewer than two anchors is not numbered at all.

A conditional child inherits its parent's index without consuming a slot: "If other, enter School" is
the same question as the School dropdown, not a second school — but it must still be answered from
the same record, which is why the second block's "If other" box was briefly filled with the first
block's school.

### B4. Projects had no questions at all

The profile has `projects[]`; no canonical question named a project's columns, so a Projects section
resolved nothing. Seven questions added (`project_name`, `project_role`, `project_description`,
`project_technologies`, `project_url`, `project_start_date`, `project_end_date`), matched ahead of
the experience rules because both sections label their columns with the same bare nouns.
`project_role` is deliberately unanswerable — the profile records what a project _was_, not what the
applicant's title on it was called.

### B5. Incremental scanning

`onBlockAdded` fires per created block so the caller can scan that block alone. The orchestrator
re-reads once after a section has finished growing, not after every press — the new blocks are empty
and the rest of the page is unchanged.

### Diagnostic

One line per section, counts and statuses only:

```
[agent] autofill records
  experience: 3 record(s), blocks 1→3, 2 add press(es), #0=MATCHED_EXISTING_BLOCK #1=CREATED_NEW_BLOCK #2=CREATED_NEW_BLOCK
```

This separates the two ways a work history goes missing — a profile holding one job, and a page whose
Add button was never pressed — which produce the same one-block application and need completely
different responses.

---

## Conditional children

Unchanged from Phase 3.5 and re-verified: gated in the planner before any answer lookup, and again in
the executor against the live page. One repair was needed — both gates compared answers with a naive
lowercase, so a page spelling its escape hatch `Other/Not Listed` and storing it as `other_not_listed`
did not match the activation value `other`. Both now use the same normalizer the option matcher uses.

---

## Known limits

- Verified against fixtures through the real pipeline in jsdom. jsdom has no layout, so the
  virtualized-list cases model `scrollTop`/`scrollHeight` explicitly; live behaviour on the employer's
  own widgets has not been observed since this change.
- The Add control must name its section. A page whose only Add button says "Add" grows no blocks and
  reports its unplaced records as `BLOCK_LIMIT_REACHED` rather than guessing.
- Semantic matching remains deterministic. No model is involved in any of this.
