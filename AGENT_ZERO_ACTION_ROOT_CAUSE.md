# Agent zero-action exit — root cause

**Date:** 2026-08-11
**Symptom (real Lincoln Electric run):**

```
[agent] scan merged across frames   frames: 2   fields: 29
[agent] scan complete               adapter: successfactors   fields: 29
[agent] agent run                   status: READY_FOR_REVIEW  observations: 1  actions: 0  verified: 0
```

A blank application with a dozen visible unanswered required controls was declared ready.

---

## 1. The exact cause

**File:** `extension/src/agent/pageObserver.ts`
**Function:** `observePage`
**Condition:** the final `pageObservationSchema.parse(...)` threw a `ZodError`
**Data:** `navigation` — one entry per visible `button`, `input[type=submit]` and `[role=button]`

`shared/schemas/agent.ts` declared:

```ts
navigation: z.array(observedNavigationSchema).max(20).default([]),
```

**A Zod `.max()` does not truncate. It throws.**

`navigationControls()` collects _every_ visible button on the page. A lab fixture has three or four. A real SuccessFactors page has a nav bar, a language picker, a help launcher, per-section edit controls and a footer — comfortably past twenty. So on the live page:

1. `observePage` built all 29 elements correctly;
2. the final `parse` threw on the navigation array;
3. the content-script handler's `.catch` called `sendResponse(undefined)`;
4. `observeAcrossFrames` ran `pageObservationSchema.safeParse(undefined)`, which failed, and `continue`d — **for both frames**;
5. the worker assembled an observation with `elements: []`;
6. `decideDeterministically` found nothing to do and returned `READY_FOR_REVIEW`;
7. `evaluateReady` did not exist, so nothing contradicted it.

**29 scanned fields became zero actionable tasks because the observation carrying them was discarded in its entirety by a validation cap on an unrelated array.**

### Which of the listed candidates it was

**A — the scanner finds fields but `pageObserver` drops them.** Precisely: the observer built them and then threw, and the throw was swallowed as "this frame has nothing".

Not B (actionability was never consulted), not C (the profile was present and complete — see §4), not D/E/G (no decision provider was involved; the deterministic policy ran and was _correct_ given an empty observation), and F only as a consequence: the fallback returned `READY_FOR_REVIEW` because the page it was shown genuinely had nothing on it.

### Reproduction

`tests/extension/agentZeroAction.test.ts` mounts a page with four real questions and 40 header buttons. Before the repair, `observePage` threw; after it, the observation carries every question.

---

## 2. Why nothing caught it

Three reasons, all worth recording:

- **Every fixture was small.** The lab pages carry a handful of buttons, so no test ever crossed the cap.
- **The failure was silent by design.** A frame that cannot be reached legitimately contributes nothing, and a frame that threw was indistinguishable from one that had gone away.
- **`READY_FOR_REVIEW` was a claim, not a predicate.** "I have nothing to do" and "I cannot see anything to do" produced identical output, and only one of them is a finished application.

---

## 3. What changed

### The observation can no longer be lost

- Every array is bounded **before** the schema sees it (`MAX_NAVIGATION`, `MAX_ELEMENTS`, `MAX_REPEATERS`, `MAX_SECTIONS`).
- Navigation is sorted step-controls-first before truncation, so trimming can never discard the "Next" button in favour of vendor chrome.
- `observePage` cannot throw: a draft that fails validation falls back to per-element `safeParse`, keeping the controls and dropping only what was malformed.

### `READY_FOR_REVIEW` became a predicate

`extension/src/agent/agentReady.ts`, evaluated independently of the decider, recorded per cycle in the trace:

| Condition                                                             | Blocks readiness |
| --------------------------------------------------------------------- | ---------------- |
| `knownActionableRemaining` — a saved answer not yet applied           | yes              |
| `askUserRemaining` — a required question not yet put to the applicant | yes              |
| `documentsPending` — a document available and unattached              | yes              |
| `finalSubmitReached`                                                  | yes              |
| `blockedRemaining` — tried and failed; the applicant's now            | no, but reported |

A decider claiming `READY_FOR_REVIEW` while the predicate disagrees is **overridden**; three such claims end the run as `BLOCKED` with `AGENT_DECISION_INVALID_READY_STATE`.

### A failed decision is never a finished application

`AGENT_DECISION_FAILED` · `AGENT_MODEL_UNAVAILABLE` · `AGENT_INVALID_DECISION` · `AGENT_DECISION_TIMEOUT` — the run ends `FAILED` with the code on the trace. There is no path from "could not decide" to "ready".

### The next live run will be conclusive

Twelve markers (`AGENT_RUN_STARTED` … `AGENT_RUN_FINISHED`), each carrying `fieldCount`, `actionableFieldCount`, `knownAnswerFieldCount`, `askUserFieldCount`, `decisionProvider`, `durationMs` and an error code. The console summary now prints `observedFields`, `actionableFields`, `knownAnswerFields`, `askUserFields`, `decisionProviderCalled`, the readiness verdict and `failureCode`.

---

## 4. Was the profile ever the problem?

No. `profileContext` on the acceptance run reports every field present:

```
profileLoaded true, hasFirstName true, hasLastName true, hasEmail true,
hasPhone true, hasAddress true, hasCity true, hasPostalCode true,
hasCountry true, hasState true, workRecordCount 2, educationRecordCount 2
```

The agent had the address, city, postal code and phone the old autofiller used to write. It never got to look at them, because the observation those values would have been matched against was empty.

---

## 5. Still open

`blockedRemaining: 1` on the acceptance run — one control the agent attempted three times and could not apply (an education-vocabulary mismatch). That is reported to the applicant rather than hidden, and it does not block readiness. It is not the zero-action bug and is not fixed here.
