# Release

1. Confirm `git status --short` is empty.
2. Run `npm ci`, `npm run validate`, and `npm run test:e2e`.
3. Run live Ollama tests when a local model is available; report a skip honestly otherwise.
4. Run the manual checklist in `docs/MANUAL_TESTING.md`.
5. Run `npm run db:check`, a backup/restore drill against a disposable data directory, and
   `npm run backup:verify`.
6. Confirm `extension/dist/manifest.json` and `agent-server/dist/index.js` exist after a fresh
   shell/restart.
7. Commit the release and create the annotated `v1.0.0` tag.

Never publish `local-data`, `.env`, browser profiles, résumés, tokens, logs, or Playwright artifacts.
