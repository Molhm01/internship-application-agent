# Phase 3 — dependency, company-fact, experience and education audit

Traced through the active pipeline: `domScanner` → `deterministicMatcher` →
`deterministicPlanner` → `domExecutor`/`dropdownEngine` → `domVerifier` →
`orchestrator` → `finalFieldStatus`.

Two fixtures reproduce the live page. `tests/fixtures/lab/lincoln-application.html`
carries the layout on native `<select>` controls;
`tests/fixtures/lab/lincoln-custom-controls.html` carries the same questions on the
control types the live portal actually renders — ARIA comboboxes, portal-mounted
menus, a React-style control that replaces its own trigger text, a searchable list,
and a list whose options arrive a frame late — with the education chain running
three deep (Country → State → School).

No model is involved anywhere in either run. `analyze` is counted and never
satisfied, so a field that needed one would appear as unanswered rather than
passing quietly.

---

## 1. Personal — State/Province

|                      |                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Normalized label     | `state province`                                                                               |
| Section              | `contact_information`                                                                          |
| DOM control          | native `<select>` (native fixture); portal-mounted `role="menu"` (custom fixture)              |
| Canonical intent     | `state`                                                                                        |
| Profile key          | `profile.personal.address.state` = "New Jersey" — **found**                                    |
| Options at scan time | one placeholder only (`Select a country first`)                                                |
| Planned action       | `missing_information` → on the pass after Country, `select_option` / `select_suggested_option` |
| Dependency parent    | Country (`profile.personal.address.country`)                                                   |
| Executor result      | verified                                                                                       |
| Verification         | `FILLED_VERIFIED`                                                                              |
| Failure code         | none                                                                                           |

**Live root cause.** Not a matching failure and not a missing profile value. The
page _replaces_ the State element when Country changes, so every reference taken
before Country landed pointed at a detached node, and the option list the scan had
recorded no longer existed. The old path matched against that scan snapshot and
asserted its `value` still existed, which is why a control the agent could drive
reported "Autofill failed" with the answer in hand.

**Repair, and what was already in place.** `EXECUTION_PRECEDENCE` puts `country`
ahead of everything, `awaitDependentOptions` waits on a MutationObserver bounded at
2 s rather than a fixed sleep, and the dropdown engine re-reads options from the
live control at the moment of the attempt for every widget shape. Added this pass:
the four stage-specific codes §2 named, so the four ways this control can fail stop
sharing one red badge —

- `STATE_OPTIONS_NOT_UPDATED` — Country was answered and the list never rebuilt
- `STATE_OPTION_NOT_FOUND` — the list rebuilt and does not offer the saved region
- `STATE_EXECUTION_FAILED` — the region is on the list and the page refused the click
- `STATE_VERIFICATION_FAILED` — it was selected and the control shows something else

They are a re-labelling of the engine's own stages for `canonicalKey === 'state'`
(`REGION_ERROR_CODES` in `domExecutor.ts`), not a second execution path.

## 2. Company-specific questions

| Question                               | Canonical intent         | Profile key        | Outcome                      |
| -------------------------------------- | ------------------------ | ------------------ | ---------------------------- |
| "…ever worked for [company]…"          | `previously_employed`    | none — **missing** | `USER_CONFIRMATION_REQUIRED` |
| "…contract or employment restriction…" | `employment_restriction` | none — **missing** | `USER_CONFIRMATION_REQUIRED` |
| "…relatives…employed by our Company?"  | `family_member_employed` | none — **missing** | `USER_CONFIRMATION_REQUIRED` |

**Live root cause.** "Are you under any contract or employment restriction with a
current or previous employer?" contains the word _employer_, so it matched the
`employer` question and the planner offered a company **name** to a Yes/No control.
The page refused it and the report called it a failed autofill. Separately, prior
employment was answered from `experience[0].current === false` — asserting to an
employer that the applicant had never worked there, on the strength of nobody having
been asked.

**Result.** All three are their own canonical questions, none has a profile-wide
default, and none is inferable. Each resolves to `USER_CONFIRMATION_REQUIRED` with
an orange "Information needed" mark — never a guessed Yes or No, and never a generic
"waiting on the page analysis" that blames a model with nothing to do with it.

