import { createHash, randomUUID } from 'node:crypto';
import {
  latestDocumentRecordSchema,
  type LatestDocumentRecord,
  type LatestDocumentType,
  type LatestDocumentUpload,
} from '@internship-agent/shared';
import { asRow, asRows, type AgentDatabase } from '../database/db.js';
import type { DocumentStorage, StoredFile } from './storage.js';

/**
 * The newest tailored résumé and cover letter, and only those.
 *
 * "Latest" is a query, not a mutable pointer: the newest row of a type wins.
 * A pointer column would have to be cleared and re-set on every save, and a
 * crash between the two writes would leave the extension with no current résumé
 * at all — which is the failure this whole path exists to remove.
 *
 * Superseded rows and their files are deleted after the new one is durable, so
 * a generated document is never stored twice and the popup opening cannot
 * create a copy.
 */

interface LatestDocumentRow {
  id: string;
  document_type: string;
  filename: string;
  mime_type: string;
  byte_length: number;
  checksum: string;
  source: string;
  company: string | null;
  job_title: string | null;
  job_id: string | null;
  file_name: string;
  created_at: string;
  received_at: string;
}

function rowToRecord(row: LatestDocumentRow): LatestDocumentRecord {
  // Validated on read as well as write: a hand-edited database must produce a
  // clear error rather than flow into an employer's file input.
  return latestDocumentRecordSchema.parse({
    id: row.id,
    documentType: row.document_type,
    filename: row.filename,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
    source: row.source,
    ...(row.company ? { company: row.company } : {}),
    ...(row.job_title ? { jobTitle: row.job_title } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    checksum: row.checksum,
  });
}

/** Lowercase hex SHA-256, the one digest this contract speaks. */
export function checksumOf(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface LatestDocumentRepository {
  latest(documentType: LatestDocumentType): LatestDocumentRecord | null;
  find(id: string): { record: LatestDocumentRecord; fileName: string } | null;
  /** `stored` must already be on disk. Returns the new current record. */
  save(
    input: LatestDocumentUpload,
    stored: StoredFile,
    checksum: string,
    id: string,
  ): LatestDocumentRecord;
}

/**
 * The id is minted by the caller because it is also the on-disk filename prefix:
 * the file has to be written before the row exists, and both must name the same
 * document.
 */
export function newLatestDocumentId(): string {
  return randomUUID();
}

export function createLatestDocumentRepository(
  db: AgentDatabase,
  storage: DocumentStorage,
): LatestDocumentRepository {
  const handle = db.handle;

  const selectLatest = handle.prepare(
    `SELECT * FROM latest_documents
      WHERE document_type = ?
      ORDER BY received_at DESC, rowid DESC
      LIMIT 1`,
  );
  const selectById = handle.prepare('SELECT * FROM latest_documents WHERE id = ?');
  const selectSuperseded = handle.prepare(
    'SELECT * FROM latest_documents WHERE document_type = ? AND id <> ?',
  );
  const deleteById = handle.prepare('DELETE FROM latest_documents WHERE id = ?');

  return {
    latest(documentType): LatestDocumentRecord | null {
      const row = asRow<LatestDocumentRow>(selectLatest.get(documentType));
      return row ? rowToRecord(row) : null;
    },

    find(id): { record: LatestDocumentRecord; fileName: string } | null {
      const row = asRow<LatestDocumentRow>(selectById.get(id));
      return row ? { record: rowToRecord(row), fileName: row.file_name } : null;
    },

    save(input, stored, checksum, id): LatestDocumentRecord {
      const now = new Date().toISOString();
      const createdAt = input.createdAt ?? now;

      handle
        .prepare(
          `INSERT INTO latest_documents
             (id, document_type, filename, mime_type, byte_length, checksum, source,
              company, job_title, job_id, file_name, created_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.documentType,
          input.filename,
          input.mimeType,
          stored.sizeBytes,
          checksum,
          input.source,
          input.company ?? null,
          input.jobTitle ?? null,
          input.jobId ?? null,
          stored.fileName,
          createdAt,
          now,
        );

      // Only after the replacement is committed. An orphaned file is
      // recoverable; a row pointing at a file that was deleted first is a
      // résumé the extension can list but never attach.
      for (const stale of asRows<LatestDocumentRow>(selectSuperseded.all(input.documentType, id))) {
        deleteById.run(stale.id);
        // Never delete the file just written. Ids prefix filenames, so a
        // collision should be impossible — but "should be impossible" is not a
        // reason to hand `unlink` the path of the current résumé.
        if (stale.file_name !== stored.fileName) storage.remove(stale.file_name);
      }

      return rowToRecord(asRow<LatestDocumentRow>(selectById.get(id))!);
    },
  };
}
