# Master plan

The repository uses milestone commits and annotated tags.

- Milestones 0–4: foundation, durable profile/documents/answers, read-only scanning, deterministic
  verified fill, and grounded local AI answers. The imported workspace arrived without Git history,
  so these phases are represented by the transparent recovery checkpoint `v0.5.0-m4`.
- Milestone 5: explicit, reviewed, verified document attachment (`v0.6.0-m5`).
- Milestone 6: migrations, diagnostics, backup/restore/export, recovery documentation, and release
  validation (`v1.0.0`).

Every browser mutation originates in a typed fill plan, requires approval where policy demands it,
is executed by deterministic code, and is verified. No component clicks Submit, Next, Continue,
Review, Sign, or a legal attestation. AI can propose text only and uses local Ollama.

Optional screenshot/OCR fallback and additional ATS-specific controls remain post-1.0 work; DOM
text and manual entry are the supported paths in 1.0.
