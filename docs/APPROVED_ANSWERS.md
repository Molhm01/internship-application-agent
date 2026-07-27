# Approved answers

Generated drafts and reusable approved answers are separate records. A draft is never written to
the library automatically.

From the review card, the user may explicitly save the final reviewed text with one scope:

- `general`: reusable for the normalized question everywhere;
- `company`: reusable only when the company matches the stored scope reference;
- `job`: reusable only when the job title matches the stored scope reference.

The record retains normalized/canonical question metadata, classification, evidence references,
word count, timestamps, and the existing approval/review/sensitive flags. Exact normalized
question, compatible scope, and current word/character limits must all match before reuse.
Sensitive records remain governed by their sensitive-answer policy and are never silently used for
AI generation.

Editing a library item or saving a draft is an explicit server mutation. Deleting an answer does
not alter previous generation audit records, but it prevents future reuse.
