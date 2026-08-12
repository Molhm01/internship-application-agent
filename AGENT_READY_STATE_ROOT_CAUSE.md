# Agent ready-state root cause

Why two consecutive live Lincoln Electric runs reported `READY_FOR_REVIEW` over
an application with nine blank required fields and five questions the applicant
had never seen.

```text
RUN 1                          RUN 2
observations: 24               observations: 18
actions: 15                    actions: 9
verified: 6                    verified: 0
status: READY_FOR_REVIEW       status: READY_FOR_REVIEW

unresolvedRequired: 9          unresolvedRequired: 9
knownActionableRemaining: 0    knownActionableRemaining: 0
askUserRemaining: 0            askUserRemaining: 0
documentsPending: false        documentsPending: false
ready: true                    ready: true

askUserFields: 5
resumeVerified: false
coverLetterVerified: false
```

Three contradictions, three separate defects, all in the completion accounting.
Read from the TypeScript source at commit `ff06b57`.

---

## Defect 1 — `unresolvedRequired` was computed and never used

|           |                                     |
| --------- | ----------------------------------- |
| File      | `extension/src/agent/agentReady.ts` |
| Function  | `evaluateReady`                     |
| Condition | the `ready` conjunction             |

```ts
const unresolvedRequired = live.filter((element) => element.required && isBlank(element)).length;
// ...
const ready =
  knownActionableRemaining === 0 &&
  askUserRemaining === 0 &&
  !input.documentsPending &&
  !input.finalSubmitReached;
```

`unresolvedRequired` is calculated on the first line, returned in the result
object, and **never referenced by the boolean**. It was a display counter
sitting beside a predicate that did not read it.

So nine blank required fields blocked nothing. The two counters that _were_ read
had both legitimately reached zero — there was no saved answer left to apply,
and (see Defect 2) the questions had been asked — so `ready` was `true` while
nine required boxes sat empty on the employer's form.

This is the incorrect boolean logic, and it is a term missing from a conjunction
rather than a term with the wrong sense.

**Fix.** `unresolvedRequired === 0` now leads the conjunction, and every
unresolved required field is classified into exactly one bucket
(`knownActionableRemaining`, `askUserRemaining`, `blockedRequiredRemaining`)
that all block. `classifyRequired` is total over required controls, and a test
asserts the buckets sum to `unresolvedRequired` — so a field cannot fall out of
the accounting, because there is no category left for it to fall into.

---

## Defect 2 — asking a question counted as resolving it

|           |                                                                       |
| --------- | --------------------------------------------------------------------- |
| File      | `extension/src/agent/agentReady.ts`                                   |
| Function  | `evaluateReady`                                                       |
| Condition | `needsUser(element) && !input.askedQuestions.includes(element.label)` |

```ts
const askUserRemaining = live.filter(
  (element) => needsUser(element) && !input.askedQuestions.includes(element.label),
).length;
```

`askedQuestions` was `history.openQuestions()` — the list the **agent** filled by
emitting an `ASK_USER` decision. No user answer was involved anywhere in the
chain. Asking a question therefore removed it from the outstanding count.

That is the `askUserFields: 5` / `askUserRemaining: 0` contradiction exactly:
the marker counts `live.filter(needsUser)` — the raw five — while readiness
subtracted all five for having been asked. The agent resolved its own questions
by asking them, and with Defect 1 removing the last guard, readiness followed.

The questions were also unanswerable _in principle_ by the old data structure:
`history.questions` was a `string[]` of question text. There is nowhere in a list
of strings to record an answer, so no answer could ever have arrived.

**Fix.** Questions are objects (`agentPendingQuestionSchema`) carrying the
control's logical identity and an `answeredAt` that only `recordAnswer` can set —
there is deliberately no agent-side path to it. `evaluateReady` takes
`answeredQuestions` (logical keys the applicant answered) instead of the asked
list; the asked list is retained only to distinguish "asked and waiting" from
"not yet asked", both of which block.

---

## Defect 3 — an available document that the form did not mark required

|           |                                                                                     |
| --------- | ----------------------------------------------------------------------------------- |
| File      | `extension/src/background/agentController.ts`                                       |
| Condition | `haveDocument && elements.some(e => e.kind === 'file_upload' && e.required && ...)` |

One boolean answered two different questions. `haveDocument` was
`resume || coverLetter` — not per kind — and the control had to carry `required`
for anything to be pending at all.

On the live page the upload control is not marked required by any of the signals
the scanner reads (native attribute, `aria-required`, ATS metadata, visible
marker), so a tailored résumé waiting to be attached counted as _nothing_: it
vanished from the readiness predicate and from the applicant's list alike. Hence
`resumeVerified: false` beside `documentsPending: false`.

**Fix.** Uploads are counted per control and split by requiredness.
`requiredDocumentsPending` blocks readiness; `optionalDocumentsPending` is
reported in the run summary and deliberately does not block — an optional cover
letter must never hold an application open. Requiredness is still read from the
scanner and never inferred, because guessing that an upload is required would
block readiness on forms that do not ask for one.

---

## Defect 4 — one terminal state for two different outcomes

|           |                                                                                  |
| --------- | -------------------------------------------------------------------------------- |
| File      | `extension/src/agent/agentLoop.ts`                                               |
| Condition | `status = decision.kind === 'READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'BLOCKED'` |

The decider returning `READY_FOR_REVIEW` means "I have run out of things I can
safely do". That was converted verbatim into the run status, so "the agent has
finished its part" and "the application is complete" were the same state and
there was no way to report the first without claiming the second.

**Fix.** A priority ladder (`terminalStateFor`), with `READY_FOR_REVIEW` last
and reachable only when the predicate is satisfied outright:

| Condition                 | Status                  | Reason                      |
| ------------------------- | ----------------------- | --------------------------- |
| predicate satisfied       | `READY_FOR_REVIEW`      | —                           |
| questions unanswered      | `WAITING_FOR_USER`      | `WAITING_FOR_USER_INPUT`    |
| required fields refused   | `READY_FOR_USER_REVIEW` | `REQUIRED_FIELDS_BLOCKED`   |
| required document pending | `READY_FOR_USER_REVIEW` | `REQUIRED_DOCUMENT_PENDING` |
| required blanks remain    | `READY_FOR_USER_REVIEW` | `PARTIAL_COMPLETION`        |
| otherwise                 | `READY_FOR_USER_REVIEW` | `NO_MORE_SAFE_ACTIONS`      |

A final re-check where all paths converge downgrades any `READY_FOR_REVIEW` the
predicate cannot substantiate. It can only ever demote a status.

---

## Result

The live state, reconstructed as a fixture
(`tests/extension/agentReadyState.test.ts`):

```text
unresolvedRequired: 9   askUserRemaining: 5   blockedRequiredRemaining: 4
requiredDocumentsPending: 1                   ready: false
```

and the bucket invariant `5 + 4 + 0 === 9` holds, so no field is unaccounted for.

---

## What this does not fix

Completion, question-queue and pending-state accounting only. It does not touch
dropdown execution, dates, Add, upload execution, the scanner, or the decision
provider, and it makes no claim that any specific Lincoln control now fills. It
makes the run tell the truth about what it finished — which is what the previous
`READY_FOR_REVIEW` was hiding.
