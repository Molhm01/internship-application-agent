# Agent verification root cause

Why a live Lincoln Electric run reported six executed actions and zero verified
ones while text fields visibly filled on the page.

```text
status: BLOCKED   observations: 7   actions: 6   verified: 0
failureCode: undefined
```

Everything below is read from the TypeScript source as it stood at commit
`8db072c`, and every claim is reproduced against a fixture rather than inferred
from an earlier audit document.

---

## Method

The signature was reproduced before anything was changed. A jsdom fixture was
built with four required text controls shaped the way a SuccessFactors-style
portal shapes them — a required field pointing at a permanent hint node through
`aria-describedby`, and a phone box that reformats what it is given on `change` —
and the **production** loop was run over it (`runAgentLoop`, `observePage`,
`executeAgentTool`, `trustedValuesFor`; no stubs).

Result before any repair:

```text
status READY_FOR_REVIEW  observations 5  actions 4  verified 1
dom  addressLine1=48 Maple Avenue  city=Clifton  postalCode=07011  phone=(201) 555-0134

step 0  type  "Street Address *"   executed true  VERIFICATION_FAILED  SELECTION_NOT_COMMITTED
step 1  type  "City *"             executed true  VERIFICATION_FAILED  SELECTION_NOT_COMMITTED
step 2  type  "Zip/Postal Code *"  executed true  VERIFIED
step 3  type  "Phone Number *"     executed true  VERIFICATION_FAILED  VALUE_NOT_VERIFIED
```

Every one of the four values is **correct and present in the DOM**. Three of the
four are reported as failures. The only field that verified is the one carrying
neither a hint node nor a reformatting handler.

---

## Answer

**It is a verifier issue.** Not execution, not re-observation, not result
merging, and not the counter.

The execution path is sound: the DOM was mutated correctly in all four cases.
The re-observation is real: `runAgentLoop` calls `host.observe()` after every
action and verifies against the returned observation, never against the request
or a cached scan. The counter is honest: `AgentHistory.verifiedCount()` counts
steps whose `verification === 'VERIFIED'`, and it correctly counted the one step
that earned it.

What was wrong is the set of rules that decide whether a fresh reading of the
page confirms the action. Three of them independently rejected a correct write,
and two more defects turned the resulting run into an undiagnosable one.

---

## Defect 1 — a static "required" hint was read as the form rejecting the value

_Primary cause. Accounts for the majority of the live failures._

|             |                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| File        | `extension/src/agent/pageObserver.ts`                                                                                    |
| Function    | `validationErrorFor`                                                                                                     |
| Condition   | any node named by `aria-describedby` whose text matched `UNANSWERED_WORDING`                                             |
| Consumed by | `extension/src/agent/agentLoop.ts` → `verify`, `if (now.validationError.trim().length > 0) return 'VERIFICATION_FAILED'` |

The observer collected error text from `aria-errormessage` **and**
`aria-describedby` in a single list, and accepted any of them whose wording
matched `/required|please select|mandatory|.../`.

`aria-describedby` is the attribute for _hints_. A required field on a real
portal routinely points at a permanent "This field is required" marker through
it, and that marker does not disappear when the field is filled — it is a label,
not a verdict.

So `validationError` was non-empty **for ever** on any such control, the first
line of the text branch in `verify` failed the step, and every text field on the
page with a required hint reported `VERIFICATION_FAILED` on every attempt no
matter what had been written into it.

The asymmetry is the tell: the _container walk_ immediately below already
required `aria-invalid="true"` before attributing nearby error text to a
control, with a comment explaining why. The `aria-describedby` path had no such
guard.

**Fix.** `aria-errormessage` stays authoritative — it is the error attribute by
definition. `aria-describedby` and the container walk now both require the page
to have actually flagged the control with `aria-invalid="true"`.

---

## Defect 2 — a control that reformatted what it kept counted as a different value

|              |                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| File         | `extension/src/agent/agentLoop.ts` (verifier) and `extension/src/agent/agentToolExecutor.ts` (executor)       |
| Function     | `verify` case `'type'`; executor case `'type'`                                                                |
| Condition    | `held === target \|\| held.includes(target)` after reducing to lowercase alphanumerics                        |
| Result shape | `VERIFICATION_FAILED`, and `ToolExecutionResult.pageChanged === false` with `errorCode: 'VALUE_NOT_VERIFIED'` |

`+1 201 555 0134` reduces to `1 201 555 0134`. The value the box stored,
`(201) 555-0134`, reduces to `201 555 0134`. Neither contains the other, because
of the leading country code — so a phone number filled perfectly failed both the
executor's own check and the verifier's.

This one compounds: because the executor also reported `pageChanged: false`, the
loop's no-progress counter treated a correctly filled field as a step that
changed nothing.

