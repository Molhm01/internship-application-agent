# Autofill coverage audit

Why a twenty-seven-field application filled exactly one field, and that one
wrongly.

## The instrument that was missing

Every unfilled field reported "needs information". That single message is the
symptom of four different problems — no profile value, no mapping, a rejected
action, a refused write — and nothing distinguished them.
`extension/src/autofill/coverage.ts` now records one row per field with the
stage it stopped at. Intents, control types, counts and failure codes only:
never a value, a credential, a document, or a prompt, so it can be left on.

## Exact reason only "Work-experience location" filled

Two independent facts, and they compound.

**1. The experience section had no mappings at all.** `profileValue()` in
`deterministicMatcher.ts` covered personal, address, education and eligibility.
It had no entry for `employer`, `job_title`, experience location, employment
dates, `currently_employed` or `responsibilities`. On a page with a work-history
section every one of those fell through to "no saved value" while the profile
held all of them.

**2. `current_location` swallowed the one field that did resolve.** Its rule is
`/^location( city)?$/`, so a work-history control labelled "Location" matched it
and was filled with `locationSearchText(address)` — _"Clifton, NJ"_. That is the
applicant's home address written into a question about where a past job was. The
single field the run managed to fill was also the single field it got wrong.

So the page's only successful write came from a mapping that should not have
applied, while the mappings that should have applied did not exist.

## Coverage, before and after

Measured on the iCIMS fixture, extended to match the live page (it previously
had no education or experience section at all, which is why coverage looked
healthy here while the real run filled almost nothing).

| Metric                        | Before | After   |
| ----------------------------- | ------ | ------- |
| Fields scanned                | 24     | 35      |
| Classified                    | 19     | 31      |
| Executable actions produced   | 13     | 26      |
| Verified after one click      | 14     | **25**  |
| Coverage of answerable fields | —      | **76%** |
| Contract rejections           | 0      | 0       |
| Unclassified                  | 5      | 0       |

Still unfilled, all correctly:

| Field                       | Why                                         |
| --------------------------- | ------------------------------------------- |
| Password, Password Re-enter | credential vault, never the ordinary plan   |
| State/Province              | dependent — fills on the pass after Country |
| Resume                      | no bundle in this harness                   |
| "Please specify further"    | dependent on the source answer              |
| "Anything else…"            | optional long-form, left blank              |
| Policy agreement            | legal consent, never ticked automatically   |

## Mappings added

- **Experience:** `employer`, `job_title`, `experience_location`,
  `employment_start_date`, `employment_end_date`, `currently_employed`,
  `responsibilities`. An end date is withheld for a current role rather than
  invented.
- **`experience_location`** as a canonical question, anchored to
  employer/company wording and explicitly _not_ to "job location" or any
  relocation phrasing — those remain `preferred_locations` and
  `willing_to_relocate`.
- **`account_username`** classified so a login page is recognized, but
  deliberately given no `profileValue` entry: it is filled by the account
  executor beside the password, never by the ordinary plan. Routing it through
  the plan typed an identifier into every sign-in form the agent landed on.

## Stage timings

```
passes: 2  totalMs: 2014
scan#1:220ms/35   plan#1:163ms/35   execute#1:1301ms/25
scan#2:152ms/35   plan#2:157ms/35
planned: 35   executed: 25   verified: 25
```

Scan 220 ms, deterministic plan 163 ms — both inside the 2 s / 1 s budgets.
Execution is now the largest stage, which is the right shape: it is doing the
work. No model call is made for any of the 25, and the batch that would run
carries at most six questions.
