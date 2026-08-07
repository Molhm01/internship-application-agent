# Lincoln live-form audit

Each field the live run got wrong, traced from the scanner to the final status, with the cause and
the repair. Every row was reproduced against a fixture of the same shape before it was fixed, and
re-run after; the "after" column is observed behaviour, not intent.

No field value, saved answer, credential, or token appears in this document or in the run trace it
describes.

---

## 1. Profile — State/Province stayed "No Selection"

| Stage             | Before                                                                |
| ----------------- | --------------------------------------------------------------------- |
| intent            | `state`                                                               |
| answer source     | `profile.personal.address.state` — **known**                          |
| control           | native `<select>`, replaced (not mutated) when Country fires `change` |
| dependency parent | Country                                                               |
| options at plan   | one placeholder, "Select a country first"                             |
| planned           | `missing_information` (correctly, on pass 1)                          |
| final status      | **USER_CONFIRMATION_REQUIRED**, and the control stayed empty          |

**Cause.** Not a dropdown defect. Country selects on pass 1, the page replaces the State element,
and the run's second pass re-scans and fills it — that machinery was already correct and is verified
here. What was missing was everything _around_ it: on the live page State sat below three questions
whose plans were malformed (see §2 and §3), and the run's outcome for those was `FAILED_EXECUTION`,
which is what the user saw beside State.

**After.** `#state` = `NJ`, verified, on the pass after Country. The same cascade, through the same
engine, fills Education State/Province. Both are asserted against observed DOM state.

---

## 2. Prior employment — "Autofill failed", and a fabricated answer underneath it

| Stage         | Before                                    | After                          |
| ------------- | ----------------------------------------- | ------------------------------ |
| intent        | **`currently_employed`** (wrong)          | `previously_employed`          |
| answer source | `profile.experience[0].current` = `false` | none — no saved fact exists    |
| answer known  | **apparently yes** (it was not)           | no                             |
| planned       | `select_option` → "No"                    | `missing_information`          |
| final status  | FAILED_EXECUTION / a wrong answer         | **USER_CONFIRMATION_REQUIRED** |

**Cause.** "Are you currently employed by, or have you ever worked for, Lincoln Electric…" opens
with the words _currently employed by_, and the `currently_employed` rule — which exists for the "I
currently work here" checkbox beside a job's end date — claimed it before `previously_employed`
could. The planner then answered a question about _this employer_ from an unrelated fact about the
applicant's most recent job.

This was worse than a mis-fill. A blank would have been honest; "No" asserted to an employer that
the applicant had never worked there, on the strength of nobody having been asked.

**Repair.** A negative lookahead on the `currently_employed` rule, so a label also carrying _ever_,
_previously_, _before_, _our company_, _this company_ or _subsidiar…_ is not claimed by it. The
question resolves to `previously_employed`, which `companyRelationship.ts` already refuses to answer
without a recorded fact.

---

## 3. Employment restriction — a company name offered to a Yes/No dropdown

| Stage         | Before                                                | After                          |
| ------------- | ----------------------------------------------------- | ------------------------------ |
| intent        | **`employer`** (wrong)                                | `employment_restriction` (new) |
| answer source | `profile.experience[0].employer` — a company **name** | none                           |
| planned       | `select_option` against options `Yes` / `No`          | `missing_information`          |
| failure code  | `NO_OPTION_MATCH`                                     | —                              |
| final status  | **FAILED_EXECUTION** ("Autofill failed")              | **USER_CONFIRMATION_REQUIRED** |

**Cause.** The label contains the word "employer", and `{ question: 'employer', patterns:
[/\b(employer|company name|organization)\b/] }` matched it. The planner offered a saved company name
to a Yes/No control, the page refused it, and the report called that a failed autofill — for a legal
question about the applicant's own agreements that no profile field states.

**Repair.** Its own canonical question, matched ahead of `employer`, and added to
`ALWAYS_CONFIRM_QUESTIONS` so no policy can ever answer it from inference.

---

## 4 & 5. Relatives — unresolved parent, and a child filled with the applicant's own name

