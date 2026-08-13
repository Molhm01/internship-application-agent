# Live SuccessFactors classifier miss — production root cause

## Scope and evidence

This audit starts from the current dirty tree and the live build
`76dcc43+dirty.s3.20260813053931`. It does not use an older audit as runtime
evidence.

The old live trace proves the final facts for State/Province, Education Type,
and Area of Study: `controlType=TEXT_INPUT`, `toolRequested=type`, zero options,
and form rejection. That build did **not** record the scanner type or DOM
attributes, so those facts cannot be reconstructed honestly after the fact.
This repair adds the value-free `CONTROL_CLASSIFICATION_TRACE` at the final
authority to make the next live trace carry them.

## What the previous patch changed

The dirty patch added `scanner/controlOwnership.ts`, made `domScanner.scanOnce`
canonicalize a matched node through `logicalControlOwner`, and made
`pageObserver.interactionTypeOf` consult `choiceOwnershipOf`. It also placed
failure context on `DecisionInput`, `buildDecisionPrompt`, and the option-choice
request.

Those classification changes are in the Agent Mode bundle and are called. They
are not legacy-only or fixture-only. The date part succeeded because the final
classifier itself calls `isDateControl(element)` before the text fallback. A
text-backed `MM/DD/YYYY` input therefore became `DATE_INPUT` without depending
on composite ownership.

The dropdown part still failed because the ownership predicate admitted a
labelled inner input plus sibling trigger only when both pieces repeated the
same `aria-labelledby` relationship. SuccessFactors may put the accessible
label on the input/field and leave the sibling trigger relationship implicit.
For that shape:

1. the sibling was found, but `sharesAccessibleLabel(input, trigger)` was false;
2. the structural fallback was disabled because `hasOwnAccessibleLabel(input)`
   was true;
3. `choiceOwnershipOf(input)` returned null;
4. the scanner retained the input and inferred `fieldType=text`;
5. the final Agent authority saw an ordinary editable input and returned
   `TEXT_INPUT`.

The previous boundary list also omitted SuccessFactors' `.formField` spelling,
and a role-less SuccessFactors arrow was not an eligible sibling trigger. Both
are now handled inside the same SuccessFactors-gated composite ownership rule.
No field label participates in the production classification.

## Exact production path and final authority

`popup Autofill Application`
→ `background/index.ts: runAgentAutofill`
→ `background/agentController.ts: runAgentApplication`
→ `background/agentAcrossFrames.ts: observeAcrossFrames`
→ content message `AGENT_OBSERVE`
→ `content/index.ts`
→ `agent/pageObserver.ts: observePage`
→ `scanner/domScanner.ts: scanDom / scanOnce`
→ `scanner/controlOwnership.ts: logicalControlOwner`
→ normalized `DetectedField`
→ `dependencies/dependencyDetector.ts: findControl`
→ `agent/pageObserver.ts: authoritativeAgentControlType`
→ `ObservedElement.interactionType`
→ `agent/agentLoop.ts: actionTraceFor`
→ both `action.targetControlType` and `action.controlType`.

**LIVE AUTHORITATIVE CONTROL TYPE FUNCTION**

- file: `extension/src/agent/pageObserver.ts`
- function: `authoritativeAgentControlType` (previous exported name:
  `interactionTypeOf`)
- upstream type: `DetectedField.fieldType`, plus the live DOM element resolved
  from `DetectedField.selector`
- downstream type: `ObservedElement.interactionType`
- final old `TEXT_INPUT` assignment: the editable-input fallthrough in
  `authoritativeAgentControlType`

`actionTraceFor` does not classify again. It copies the observed interaction
type unchanged into both trace properties.

## Adapter participation

Agent Mode calls generic `scanDom` directly from `observePage`; it does not call
`BrowserAdapter.scan`. Adapter detection identifies the ATS for policy and the
new diagnostic, but there is no vendor field type later overwriting the scan.

| Question | Answer | Proof |
|---|---:|---|
| A. Was code unused by Agent Mode modified? | NO | Both `scanOnce` and the final `pageObserver` classifier are on the `AGENT_OBSERVE` call path. |
| B. Was only legacy autofill code modified? | NO | `runAgentAutofill` reaches the modified observer through `runAgentApplication`. |
| C. Was only fixture/test code modified? | NO | The extension production entry imports the modified content/background graph. |
| D. Was scanner dropdown type later overwritten as text? | NO | The failing field remained/resolved as an input because ownership returned null; `actionTraceFor` only copied the final result. |
| E. Was a helper result ignored? | NO | `logicalControlOwner` and `choiceOwnershipOf` results are consumed. |
| F. Did the structural predicate fail? | YES | Its shared-label-or-unlabelled-input condition excludes a labelled input whose sibling trigger has implicit field ownership. |

## New authoritative precedence

The shared ownership rule now applies this order:

1. positive date/calendar input evidence (never converted to a dropdown);
2. a native select owned by the same compact field composite;
3. direct choice semantics on the node or an ancestor;
4. one input plus one SuccessFactors choice trigger in the same logical field,
   including `.formField`, direct combobox semantics without duplicated label
   ARIA, and a SuccessFactors-gated dropdown-arrow affordance;
5. textarea;
6. ordinary editable input.

The structural rule is gated by SuccessFactors host/DOM adapter evidence and
does not inspect question wording. Inputs of type `tel`, password controls,
calendar/date affordances, and a wrapper containing multiple independent
inputs/buttons do not qualify.

## Failure-feedback miss

The previous patch changed `buildDecisionPrompt`, but production
`runAgentAutofill` supplies only `chooseChoice`, not the general `decide`
provider. `buildDecisionPrompt` therefore has no production call site. Worse,
the loop set `decisionProviderCalled=true` and labelled every cycle `model`
merely because `chooseChoice` was configured, even if deterministic logic never
called it. That is why the trace could report a provider while every failed
action still showed `modelReceivedFailureFeedback=false`.

The production option request already has the correct privacy boundary: actual
observed option IDs/labels, boolean trusted-answer availability, and sanitized
failure state. Recovery now invokes that real provider when a failed strategy's
fresh observation is a choice control with actual options. The request carries:

- previous tool and logical field wording;
- `ACTION_VERIFICATION_FAILED` plus the specific detail code;
- `REJECTED_BY_FORM`/other value-free observed state;
- page-changed boolean;
- previous (`TEXT_INPUT`) and fresh (`CUSTOM_SELECT` or
  `SEARCHABLE_COMBOBOX`) control types;
- guidance that typing the choice parent is invalid and only observed options
  may be selected.

The trace now marks `decisionProviderCalled` only on an actual model call and
records `modelReceivedFailureFeedback` on the resulting step. An unchanged
field/tool/state/failure is diverted after its first failure; the existing
three-failure loop breaker remains as the final safety backstop.

## Temporary developer diagnostic

With Developer Mode enabled, only State/Province, Education Type, and Area of
Study receive `CONTROL_CLASSIFICATION_TRACE`. The strict schema allows tags,
ARIA booleans/strings, parent/ancestor facts, bounded nearby-control counts,
label relationship type, sanitized container class tokens, scanner/adapter/
normalized/final types, and no field value. The record is copied into the
matching Agent action and printed under the same event name.

The label allowlist selects diagnostic records only. It is not imported or
consulted by classification, validation, option discovery, or execution.

