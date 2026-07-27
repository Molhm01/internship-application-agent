# Ollama setup

Install Ollama for Windows, start it, and pull a model that reliably supports structured JSON:

```powershell
ollama serve
ollama pull qwen3.5:9b
ollama list
npm run check:ollama
```

Start the agent server in a separate PowerShell window:

```powershell
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen3.5:9b"
npm run dev:server
```

The server and extension show whether Ollama is connected and whether the selected model is
installed. AI generation is disabled by default; enable it in Settings → AI answers and select the
same installed generation model.

Relevant extension settings are generation/optional validation model, temperature (default 0.2),
maximum tokens (768), answer length, timeout (60 seconds), retries (maximum one), concurrency
(maximum two), prior-draft behavior, and tone. The optional validation-model name is reserved for a
future independent model pass; Milestone 4 always performs the authoritative deterministic
validation locally.

Troubleshooting:

- `OLLAMA_UNAVAILABLE`: start `ollama serve` and confirm the URL.
- `MODEL_NOT_INSTALLED`: run `ollama pull <model>` and refresh the settings list.
- `OLLAMA_TIMEOUT`: use a smaller model, raise the timeout in Settings, or close competing jobs.
- `INVALID_MODEL_OUTPUT`: choose a model with stronger JSON-schema support; one repair/retry has
  already been attempted.
- `INSUFFICIENT_EVIDENCE`: add accurate profile/resume evidence; changing the model is not a fix.

Ollama must remain on loopback. Do not point `OLLAMA_URL` at a hosted or remote model if the
local-only privacy guarantee matters.
