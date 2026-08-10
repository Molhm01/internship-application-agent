# Dependency Engine Audit

Why State stays on "No Selection" after Country is answered correctly, and why the education chain
resolves by luck rather than by design.

## The short answer

There is no dependency graph. There never was one.

The codebase handles two _unrelated_ halves of what "depends on" means, with two mechanisms that do
not know about each other:

1. **Conditional children** (`If yes, …`, `If other, …`) get a real recorded edge —
   `field.dependsOn = { fieldId, value }` — created by `markConditionalChildren`
   (`extension/src/scanner/domScanner.ts:1632`). This half is genuinely good, and the relatives
   safety property is already enforced twice over.
2. **Option-refresh dependencies** (Country → State, Education Country → Education State → School)
   get **no edge at all**. They are inferred, one control at a time, from a heuristic called
   `isDependentControl` (`deterministicPlanner.ts:311`) that asks only _"is this select empty or
   showing nothing but a prompt?"_ — never _"whose answer produces its options?"_.

So the run knows that "If other, enter School" belongs to the School dropdown. It does not know that
the School dropdown belongs to Education State, that Education State belongs to Education Country, or
that State belongs to Country. Those relationships are not stored anywhere, so nothing can order the
work by them, and the ordering that does happen is a side effect of the pass loop running up to five
times and hoping the page settles in between.

## Trace of the current path

### How a dependent control is currently recognised

```ts
// deterministicPlanner.ts:311
export function isDependentControl(field: DetectedField): boolean {
  if (field.fieldType !== 'select' && field.fieldType !== 'radio') return false;
  const options = field.options ?? [];
  if (options.length === 0) return true;
  return options.every(isPlaceholderOption);
}
```

Three consequences, all load-bearing:

- **A custom combobox can never be dependent.** The type check admits only `select` and `radio`. A
  State control rendered as `<div role="combobox">` — which is what Workday, Icims and the Lincoln
  form use — falls straight through to the ordinary planner, which matches "New Jersey" against the
  empty option list it was scanned with, fails, and reports
  `No option on the page matched "New Jersey"`. That message blames the profile for the page's
  ordering.
- **Emptiness is not dependency.** A control that is empty because the page has not loaded its list
  yet, one that is empty because it is genuinely optional, and one that is empty because _another
  control has not been answered_ are indistinguishable here.
- **It names no parent.** `dependsOnLabel` (`deterministicPlanner.ts:319`) is the whole of the
  engine's knowledge about who produces whose options:

  ```ts
  function dependsOnLabel(field: DetectedField): string {
    return field.canonicalKey === 'state' ? 'Country' : 'the field it depends on';
  }
  ```

  One hard-coded pair, and a shrug for everything else.

### The exact State failure

The sequence the run actually performs:

```
pass 1  scan whole page          ← State scanned here, holding ["Select a country first"]
        plan whole page          ← State planned here, from that option set
        execute                  ← Country written and verified; State's action already exists
        awaitDependentOptions    ← waits for State to offer a real choice (this part works)
pass 2  scan whole page again    ← State now has real options
        plan whole page again
        execute                  ← State finally attempted
```

It converges _only_ when three things all hold: State is a native `<select>` or radio group, the page
produces its options inside the 2s bound, and the run has a pass left. Remove any one and State stays
on "No Selection".

The specific breakages, in the order they bite:

1. **The plan is built before the parent is verified.** `plan(scanId)` plans every field on the page
   from one scan, including controls whose options do not exist yet. §4 of the brief names this
   directly, and it is what the architecture does on every pass.
2. **`awaitDependentOptions` is only reached at the _end_ of a pass** (`orchestrator.ts:1272`), after
   the whole plan has been executed. Within a pass there is no ordering whatsoever — the executor
   walks `plan.actions` in plan order, so State may be written before Country.
3. **The recovery is a full-page rescan.** `scan()` re-reads every control in every frame to learn
   one control's new options. §5 forbids this, and it is also what makes the retry cost a whole pass.
