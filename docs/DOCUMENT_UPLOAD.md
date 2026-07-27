# Approved document attachment

Document attachment is local, deterministic, and approval-gated.

1. Register a résumé in Settings → Documents. The local server stores it beneath the configured
   document directory.
2. Select that résumé explicitly or mark it as the default.
3. Analyze an application and build a fresh fill plan.
4. A compatible résumé/CV file field receives an `upload_file` proposal. Other file fields remain
   manual unless a compatible document-selection workflow is available.
5. Review the displayed document name and approve that individual upload action. “Approve safe
   actions” never approves files.
6. When filling starts, the worker requests only the bytes referenced by approved upload actions
   through the authenticated local API. Bytes are not stored in extension storage.
7. The content script creates a browser `File`, assigns it to the scanned input, dispatches normal
   input/change/blur events, and verifies the filename retained by the control.

The executor does not click Submit, Next, Continue, Review, or any legal attestation. A missing
file, changed field fingerprint, unsupported control, failed filename verification, or page change
ends in a visible failure/manual-review result.

The authenticated content endpoint is `GET /documents/:id/content`. It validates the response
against the shared schema and never exposes a filesystem path to the application page.
