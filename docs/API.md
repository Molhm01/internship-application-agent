# Local agent server API

Base URL: `http://127.0.0.1:4317` (loopback only — the host is hard-coded, not configurable).

## Conventions

Every response uses one of two envelopes.

Success:

```json
{ "ok": true, "data": {} }
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "OLLAMA_UNAVAILABLE",
    "message": "Could not reach Ollama at http://127.0.0.1:11434: ECONNREFUSED",
    "recoverable": true,
    "suggestedAction": "Start Ollama (`ollama serve`) and confirm it is listening on 127.0.0.1:11434.",
    "debugContext": {}
  }
}
```

`fieldId` is present when the error concerns a specific form field. Every payload is validated
against its shared schema _before_ it is sent; a payload that fails its own contract is reported as
`VALIDATION_FAILED` rather than delivered.

### Authentication

Send the token in the `x-agent-token` header. The server generates it on first start, prints it,
and stores it at `local-data/agent-token.txt` (mode `600` where the OS honors it). Set `AGENT_TOKEN`
to supply your own. Comparison is constant-time.

`GET /health` and `GET /version` are intentionally open so the popup can display a truthful
connection state before the user has configured a token. They expose no profile content.

Every other endpoint returns `401 UNAUTHORIZED` without a valid token — including unknown paths, so
route existence is not disclosed.

### Origin policy

Requests with no `Origin` (curl, health probes) are allowed and still require a token. Requests from
`chrome-extension://…` are allowed. Loopback web origins are allowed while
`AGENT_ALLOW_LOCAL_ORIGINS=true` (the default, for tests and docs examples). Anything else gets
`403 ORIGIN_REJECTED`.

### Limits

- Body limit 2 MiB → `413 REQUEST_TOO_LARGE`. `POST /documents` raises this to 14 MiB because the
  file arrives base64-encoded; the decoded file must still be ≤ 10 MiB.
- 240 requests per 60 s per client → `429 RATE_LIMITED` with a `retry-after` header.

---

## Implemented endpoints

### `GET /health`

