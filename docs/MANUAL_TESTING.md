# Milestone 4 manual grounded-answer testing

## Setup and generic fixture

```powershell
npm run build
npm run dev:server
npm run start:fixtures
```

Load `extension\dist` unpacked, connect the token, and save a synthetic test profile. Open
`http://127.0.0.1:4173/ai-custom-answers.html`.

1. Enable local AI in Settings, select an installed model, and register/extract a synthetic resume.
2. Analyze, build the plan, and confirm motivation, experience, project, teamwork, goals, skills,
   and additional-information fields are eligible while demographic/legal/injection fields are not.
3. Generate one answer. Confirm it starts unapproved and displays evidence, claim mappings,
   warnings, model, duration, word/character counts, and field limit.
4. Exercise shorter/longer/technical/personal/direct/formal/conversational and emphasis modes.
5. Generate all eligible, observe per-field progress, then cancel a run. Refresh and confirm states
   persist and no cancelled draft becomes approved.
6. Confirm a story question without facts says what evidence is missing instead of inventing it.
7. Edit one draft, confirm its source changes to `user_override`, approve it explicitly, and leave
   another blank. Save one reviewed answer with a deliberate scope.
8. Fill approved fields. Confirm only approved text is written and both native and React-controlled
   textareas verify. Demographic, legal, injection, rejected, invalid, and unapproved fields stay empty.
9. Confirm character limits are enforced before approval and in the executor.
10. Confirm `fixtureState.submitted` and `fixtureState.nextClicked` remain false. Review and continue
    manually; never press Submit during this test.

Re-run the Milestone 3 native-control regression on
`http://127.0.0.1:4173/autofill-controls.html`; its safe deterministic behavior must be unchanged.

## Greenhouse fixture and real Greenhouse

Fixture: repeat analyze → build → approve safe → fill on
`http://127.0.0.1:4173/greenhouse.html`. Confirm `#first_name` verifies, Resume remains empty, and
Submit is untouched.

Real site:

1. Open a public `boards.greenhouse.io` or `job-boards.greenhouse.io` application.
2. Record a redacted URL, date, Chrome/build version, and visible field count. Do not record answers.
3. Analyze and confirm Greenhouse detection, title/company/location, labels, options, and uploads.
4. Build the plan. Review every proposed value; keep resume/file actions unsupported.
5. For one custom text question, generate and inspect evidence/claims. If evidence is inadequate,
   leave it manual. Otherwise approve that draft explicitly.
6. Approve one harmless text field first, fill it, and confirm the report says `verified` and the
   visible field kept the exact value.
7. Approve remaining safe fields deliberately. Confirm dropdowns use exact visible options and
   sensitive/legal questions remain untouched.
8. Confirm no request advanced or submitted the form. Finish or abandon manually.

## Lever fixture and real Lever

Fixture: use `http://127.0.0.1:4173/lever.html`. Confirm Lever detection, email verifies, Resume
stays empty, and Submit application is untouched.

Real site:

1. Open `jobs.lever.co/<company>/<posting>` and record only redacted diagnostics.
2. Analyze and confirm Lever title, location/department, grouped questions, and upload controls.
3. Build/review the plan; approve a single safe contact field and fill.
4. Generate at most one custom answer, inspect its evidence and limits, explicitly approve or reject.
5. Confirm exact observed value and `verified`, then approve other safe native controls.
6. Leave ambiguous options, custom widgets, sensitive questions, attestations, and uploads manual.
7. Confirm no Submit application/Next control was activated and continue manually.

## Workday fixture and real Workday

Fixture: use `http://127.0.0.1:4173/workday.html`. Confirm Workday detection, Legal First Name
verifies, the custom Country combobox is unsupported, and Submit is untouched.

Real site:

1. Open a public `myworkdayjobs.com` application and navigate to a visible step manually.
2. Record redacted diagnostics and analyze only that rendered step.
3. Confirm automation-id fields and current-step options. Treat virtualized/custom comboboxes as
   unsupported unless every option is visibly detected.
4. Build the plan and approve one safe native text/date/select control. Fill and verify it.
5. Generate only for an eligible visible native custom textarea; review evidence and approve it
   individually. Do not attempt rich-text or cross-frame questions.
6. Re-analyze after every manual step transition; never reuse a plan across steps.
7. Confirm inaccessible frames/widgets are warnings, no file is uploaded, no demographic/legal
   form is auto-completed, and no Next/Continue/Submit control is activated.

Workday support is intentionally partial: fixture-tested native controls on the current rendered
step, not a claim of full production Workday automation.
