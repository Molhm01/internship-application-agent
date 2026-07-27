import {
  answerGenerationRecordSchema,
  type AnswerGenerationRecord,
} from '@internship-agent/shared';
import { asRow, asRows, type AgentDatabase } from '../database/db.js';

interface GenerationRow {
  id: string;
  data: string;
}

function parse(row: GenerationRow): AnswerGenerationRecord {
  return answerGenerationRecordSchema.parse(JSON.parse(row.data) as unknown);
}

export interface GenerationRepository {
  find(id: string): AnswerGenerationRecord | null;
  list(scanId: string, planId?: string): AnswerGenerationRecord[];
  save(record: AnswerGenerationRecord): AnswerGenerationRecord;
}

export function createGenerationRepository(db: AgentDatabase): GenerationRepository {
  return {
    find(id) {
      const row = asRow<GenerationRow>(
        db.handle.prepare('SELECT id, data FROM answer_generations WHERE id = ?').get(id),
      );
      return row ? parse(row) : null;
    },
    list(scanId, planId) {
      const rows = planId
        ? db.handle
            .prepare(
              'SELECT id, data FROM answer_generations WHERE scan_id = ? AND plan_id = ? ORDER BY updated_at',
            )
            .all(scanId, planId)
        : db.handle
            .prepare(
              'SELECT id, data FROM answer_generations WHERE scan_id = ? ORDER BY updated_at',
            )
            .all(scanId);
      return asRows<GenerationRow>(rows).map(parse);
    },
    save(record) {
      const parsed = answerGenerationRecordSchema.parse(record);
      db.handle
        .prepare(
          `INSERT INTO answer_generations
             (id, scan_id, plan_id, field_id, state, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(
          parsed.id,
          parsed.scanId,
          parsed.planId,
          parsed.fieldId,
          parsed.state,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        );
      return parsed;
    },
  };
}
