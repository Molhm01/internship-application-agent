# Phase 4 — education mapping and date-fallback audit

Traced before any change was made, against the code on `recovery/autofill-vertical-slice`
at `a416fb6`. Every file and line named here is the code that actually ran during the
live applications that produced the reported failures.

## 1. The active education path

```
DOM control
  → extension/src/scanner/domScanner.ts                       (DetectedField, label, section)
  → shared/logic/sectionContext.ts  contextualQuestionLabel() (folds the section heading in)
  → shared/logic/normalizeQuestion.ts  QUESTION_RULES         (canonical education intent)
  → extension/src/matcher/deterministicMatcher.ts  profileValue()   (profile education lookup)
  → shared/logic/formatters.ts  formatValue() → date()        (date formatter)
  → extension/src/planner/deterministicPlanner.ts  planAction()     (deterministic action)
  → extension/src/executor/domExecutor.ts  applyValue()       (executor)
  → extension/src/verifier/domVerifier.ts                     (verifier)
  → shared/logic/finalFieldStatus.ts  resolveFinalFieldStatus()     (final field status)
  → extension/src/content/highlighter.ts                      (page-mark renderer)
```

Second path, for anything the deterministic pass could not settle:

```
planAction() → 'missing_information'
  → extension/src/autofill/orchestrator.ts  (batched analysis)
  → shared/logic/unresolvedResolver.ts  resolveUnresolvedField()
      Tier 1 structuredProfileValue()  → Tier 2 approved answer → Tier 3 override
      → Tier 4 **AI suggestion**, gated only by mayReasonAbout()/AI_PROHIBITED_QUESTIONS
```

### Active components, named

| Concern                  | Active implementation                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Education mapper         | `shared/logic/normalizeQuestion.ts` lines 290–324 (the `// Education` rule block)        |
| Education profile source | `deterministicMatcher.ts` `profileValue()`; **`const education = profile.education[0]`** |
| Completed-degree logic   | `shared/logic/degreeLevel.ts` `degreeAnswersFor().highestCompletedDegree`                |
| Current-degree logic     | `profileValue().degree` — `profile.currentDegreeInProgress ?? education?.degree`         |
| Date formatter           | `shared/logic/formatters.ts` `date()` (private), reached via `formatValue()`             |
| Second-tier lookup       | `unresolvedResolver.ts` `structuredProfileValue()` lines 180–235                         |

## 2. Every current-date fallback reachable from the runtime

Searched `extension/src/**` and `shared/**` for `Date.now()`, `new Date()`, `today`,
`currentDate`, `fallbackDate`, `defaultDate`.

**Timestamps only — not values written to a form, and left alone:**
`orchestrator.ts` run timings, `agentClient.ts` latency, `reporter/fillReporter.ts`
`startedAt`/`completedAt`, `storage/settings.ts`, `credentials/vault.ts`,
`latestDocumentStore.ts` `receivedAt`, `deterministicPlanner.ts` `createdAt`/`updatedAt`,
`background/index.ts` `updatedAt`, `popup` elapsed-time counters, `DiagnosticsSection.tsx`
download filenames, `analysisMemo`/`autoStart`/`bundleStore` TTLs.

**Reachable paths that could put a fabricated date on an employer's form:**

1. **`formatters.ts` `date()` invented a day.** Two places:
   - `if (field.fieldType === 'date') return \`${year}-${month}-${day ?? '01'}\`;`
   - `if (/mm\/dd\/yyyy/i.test(...)) return \`${month}/${day ?? '01'}/${year}\`;`

   A profile storing `2027-05` (month and year, which is all a graduation is ever
   known to) became `2027-05-01` on a native date input. That is a day nobody stated.

2. **The AI tier answered date questions.** `AI_PROHIBITED_QUESTIONS` in
   `unresolvedResolver.ts` listed `graduation_date`, `graduation_month`,
   `graduation_year`, `employment_start_date`, `employment_end_date` — and **not**
   `earliest_start_date`, `internship_availability`, or `education_start_date`.
   Any of those three that the deterministic pass left open reached Tier 4, where a
   local model asked "When can you start?" answers with the date it believes today to
   be. This is the exact mechanism by which an internship availability date became
   the current date.

3. **Misclassification routed a date question into the AI tier.** See §3 below: a
   graduation control the mapper did not recognise carried no canonical key at all,
   and `mayReasonAbout(undefined)` returns `true`. An unrecognised
   "Anticipated Degree Completion Date" was therefore an ordinary open question and
   was answered by the model — again, with today.

## 3. Exact reason graduation dates became today's date

Three defects compounding:

1. `normalizeQuestion.ts` matched a graduation control only through
   `/\b(graduation|grad)\b.*\b(date|year|month)\b/` or
   `/\b(expected|anticipated) (completion|graduation)\b/` — the second requires the
   two words to be **adjacent**. Real wording is not:
   - "Anticipated Degree Completion Date" — `expected|anticipated` is followed by
     "degree", so the pattern fails.
   - "Degree Completion Date" — no `graduation`/`grad` token at all.

   Both then fell through to `{ question: 'degree', patterns: [/\bdegree\b/] }`, or
   past the education block entirely to `unknown`.

2. Classified `degree`, the field was offered the _degree name_ — a date control
   received "Bachelor's Degree", failed verification, and was reported as failed.
   Classified `unknown`, it went to the batched analysis, `mayReasonAbout(undefined)`
   allowed it, and the model supplied a date: the current one.