## 3. The conditional relatives field — the critical bug

|                         |                                                                             |
| ----------------------- | --------------------------------------------------------------------------- |
| Normalized label        | `if yes please provide the name location and relationship of each relative` |
| Control                 | `textarea` (enabled and typeable — the page merely ignores it)              |
| Dependency parent       | the relatives question, activation value `yes`                              |
| Outcome, parent unknown | untouched, `USER_CONFIRMATION_REQUIRED` naming the parent                   |
| Outcome, parent = No    | untouched, **`OPTIONAL_LEFT_BLANK`**, no mark                               |
| Outcome, parent = Yes   | activated; saved details, else `USER_CONFIRMATION_REQUIRED`                 |

**Live root cause.** The label contains the word "name", so the matcher found the
applicant's own legal name and the planner filled it — while the relatives question
above it had no answer at all. The form then stated to an employer that the
applicant had a relative working there. Nobody had said that.

**Repair.** Three layers, none trusting the others:

1. `markConditionalChildren` (scanner) records the relationship from the page's own
   words (`^if (yes|no|other|another|none)`) and stores the parent's selector.
2. `conditionalGateFor` (planner) reads the parent's **observed** `currentValue`
   from the same scan — never the plan's intention, because a plan that intends to
   choose "Other" has not chosen it.
3. `conditionalGateViolation` (executor) re-reads the parent out of the live
   document and refuses the write with `PARENT_ANSWER_REQUIRED`, even when handed
   an approved action.

**Fixed this pass.** The parent-answered-No case was reported as
`USER_CONFIRMATION_REQUIRED` with an orange badge — the form had switched the
question off and the agent was still asking for it. The planner now distinguishes
_not applicable_ (parent answered, not the activating value → `skip`) from _not
decidable_ (parent unanswered → `missing_information`), and the orchestrator treats
a gated-off child as an optional blank regardless of the `required` flag the page
carries on it.

## 4. Work experience

| Field                  | Canonical intent        | Profile key                      | Result                                             |
| ---------------------- | ----------------------- | -------------------------------- | -------------------------------------------------- |
| Company Name           | `employer`              | `experience[n].employer`         | `FILLED_VERIFIED`                                  |
| Position Title         | `job_title`             | `experience[n].title`            | `FILLED_VERIFIED`                                  |
| From Date              | `employment_start_date` | `experience[n].startDate`        | `FILLED_VERIFIED`                                  |
| End Date               | `employment_end_date`   | `experience[n].endDate`          | `FILLED_VERIFIED`                                  |
| End Date, current role | `employment_end_date`   | none, by design                  | **`OPTIONAL_LEFT_BLANK`**                          |
| I currently work here  | `currently_employed`    | `experience[n].current`          | `FILLED_VERIFIED`                                  |
| Employment Type        | `employment_type`       | `experience[n].employmentType`   | `FILLED_VERIFIED`, or `USER_CONFIRMATION_REQUIRED` |
| Reason for Leaving     | `reason_for_leaving`    | `experience[n].reasonForLeaving` | `FILLED_VERIFIED`, or `USER_CONFIRMATION_REQUIRED` |

**Live root cause.** `employment_type` and `reason_for_leaving` resolved to no
canonical question at all, so both controls sat at "No Selection" on every run while
the planner reported them as waiting on an analysis that had nothing to say about
them. Dates went through the same path and were reported the same way.

**Dates.** Every factual date is formatted by the one clockless formatter. A saved
`YYYY-MM` fills a month control directly; a control demanding `MM/DD/YYYY` from a
month-only record yields `confirmation_required`, never a fabricated day. Today's
date is never a fallback anywhere.

**Fixed this pass.** A current role's End Date was `manual_review` →
`USER_CONFIRMATION_REQUIRED` with an orange badge, asking the applicant to supply a
date that must not exist beside a "currently work here" box the agent had just
ticked and verified. `notApplicableByRecord` now reports it as correctly blank.

**Employment type** is matched semantically against the options the control is
actually offering (`Internship` → "Internship"), and is never inferred from the
company name: an employer called "Freelance" is not a statement about how the work
was classified, and a form offering Contract, Self-Employed and Internship
separately is asking a distinction a company name cannot settle. With nothing saved,
both this and Reason for Leaving ask.

