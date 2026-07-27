# Testing

Run the complete automated gate:

```powershell
npm ci
npm run validate
npm run test:e2e
```

`validate` runs formatting, lint, TypeScript project checks, Vitest unit/integration suites, and
all production builds. Playwright loads the unpacked extension in Chromium against local fixtures
and a mocked Ollama service. Live Ollama tests run only when explicitly enabled and otherwise
report skipped, never passed.

Manual release validation is listed in `docs/MANUAL_TESTING.md`.
