# local-data

Everything the agent stores on your machine. **Git-ignored in full** — nothing in here should ever
be committed.

| Path                | Contents                                                            |
| ------------------- | -------------------------------------------------------------------- |
| `agent.db`          | SQLite database: profile, documents, answers, application runs.       |
| `agent-token.txt`   | The extension's access token, generated on first server start.        |
| `documents/`        | Resumes and other attachments. The only directory uploads may read.   |
| `logs/agent.log`    | Structured JSON log, one record per line, with sensitive keys redacted. |
| `profiles/`, `answers/`, `applications/` | Reserved for exports in later milestones.       |

To reset everything, stop the server and delete `agent.db` and `agent-token.txt`. The schema is
recreated and a new token issued on the next start — you will need to paste the new token into the
extension options page.
