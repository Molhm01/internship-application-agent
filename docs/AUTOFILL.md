# Deterministic autofill

The matcher uses profile values, approved answers, explicit user overrides, and reviewed generated
answers. Options require exact or allowlisted alias matches. Sensitive and legal fields are never
inferred.

Execution rechecks URL, field ID, and fingerprint; uses native DOM setters and browser events; then
re-queries and verifies the observed value. Text, textarea, email, phone, number, URL, date, native
select, radio, checkbox groups, generated text, and approved résumé uploads are supported. The
executor never advances or submits an application.

## Final field statuses

Every question on the form ends a run with exactly one status, and there is no seventh:

| Status                       | Meaning                                                        | Page mark                                              |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| `FILLED_VERIFIED`            | Written and confirmed against observed DOM state               | Green tick                                             |
| `SKIPPED_ALREADY_VALID`      | The page already held the correct answer                       | No mark                                                |
| `OPTIONAL_LEFT_BLANK`        | Optional and deliberately empty. Finished work                 | Grey badge                                             |
| `USER_CONFIRMATION_REQUIRED` | A factual answer nobody holds, or a decision only you may make | Orange badge, or purple when the question is sensitive |
| `FAILED_EXECUTION`           | The agent wrote a value and the page did not keep it           | Red badge                                              |
| `BLOCKED`                    | A CAPTCHA or verification step stood in the way                | Red badge                                              |

An already-valid field carries no mark on purpose: the user wrote that answer, and a green tick on
it claims credit for their work.

While a run is moving a field holds one of `PENDING_SCAN`, `PENDING_RESOLUTION`,
`PENDING_EXECUTION` or `PENDING_VERIFICATION`. Those two vocabularies share no member, and
`assertNoTemporaryStatuses` runs before a run may report `completed` — so COMPLETED cannot be
claimed over a field the pipeline is still thinking about. `applicationAutofillReportSchema`
independently refuses a report whose status is `completed` while any field is unsettled, and one
whose counters do not sum to the number of fields.

`shared/logic/finalFieldStatus.ts` owns both vocabularies, the colour mapping, and the resolution
order.

Marks are redrawn from the current final statuses after every verification stage, not once at the
end. Every field is sent on every redraw, including the ones that end up unmarked — a field omitted
from a redraw keeps whatever an earlier pass drew on it, which is the whole class of bug this
replaced. A field that verifies stops being marked at the moment it verifies, so a filled field can
never still display "Information needed".

## The popup summary

The eight lines the popup prints are counted by `summarize()` in `popup/AutofillPanel.tsx`, from
`report.fieldOutcomes` and from nothing else — never from planner output:

    Detected · Filled and verified · Optional blank · Needs your answer
    Failed · Blocked · Already valid · Elapsed time

The six status lines partition the fields, so they sum to `Detected` by construction. If they ever
do not, the popup says so in an alert rather than printing a summary it cannot justify.

## The run trace

`Settings → Diagnostics → Export Autofill Run Trace` writes the last run to a JSON file. The button
is behind `developerMode`, like every other diagnostic surface.

One record per field, carrying: the run id, the BUILD_ID, the sanitized field id, the frame id, the
question, its section, the DOM control type, whether it was required, the canonical intent, whether
a saved value existed, the planner source, the planned action, the action-contract result, whether
the executor was invoked, what verification observed, the final status, the annotation, a sanitized
failure code, and how long the field spent in the executor — plus per-stage durations and a
plain-English summary of where the run lost the fields it did not fill.

The run id and BUILD_ID are repeated on every record deliberately: field records get pasted into bug
reports one at a time, and a record that cannot say which run and which bundle produced it is
unusable.

It carries no field values, passwords, document contents, profile data, or model prompts.
`fieldTraceSchema` is strict and has no member capable of holding one, so the file is safe to attach
to a bug report without reading it first.

## One pipeline

`runApplicationAutofill` in `extension/src/autofill/orchestrator.ts` has exactly one caller —
`background/index.ts` — and that is the whole of the active path. Two other extension pages reach
the same modules and are **not** second pipelines:

- `fill-plan.html` is a developer-mode manual builder. It sends `EXECUTE_APPROVED_ACTIONS` to the
  same worker handler and therefore the same executor; it does not scan, plan, verify, annotate, or
  produce a run trace.
- `review.html` is a read-only preview of the last scan.

Both are behind `developerMode`. If you add a status, a mark, or a counter, add it in
`shared/logic/finalFieldStatus.ts` and let those pages read it — do not grow a second model.
