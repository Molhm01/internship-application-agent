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
  {
    version: 4,
    name: 'production_recovery_and_persistence_catalog',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS education (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experience (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS volunteering (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS eligibility (
        profile_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, ats TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS detected_fields (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_detected_fields_scan ON detected_fields(scan_id);

      CREATE TABLE IF NOT EXISTS fill_plans (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fill_actions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES fill_plans(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fill_actions_plan ON fill_actions(plan_id);

      CREATE TABLE IF NOT EXISTS evidence_items (
        id TEXT PRIMARY KEY, generation_id TEXT, source TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fill_runs (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, submitted INTEGER NOT NULL DEFAULT 0
          CHECK (submitted = 0)
      );
      CREATE TABLE IF NOT EXISTS fill_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES fill_runs(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fill_results_run ON fill_results(run_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL, event_type TEXT NOT NULL,
        entity_id TEXT, safe_context TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(occurred_at DESC);
    `,
  },
  {
    version: 5,
    name: 'application_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS application_sessions (
        session_id     TEXT PRIMARY KEY,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        claimed_at     INTEGER,
        status         TEXT NOT NULL,
        url            TEXT NOT NULL,
        domain         TEXT NOT NULL,
        ats            TEXT NOT NULL,
        job_context    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON application_sessions (expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON application_sessions (status);
    `,
  },
  {
    version: 6,
    name: 'application_sessions_website_handoff',
    sql: `
      ALTER TABLE application_sessions ADD COLUMN company TEXT;
      ALTER TABLE application_sessions ADD COLUMN job_title TEXT;
      ALTER TABLE application_sessions ADD COLUMN official_apply_url TEXT;
      ALTER TABLE application_sessions ADD COLUMN website_job_id TEXT;
      ALTER TABLE application_sessions ADD COLUMN location TEXT;
      ALTER TABLE application_sessions ADD COLUMN eligibility_score REAL;
      ALTER TABLE application_sessions ADD COLUMN tailored_resume_document_id TEXT;
      ALTER TABLE application_sessions ADD COLUMN tailored_cover_letter_document_id TEXT;
      ALTER TABLE application_sessions ADD COLUMN start_autofill INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    name: 'latest_generated_documents',
    sql: `
      -- The newest tailored résumé and cover letter Internship Pilot produced.
      -- Kept apart from \`documents\`, which is the user's own hand-registered
      -- library: these rows are machine-written, superseded rather than edited,
      -- and are the only thing the document-only attachment path reads.
      CREATE TABLE IF NOT EXISTS latest_documents (
        id            TEXT PRIMARY KEY,
        document_type TEXT NOT NULL CHECK (document_type IN ('resume', 'cover_letter')),
        filename      TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        byte_length   INTEGER NOT NULL,
        checksum      TEXT NOT NULL,
        source        TEXT NOT NULL CHECK (source IN ('tailored', 'default')),
        company       TEXT,
        job_title     TEXT,
        job_id        TEXT,
        file_name     TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        received_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_latest_documents_type_received
        ON latest_documents (document_type, received_at DESC);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