**Fix.** `shared/logic/valueCommitment.ts` → `holdsWrittenValue`, used by both
layers. Equality, then containment, then — only for values that are
substantially digits — equality of the digit sequence with a common prefix
allowed. Deliberately narrow: it cannot make two different names or addresses
compare equal, and a test asserts that.

---

## Defect 3 — the control could not always be found again

|              |                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| File         | `extension/src/agent/agentLoop.ts`                                                                                 |
| Function     | `verify`                                                                                                           |
| Condition    | `element.label === before.label && element.section === before.section && element.blockIndex === before.blockIndex` |
| Result shape | `NOT_VERIFIED`                                                                                                     |

Handles are reminted every observation by design, so the control just written to
necessarily has a new one and has to be correlated by content. Exact triple
equality of label, section and block index is too brittle: a re-render that adds
or removes a required marker (`City` → `City *`), rewrites whitespace, or moves
the control between frames loses it entirely. `frameId` was not part of the
match at all, so two frames carrying the same label could confirm one against
the other.

**Fix.** `shared/logic/logicalField.ts` → `findLogicalField`, correlating on
canonical intent first and normalized label second, scoped to frame, section and
repeated block. A pass that finds more than one candidate is discarded rather
than guessed at — confirming a write against the wrong control is worse than
failing to confirm it.

---

## Defect 4 — the run gave up without saying why

|           |                                                         |
| --------- | ------------------------------------------------------- |
| File      | `extension/src/agent/agentLoop.ts`                      |
| Condition | three `status = 'BLOCKED'` assignments set no `failure` |

`failureCode: undefined` on a `BLOCKED` run came from the terminal-BLOCKED
decision path: the decider ran out of ideas, `evaluateReady` disagreed, and
`fallbackDecision` produced `{ kind: 'BLOCKED' }` carrying nothing. The budget
exhaustion and no-progress exits had the same gap.

**Fix.** Every exit sets a specific code, plus a backstop where all paths
converge so a future exit cannot silently reintroduce the blank. `CANCELLED` is
exempt — the applicant pressing stop is not a failure.

---

## Defect 5 — the failure was filed under a code that did not describe it

|           |                                                                                     |
| --------- | ----------------------------------------------------------------------------------- |
| File      | `extension/src/agent/agentLoop.ts`                                                  |
| Condition | `verification === 'VERIFICATION_FAILED' ? { errorCode: 'SELECTION_NOT_COMMITTED' }` |

A failed **text** write was recorded as `SELECTION_NOT_COMMITTED` — a dropdown
code — which is why the live failure was unsearchable in its own trace. Where
the executor did supply a code it won over the verifier's, so the executor's
opinion outranked the reading taken last against fresh evidence.

**Fix.** The verifier's verdict is recorded first and carries a code that
describes the actual control: `TEXT_VALUE_NOT_COMMITTED`,
`OPTION_SELECTION_NOT_COMMITTED`, `ACTION_VERIFICATION_FAILED`, `STALE_ELEMENT`.
A step that verified now carries no code at all.

---

## Defect 6 — progress was read from the executor rather than from the page

|           |                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------- |
| File      | `extension/src/agent/agentLoop.ts`                                                                   |
| Condition | `unchangedStreak = execution.pageChanged \|\| verification === 'VERIFIED' ? 0 : unchangedStreak + 1` |

`execution.pageChanged` for `type` was the executor asking whether the box held
its literal argument — the same flawed comparison as Defect 2 — so filling a
form correctly could count as six consecutive steps of no progress and stop the
run.

**Fix.** Progress is measured from the readiness evaluation either side of the
action: verified, _or_ fewer required blanks, _or_ fewer fields the agent could
still fill. That is the same predicate that decides whether the run may finish,
so "made progress" and "is finished" cannot disagree about what counts.

---

## Result after repair

Same fixture, same production loop:

```text
status READY_FOR_REVIEW  observations 5  actions 4  verified 4
dom  addressLine1=48 Maple Avenue  city=Clifton  postalCode=07011  phone=(201) 555-0134

step 0  type  "Street Address *"   executed true  VERIFIED
step 1  type  "City *"             executed true  VERIFIED
step 2  type  "Zip/Postal Code *"  executed true  VERIFIED
step 3  type  "Phone Number *"     executed true  VERIFIED
```

---

## What this does not fix

This repair is confined to the action-result → re-observation → verification →
progress-accounting path. It does not touch dropdown execution, dates, Add,
uploads, or the dependency system, and it makes no claim about whether State,
Education Type, or any other specific control on the live Lincoln application
now fills. It makes the run _tell the truth about what it did_, which is the
precondition for diagnosing those.

The next real Lincoln run is the acceptance source. The per-action trace added
in `agentStepTraceSchema.action` is what that run should be read through.
