# Execution blocker audit

Why the popup showed only "Information needed" cards and nothing on the page
changed.

## Active runtime files

| Stage         | File                                            | Function                     |
| ------------- | ----------------------------------------------- | ---------------------------- |
| Popup click   | `extension/src/popup/useAutofillState.ts`       | `run()` → `follow()`         |
| Worker entry  | `extension/src/background/index.ts`             | `acceptAutofillRun()`        |
| Orchestrator  | `extension/src/autofill/orchestrator.ts`        | `runApplicationAutofill()`   |
| Scanner       | `extension/src/scanner/domScanner.ts`           | `scanDom()`                  |
| Normalizer    | `shared/logic/questionModel.ts`                 | `buildNormalizedQuestions()` |
| Deterministic | `extension/src/planner/deterministicPlanner.ts` | `buildDeterministicPlan()`   |
| AI planner    | `extension/src/analysis/formAnalysis.ts`        | `applyAnalysisToPlan()`      |
| Approval      | `extension/src/autofill/approvalPolicy.ts`      | `decideApproval()`           |
| Executor      | `extension/src/executor/domExecutor.ts`         | `executeDomAction()`         |
| Verification  | `extension/src/verifier/domVerifier.ts`         | `verifyDomAction()`          |

## Was the executor invoked?

**Yes.** This was never a disabled executor, a dry-run mode, or an approval-only
gate. Instrumenting the three stages shows it running on the first pass:

```
passes: 2  totalMs: 1426
scan#1:207ms/24   plan#1:145ms/24   execute#1:791ms/14
scan#2:138ms/24   plan#2:140ms/24
planned: 24   executed: 14   verified: 14
```

The executor was reached and did work. What failed is _which actions it was
given_.

## Exact function where the run stopped being useful

`applyAnalysisToPlan()` in `extension/src/analysis/formAnalysis.ts`, in the
`SELECT_OPTION` / `SELECT_RADIO` branch of `actionFromAnswer()`.

The deterministic planner had been taught the control-type contract and runs
every action it builds through `enforceContract()`. The **model** planner had
not. It built whatever action the model named:

```ts
if (options.length === 0) {
  return { ...base, action: 'select_suggested_option', proposedValue: wanted, … };
}
```

Two live failures, one branch:

- **First Name.** With no saved first name the field reaches the model, the
  model answers `SELECT_OPTION`, the field is a text input with no options, and
  this branch produces an option action on a text box. The executor then opens a
  list that does not exist → _"No option on the page matched 'Molhm'"_.
- **State/Province.** Its options are empty until Country is chosen, so the same
  branch fires → _"No option on the page matched 'New Jersey'"_.

The deterministic planner had the second half of the State bug independently: a
`<select>` whose only option is the prompt "Select a country first" is not an
empty list, so it reached `matchOption()`, failed, and reported the same
misleading sentence — blaming the profile for the page's ordering.

Separately, `highest_degree_awarded` had been added to `AI_PROHIBITED_QUESTIONS`
and had no resolver entry, so a profile full of education produced
_"is a fact only you can confirm"_.

## Counts

| Metric                          | Before    | After      |
| ------------------------------- | --------- | ---------- |
| Actions planned                 | 24        | 24         |
| Actions executed                | 14        | 16         |
| Actions verified                | 14        | 16         |
| Option actions on text controls | reachable | impossible |

## Fixes

1. `applyAnalysisToPlan` runs every model-derived action through the same
   `contractViolation` / `repairActionFor` pair the deterministic planner uses.
   A repairable mismatch is rewritten; an unrepairable one is discarded with a
   reason rather than executed.
2. A native `<select>`/`radio` with no options is a **dependent** control, not a
   list waiting to open. The model's answer for one is discarded, and the
   deterministic planner reports it as waiting on Country instead of as an
   unmatched option. `isDependentControl()` recognizes it structurally —
   placeholder-only option sets included — so it is not a list of vendor quirks.
3. `highest_degree_awarded` is resolvable again, and `structuredProfileValue`
   derives it through `degreeAnswersFor()`: an entry marked completed, or one
   whose graduation date has passed. With no such evidence it still yields
   nothing rather than claiming a degree.
4. Stage timings are logged per pass — counts and durations only, never a value,
   a credential, a document, or a prompt.
