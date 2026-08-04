# Autofill early-completion audit

Why one click scanned 26 fields, filled 2, and ended with 18 cards reading
`"<question>" is waiting on the page analysis`.

## Where the pending placeholders are created

`extension/src/planner/deterministicPlanner.ts`, in `planAction()`. A field the
deterministic pass cannot settle becomes:

```ts
action: 'missing_information',
reason: `"${field.question}" is waiting on the page analysis.`,
```

That is a **stage marker**, not a verdict — the field is on its way to the
batched analysis. Nothing in the runtime distinguished the two.

## Where the AI analysis should start, and whether it runs

`analyzePage()` inside `buildPlan()` (`background/index.ts`), reached from
`dependencies.plan()` on every pass. It is guarded by:

```ts
if (!settings.aiGenerationEnabled) return { warnings: [] };
const availability = await agentAvailability(() => fetchAgentStatus());
if (!canAnalyze(availability)) return { warnings: [availabilityMessage(availability)] };
```

Both guards return **quietly**. With the local agent server not running — the
overwhelmingly likely case behind a 27-second run that resolved nothing — the
analysis never happens, the markers are never replaced, and the only sign is a
warning nobody surfaced.

## Why the run completed holding placeholders

`report()` in `extension/src/autofill/orchestrator.ts` built the final
`ApplicationAutofillReport` straight from `resultsByField`, with no check that
any of it represented an outcome. A `missing_information` action with
`verification: 'not_attempted'` is exactly what a _pending_ field looks like and
exactly what an _unanswerable_ field looks like, so the marker was rendered
verbatim as a final card.

## Why the counts read zero

Three different numbers, each counting a different subset, none counting the
fields that produced no action at all:

- `uncertainSuggestions` — only `reviewReason === 'ai_suggestion'`
- `manualBlockers` — only `reviewReason === 'manual_required'`
- `failedFields` — only `reviewReason === 'failed'`, set solely when the
  executor ran and returned `failed`

The 18 pending fields carried `reviewReason: 'missing_information'`, which
appears in none of them. Hence `Needs confirmation: 0` and `Could not fill: 0`
above eighteen unanswered required fields.

## Why only 2 fields filled

The two that filled are the only two on the page that need **no profile data at
all**: `Phone Type → Mobile` and `Address Type → Home`, resolved by
`resolveStructuralField()` from the form's own option vocabulary
(`sourceReference: 'form.structural'`).

Every other field needs a saved value. That they all came back empty says the
synchronised profile reaching the extension is essentially empty — not that the
mappings are missing. The run had no way to say so, which is why 26 identical
cards looked like 26 separate problems.

## Fixes

1. `shared/logic/pendingResolution.ts` makes a stage marker recognizable.
   `report()` now resolves every one before building the report, into a reason
   that names the stage that did not run — "The page analysis could not run…
   start the local AI agent and run autofill again" — rather than restating the
   question.
2. A run reports **one** number for outstanding work, counted across the audit
   and the review list together, so `Needs confirmation: 0` cannot appear above
   a list of unanswered fields.
3. When five or more fields are found and two or fewer resolve from saved data,
   the report leads with the actual diagnosis: the profile has not
   synchronised. Shown above the counts, not buried under them.
