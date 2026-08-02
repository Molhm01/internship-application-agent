import type { AgentDatabase } from './db.js';
import { asRow } from './db.js';
import { applicationSessionSchema } from '@internship-agent/shared';
import type { ApplicationSession } from '@internship-agent/shared';

interface ApplicationSessionRow {
  session_id: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  status: string;
  url: string;
  domain: string;
  ats: string;
  job_context: string | null;
  company: string | null;
  job_title: string | null;
  official_apply_url: string | null;
  website_job_id: string | null;
  location: string | null;
  eligibility_score: number | null;
  tailored_resume_document_id: string | null;
  tailored_cover_letter_document_id: string | null;
  start_autofill: number;
}

function rowToSession(row: ApplicationSessionRow): ApplicationSession {
  const candidate = {
    sessionId: row.session_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at ?? undefined,
    status: row.status,
    url: row.url,
    domain: row.domain,
    ats: row.ats,
    jobContext: row.job_context ? (JSON.parse(row.job_context) as unknown) : undefined,
    company: row.company ?? undefined,
    jobTitle: row.job_title ?? undefined,
    officialApplyUrl: row.official_apply_url ?? undefined,
    websiteJobId: row.website_job_id ?? undefined,
    location: row.location ?? undefined,
    eligibilityScore: row.eligibility_score ?? undefined,
    tailoredResumeDocumentId: row.tailored_resume_document_id ?? undefined,
    tailoredCoverLetterDocumentId: row.tailored_cover_letter_document_id ?? undefined,
    startAutofill: Boolean(row.start_autofill),
  };
  return applicationSessionSchema.parse(candidate);
}

export interface CreateApplicationSessionInput {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: 'available' | 'claimed' | 'completed';
  url: string;
  domain: string;
  ats: string;
  jobContext?: ApplicationSession['jobContext'];
  company?: string;
  jobTitle?: string;
  officialApplyUrl?: string;
  websiteJobId?: string;
  location?: string;
  eligibilityScore?: number;
  tailoredResumeDocumentId?: string;
  tailoredCoverLetterDocumentId?: string;
  startAutofill?: boolean;
}

export function createApplicationSession(
  db: AgentDatabase,
  input: CreateApplicationSessionInput,
): ApplicationSession {
  const sql = `
    INSERT INTO application_sessions (
      session_id, created_at, expires_at, claimed_at, status,
      url, domain, ats, job_context,
      company, job_title, official_apply_url, website_job_id, location,
      eligibility_score, tailored_resume_document_id, tailored_cover_letter_document_id,
      start_autofill
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `;

  const row = db.handle
    .prepare(sql)
    .get(
      input.sessionId,
      input.createdAt,
      input.expiresAt,
      input.status,
      input.url,
      input.domain,
      input.ats,
      input.jobContext ? JSON.stringify(input.jobContext) : null,
      input.company ?? null,
      input.jobTitle ?? null,
      input.officialApplyUrl ?? null,
      input.websiteJobId ?? null,
      input.location ?? null,
      input.eligibilityScore ?? null,
      input.tailoredResumeDocumentId ?? null,
      input.tailoredCoverLetterDocumentId ?? null,
      input.startAutofill ? 1 : 0,
    );

  const created = asRow<ApplicationSessionRow>(row);
  if (!created) {
    throw new Error('INSERT ... RETURNING * produced no row');
  }
  return rowToSession(created);
}

export function getApplicationSession(db: AgentDatabase, sessionId: string): ApplicationSession | null {
  const row = db.handle
    .prepare('SELECT * FROM application_sessions WHERE session_id = ?')
    .get(sessionId) as ApplicationSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function claimApplicationSession(db: AgentDatabase, sessionId: string): ApplicationSession | null {
  const row = db.handle
    .prepare(
      `UPDATE application_sessions
       SET claimed_at = ?, status = 'claimed'
       WHERE session_id = ? AND status = 'available'
       RETURNING *`,
    )
    .get(Date.now(), sessionId) as ApplicationSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function updateApplicationSessionStatus(
  db: AgentDatabase,
  sessionId: string,
  status: 'available' | 'claimed' | 'completed',
): ApplicationSession | null {
  const row = db.handle
    .prepare(`UPDATE application_sessions SET status = ? WHERE session_id = ? RETURNING *`)
    .get(status, sessionId) as ApplicationSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function clearExpiredApplicationSessions(db: AgentDatabase): void {
  db.handle.prepare('DELETE FROM application_sessions WHERE expires_at < ?').run(Date.now());
}
