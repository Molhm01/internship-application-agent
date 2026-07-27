# Supported models

Milestone 4 uses Ollama's `/api/chat` structured-output interface. A model is usable when it is
installed locally, accepts a JSON schema, follows evidence IDs, and returns concise prose without
tool instructions.

The default and tested model is `qwen3.5:9b`. Other recent instruction models may work, but support
is capability-based rather than an allowlist. Run:

```powershell
$env:OLLAMA_MODEL = "your-model:tag"
npm run check:ollama
```

Small models use less memory and respond faster but are more likely to miss schema, grounding, or
length constraints. Large models can exceed the default 60-second timeout. Quantization and
hardware make latency machine-specific. The server refuses a configured tag that is not reported
by the local daemon and does not silently substitute another model.

Automated tests use a deterministic fake Ollama server. A real-daemon smoke test is opt-in:

```powershell
$env:RUN_LIVE_OLLAMA = "1"
npm run test -- tests/server/ollamaLive.test.ts
```

That test uses synthetic applicant/job evidence and never reads the user's saved profile.
