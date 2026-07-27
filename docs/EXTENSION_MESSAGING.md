# Extension messaging

All scan and fill payloads and responses are Zod schemas in `shared/schemas/messages.ts`. Popup and
review requests go to the background worker; the worker sends the scan to the application tab; the
content script emits progress and returns exactly one terminal completion or failure.

| Message            | Direction                       | Terminal response                  |
| ------------------ | ------------------------------- | ---------------------------------- |
| `SCAN_APPLICATION` | popup/review → worker → content | `SCAN_COMPLETE` or `SCAN_FAILED`   |
| `SCAN_PROGRESS`    | content → extension listeners   | `{ ok: true }`                     |
| `SCAN_COMPLETE`    | content/worker                  | validated result / `{ ok: true }`  |
| `SCAN_FAILED`      | content/worker                  | structured error / `{ ok: true }`  |
| `SCAN_CANCEL`      | popup/review → worker → content | `{ ok: true }`                     |
| `GET_LAST_SCAN`    | popup/review → worker           | `{ scan: ApplicationScanResult     | null }` |
| `CLEAR_LAST_SCAN`  | review → worker                 | `{ ok: true }` or structured error |

| Fill message               | Direction                          | Terminal response                |
| -------------------------- | ---------------------------------- | -------------------------------- |
| `BUILD_DETERMINISTIC_PLAN` | popup/review → worker              | `{ plan }` or structured error   |
| `GET_FILL_PLAN`            | popup/fill-plan → worker           | `{ plan, report }`               |
| `UPDATE_FILL_ACTION`       | fill-plan → worker                 | updated plan or structured error |
| `APPROVE_FILL_ACTION`      | fill-plan → worker                 | updated plan or structured error |
| `APPROVE_SAFE_ACTIONS`     | popup/fill-plan → worker           | updated plan or structured error |
| `EXECUTE_APPROVED_ACTIONS` | popup/fill-plan → worker           | complete or failed               |
| `EXECUTE_FILL_PLAN`        | worker → content                   | complete or failed               |
| `FILL_PROGRESS`            | content → listeners                | `{ ok: true }`                   |
| `FILL_CANCEL`              | popup/fill-plan → worker → content | `{ ok: true }`                   |
| `CLEAR_FILL_PLAN`          | fill-plan → worker                 | `{ ok: true }` or error          |

Ordinary callers time out after 15 seconds, scans after 25 seconds, and fills after 35 seconds.
Worker-to-content scanning has a 20-second hard timeout and filling has a 30-second hard timeout.
Cancellation uses `AbortController`. Errors include code, message, recoverability, suggested action,
and safe debug context. Logs omit tokens, raw HTML, and full field values.

Milestone 4 adds the following closed messages:

| Message                                                  | Purpose                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `CLASSIFY_CUSTOM_QUESTION`                               | Classify one uncertain custom question                     |
| `GENERATE_CUSTOM_ANSWER` / `GENERATE_ALL_CUSTOM_ANSWERS` | Start one or batched local generation                      |
| `ANSWER_GENERATION_PROGRESS`                             | Broadcast field/state/count progress                       |
| `CANCEL_ANSWER_GENERATION`                               | Cancel one or all active generation requests               |
| `GET_GENERATED_ANSWERS` / `CLEAR_GENERATED_ANSWERS`      | Load or invalidate persisted review state                  |
| `UPDATE_GENERATED_ANSWER`                                | Validate a manual edit and mark it `user_override`         |
| `APPROVE_GENERATED_ANSWER` / `REJECT_GENERATED_ANSWER`   | Record explicit review                                     |
| `REGENERATE_CUSTOM_ANSWER`                               | Apply a closed regeneration mode                           |
| `ADD_GENERATION_EVIDENCE`                                | Add explicit user-supplied evidence before regeneration    |
| `SAVE_GENERATED_ANSWER`                                  | Explicitly save reviewed text to the scoped answer library |
| `DOCUMENT_EXTRACT`                                       | Request local extraction of a registered document          |

Generation calls have a 390-second extension timeout so a bounded batch can finish; each individual
Ollama call still obeys the configured timeout. Every AI message is validated at the extension and
HTTP boundaries. Progress contains ids, states, counts, and safe status text—not prompts or answers.

The external execute request carries only a target URL. The worker retrieves the stored scan and
plan and sends them to content; callers cannot inject selectors or DOM instructions. Every request
resolves with a schema-validated terminal response.
