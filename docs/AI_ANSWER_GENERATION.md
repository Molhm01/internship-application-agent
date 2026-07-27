# AI answer generation

Milestone 4 generates drafts for eligible custom text questions through a model served by local
Ollama. It does not delegate browser control to the model.

## Flow

1. The scanner records the normalized question and HTML word/character limits.
2. Deterministic rules classify clear questions and reject demographic, sensitive, legal,
   consent, upload, and unsupported controls. Only uncertain questions use the local model
   classifier.
3. The server assembles verified evidence from the profile, approved answers, selected resume
   (or the default resume), job context, and explicit evidence added by the user.
4. Deterministic weighted lexical retrieval ranks evidence with category boosts. The prompt is
   bounded to 20 items and 24,000 evidence characters. Sensitive evidence is excluded.
5. Ollama receives the controlled system instruction, untrusted question/job text inside explicit
   delimiters, evidence IDs, limits, tone, and regeneration mode.
6. The response must satisfy the closed candidate schema. Counts are recomputed locally. One
   deterministic JSON repair is allowed; generation/validation is retried at most once.
7. Validation rejects unknown evidence IDs, unsupported factual or numeric claims, placeholders,
   tool/code instructions, irrelevant answers, and length-limit violations.
8. The extension displays the draft, evidence, claims, warnings, model, duration, and counts.
   Drafts start unapproved. The user can edit, regenerate, add evidence, reject, leave blank, or
   approve.
9. Approval creates a review-required `fill_generated_text` action. The existing deterministic
   executor locates the scanned field, writes text, dispatches framework-compatible events, and
   verifies the observed value.

## Classifications

Eligible categories include company/role motivation, personal introduction, experience, projects,
technical skills, leadership, teamwork, challenge/conflict/failure/achievement, problem solving,
goals, industry interest, strengths, qualifications, work style, values, and additional
information. `prohibited_sensitive`, `prohibited_legal`, and `unsupported` never generate.

## Evidence and insufficient context

Evidence items carry a stable id, source/reference, category, text/facts, relevance score,
verification state, and sensitivity flag. Generation does not treat the application question or
job description as facts about the applicant. A story question needs explicit applicant evidence
for a story; the model is not allowed to manufacture one. When the selected evidence cannot
support an honest answer, the result is `needs_user_input` and lists what is missing.

## Review states

Records progress through `queued`, `gathering_context`, `generating`, `validating`, and one of
`ready_for_review`, `needs_user_input`, `prohibited`, `failed`, or `cancelled`. User actions may
move a valid draft to `approved` or `rejected`; execution records `filled`, `verified`, or `failed`.
Refreshes preserve records in `chrome.storage.local`, while the server also persists generation
audit records in SQLite. A new scan or rebuilt plan invalidates stale drafts.

Editing a draft changes its source to `user_override`; it must still satisfy the field limit and
closed-output checks and must be approved again. Saving to the approved-answer library is a
separate explicit action with general, company, or job scope.

## Regeneration

Supported modes are default, shorter, longer, more technical, more personal, more direct, more
formal, more conversational, emphasize project, emphasize experience, and emphasize leadership.
Settings choose whether the prior draft is retained. Batch generation accepts at most 20 requests,
uses concurrency 1 or 2, reports per-field failures, and can be cancelled.

## Model boundary

The model cannot return a selector, click, script, XPath, URL navigation, file path, upload, or
submission instruction. Model text is data for a review card. Only a schema-validated and manually
approved answer can be translated into the single closed executor action `fill_generated_text`.

## Approved-answer plan integration

Generated-answer records retain the original scan target (`scanId`, `fieldId`, `pageId`, selector,
field metadata, question, and page URL). Generation and approval upsert `fill_generated_text` into
the same persisted fill plan used for deterministic profile fields. `GET_FILL_PLAN` and execution
also reconcile the current generation store into that plan, which repairs a missing action from an
older or interrupted worker state. Every update recomputes statistics and broadcasts
`FILL_PLAN_UPDATED`; generated answer text is never included in diagnostic logs.

Unapproved or invalid generated actions remain non-executable. Contenteditable questions can be
generated and reviewed, but the executor reports `UNSUPPORTED_GENERATED_FIELD` until a safe
contenteditable strategy exists. Availability and discovery-source selects are not AI-generated:
they require an approved answer or explicit user override, and the value must match an option that
was actually scanned.

## Manual integration check

1. Start Ollama with `ollama serve` and ensure the configured model is installed.
2. Start the local server with `npm run dev:server`.
3. Build the unpacked extension with `npm run build:extension`.
4. Reload the extension on `chrome://extensions`.
5. Open an application containing a visible long-form textarea.
6. Select **Analyze Application**, then **Build Fill Plan**.
7. Confirm the field displays **AI eligible: Yes** and its classification.
8. Generate and review the answer, then select **Approve**.
9. Confirm **Execution status: Approved, queued** and **Included in active fill plan: Yes**.
10. Reopen the review page or return from the popup and select **Fill Approved Fields**.
11. Confirm the textarea retains the exact reviewed answer and the report marks it **verified**.
12. Confirm the extension did not submit the form or navigate to another application step.