4. **A control that failed keeps its failure.** `orchestrator.ts:1091`:
   `if (previous?.verification === 'failed' && !executed) continue;`. A State control that failed in
   pass 1 against stale options keeps that verdict unless pass 2 re-executes it — which depends on the
   ledger deciding the question is "genuinely different", judged from an identity that includes the
   option set. It usually does. "Usually" is the defect.

### The exact education chain failure

`Education Type → Education Country → Education State → School` is **four deep**. Nothing in the
system can order four dependent steps:

- The pass loop gives at most `MAX_ITERATIONS = 5` whole-page rounds, and every round costs a full
  scan, plan and execute of every field in every frame.
- The Dropdown Engine has its own ordering, and it is two levels:
  `inDependencyOrder` (`background/dropdownAcrossFrames.ts:153`) ranks controls whose
  `dependencyState === 'awaiting_parent'` after the rest, and `MAX_DEPENDENCY_ROUNDS = 2`. A
  four-deep chain cannot resolve in two rounds, and the constant is not the problem — a rank of
  "parent or not-parent" cannot express a chain of any depth.

So the chain resolves when the page happens to populate fast enough that consecutive whole-page
passes walk it one link at a time, and it stalls at whatever depth the pass budget runs out. On the
repeater fixture it reached School in two passes. On a form with a slower region list, or with a
fifth link, it will not.

### The conditional-child handling is correct, and is not the failure

This deserves saying plainly because the brief asks for a regression proving it: the relatives defect
is **already fixed**, in two independent places, and I could not reproduce it.

- The planner refuses on the _scan's_ observation of the parent —
  `conditionalGateFor` (`deterministicPlanner.ts:163`) reads `parent.currentValue`, explicitly not
  what the plan intends the parent to become.
- The executor refuses again on the _live DOM_ at write time —
  `conditionalGateViolation` (`executor/domExecutor.ts:198`) re-reads the parent element out of the
  document and compares what it currently holds.

The comment above `markConditionalChildren` records the original incident: the run typed the
applicant's own name into "If yes, provide the name, location and relationship of each relative"
because the label contains "name", while the relatives question above it was never answered — so the
form stated to the employer that the applicant had a relative working there.

What is still missing is **status vocabulary**, not safety. A gated child currently ends as
`OPTIONAL_LEFT_BLANK` via the `notApplicable` branch at `orchestrator.ts:1103`, and a child whose
parent is unanswered is reported the same way as one whose parent said No. §13 wants those
distinguished, and §22 wants `NOT_APPLICABLE` as a named outcome.

### Stale DOM references and stale option sets

Three places hold a reference across a mutation:

- `plan.actions` carries `matchedOption` chosen from the scan's option list. After the parent is
  answered the page frequently _replaces_ the select element, so both the option and the selector's
  resolution are stale.
- `unpopulatedDependents` (`orchestrator.ts:1277`) is keyed by selector, and a replaced control keeps
  its selector while becoming a different element.
- `awaitDependentOptions` re-resolves per check (`dependentOptions.ts:104`) and is the one place that
  gets this right. Its observer is correctly disconnected in `finish()`.

There is no fingerprint of any kind: nothing records "before the parent was answered this control was
disabled and had 1 option", so nothing can tell "the page rebuilt the list" from "the page has not
rebuilt the list yet, and it happens to have had one option all along".

### Fields planned too early

Every field on the page, every pass. `buildPlan(scanId, { analyze: false })` plans from one scan
snapshot with no notion that some of its inputs are provisional.

## A separate finding, and it changes what "reuse the Dropdown Engine" means

**The Dropdown Autofill Engine is not wired into the run at all.**

`runDropdownAutofill` (`extension/src/background/dropdownAcrossFrames.ts:217`) is never called from
`background/index.ts`, and the content script handles neither `DISCOVER_DROPDOWNS` nor
`RUN_DROPDOWN_DIRECTIVES`. It is unreachable from the button, exactly as `growRepeatedSections` was
before the previous change — dead code with a green unit suite.

