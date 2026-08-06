# Phase 3 — personal, phone, address, Country/Region, State/Province, Legal Name

Traced against the code that actually runs when the popup's **Autofill Application** button is
pressed. Every module below was read; nothing here is inferred from documentation.

## The active deterministic path

```
popup  useAutofillState → RUN_APPLICATION_AUTOFILL
  ↓
background/index.ts  runApplicationAutofill(dependencies)
  ↓
autofill/orchestrator.ts   pass loop (max 5), one scan + one plan + one execute per pass
  ↓ scan            content/index.ts → scanner/scanApplication.ts → scanner/domScanner.ts
  ↓ canonical key   shared/logic/normalizeQuestion.ts  matchCanonicalQuestion()
  ↓ profile lookup  matcher/deterministicMatcher.ts    matchField() → profileValue()
  ↓ action          planner/deterministicPlanner.ts    planAction()
  ↓ contract        shared/logic/actionContract.ts     contractViolation() / repairActionFor()
  ↓ approval        autofill/approvalPolicy.ts         decideApproval()
  ↓ execute         content/index.ts → executor/domExecutor.ts (+ comboboxExecutor.ts)
  ↓ verify          verifier/domVerifier.ts            verifyDomAction()
  ↓ final status    shared/logic/finalFieldStatus.ts   resolveFinalFieldStatus()
                    shared/logic/phoneGroup.ts         reconcilePhoneGroup()
  ↓ marks           content/highlighter.ts             one mark per control, redrawn each pass
```

| Concern                  | Owner                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Canonical profile source | `shared/schemas/profile.ts` → `profile.personal`, `personal.address`                                |
| Personal-field mapper    | `deterministicMatcher.ts` `profileValue()`                                                          |
| Address mapper           | same `profileValue()`, `address_line1/2`, `city`, `state`, `postal_code`, `country`, `address_type` |
| Country option matcher   | `shared/logic/optionMatcher.ts` `matchOption()` + `OPTION_ALIASES`                                  |
| State dependency handler | `deterministicPlanner.isDependentControl()` + `EXECUTION_PRECEDENCE` + the bounded wait (new)       |
| Phone-code handler       | `profileValue.phone_country_code` (split) and `phoneGroup.reconcilePhoneGroup()` (combined)         |
| Legal-name constructor   | `shared/logic/legalName.ts` `fullLegalName()` (new)                                                 |
| Text/option contract     | `shared/logic/actionContract.ts`, enforced in planner **and** executor                              |

There is **one** deterministic mapper. No duplicate or legacy personal/address mapper is reachable:
`formAnalysis.ts` names the same canonical keys but only for the batched model stage, and that stage
runs after the deterministic writes and was not consulted at all in the Phase 3 run.

## Root causes found

### Country remained blank — a misclassification, not a matching failure

`normalizeQuestion.ts` tested its `state` rule (`/\b(state|province|region)\b/`) **before** its
`country` rule. Every Workday-shaped label — "Country/Region", "Country/Region of Residence" —
contains the word _region_, so the residence country was classified `state`. The matcher then
offered the saved **"New Jersey"** to a list of countries, `matchOption` correctly found nothing, and
the field was deferred. The country control never received the country, and the alias table
(`united states / usa / us / u s a / america`) was never reached.

**Fix:** the `country` rule now precedes `city` and `state`. A genuine "State/Province/Region"
control names no country and still reaches the state rule.

### State remained blank — a consequence, plus a blind sleep

Two causes, in order:

1. Country was never selected (above), so the page never produced a region list. `State/Province`
   offered one prompt option, `isDependentControl` correctly reported it as dependent, and it stayed
   dependent for the whole run.
2. Even with Country selected, the pass loop bridged the gap with a fixed
   `setTimeout(350)` (`background/index.ts` `waitForStability`). A portal that fetches its region
   list takes longer, so the next scan read the prompt the list was about to replace.

**Fix:** a bounded, observed wait — `content/dependentOptions.ts`, driven by a MutationObserver with
a 2s ceiling, asked for only the dependent controls' selectors, in every frame at once. It resolves
the moment a real choice appears. No extra full-page rescan; the fixed sleep remains only for pages
with no dependent controls.

### Full Legal Name was blank

`full_name` is a canonical question and the scanner produced it, but `profileValue()` had no entry
for it — the profile stores the parts and nothing assembled the whole. Later-step labels ("Name as it
appears on legal documents", "Signature Name") also matched no rule.

**Fix:** `shared/logic/legalName.ts` assembles first + middle (when present) + last + suffix,
collapsing whitespace, preserving capitalization, excluding the preferred name, and returning `null`
rather than half a name. New label patterns cover the later-step wordings.

### A text input reaching option matching

Already prevented before this phase, in both directions (`actionContract.ts`, enforced by
`enforceContract` in the planner and by `contractViolation` + `elementContractViolation` in the
executor). Confirmed by test, not by inspection alone. No text-control option-matching path exists.

### Stale "Information needed" on filled fields

Two remaining causes, both fixed here:

- A second run over a correctly filled form escalated **every option control** to review, because the
  planner compared the control's stored option _value_ ("US", "NJ", "1") against the saved _label_
  ("United States", "New Jersey", "+1") and concluded they differed. Option controls are now compared
  against the matched option, after matching.
- A field settled by reconciliation kept the review flag the planner gave it before the executor ran.
  A phone country code answered by the combined control beside it ended `FILLED_VERIFIED` while its
  result still said `missing_information` — and `applicationAutofillReportSchema` refuses a
  `completed` run whose results claim fields await review, so the whole run was **thrown away rather
  than stored**. Review flags are now cleared from every settled field before the report is built.

### Two more defects the fixture exposed

- **Rewriting an already-correct control.** Re-selecting a country that is already selected fires
  `change`, and a page that repopulates its region list on that event discards the state chosen
  moments earlier. The executor now verifies rather than rewrites when a control already holds the
  intended value.
- **A combined widget counted as a split control.** `hasPhoneCountryCodeField` counted any
  `phone_country_code` field, so the combined widget's chooser made the planner strip "+1" from the
  number and put it nowhere. The scanner now records `embeddedInPhoneControl` when the chooser and
  the number input are siblings in one wrapper — deliberately that tight, because a fieldset contains
  both in every split design too.

## Failure codes

Existing precise codes cover the country/state stages: `CONTROL_NOT_FOUND`, `FIELD_NOT_VISIBLE`,
`FIELD_DISABLED`, `OPTION_NOT_FOUND` / `NO_OPTION_MATCH`, `OPTION_VALUE_NOT_VERIFIED`,
`VALUE_NOT_VERIFIED`. One state had no code and now has one: **`STATE_OPTIONS_NOT_POPULATED`** —
Country was answered, the run waited, and the page never produced a region list. It is stamped on the
field's own result, with guidance, so the report names the page's failure instead of blaming the
profile.

## Proof

- `tests/extension/phase3PersonalAddress.test.ts` — 96 unit tests over the rules above.
- `tests/e2e/phase3-personal-address.spec.ts` — 28 gates against the **built** extension, driven by
  the popup button over `tests/fixtures/lab/phase3-candidate-profile.html` and
  `phase3-combined-phone.html`.