| Stage        | Before                                                  | After                                  |
| ------------ | ------------------------------------------------------- | -------------------------------------- |
| parent       | `family_member_employed` → unanswered (already correct) | unchanged — USER_CONFIRMATION_REQUIRED |
| child        | "If yes, provide the name, location, and relationship…" | `dependsOn: { parent, value: "yes" }`  |
| child intent | matched a **name** question — the label contains "name" | gated before any intent is consulted   |
| child result | **filled with the applicant's own name**                | untouched; `PARENT_ANSWER_REQUIRED`    |

**Cause.** Nothing modelled conditional dependencies. The child was an ordinary field whose label
happened to contain "name", so an ordinary name lookup answered it — while the question it belongs
to had no answer at all. The form then stated to the employer that the applicant had a relative
working there.

**Repair, in two independent places.**

- The scanner marks a control whose label opens `If yes,` / `If other,` as a conditional child and
  records its parent (the nearest preceding control that offers choices) and the activating value.
- The planner refuses to plan anything for an inactive child, **before** any answer lookup runs.
- The executor re-checks the parent's value against the **live page** and refuses the write, exactly
  as the control-type contract is checked twice. Neither trusts the other: a plan is built from a
  scan taken some time ago, and the activating answer can be cleared in between.

Exercised directly by a test that hands the executor an approved, correctly-shaped `fill_text`
action for the child and asserts it is refused with `PARENT_ANSWER_REQUIRED` and the box stays empty.

---

## 6 & 7. Work experience — From Date and End Date stayed blank

| Stage        | Before                                       | After                                   |
| ------------ | -------------------------------------------- | --------------------------------------- |
| intent       | **none** — "From Date" matched no rule       | `employment_start_date`                 |
| planned      | `missing_information`, "waiting on analysis" | `set_date`                              |
| final status | USER_CONFIRMATION_REQUIRED                   | **FILLED_VERIFIED** from the saved date |

**Cause.** `employment_start_date` matched `\bstart date\b` only. The live form says "From Date",
which matched nothing at all, so the control carried no canonical question and the planner reported
it as waiting on an analysis that had no opinion about it. `sectionContext` had a `from` → start-date
entry, but the label is "From Date", not "From".

**Repair.** `^from date$` and `^date from$` on the start rule, `^to date$` / `^date to$` on the end
rule. No current-date fallback exists anywhere; a record with no saved date still yields nothing.

---

## 8 & 9. Employment Type and Reason for Leaving stayed "No Selection"

| Stage         | Before                     | After (no saved fact)          | After (saved fact)  |
| ------------- | -------------------------- | ------------------------------ | ------------------- |
| intent        | **none**                   | `employment_type` (new)        | same                |
| answer source | —                          | `experience[i].employmentType` | same                |
| planned       | `missing_information`      | `missing_information`          | `select_option`     |
| final status  | USER_CONFIRMATION_REQUIRED | **USER_CONFIRMATION_REQUIRED** | **FILLED_VERIFIED** |

**Cause.** Neither control had a canonical question, so neither had an answer source — the profile
had nowhere to record either fact.

**Repair.** Two new canonical questions, two new optional fields on `experienceEntrySchema`, and
both added to `AI_PROHIBITED_QUESTIONS`: they are matters of record, and with nothing saved the
honest outcome is the applicant's to give. Specifically **not** inferred from the company name — a
test asserts that an employer named "Freelance" leaves Employment Type unanswered, because the form
offers Self-Employed and Contract separately and a company name settles neither.

---

## 10. Extra blank experience blocks

| Stage        | Before                               | After                     |
| ------------ | ------------------------------------ | ------------------------- |
| record       | **`experience[0]` for every block**  | `experience[recordIndex]` |
| blocks 2 & 3 | filled with the first job's details  | untouched                 |
| final status | FILLED_VERIFIED (of fabricated data) | **OPTIONAL_LEFT_BLANK**   |

**Cause.** Every "Company Name" on the page shares one canonical question, and the matcher read
`profile.experience[0]` unconditionally. Three employer blocks and one saved job produced an
application listing that job three times, with the same title and the same dates.