This means every dropdown that currently works — Country, State, Employment Type, School on the
repeater fixture — is being driven by the **deterministic planner and `domExecutor`**, not by the
Dropdown Engine. So "the Dependency Engine must reuse the Dropdown Engine" cannot be satisfied by
calling something already in the path; the reuse has to _make_ that path reachable.

The Dependency Engine therefore drives its dependent controls through the existing in-frame dropdown
primitives — `scanDropdowns` for a fresh registration and `runOneDropdown` for open/enumerate/match/
select/verify — which is the reuse the brief asks for, applied to exactly the controls this engine is
responsible for. It does not add a second dropdown implementation, and it does not change how
non-dependent controls are filled.

## Four more defects, found by building the engine rather than by reading

Each of these was caught by a test or by the built-extension run, and none was visible from the
source alone.

1. **The education chain used canonical questions that do not exist.** The first draft chained
   `education_type → education_country → education_state → school`. There is no `education_country`
   and no `education_state` in `CANONICAL_QUESTIONS` — the scanner classifies an education block's
   country control as plain `country`, like any other. The chain matched nothing. It is now
   `education_type → country → state → school`, kept out of the applicant's own address pair by
   scope rather than by name.

2. **A control inside a repeating block got no record index unless its question belonged to that
   section's vocabulary.** `markRepeatedRecords` required
   `sectionForQuestion(field.canonicalKey) === section`, which is right for "School" and wrong for
   everything else in the block: an Education block's Country is `country`, so it took the `continue`
   and kept no index. Every education block's country therefore looked like the same question as the
   applicant's home country — which is how a graph pairs block 1's State with block 0's Country.
   Blocks are now numbered by _containment_.

3. **"If other, enter School/Institution Name" was adopted as a second School.** That box carries
   the canonical question `school`, exactly like the dropdown above it, so the option-refresh chain
   matched it on intent and _drove it_ — writing the institution into a box that applies only when
   School says "Other". Observed on the built extension: both `otherSchools` boxes held the school
   name. A control the page's own words have already made somebody's child now has exactly one
   parent, and it is the one the page named.

4. **The wait ended while the control was still being rebuilt.** A form that answers one parent by
   queueing _two_ rebuilds — one clearing the child, one filling it — passes through a state where
   the child is enabled, changed, and holding nothing but its prompt. The first watcher ended there
   and handed the executor an empty list, which is the same stale-read failure it exists to prevent,
   reached from the other side. Observed on Education State → School. The fingerprint now counts
   _usable_ options separately from raw ones, and a control is settled only when it has some.

And one regression this change introduced and then removed: the status reconciliation overwrote
fields the ordinary pipeline had already filled and verified. `WAITING_FOR_DEPENDENCY` and
`USER_CONFIRMATION_REQUIRED` are this engine reporting on _its own_ attempt, not a claim that the
field is empty — and writing them over a verified result turned an "Anticipated Graduation Date"
holding _May 2027_ into an orange "Information needed". Caught by `phase4-education` gates 7 and 9.

## What is being built, and what is being left alone

| Concern                                      | Before                                 | After                              |
| -------------------------------------------- | -------------------------------------- | ---------------------------------- |
| Who produces whose options                   | not recorded                           | `dependencyGraph.ts`, typed edges  |
| Ordering                                     | pass loop + 2-level rank               | topological, cycle-checked         |
| Waiting                                      | option-presence, whole document        | fingerprint change, scoped subtree |
| Rescan after a parent lands                  | whole page, whole frame set            | the one dependent control          |
| A dependent control's interim status         | `missing_information` / failure        | `WAITING_FOR_DEPENDENCY`           |
| A gated child whose parent said No           | `OPTIONAL_LEFT_BLANK`                  | `NOT_APPLICABLE`                   |
| Failure vocabulary                           | `STATE_OPTIONS_NOT_UPDATED` or generic | nine `DEPENDENCY_*` codes          |
| Conditional-child safety                     | correct, twice                         | unchanged, plus a regression test  |
| Text execution, repeaters, submit protection | —                                      | unchanged                          |
