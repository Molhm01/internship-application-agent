# Deterministic autofill

The matcher uses profile values, approved answers, explicit user overrides, and reviewed generated
answers. Options require exact or allowlisted alias matches. Sensitive and legal fields are never
inferred.

Execution rechecks URL, field ID, and fingerprint; uses native DOM setters and browser events; then
re-queries and verifies the observed value. Text, textarea, email, phone, number, URL, date, native
select, radio, checkbox groups, generated text, and approved résumé uploads are supported. The
executor never advances or submits an application.