**Repair.** The scanner numbers the controls of a repeating block by occurrence — the Nth "Company
Name" belongs to the Nth employer, and so does the Nth "From Date" beside it — restricted to the
experience and education sections, which are the only ones that genuinely repeat. The matcher reads
`experience[recordIndex]`; the planner skips a block whose record does not exist, reporting it as
deliberately blank rather than as outstanding work. Conditional children are excluded from the
count: "If other, enter School" is the same question asked twice, not a second school.

The run trace now carries `recordIndex`, so "three employers filled" and "one employer filled into
three blocks" are distinguishable from the outside — they were not.

---

## 11–13, 16. Education Type, Country, State, Graduated?

| Field             | Before                                  | After                        |
| ----------------- | --------------------------------------- | ---------------------------- |
| Education Type    | intent **none** → No Selection          | `education_type` → `college` |
| Education Country | `country` → planned, blocked downstream | `US`, verified               |
| Education State   | dependent, never reached                | `NJ`, after Country          |
| Graduated?        | intent **`graduation_date`** → a date   | `graduated` → `no`           |

**Graduated? cause.** The `graduation_date` rule ends with a bare `/\bgraduat/` catch-all, which
claims "Graduated?". A Yes/No control was therefore offered "May 2027", no option matched, and the
run reported a failed autofill for a question the record answers plainly.

**Repair.** A `graduated` question matched _ahead_ of `graduation_date`, answered from
`education[i].status`: `in_progress` → No, `completed` → Yes, anything else → the user's. Never from
a date and never from today. `education_type` is a closed mapping from the recorded credential to
the kind of institution, and `undefined` for anything it does not cover.

One regression was introduced and caught here: an early `\b(degree|program) awarded\b` pattern stole
"Highest Degree Awarded" from its own question. It was removed — that phrase asks _which_ credential,
not whether there is one.

---

## 14 & 15. School and Area of Study — free text filled, dropdown left unset

| Stage        | Before                                    | After (exact)   | After (fallback)              |
| ------------ | ----------------------------------------- | --------------- | ----------------------------- |
| dropdown     | **No Selection**                          | exact option    | `Other`, verified first       |
| "If other"   | **filled** with the saved value           | left blank      | filled, on the following pass |
| final status | the employer reads no school named at all | FILLED_VERIFIED | both FILLED_VERIFIED          |

**Cause, two halves.** The dropdown: `major` and `school` are in `AI_PROHIBITED_QUESTIONS`, and the
planner's deferral guard used `mayReasonAbout` — a rule about what a _model_ may invent — to decide
what could be matched against a live option list. Matching a school the applicant already recorded
against the options a page offers involves no model and invents nothing, but the guard blocked it,
so the control was reported as manual review with the answer in hand. The free-text box: nothing
gated it, so it filled from the same saved value regardless of what the dropdown held.

**Repair.** The guard now uses `isNeverGuessedQuestion` — sensitive characteristics, employer
relationships, and eligibility statements — which is the set it was always meant to be. The
"If other" box is a conditional child of the dropdown above it, so it fills only on a pass where the
dropdown is **observed** to hold Other. The ordering is not a sequencing trick; it falls out of the
gate reading live state.

---

## Vocabulary

Distinct final diagnostic codes, so two different problems stop looking alike:

`ANSWER_UNKNOWN` · `CONTROL_NOT_FOUND` · `CONTROL_DISABLED` · `DROPDOWN_OPEN_FAILED` ·
`DROPDOWN_NO_OPTIONS_FOUND` · `OPTION_NOT_FOUND` · `NO_SEMANTIC_OPTION_MATCH` · `OPTION_DISABLED` ·
`OPTION_CLICK_FAILED` · `SELECTION_NOT_ACCEPTED` · `OPTION_VALUE_NOT_VERIFIED` ·
`DEPENDENT_CONTROL_NOT_REFRESHED` · `PARENT_ANSWER_REQUIRED`

`FAILED_EXECUTION` is reachable only when an answer was known, the control existed, a write was
attempted, and the page did not keep it. Everything else is the applicant's question, a block that
does not apply, or a control that has not had its turn yet.
