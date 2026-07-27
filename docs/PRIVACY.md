# Privacy

Profile facts, approved answers, extracted resume text, application questions, job context,
prompts, drafts, and generation records stay on the user's machine. The server binds to
`127.0.0.1`; the extension talks only to that server; inference goes only to the configured Ollama
loopback URL. There is no telemetry or cloud fallback.

Resume parsing is local. PDF, DOCX, and TXT bytes are read only from the controlled documents
directory. Extraction stores normalized text, sections, a content hash, status, and a safe error;
PDF metadata is not evidence. Original bytes are not placed in prompts.

The general log redacts answers, prompts, profile values, evidence text, contact details, tokens,
paths, and observed/attempted field values. Do not enable ad-hoc console logging around generation.
SQLite and `chrome.storage.local` still contain personal data in plaintext and are accessible to
processes running as the same OS user. Protect the Windows account and remove `local-data/` and
extension storage when retiring the tool.

If `OLLAMA_URL` is deliberately changed to a non-loopback service, prompt data can leave the
machine. That deployment is outside the supported privacy model.
