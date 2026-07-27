import { randomUUID } from 'node:crypto';
import {
  approvedAnswerSchema,
  type ApprovedAnswer,
  type ApprovedAnswerInput,
} from '@internship-agent/shared';
import { asRow, asRows, type AgentDatabase } from '../database/db.js';

interface AnswerRow {
  id: string;
  canonical_question: string;
  aliases: string;
  answer_type: string;
  answer: string;
  category: string;
  approved: number;
  auto_fill_allowed: number;
  sensitive: number;
  tailoring_allowed: number;
  requires_review: number;
  last_updated_at: string;
  normalized_question: string | null;
  classification: string | null;
  evidence_references: string;
  scope: string;
  scope_reference: string | null;
  word_count: number | null;
  created_at: string | null;
}

export class DuplicateQuestionError extends Error {
  constructor(readonly canonicalQuestion: string) {
    super(`An approved answer already exists for "${canonicalQuestion}"`);
    this.name = 'DuplicateQuestionError';
  }
}

function rowToAnswer(row: AnswerRow): ApprovedAnswer {
  let aliases: unknown;
  let answer: unknown;
  try {
    aliases = JSON.parse(row.aliases);
    // Values are stored JSON-encoded so a boolean, number, string, or array all
    // round-trip through one TEXT column without ambiguity.
    answer = JSON.parse(row.answer);
  } catch (cause) {
    throw new Error(
      `Approved answer ${row.id} has unparseable stored JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  return approvedAnswerSchema.parse({
    id: row.id,
    canonicalQuestion: row.canonical_question,
    aliases,
    answerType: row.answer_type,
    answer,
    category: row.category,
    approved: row.approved === 1,
    autoFillAllowed: row.auto_fill_allowed === 1,
    sensitive: row.sensitive === 1,
    tailoringAllowed: row.tailoring_allowed === 1,
    requiresReview: row.requires_review === 1,
    lastUpdatedAt: row.last_updated_at,
    ...(row.normalized_question ? { normalizedQuestion: row.normalized_question } : {}),
    ...(row.classification ? { classification: row.classification } : {}),
    evidenceReferences: JSON.parse(row.evidence_references) as unknown,
    scope: row.scope,
    ...(row.scope_reference ? { scopeReference: row.scope_reference } : {}),
    ...(row.word_count !== null ? { wordCount: row.word_count } : {}),
    createdAt: row.created_at ?? row.last_updated_at,
  });
}

export interface AnswerRepository {
  list(): ApprovedAnswer[];
  find(id: string): ApprovedAnswer | null;
  create(input: ApprovedAnswerInput): ApprovedAnswer;
  update(id: string, input: ApprovedAnswerInput): ApprovedAnswer | null;
  remove(id: string): ApprovedAnswer | null;
  count(): number;
}

export function createAnswerRepository(db: AgentDatabase): AnswerRepository {
  const handle = db.handle;
  const selectAll = handle.prepare(
    'SELECT * FROM approved_answers ORDER BY category COLLATE NOCASE ASC, canonical_question COLLATE NOCASE ASC',
  );
  const selectById = handle.prepare('SELECT * FROM approved_answers WHERE id = ?');
  const selectByQuestion = handle.prepare(
    'SELECT id FROM approved_answers WHERE canonical_question = ? AND id <> ?',
  );

  function assertQuestionFree(canonicalQuestion: string, excludingId: string): void {
    const clash = asRow<{ id: string }>(selectByQuestion.get(canonicalQuestion, excludingId));
    if (clash) throw new DuplicateQuestionError(canonicalQuestion);
  }

  return {
    list(): ApprovedAnswer[] {
      return asRows<AnswerRow>(selectAll.all()).map(rowToAnswer);
    },

    find(id): ApprovedAnswer | null {
      const row = asRow<AnswerRow>(selectById.get(id));
      return row ? rowToAnswer(row) : null;
    },

    create(input): ApprovedAnswer {
      assertQuestionFree(input.canonicalQuestion, '');
      const id = randomUUID();
      const now = new Date().toISOString();

      handle
        .prepare(
          `INSERT INTO approved_answers
             (id, canonical_question, aliases, answer_type, answer, category,
              approved, auto_fill_allowed, sensitive, tailoring_allowed, requires_review, last_updated_at,
              normalized_question, classification, evidence_references, scope, scope_reference,
              word_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.canonicalQuestion,
          JSON.stringify(input.aliases),
          input.answerType,
          JSON.stringify(input.answer),
          input.category,
          input.approved ? 1 : 0,
          input.autoFillAllowed ? 1 : 0,
          input.sensitive ? 1 : 0,
          input.tailoringAllowed ? 1 : 0,
          input.requiresReview ? 1 : 0,
          now,
          input.normalizedQuestion ?? null,
          input.classification ?? null,
          JSON.stringify(input.evidenceReferences ?? []),
          input.scope ?? 'general',
          input.scopeReference ?? null,
          input.wordCount ?? null,
          input.createdAt ?? now,
        );

      return rowToAnswer(asRow<AnswerRow>(selectById.get(id))!);
    },

    update(id, input): ApprovedAnswer | null {
      if (!selectById.get(id)) return null;
      assertQuestionFree(input.canonicalQuestion, id);

      handle
        .prepare(
          `UPDATE approved_answers
              SET canonical_question = ?, aliases = ?, answer_type = ?, answer = ?, category = ?,
                  approved = ?, auto_fill_allowed = ?, sensitive = ?, tailoring_allowed = ?,
                  requires_review = ?, last_updated_at = ?, normalized_question = ?,
                  classification = ?, evidence_references = ?, scope = ?, scope_reference = ?,
                  word_count = ?
            WHERE id = ?`,
        )
        .run(
          input.canonicalQuestion,
          JSON.stringify(input.aliases),
          input.answerType,
          JSON.stringify(input.answer),
          input.category,
          input.approved ? 1 : 0,
          input.autoFillAllowed ? 1 : 0,
          input.sensitive ? 1 : 0,
          input.tailoringAllowed ? 1 : 0,
          input.requiresReview ? 1 : 0,
          new Date().toISOString(),
          input.normalizedQuestion ?? null,
          input.classification ?? null,
          JSON.stringify(input.evidenceReferences ?? []),
          input.scope ?? 'general',
          input.scopeReference ?? null,
          input.wordCount ?? null,
          id,
        );

      return rowToAnswer(asRow<AnswerRow>(selectById.get(id))!);
    },

    remove(id): ApprovedAnswer | null {
      const existing = this.find(id);
      if (!existing) return null;
      handle.prepare('DELETE FROM approved_answers WHERE id = ?').run(id);
      return existing;
    },

    count(): number {
      const row = asRow<{ count: number }>(
        handle.prepare('SELECT COUNT(*) AS count FROM approved_answers').get(),
      )!;
      return row.count;
    },
  };
}