3. Even when classification was right, `date()` fabricated the day for a native
   `input[type=date]`, so `2027-05` silently became `2027-05-01`.

## 4. Exact reason completed and in-progress degrees were confused

The canonical split was already correct — `highest_degree_awarded` reads
`degreeAnswersFor().highestCompletedDegree`, `degree` reads the in-progress one — and
`degreeLevel.ts` is careful never to substitute one for the other. The confusion came
from the _lookup_, not the taxonomy:

1. **`profileValue()` fell back to `profile.education[0].degree`**:

   ```ts
   degree: {
     reference: profile.currentDegreeInProgress ? ... : 'profile.education[0].degree',
     value: profile.currentDegreeInProgress ?? education?.degree,
   }
   ```

   `profile.education[0]` is "the first stored education entry", which for a profile
   listing high school first **is the completed high-school record**. A form asking for
   the current degree program got "High School Diploma"; and every other education
   field in `profileValue()` (`school`, `major`, `minor`, `gpa`, `graduation_date`,
   `graduation_month`, `graduation_year`, `degree_level`) read that same
   `education[0]`, so all of them described the wrong record.

2. **`unresolvedResolver.ts` `structuredProfileValue()` was worse**: its `degree` entry
   read `education[0].degree` with **no** `currentDegreeInProgress` preference at all,
   so the second tier could contradict the first.

3. **"Bachelor's for every education-level question"** is the mirror image: for a
   profile whose only entry was the in-progress bachelor's, `education[0].degree`
   answered the _highest completed_ question through the `degree` rule whenever the
   wording missed `highest_degree_awarded`'s patterns — "Highest Level of Education
   Completed" matches, but "Education Level (Completed)" and "Degree Awarded to Date"
   did not, and `{ question: 'degree', patterns: [/\blevel of education\b/] }` caught
   them.

4. There was **no rule at all** for "Current degree", "Degree currently pursuing",
   "Current academic program", "Degree in progress", or "Current education program"
   beyond the bare `\bdegree\b` token — so "Current academic program" reached no
   education rule whatsoever.

## 5. Current-student status

`education_status` existed in `CANONICAL_QUESTIONS` and in
`CANONICAL_QUESTION_SECTIONS`, and had:

- **no pattern in `normalizeQuestion.ts`** — nothing on any page could ever classify
  as it;
- **no entry in `profileValue()` or `structuredProfileValue()`** — even if something
  had, there was no answer to give.

"Are you currently a university student?" therefore matched
`{ question: 'degree', patterns: [/\bdegree\b/] }` only when the wording happened to
contain "degree" ("Are you pursuing a degree?" → offered a degree _name_ to a Yes/No
radio), and was otherwise `unknown` → the AI tier.

## 6. Internship availability

`earliest_start_date` was mapped and read `profile.eligibility.earliestStartDate`
correctly. With that field unset the deterministic pass produced
`missing_information` with `requiresReview: false` (because
`mayReasonAbout('earliest_start_date')` was `true`), and Tier 4 answered it from the
model. Nothing in the pipeline said "this is a date and dates are never suggested".

## 7. Stale "Information needed" on filled education fields

Not a defect in the annotation code — `finalFieldStatus.ts` derives the mark from the
single final status, and Phase 3 fixed the ordering. The education fields wearing
"Information needed" after being filled were fields the run had genuinely _not_
settled: the value written was rejected by the control (a degree name in a date box,
§3), so verification failed and the honest status was reported. Fixing the mapping
fixes the mark.

## 8. The repair

1. **Canonical model.** `school`, `highest_degree_awarded`, `degree` (in progress),
   `degree_level`, `major`, `minor`, `gpa`, `education_start_date`, `graduation_date`,
   `graduation_month`, `graduation_year`, `education_status` (currently enrolled) and a
   new `enrolled_during_internship` are twelve separate answers.
   `highestCompletedDegree` and `currentDegreeInProgress` are never merged.

2. **`activeEducationEntry()`** (`shared/logic/degreeLevel.ts`) replaces
   `profile.education[0]` everywhere an education _fact_ is read: the entry marked
   `in_progress` wins, then one with a future graduation date, then — only when no
   entry states either — the first. School, major, minor, GPA, degree level and both
   education dates now describe the record the applicant is actually in.

3. **`educationLevelIntent()`** decides between completed and current wording, using
   the label, the help text, and the control's own options, and never defaults to a
   degree the applicant does not hold.

4. **`shared/logic/dateValues.ts`** is the one date formatter. It parses only
   `YYYY`, `YYYY-MM` and `YYYY-MM-DD`, determines the required shape from the control
   (`type`, `pattern`, `placeholder`, `min`/`max`, existing value), and returns either
   a value or `confirmation_required` with a sanitized reason. **It has no access to
   the clock**: there is no code path in it that can produce today's date. A day is
   never invented.

5. **`AI_PROHIBITED_QUESTIONS`** gains `earliest_start_date`,
   `internship_availability`, `education_start_date`, `education_status`,
   `enrolled_during_internship`, `degree`, `degree_level`, `major`, `minor`. Every
   factual date and every education credential is now unreachable from the model tier.

6. **`assertNoFabricatedDate()`** is asserted by a test that walks the built extension
   bundle for a clock reference inside the value-producing modules.