Unauthenticated. Live probe of Ollama and the database — not a cached value.

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "service": "internship-application-agent",
    "version": "0.1.0",
    "uptimeSeconds": 15,
    "checkedAt": "2026-07-26T09:21:16.825Z",
    "ollama": {
      "state": "connected",
      "baseUrl": "http://127.0.0.1:11434",
      "version": "0.32.4",
      "modelCount": 1,
      "selectedModel": "qwen3.5:9b",
      "selectedModelInstalled": true,
      "checkedAt": "2026-07-26T09:21:16.821Z",
      "latencyMs": 3
    },
    "database": { "state": "ready", "path": "…/local-data/agent.db", "schemaVersion": 2 },
    "profileLoaded": true,
    "authenticated": true,
    "profileCompleteness": {
      "percent": 100,
      "completeSections": 10,
      "totalRequiredSections": 10,
      "sections": []
    },
    "documentCounts": { "total": 1, "resumes": 1, "hasDefaultResume": true },
    "approvedAnswerCount": 3
  }
}
```

`profileCompleteness`, `documentCounts`, and `approvedAnswerCount` are present **only for an
authenticated caller**, so an unauthenticated probe learns connection facts and nothing about the
user. `profileCompleteness` is also absent when no profile exists, or when the stored profile cannot
be parsed — reported as absent rather than as a fabricated zero.

`status` is `degraded` when Ollama is unreachable or the database is in error; the endpoint itself
still returns 200, because the server _is_ answering and the popup needs the detail. When
`ollama.state` is not `connected`, `ollama.error` carries a code (`OLLAMA_UNAVAILABLE` or
`OLLAMA_TIMEOUT`), a message naming the cause, and a suggested action.

`selectedModelInstalled: false` means the configured model is not pulled — reported here rather
than discovered as a failure mid-application.

Schema: `healthResponseSchema`.

### `GET /version`

Unauthenticated. Build identity and the milestone this build implements.

```json
{
  "ok": true,
  "data": {
    "name": "internship-application-agent",
    "version": "0.1.0",
    "milestone": "Milestone 1 — profile and document management",
    "node": "v24.18.0",
    "platform": "win32-x64",
    "startedAt": "2026-07-26T09:21:01.913Z"
  }
}
```

Schema: `versionResponseSchema`.

### `GET /models`

Authenticated. Models installed in the local Ollama daemon.

```json
{
  "ok": true,
  "data": {
    "models": [
      {
        "name": "qwen3.5:9b",
        "size": 6594474711,
        "parameterSize": "9.7B",
        "quantization": "Q4_K_M",
        "modifiedAt": "2026-07-21T22:05:39.548Z"
      }
    ],
    "selectedModel": "qwen3.5:9b",
    "selectedModelInstalled": true
  }
}
```

Errors: `503 OLLAMA_UNAVAILABLE`, `504 OLLAMA_TIMEOUT`.

Schema: `modelsResponseSchema`.

### `GET /profile`

Authenticated. Returns the stored profile plus its computed completeness.

```json
{
  "ok": true,
  "data": {
    "profile": { "id": "primary", "personal": {}, "education": [], "updatedAt": "…" },
    "completeness": {
      "percent": 90,
      "completeSections": 9,
      "totalRequiredSections": 10,
      "sections": [
        {
          "id": "experience",
          "label": "Work experience",
          "required": true,
          "complete": false,
          "missing": ["At least one role with a title"]
        }
      ]
    }
  }
}
```

`404 PROFILE_MISSING` when no profile exists — an empty profile is never invented. A stored record
that no longer satisfies the schema returns `422 VALIDATION_FAILED` naming the offending paths, so
bad data cannot flow into an application form.

Completeness counts required sections only, and `missing` lists requirement names, never values.

Schema: `profileSchema` + `profileCompletenessSchema`.

### `PUT /profile`

Authenticated. Body: `profileUpdateSchema` (the full profile minus `updatedAt`, which the server
owns). This is a replace, not a merge: a section omitted from the body is stored as absent.

`422 VALIDATION_FAILED` lists offending field paths in `debugContext.fields`. Rejected **values** are
never echoed back, because the value is usually the sensitive part.

Every field is optional. A missing value means "the user has not told us" and stays missing — it is
never defaulted, and a missing boolean never becomes `false`.

### `GET /documents`

Authenticated. `{ documents: SavedDocument[], defaultResumeId: string | null }`.

### `POST /documents`

Authenticated. Body: `documentUploadSchema` — `{ name, type, fileName, mimeType, contentBase64,
tags, targetRoles, targetIndustries, isDefault }`.

The caller never supplies a path. The server sanitizes `fileName` to a basename, prefixes it with a
generated document id, and writes inside the documents directory. Body limit for this route is 14 MiB
to accommodate base64; the decoded file must be ≤ 10 MiB.

Rejected with `422 VALIDATION_FAILED` when the MIME type is outside the allowlist, the extension
disagrees with the MIME type, the base64 is malformed or carries a `data:` prefix, or the file's
magic bytes contradict its declared type. Over-size files return `413 REQUEST_TOO_LARGE`.

The first document of a given type automatically becomes that type's default, and a unique partial
index guarantees at most one default per type.

Returns `201` with `savedDocumentSchema`.

### `PUT /documents/:id`

Authenticated. Body: `documentUpdateSchema` — metadata only. The stored file is immutable; replacing
it means registering a new document. `isDefault: true` moves the default atomically.
`404 DOCUMENT_MISSING` for an unknown id.

### `DELETE /documents/:id`

Authenticated. Removes the row and the file. Reports `fileRemoved: false` when the row existed but
the file was already gone, rather than claiming a deletion that did not happen.

### `GET /answers`

Authenticated. `{ answers: ApprovedAnswer[] }`, ordered by category then question.

### `POST /answers`, `PUT /answers/:id`, `DELETE /answers/:id`

Authenticated. Body: `approvedAnswerInputSchema`. The server owns `id` and `lastUpdatedAt`.

Rejected with `422 VALIDATION_FAILED` when:

- the answer value contradicts `answerType` (e.g. `number` with `"three"`),
- `canonicalQuestion` duplicates another answer (unique index),
- `sensitive && autoFillAllowed && !requiresReview` — a sensitive answer can never be filled without
  review, and
- `autoFillAllowed` without `approved`.

### AI and extraction endpoints

All are authenticated and schema-validated.

| Endpoint                        | Purpose                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `POST /ai/classify-question`    | Deterministic classification with local-model fallback for uncertain text |
| `POST /ai/generate-answer`      | Generate, validate, and persist one unapproved answer record              |
| `POST /ai/generate-batch`       | Generate 1–20 requests with configured concurrency 1–2                    |
| `POST /ai/cancel-generation`    | Abort one generation id, or all active generations when omitted           |
| `GET /ai/generations/:id`       | Retrieve a persisted generation record                                    |
| `POST /documents/:id/extract`   | Locally extract and cache PDF, DOCX, or TXT text                          |
| `GET /documents/:id/extraction` | Retrieve the cached extraction                                            |

`generateAnswerRequestSchema` contains scan/plan/field ids, question, optional classification and
constraints, job context, selected document id, explicit user evidence, AI settings, and
regeneration mode. The response is an `AnswerGenerationRecord`; a generation-domain failure is
represented honestly by its terminal state and structured `error` rather than a fabricated draft.

---

## Endpoints reserved for later milestones

Registered and reachable, but they return `501 NOT_IMPLEMENTED` with the milestone named in the
message. They answer honestly instead of 404-ing (which would look like a broken install) and
instead of stubbing a fake success.

| Endpoint                     | Milestone | Response schema when implemented |
| ---------------------------- | --------- | -------------------------------- |
| `POST /applications/analyze` | 2         | `detectedFieldSchema[]`          |
| `POST /applications/plan`    | future    | `applicationPlanSchema`          |
| `POST /applications/report`  | 3         | `applicationRunSchema`           |
| `GET /applications/:id`      | 3         | `applicationRunSchema`           |

Milestone 2 analysis runs inside the extension so live DOM data never needs to be sent to the local
server. The reserved `/applications/analyze` endpoint therefore remains 501 and is not part of the
Milestone 2 flow. The latest validated scan is stored extension-locally and retrieved through the
messages in [EXTENSION_MESSAGING.md](EXTENSION_MESSAGING.md).

---

## Error codes

Transport and setup: `AGENT_SERVER_UNAVAILABLE`, `UNAUTHORIZED`, `ORIGIN_REJECTED`, `RATE_LIMITED`,
`REQUEST_TOO_LARGE`, `VALIDATION_FAILED`, `NOT_FOUND`, `NOT_IMPLEMENTED`, `INTERNAL_ERROR`,
`PERMISSION_DENIED`.

Model: `AI_DISABLED`, `QUESTION_NOT_ELIGIBLE`, `PROHIBITED_QUESTION`,
`INSUFFICIENT_EVIDENCE`, `MODEL_NOT_INSTALLED`, `OLLAMA_UNAVAILABLE`, `OLLAMA_TIMEOUT`,
`GENERATION_CANCELLED`, `INVALID_MODEL_OUTPUT`, `GROUNDING_FAILED`, `ANSWER_LIMIT_EXCEEDED`,
`PROMPT_INJECTION_DETECTED`, `ANSWER_NOT_APPROVED`, `INVALID_MODEL_RESPONSE`.

Data: `PROFILE_MISSING`, `DOCUMENT_MISSING`.

Page and fields: `ATS_UNSUPPORTED`, `FIELD_NOT_FOUND`, `FIELD_NOT_VISIBLE`, `OPTION_NOT_FOUND`,
`VALUE_NOT_VERIFIED`, `UPLOAD_FAILED`, `IFRAME_INACCESSIBLE`, `PAGE_CHANGED`, `REVIEW_REQUIRED`.

Each has default guidance in `DEFAULT_ERROR_GUIDANCE`; a test asserts none is missing.

## Configuration

| Variable                    | Default                  | Effect                                       |
| --------------------------- | ------------------------ | -------------------------------------------- |
| `AGENT_PORT`                | `4317`                   | Listening port. The host is always loopback. |
| `AGENT_TOKEN`               | generated                | Overrides the stored token.                  |
| `AGENT_DATA_DIR`            | `local-data`             | Root for the database, logs, documents.      |
| `AGENT_DB_PATH`             | `<data>/agent.db`        | Database file.                               |
| `AGENT_LOG_LEVEL`           | `info`                   | `debug` \| `info` \| `warn` \| `error`.      |
| `AGENT_ALLOW_LOCAL_ORIGINS` | `true`                   | Permit loopback web origins.                 |
| `OLLAMA_URL`                | `http://127.0.0.1:11434` | Ollama base URL.                             |
| `OLLAMA_MODEL`              | `qwen3.5:9b`             | Default model.                               |
