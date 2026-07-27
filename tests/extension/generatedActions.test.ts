import { describe, expect, it } from 'vitest';
import {
  answerGenerationRecordSchema,
  deterministicFillPlanSchema,
  detectedFieldSchema,
  type AnswerGenerationRecord,
} from '@internship-agent/shared';
import {
  applyRecordToPlan,
  generationStatistics,
  updateManualAnswer,
} from '../../extension/src/answers/generatedActions.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';

const now = new Date().toISOString();

function record(): AnswerGenerationRecord {
  const answer = 'I am interested because my saved TypeScript project aligns with this role.';
  return answerGenerationRecordSchema.parse({
    id: 'generation-1',
    scanId: 'scan-1',
    planId: 'plan-1',
    fieldId: 'field-1',
    question: 'Why are you interested in this role?',
    classification: 'why_role',
    constraints: { maxCharacters: 500 },
    state: 'ready_for_review',
    candidate: {
      questionId: 'field-1',
      status: 'generated',
      classification: 'why_role',
      answer,
      evidenceUsed: ['ev-1'],
      factualClaims: [{ claim: 'Saved TypeScript project', evidenceIds: ['ev-1'] }],
      missingInformation: [],
      warnings: [],
      confidence: 'high',
      wordCount: answer.split(/\s+/).length,
      characterCount: answer.length,
    },
    validation: { valid: true, checkedAt: now, issues: [], warnings: [] },
    contextEvidence: [
      {
        id: 'ev-1',
        source: 'profile',
        sourceReference: 'profile.projects.one',
        category: 'project',
        text: 'Saved TypeScript project',
        facts: ['TypeScript'],
        relevanceScore: 100,
        sensitive: false,
        verified: true,
      },
    ],
    userEvidence: [],
    source: 'ai_generated',
    approved: false,
    rejected: false,
    leaveBlank: false,
    createdAt: now,
    updatedAt: now,
    warnings: [],
  });
}

function plan() {
  return deterministicFillPlanSchema.parse({
    id: 'plan-1',
    scanId: 'scan-1',
    createdAt: now,
    updatedAt: now,
    url: 'https://example.com/apply',
    domain: 'example.com',
    ats: 'generic',
    actions: [
      {
        id: 'action-1',
        fieldId: 'field-1',
        question: 'Why are you interested in this role?',
        fieldType: 'textarea',
        action: 'manual_review',
        source: 'none',
        confidence: 0,
        sensitive: false,
        requiresReview: true,
        approved: false,
        reason: 'No deterministic profile answer.',
        warnings: [],
      },
    ],
    warnings: [],
    statistics: { total: 1, ready: 0, review: 1, skipped: 0, unsupported: 0, sensitive: 0 },
  });
}

describe('generated answer fill integration', () => {
  it('upserts a missing generated action while preserving the original scan field ID', () => {
    const target = detectedFieldSchema.parse({
      id: 'field-1',
      pageId: 'page-1',
      label: 'Why are you interested in this role?',
      normalizedLabel: 'why are you interested in this role',
      question: 'Why are you interested in this role?',
      fieldType: 'textarea',
      semanticType: 'other',
      selector: '#answer',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
      warnings: [],
      metadata: { tagName: 'textarea' },
    });
    const stale = deterministicFillPlanSchema.parse({
      ...plan(),
      actions: [],
      statistics: {
        total: 0,
        ready: 0,
        review: 0,
        skipped: 0,
        unsupported: 0,
        sensitive: 0,
      },
    });
    const integrated = applyRecordToPlan(stale, record(), target);
    expect(integrated.actions).toHaveLength(1);
    expect(integrated.actions[0]).toMatchObject({
      fieldId: target.id,
      question: target.question,
      action: 'fill_generated_text',
      generationId: 'generation-1',
      approved: false,
    });
    expect(integrated.statistics.total).toBe(1);
  });

  it('never pre-approves a valid generated answer', () => {
    const integrated = applyRecordToPlan(plan(), record());
    expect(integrated.actions[0]).toMatchObject({
      action: 'fill_generated_text',
      source: 'ai_generated',
      requiresReview: true,
      approved: false,
      answerValidationPassed: true,
    });
  });

  it('does not count or attach a failed generation even if a rejected candidate exists', () => {
    const failed = {
      ...record(),
      state: 'failed' as const,
      validation: {
        valid: false,
        checkedAt: now,
        issues: [{ code: 'ANSWER_NOT_GROUNDED', message: 'Not grounded.' }],
        warnings: [],
      },
      error: {
        code: 'ANSWER_NOT_GROUNDED' as const,
        message: 'Not grounded.',
        recoverable: true,
        suggestedAction: 'Add verified evidence and retry.',
        debugContext: {},
      },
    };
    const statistics = generationStatistics(
      {
        scanId: 'scan-1',
        planId: 'plan-1',
        records: [failed],
        updatedAt: now,
      },
      2,
    );
    expect(statistics).toMatchObject({ generated: 0, failed: 1, eligibleNotRequested: 2 });
    expect(applyRecordToPlan(plan(), failed).actions[0]).toMatchObject({
      action: 'manual_review',
      approved: false,
      proposedValue: undefined,
    });
  });

  it('marks manual edits as user_override and requires approval again', () => {
    const updated = updateManualAnswer(record(), 'A shorter explicit user-authored answer.');
    expect(updated.source).toBe('user_override');
    expect(updated.approved).toBe(false);
    expect(updated.validation?.valid).toBe(true);
    const integrated = applyRecordToPlan(plan(), { ...updated, approved: true, state: 'approved' });
    expect(integrated.actions[0]).toMatchObject({
      source: 'user_override',
      approved: true,
    });
  });

  it('fills and verifies approved generated text through the deterministic executor', async () => {
    document.body.innerHTML =
      '<label for="answer">Why this role?</label><textarea id="answer"></textarea>';
    const field = detectedFieldSchema.parse({
      id: 'field-1',
      pageId: 'page-1',
      label: 'Why this role?',
      normalizedLabel: 'why this role',
      question: 'Why this role?',
      fieldType: 'textarea',
      selector: '#answer',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
      warnings: [],
      metadata: { tagName: 'textarea' },
    });
    const approved = applyRecordToPlan(plan(), {
      ...record(),
      approved: true,
      state: 'approved',
    }).actions[0]!;
    const result = await executeDomAction(document, field, approved, new AbortController().signal);
    expect(result.status).toBe('verified');
    expect((document.querySelector('#answer') as HTMLTextAreaElement).value).toBe(
      approved.proposedValue,
    );
  });
});
