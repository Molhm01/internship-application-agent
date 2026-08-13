# Dropdown option handoff — root cause

Traced against the live SAP SuccessFactors / Lincoln Electric Agent Run Trace in which
State/Province opened correctly (`opened=true`, `menuFound=true`, `optionCount=58`,
`optionIdsGeneratedCount=58`, `verification=VERIFIED`) and then never progressed to
`select_option` (`optionsPassedToDecisionProvider=false`, `llmCalled=false`,
`matchingStrategy=UNKNOWN`, `optionIdsChosen=[]`).

## Summary

The dropdown session is **not** lost. The 58 options survive re-observation and are present on
the `ObservedElement` handed to the decider. They are discarded one layer later, by a gate that
escalates to the choice provider only for a single narrow error code.

There are two independent defects. The first fully explains the live State/Education/Area
failure. The second is the reported stale-model defect and explains why an infrastructure
failure surfaces as a factual question.

---

## Defect 1 — the choice provider is gated on one error code

**options exist in:**
`ObservedElement.options` (58 entries, session-scoped ids `e<N>::option::<i>`) produced by
`optionsOf` in `extension/src/agent/pageObserver.ts:404`, and independently in
`ToolExecutionResult.options` from the `open_dropdown` case in
`extension/src/agent/agentToolExecutor.ts:150`.

**options disappear in:**
`decideWithChoiceFallback`

**file:**
`extension/src/agent/agentLoop.ts`

**function:**
`decideWithChoiceFallback` (lines 130–214), specifically the early return at lines 153–158.

**condition:**

```ts
if (
  !recoveredChoice &&
  (deterministic.kind !== 'ASK_USER' ||
    deterministic.errorCode !== 'DROPDOWN_TARGET_NOT_FOUND' ||
    !deterministic.elementId)
) {
  return deterministic;   // <-- the 58 options are dropped here
}
```

The choice provider is consulted **only** when `decideDeterministically` returned exactly
`ASK_USER` carrying `errorCode === 'DROPDOWN_TARGET_NOT_FOUND'` (or when a prior text failure
is being recovered). Any other deterministic outcome returns before
`onChoiceRequest?.(request)` at line 170 — which is the exact call that sets
`optionsPassedToDecisionProvider = true` — and before `chooseChoice(request)` at line 171.

**root cause:**

For a searchable dropdown with a known answer and no deterministic match,
`decideDeterministically` does **not** return `DROPDOWN_TARGET_NOT_FOUND`. It returns an
`ACTION` first, from the search branch in `extension/src/agent/agentDecision.ts:341–355`:

```ts
const search = element.searchInputId;
if (search !== undefined && element.dropdownState === 'OPEN') {
  const searchElement = live.find((c) => c.elementId === search);
  if (searchElement && !history.exhausted('type', searchElement.label)) {
    return { kind: 'ACTION', action: { tool: 'type', elementId: search, value: element.proposedValue } };
  }
}
```

On the live State control every precondition holds: the menu is open, the observer emitted the
`Search within * State/Province` box as a separate `TEXT_INPUT`, and `matchActualChoice`
returned `UNKNOWN`. So the cycle is spent typing into the search box, the decision is an
`ACTION` rather than `ASK_USER`, the gate at agentLoop.ts:153 returns immediately, and the 58
real options are never offered to any chooser — deterministic escalation or LLM.

This is a single mechanism producing three of the reported live symptoms at once:

- `optionsPassedToDecisionProvider=false` and `llmCalled=false` — the handoff call is never reached.
- The search box being "treated as an independent TEXT_INPUT and filled" — that is this branch.
- The run stalling after `OPTIONS_READ` — no branch remains that turns options into an `optionId`.

The escalation is keyed on an error code rather than on the condition that actually matters:
*a known-answer choice control whose real options are in hand has no deterministic match.*

---

## Defect 2 — the model gate reads a different model than the model the request uses

**stale source:**
`agent-server/src/config.ts:57`

```ts
defaultModel: envString('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL)
```

with `DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b'` in `shared/constants/network.ts:12`. With
`OLLAMA_MODEL` unset this is `qwen3.5:9b`, and `agent-server/src/ollama/client.ts:146` reports
it to `/health` as `selectedModel` / `selectedModelInstalled`.

**authoritative source:**
The extension's saved AI Answers model, `settings.ai.generationModel`
(`extension/src/storage/settings.ts:93–107`) — the value the user set to `qwen3-coder:30b`.
It is what the actual request uses at `extension/src/background/index.ts:591`.

**the break:**
`interpretHealth` in `extension/src/background/agentAvailability.ts:89` gates on the *server's*
`ollama.selectedModel`, not on the model the request will use:

```ts
if (ollama.selectedModel && ollama.selectedModelInstalled === false) {
  return { state: 'model_unavailable', error: agentError('MODEL_NOT_FOUND',
    `The selected model "${ollama.selectedModel}" is not installed, ...`) };
}
```

So the gate fails on `qwen3.5:9b` — a model the request would never have asked for — while
`settings.ai.generationModel` is `qwen3-coder:30b`. Two model configuration sources, and the one
that decides availability is not the one that is saved.

**why it becomes ASK_USER:**
`extension/src/background/index.ts:1750–1762` converts any choice-provider failure, including
this infrastructure failure, into a factual answer:

```ts
chooseChoice: async (request) => {
  const result = await chooseAgentOption(request, state.controller.signal);
  return result.data ?? { decision: 'ASK_USER' as const, confidence: 0, reason: ... };
}
```

A missing or misconfigured model is an infrastructure error and must surface as
`MODEL_UNAVAILABLE`, never as a factual question about State, Education Type, School, or Area
of Study.

---

## Consequence for the prescribed repair

The dropdown *session* survives observation intact — owner-scoped option ids are already minted
by `optionsOf` and already validated against `before.options` in `dropdownTraceFor`. The State
handoff does not require a new session-ownership layer; it requires the escalation gate to fire
on the right condition, and the search box to be treated as a step *inside* the dropdown
lifecycle rather than as a decision that ends the cycle.

Menu ownership (`findListbox`, `extension/src/scanner/optionDiscovery.ts:215`) is a separate,
real defect: the last-resort single-visible-portal branch at the end of that function can hand
one dropdown's open menu to a different control, which is consistent with the live Education
Type / Area of Study rows reporting `triggerFound=false`, `openAttempted=false`,
`menuFound=true`, `optionCount=118`.
