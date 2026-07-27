export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Append-only. Never edit a migration that has shipped: an existing database has
 * already recorded it as applied, so a change would silently never run.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS profile (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        file_path         TEXT NOT NULL,
        mime_type         TEXT NOT NULL,
        size_bytes        INTEGER NOT NULL,
        tags              TEXT NOT NULL DEFAULT '[]',
        target_roles      TEXT NOT NULL DEFAULT '[]',
        target_industries TEXT NOT NULL DEFAULT '[]',
        is_default        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approved_answers (
        id                 TEXT PRIMARY KEY,
        canonical_question TEXT NOT NULL,
        aliases            TEXT NOT NULL DEFAULT '[]',
        answer_type        TEXT NOT NULL,
        answer             TEXT NOT NULL,
        category           TEXT NOT NULL,
        approved           INTEGER NOT NULL DEFAULT 0,
        auto_fill_allowed  INTEGER NOT NULL DEFAULT 0,
        sensitive          INTEGER NOT NULL DEFAULT 0,
        tailoring_allowed  INTEGER NOT NULL DEFAULT 0,
        requires_review    INTEGER NOT NULL DEFAULT 1,
        last_updated_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_answers_category ON approved_answers (category);

      CREATE TABLE IF NOT EXISTS application_runs (
        id              TEXT PRIMARY KEY,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        url             TEXT NOT NULL,
        domain          TEXT NOT NULL,
        ats             TEXT NOT NULL,
        job_context     TEXT,
        status          TEXT NOT NULL,
        total_fields    INTEGER NOT NULL DEFAULT 0,
        filled_fields   INTEGER NOT NULL DEFAULT 0,
        verified_fields INTEGER NOT NULL DEFAULT 0,
        skipped_fields  INTEGER NOT NULL DEFAULT 0,
        review_fields   INTEGER NOT NULL DEFAULT 0,
        failed_fields   INTEGER NOT NULL DEFAULT 0,
        warnings        TEXT NOT NULL DEFAULT '[]',
        errors          TEXT NOT NULL DEFAULT '[]',
        submitted       INTEGER NOT NULL DEFAULT 0 CHECK (submitted = 0)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON application_runs (started_at DESC);

      CREATE TABLE IF NOT EXISTS application_actions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         TEXT NOT NULL REFERENCES application_runs (id) ON DELETE CASCADE,
        field_id       TEXT NOT NULL,
        question       TEXT NOT NULL,
        action         TEXT NOT NULL,
        source         TEXT NOT NULL,
        status         TEXT NOT NULL,
        verified       INTEGER NOT NULL DEFAULT 0,
        attempts       INTEGER NOT NULL DEFAULT 0,
        payload        TEXT NOT NULL DEFAULT '{}',
        completed_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_actions_run ON application_actions (run_id);
    `,
  },
  {
    version: 2,
    name: 'document_file_name_and_indexes',
    sql: `
      -- Basename of the stored file, so the UI can show it without being handed
      -- the absolute path.
      ALTER TABLE documents ADD COLUMN file_name TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (type);
      CREATE INDEX IF NOT EXISTS idx_documents_default ON documents (type, is_default);

      -- At most one default per document type. Enforced by the database so a UI
      -- bug cannot produce two "default" resumes.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_one_default_per_type
        ON documents (type) WHERE is_default = 1;

      -- Answer lookup is by canonical question text, which must be unique so the
      -- library cannot hold two conflicting answers to the same question.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_canonical
        ON approved_answers (canonical_question);
    `,
  },
  {
    version: 3,
    name: 'milestone_4_ai_answers_and_resume_extraction',
    sql: `
      CREATE TABLE IF NOT EXISTS document_extractions (
        document_id    TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
        status         TEXT NOT NULL,
        normalized_text TEXT NOT NULL DEFAULT '',
        sections       TEXT NOT NULL DEFAULT '[]',
        content_hash   TEXT,
        extracted_at   TEXT,
        error          TEXT
      );

      CREATE TABLE IF NOT EXISTS answer_generations (
        id          TEXT PRIMARY KEY,
        scan_id     TEXT NOT NULL,
        plan_id     TEXT NOT NULL,
        field_id    TEXT NOT NULL,
        state       TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_answer_generations_scan
        ON answer_generations (scan_id, plan_id, updated_at DESC);

      ALTER TABLE approved_answers ADD COLUMN normalized_question TEXT;
      ALTER TABLE approved_answers ADD COLUMN classification TEXT;
      ALTER TABLE approved_answers ADD COLUMN evidence_references TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE approved_answers ADD COLUMN scope TEXT NOT NULL DEFAULT 'general';
      ALTER TABLE approved_answers ADD COLUMN scope_reference TEXT;
      ALTER TABLE approved_answers ADD COLUMN word_count INTEGER;
      ALTER TABLE approved_answers ADD COLUMN created_at TEXT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
