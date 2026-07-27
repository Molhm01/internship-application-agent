# Troubleshooting

- Server unreachable: run `npm run start:server` and confirm the configured loopback URL.
- Authentication failed: copy `local-data/agent-token.txt` into Connection settings.
- Ollama unavailable: run `ollama serve`, pull a model, refresh models, and select it.
- Extension worker stale: rebuild, press Reload on `chrome://extensions`, then reload the
  application tab.
- Scan/plan stale: return to the intended application step, analyze again, and rebuild the plan.
- Database concern: stop the server, run `npm run db:check`, then consult `docs/RECOVERY.md`.
- Unsupported control or cross-origin frame: fill it manually; do not weaken fingerprint or
  approval checks.
