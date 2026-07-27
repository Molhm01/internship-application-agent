# Recovery

Stop the local server before restore operations.

```powershell
npm run db:check
npm run db:backup
npm run user-data:export
npm run db:restore -- --from "local-data/backups/<backup>.db"
npm run db:check
npm run backup:verify
```

Backup uses SQLite `VACUUM INTO` and validates the resulting database. Restore validates its source,
stages a copy beside the target, renames the existing database to a timestamped
`.pre-restore-*.bak`, removes only the target database’s WAL/SHM sidecars, and atomically replaces
the target. If startup then fails, stop the server and restore the pre-restore copy.

Documents are separate files under `local-data/documents`; database backups preserve their
metadata, not the bytes. Back up that directory with normal encrypted local backup software.
Authentication tokens are deliberately excluded from user-data exports.
