import { randomUUID } from 'node:crypto';
import {
  savedDocumentSchema,
  type DocumentUpdate,
  type DocumentUpload,
  type SavedDocument,
} from '@internship-agent/shared';
import { asRow, asRows, type AgentDatabase } from '../database/db.js';
import type { DocumentStorage, StoredFile } from './storage.js';

interface DocumentRow {
  id: string;
  name: string;
  type: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  tags: string;
  target_roles: string;
  target_industries: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: string, field: string, id: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `Document ${id} has unparseable ${field}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Document ${id} has a non-string-array ${field}`);
  }
  return value as string[];
}

function rowToDocument(row: DocumentRow): SavedDocument {
  // Validated on read as well as write: a hand-edited database must produce a
  // clear error rather than flow into an application.
  return savedDocumentSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    tags: parseStringArray(row.tags, 'tags', row.id),
    targetRoles: parseStringArray(row.target_roles, 'target_roles', row.id),
    targetIndustries: parseStringArray(row.target_industries, 'target_industries', row.id),
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export interface DocumentRepository {
  list(): SavedDocument[];
  find(id: string): SavedDocument | null;
  /** `stored` must already be on disk; this records it and applies the default. */
  create(input: DocumentUpload, stored: StoredFile, documentId: string): SavedDocument;
  update(id: string, patch: DocumentUpdate): SavedDocument | null;
  remove(id: string): { document: SavedDocument; fileRemoved: boolean } | null;
  defaultResumeId(): string | null;
  counts(): { total: number; resumes: number; hasDefaultResume: boolean };
}

export function createDocumentRepository(
  db: AgentDatabase,
  storage: DocumentStorage,
): DocumentRepository {
  const handle = db.handle;

  const selectAll = handle.prepare(
    'SELECT * FROM documents ORDER BY is_default DESC, type ASC, name COLLATE NOCASE ASC',
  );
  const selectById = handle.prepare('SELECT * FROM documents WHERE id = ?');
  const clearDefaultForType = handle.prepare(
    'UPDATE documents SET is_default = 0, updated_at = ? WHERE type = ? AND id <> ?',
  );
  const deleteById = handle.prepare('DELETE FROM documents WHERE id = ?');

  /**
   * Clearing the previous default and setting the new one must be atomic: the
   * unique partial index would otherwise reject the second write and leave the
   * table with no default at all.
   */
  function applyDefault(id: string, type: string, timestamp: string): void {
    clearDefaultForType.run(timestamp, type, id);
    handle
      .prepare('UPDATE documents SET is_default = 1, updated_at = ? WHERE id = ?')
      .run(timestamp, id);
  }

  function inTransaction<T>(work: () => T): T {
    handle.exec('BEGIN');
    try {
      const result = work();
      handle.exec('COMMIT');
      return result;
    } catch (cause) {
      handle.exec('ROLLBACK');
      throw cause;
    }
  }

  return {
    list(): SavedDocument[] {
      return asRows<DocumentRow>(selectAll.all()).map(rowToDocument);
    },

    find(id): SavedDocument | null {
      const row = asRow<DocumentRow>(selectById.get(id));
      return row ? rowToDocument(row) : null;
    },

    create(input, stored, documentId): SavedDocument {
      const now = new Date().toISOString();

      return inTransaction(() => {
        handle
          .prepare(
            `INSERT INTO documents
               (id, name, type, file_path, file_name, mime_type, size_bytes,
                tags, target_roles, target_industries, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            documentId,
            input.name,
            input.type,
            stored.absolutePath,
            stored.fileName,
            input.mimeType,
            stored.sizeBytes,
            JSON.stringify(input.tags),
            JSON.stringify(input.targetRoles),
            JSON.stringify(input.targetIndustries),
            now,
            now,
          );

        // The first document of a type becomes its default automatically —
        // otherwise a user with exactly one resume would have none selected.
        const existingDefault = asRow<{ id: string }>(
          handle
            .prepare('SELECT id FROM documents WHERE type = ? AND is_default = 1')
            .get(input.type),
        );

        if (input.isDefault || !existingDefault) {
          applyDefault(documentId, input.type, now);
        }

        const created = asRow<DocumentRow>(selectById.get(documentId))!;
        return rowToDocument(created);
      });
    },

    update(id, patch): SavedDocument | null {
      const existing = asRow<DocumentRow>(selectById.get(id));
      if (!existing) return null;

      const now = new Date().toISOString();
      const nextType = patch.type ?? existing.type;

      return inTransaction(() => {
        handle
          .prepare(
            `UPDATE documents
                SET name = ?, type = ?, tags = ?, target_roles = ?, target_industries = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            patch.name ?? existing.name,
            nextType,
            JSON.stringify(patch.tags ?? parseStringArray(existing.tags, 'tags', id)),
            JSON.stringify(
              patch.targetRoles ?? parseStringArray(existing.target_roles, 'target_roles', id),
            ),
            JSON.stringify(
              patch.targetIndustries ??
                parseStringArray(existing.target_industries, 'target_industries', id),
            ),
            now,
            id,
          );

        if (patch.isDefault === true) {
          applyDefault(id, nextType, now);
        } else if (patch.isDefault === false && existing.is_default === 1) {
          handle
            .prepare('UPDATE documents SET is_default = 0, updated_at = ? WHERE id = ?')
            .run(now, id);
        } else if (patch.type && patch.type !== existing.type && existing.is_default === 1) {
          // Moving a default document to another type could create a second
          // default there; re-apply so exactly one survives.
          applyDefault(id, nextType, now);
        }

        return rowToDocument(asRow<DocumentRow>(selectById.get(id))!);
      });
    },

    remove(id): { document: SavedDocument; fileRemoved: boolean } | null {
      const row = asRow<DocumentRow>(selectById.get(id));
      if (!row) return null;

      const document = rowToDocument(row);
      // Remove the row first: an orphaned file is recoverable, but a row pointing
      // at a deleted file would make the UI offer a document that cannot be sent.
      deleteById.run(id);
      const fileRemoved = storage.remove(document.fileName);
      return { document, fileRemoved };
    },

    defaultResumeId(): string | null {
      const row = asRow<{ id: string }>(
        handle.prepare("SELECT id FROM documents WHERE type = 'resume' AND is_default = 1").get(),
      );
      return row?.id ?? null;
    },

    counts() {
      const total = asRow<{ count: number }>(
        handle.prepare('SELECT COUNT(*) AS count FROM documents').get(),
      )!;
      const resumes = asRow<{ count: number }>(
        handle.prepare("SELECT COUNT(*) AS count FROM documents WHERE type = 'resume'").get(),
      )!;
      return {
        total: total.count,
        resumes: resumes.count,
        hasDefaultResume: this.defaultResumeId() !== null,
      };
    },
  };
}

export function newDocumentId(): string {
  return randomUUID();
}
