import {
  documentExtractionSchema,
  type AgentError,
  type DocumentExtraction,
} from '@internship-agent/shared';
import { asRow, type AgentDatabase } from '../database/db.js';

interface ExtractionRow {
  document_id: string;
  status: string;
  normalized_text: string;
  sections: string;
  content_hash: string | null;
  extracted_at: string | null;
  error: string | null;
}

function fromRow(row: ExtractionRow): DocumentExtraction {
  return documentExtractionSchema.parse({
    documentId: row.document_id,
    status: row.status,
    normalizedText: row.normalized_text,
    sections: JSON.parse(row.sections) as unknown,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.extracted_at ? { extractedAt: row.extracted_at } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as AgentError } : {}),
  });
}

export interface ExtractionRepository {
  find(documentId: string): DocumentExtraction | null;
  save(extraction: DocumentExtraction): DocumentExtraction;
}

export function createExtractionRepository(db: AgentDatabase): ExtractionRepository {
  const find = db.handle.prepare('SELECT * FROM document_extractions WHERE document_id = ?');
  const save = db.handle.prepare(`
    INSERT INTO document_extractions
      (document_id, status, normalized_text, sections, content_hash, extracted_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      status = excluded.status,
      normalized_text = excluded.normalized_text,
      sections = excluded.sections,
      content_hash = excluded.content_hash,
      extracted_at = excluded.extracted_at,
      error = excluded.error
  `);
  return {
    find(documentId) {
      const row = asRow<ExtractionRow>(find.get(documentId));
      return row ? fromRow(row) : null;
    },
    save(extraction) {
      const parsed = documentExtractionSchema.parse(extraction);
      save.run(
        parsed.documentId,
        parsed.status,
        parsed.normalizedText,
        JSON.stringify(parsed.sections),
        parsed.contentHash ?? null,
        parsed.extractedAt ?? null,
        parsed.error ? JSON.stringify(parsed.error) : null,
      );
      return parsed;
    },
  };
}