## 5. Education

| Field              | Canonical intent            | Source                                                                     | Result                                   |
| ------------------ | --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| Education Type     | `education_type`            | `education[n].degree`, with the institution-kind reading as an alternative | `FILLED_VERIFIED`                        |
| Education Country  | `country` (education block) | institution country                                                        | `FILLED_VERIFIED`                        |
| Education State    | `state` (education block)   | institution state                                                          | `FILLED_VERIFIED` after Country          |
| School/Institution | `school`                    | `education[n].institution`                                                 | `FILLED_VERIFIED` after State            |
| If other, School   | `school` (conditional)      | gated on School = Other                                                    | blank + `OPTIONAL_LEFT_BLANK`, or filled |
| Area of Study      | `major`                     | `education[n].major`                                                       | `FILLED_VERIFIED`                        |
| If other, Area     | `major` (conditional)       | gated on Area = Other                                                      | blank + `OPTIONAL_LEFT_BLANK`, or filled |
| Graduated?         | `graduated`                 | `education[n].status`                                                      | `FILLED_VERIFIED`                        |

**Education Type — live root cause.** The value offered was the _institution kind_
("College/University") and the live list named _programmes_
("Bachelor's Degree Program (or equivalent)"). Nothing matched, and the control
stayed at No Selection with the correct option visible in the open menu. Both are
restatements of the same saved record, so `educationTypeAlternatives` supplies both,
degree first, and the page's own list decides. Nothing is inferred beyond the
credential the applicant recorded; an unmapped degree makes this the user's question
rather than a guess.

**Graduated? — live root cause.** It matched `graduation_date`, so the planner
offered a **date** to a Yes/No dropdown and no option matched. It is now its own
question answered from the record's status alone: `completed` → Yes, `in_progress` →
No, anything else → `USER_CONFIRMATION_REQUIRED`. A future graduation date is not a
completion, and today's date is not evidence about anybody's degree.

**The chain.** Country → State → School are not planned simultaneously. Country
carries execution precedence, `awaitDependentOptions` waits on the dependent
controls, and each pass re-reads the list the previous control produced. In the
custom fixture the School list is empty for every query until a state is settled, so
"School selects after State" is an observable ordering rather than a coincidence of
document order.

**"If other" — fixed this pass, and it was broken worst on custom controls.**
`selectedValue` in the scanner returned `undefined` for any control that is not a
`<select>`, `<input>` or `<textarea>` — which is every custom widget, because a
custom widget holds no value at all. The conditional gate reads the parent's
`currentValue`, so on a custom parent it saw _no answer, ever_. Both halves of §11
and §13 were therefore broken there: the box could not be filled when Other really
was selected, and it wore an orange "Information needed" badge when the school had
been found normally. `readSelectedText` — the routine the executor already used to
verify a custom selection — moved down into `optionDiscovery`, the layer the scanner
and executor share, and the scanner now records what an option control _displays_ as
its current value.

## 6. Dropdown execution

One engine, every widget shape: open → enumerate what is offered **now** → match →
click the real element → verify what the control displays → close. Options are never
matched against the scan snapshot. `contractViolation` is enforced twice, in the
planner and again in the executor, neither trusting the other: `SELECT_OPTION` never
reaches a text field and `SET_TEXT` never reaches a real dropdown. Success is
reported from observed DOM state, never from planner output.

## 7. Stale marks

One table, `ANNOTATION_BY_FINAL_STATUS`, maps outcome to mark, with the final status
as the only input — the earlier bug was a mark chosen from a review reason computed
_before_ execution and never revisited. `FILLED_VERIFIED` → green and nothing else;
`OPTIONAL_LEFT_BLANK` → grey, no orange and no red; `SKIPPED_ALREADY_VALID` → no
mark at all. Every field is redrawn on the final pass, verified ones included, so a
field omitted from the redraw cannot keep a mark an earlier pass gave it.

## 8. What remains the user's

By design, and reported as `USER_CONFIRMATION_REQUIRED` rather than as failure:
the three company-specific facts; Employment Type and Reason for Leaving when the
experience record does not state them; the relatives detail box while its parent is
unanswered. None of these is inferable from a résumé, and none is guessed.
