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
| `SKIPPED_ALREADY_VALID`      | The page already held the correct answer                       | Green tick                                             |
| `OPTIONAL_LEFT_BLANK`        | Optional and deliberately empty. Finished work                 | Grey badge                                             |
| `USER_CONFIRMATION_REQUIRED` | A factual answer nobody holds, or a decision only you may make | Orange badge, or purple when the question is sensitive |
| `FAILED_EXECUTION`           | The agent wrote a value and the page did not keep it           | Red badge                                              |
| `BLOCKED`                    | A CAPTCHA or verification step stood in the way                | Red badge                                              |

`shared/logic/finalFieldStatus.ts` owns the vocabulary, the colour mapping, and the resolution
order. Statuses like `pending`, `unverified` and `not_attempted` exist only while a run is moving;
`applicationAutofillReportSchema` refuses a report whose status is `completed` while any field is
unsettled, and refuses one whose counters do not sum to the number of fields.

Marks are redrawn from the current final statuses after every verification stage, not once at the
end. A field that verifies stops being marked at the moment it verifies, so a filled field can never
still display "Information needed".

## The run trace

`Settings → Diagnostics → Export Autofill Run Trace` writes the last run to a JSON file: one record
per field carrying the sanitized field id, the question, its section, the DOM control type, whether
it was required, the canonical intent, whether a saved value existed, the planned action, whether
the executor was invoked, what verification observed, the final status, a sanitized failure code,
and how long the field spent in the executor — plus per-stage durations and a plain-English summary
of where the run lost the fields it did not fill.

It carries no field values, passwords, document contents, profile data, or model prompts.
`fieldTraceSchema` is strict and has no member capable of holding one, so the file is safe to attach
to a bug report without reading it first.
