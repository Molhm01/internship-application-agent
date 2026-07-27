# Security

This tool holds a complete picture of someone's identity: legal name, address, phone, education,
employment, work authorization, and demographic answers. It also drives a browser on their behalf.
Both facts shape everything below.

## Guarantees

1. **Nothing leaves the machine.** No profile data, document, answer, or page content is sent to
   any remote service. Inference is local via Ollama. There is no telemetry.
2. **Loopback only.** `config.host` is the constant `127.0.0.1`, not an environment variable.
   Making the server reachable from the network would require a code change and a review.
3. **No application is ever submitted.** Enforced in three places: no executor action can click a
   submit control, `applicationRunSchema.submitted` is `z.literal(false)`, and the SQLite table
   carries `CHECK (submitted = 0)`.
4. **The model cannot act.** It returns a validated answer candidate and nothing executable. See
   [ARCHITECTURE.md](ARCHITECTURE.md#what-the-model-can-and-cannot-do).
5. **No arbitrary filesystem access, command execution, or JavaScript evaluation.** Nothing in this
   repository calls `eval`, `new Function`, `child_process`, or `vm`.

## Authentication

A 256-bit CSPRNG token is generated on first start and written to `local-data/agent-token.txt` with
mode `600` (POSIX modes are advisory on Windows; the file still sits inside the user profile).
`AGENT_TOKEN` overrides it.

Comparison uses `timingSafeEqual` on equal-length buffers, so a caller cannot recover the token
byte by byte. The token is printed to stdout at startup but **never written to the log file** — the
redaction list covers `token`, `authToken`, and `authorization`, and a live check confirms it does
not appear in `local-data/logs/agent.log`.

`/health` and `/version` are deliberately unauthenticated. The alternative — a popup that cannot
tell "server down" from "token missing" — produces exactly the vague failure this product forbids.
Neither endpoint returns profile content; `/health` reports only connection facts plus a boolean
`profileLoaded`.

Every other route, including unknown paths, returns 401 without a token, so an unauthenticated
caller cannot enumerate routes.

## Origin policy

| Origin                                     | Allowed      | Why                                                             |
| ------------------------------------------ | ------------ | --------------------------------------------------------------- |
| absent                                     | yes          | curl and health probes; still requires a token.                 |
| `chrome-extension://…`                     | yes          | The extension itself.                                           |
| `http://127.0.0.1:*`, `http://localhost:*` | configurable | Tests and docs. Disable with `AGENT_ALLOW_LOCAL_ORIGINS=false`. |
| anything else                              | no           | `403 ORIGIN_REJECTED`.                                          |

The loopback pattern is anchored, so `https://127.0.0.1.evil.com` does not match. A test covers
that case.

## Limits

- Body limit 2 MiB (`413`).
- 240 requests per 60 s per client, fixed window, in memory (`429` with `retry-after`).

The rate limit exists to contain a runaway extension loop, not a hostile network — a loopback
single-process server does not need a distributed limiter.

## Log redaction

`agent-server/src/logging/redact.ts` replaces the value of any key matching a sensitive name —
tokens, credentials, `answer`, `value`, `attemptedValue`, `observedValue`, `email`, `phone`,
`address`, `gpa`, `profile`, `filePath`, and others — with `[redacted]`, case-insensitively and at
every depth. It also truncates long strings, caps array length, bounds recursion, and survives
cycles, because a logger must never be the thing that crashes a request.

Raw model responses are written only to the private debug log, never to the general log.

**Do not bypass the logger.** A one-off `console.log(profile)` defeats all of this.

## Document handling

**No caller ever supplies a filesystem path.** A document is registered by uploading its bytes
(base64, chosen through the browser's own file picker). The server derives the stored name itself:
`sanitizeFileName` reduces the original to a basename — stripping directory components, control
characters, characters Windows forbids, trailing dots, and reserved device names like `CON` — and
prefixes it with a generated document id so uploads cannot collide or overwrite.

Every read and write then goes through `resolveInsideRoot`, which resolves the path and proves it
lands inside the documents directory, comparing resolved paths so a sibling such as
`local-data/documents-evil` cannot pass as `local-data/documents`. Tests cover traversal
(`../../../../evil.pdf`), absolute Windows paths, and the sibling-prefix case.

Uploads are further constrained: the MIME type must be in an allowlist (PDF, DOC, DOCX, RTF, TXT,
MD, PNG, JPG), the file extension must agree with that MIME type, and the file's magic bytes must
match too — so a renamed executable cannot be filed as a resume. Files are written mode `600` and
capped at 10 MiB.

Resume parsing is local and limited to registered PDF, DOCX, and TXT documents inside the controlled
directory. The model receives selected normalized evidence snippets with opaque ids, never document
bytes, metadata, or paths. PDF metadata is deliberately excluded from evidence.

## Profile and answer data

The profile is stored as one Zod-validated JSON document and re-validated on the way **out** as well
as in, so a hand-edited or schema-drifted record surfaces as a clear error instead of flowing into an
application form.

Validation failures name the offending **field paths** and never echo the rejected value — the value
is usually the sensitive part. A test asserts a rejected email does not appear in the response.

The approved-answer library enforces two invariants at the schema level, so no UI bug can bypass
them: a sensitive answer can never be auto-filled without review, and an answer cannot be
auto-filled unless it is approved.

`GET /health` returns profile completeness, document counts, and the answer count **only to an
authenticated caller**. An unauthenticated probe learns connection facts and nothing about the user.

## Extension permissions

| Permission                         | Why                                                  |
| ---------------------------------- | ---------------------------------------------------- |
| `storage`                          | Server URL, token, model choice.                     |
| `activeTab`                        | Read the current tab's URL for the popup.            |
| `scripting`                        | Run the scanner and approved deterministic executor. |
| `host_permissions: 127.0.0.1:4317` | Talk to the user's local server.                     |
| `host_permissions: 127.0.0.1:4318` | Isolated Playwright server; still loopback only.     |
| `content_scripts: http(s)://*`     | Applications live on arbitrary employer domains.     |

The content-script match pattern is broad because job applications are hosted anywhere. The script
itself is inert until the user explicitly starts an analysis, makes no network requests, and writes
nothing to the page outside an approved fill action.

## Sensitive questions

Race, ethnicity, gender, disability status, veteran status, religion, sexual orientation,
citizenship, sponsorship, criminal history, medical information, salary expectations, and security
clearance are never guessed and never inferred. Each requires a stored policy —
`approved_auto_fill`, `review_required`, `decline_to_answer`, or `leave_blank`. With no policy, the
default is `review_required`.

The matcher also recognizes these categories by deterministic label rules when the scanner has no
exact canonical key (for example religion or medical information). User overrides never remove the
sensitive flag. **Approve All Safe** excludes sensitive and review-required actions. Legal consent,
terms, certification, acknowledgement, and attestation checkboxes default to manual review.

## Deterministic execution boundary

- Plans contain field IDs but no selectors; selectors come only from the validated scan.
- Execution requires exact plan/scan IDs, URL, domain, field fingerprint, visibility, and enabled
  state.
- Select/radio/grouped-checkbox values must match detected options exactly or through documented
  aliases; ambiguity is manual review.
- Only approved actions with confidence at least `0.8` execute.
- The executor has no operation for upload, arbitrary click, Next, Continue, or Submit.
- Every mutation is verified after page events and framework rerender; failures are reported and
  retried at most once.
- AI drafts begin unapproved, require valid grounding and explicit per-answer approval, and become
  only `fill_generated_text`; low-confidence or invalid drafts cannot use bulk approval.

## AI threat model

Application and evidence text are untrusted. Prompt-injection patterns are flagged, untrusted text
is delimiter-wrapped, structured output is closed, evidence ids are checked, every factual/numeric
claim is tested against verified evidence, and tool/code/placeholder output is rejected. There is
one bounded repair/retry. Output is displayed as inert text and never interpreted as HTML or code.
See [PROMPT_INJECTION.md](PROMPT_INJECTION.md).

Ollama requests never log prompts or raw responses. Cancellation uses `AbortController`; concurrency
is capped at two; prompt evidence is capped by item and character count. Generation persistence and
extension review storage contain personal data and inherit the local-account plaintext limitation.

## Known limitations

- The token is stored in plaintext in `local-data/` and in `chrome.storage.local`. Both are readable
  by other processes running as the same user. Given a loopback-only server holding data that is
  already on that machine, this is an accepted trade-off, not an oversight.
- The rate limiter is per-process and resets on restart.
- Cross-origin iframes cannot be read by an extension content script. Those sections will be
  reported as `IFRAME_INACCESSIBLE` for manual completion rather than silently skipped.

## Reporting

This is a personal, local-only tool with no server component and no users other than its operator.
If you find a flaw, fix it in a branch and note it here.
