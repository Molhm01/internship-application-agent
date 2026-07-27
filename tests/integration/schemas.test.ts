import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  DEFAULT_ERROR_GUIDANCE,
  applicationPlanSchema,
  applicationRunSchema,
  approvedAnswerSchema,
  detectedFieldSchema,
  fillActionSchema,
  deterministicFillPlanSchema,
  fillExecutionResultSchema,
  fillRunReportSchema,
  fieldMatchSchema,
  profileSchema,
  savedDocumentSchema,
} from '@internship-agent/shared';

const NOW = '2026-07-26T12:00:00.000Z';

describe('error contract', () => {
  it('provides actionable default guidance for every error code', () => {
    for (const code of ERROR_CODES) {
      const guidance = DEFAULT_ERROR_GUIDANCE[code];
      expect(guidance, `missing guidance for ${code}`).toBeTruthy();
      expect(guidance.length).toBeGreaterThan(15);
    }
  });
});

describe('detectedFieldSchema', () => {
  const base = {
    id: 'field-1',
    pageId: 'page-1',
    label: 'First name',
    normalizedLabel: 'first name',
    question: 'First name',
    canonicalKey: 'first_name',
    fieldType: 'text',
    required: true,
    disabled: false,
    visible: true,
    selector: '#first_name',
    section: 'personal_information',
    confidence: 0.95,
    sourceSignals: ['label_for'],
  };

  it('accepts a minimal field and defaults metadata', () => {
    const parsed = detectedFieldSchema.parse(base);
    expect(parsed.metadata).toEqual({});
    expect(parsed.options).toBeUndefined();
  });

  it('accepts select options', () => {
    const parsed = detectedFieldSchema.parse({
      ...base,
      fieldType: 'select',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it('rejects an unknown field type', () => {
    expect(detectedFieldSchema.safeParse({ ...base, fieldType: 'signature' }).success).toBe(false);
  });
});

describe('fillActionSchema', () => {
  const base = {
    fieldId: 'field-1',
    question: 'First name',
    fieldType: 'text',
    source: 'profile',
    confidence: 0.95,
    requiresReview: false,
  };

  it('accepts a well-formed text fill', () => {
    const parsed = fillActionSchema.parse({ ...base, action: 'fill_text', value: 'Jordan' });
    expect(parsed.value).toBe('Jordan');
  });

  it('rejects a fill action with no value', () => {
    const result = fillActionSchema.safeParse({ ...base, action: 'fill_text' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('requires a value');
  });

  it('requires a documentId for uploads', () => {
    expect(fillActionSchema.safeParse({ ...base, action: 'upload_file' }).success).toBe(false);
    expect(
      fillActionSchema.safeParse({ ...base, action: 'upload_file', documentId: 'doc-1' }).success,
    ).toBe(true);
  });

  it('requires an array for select_multiple and a boolean for toggle_checkbox', () => {
    expect(
      fillActionSchema.safeParse({ ...base, action: 'select_multiple', value: 'one' }).success,
    ).toBe(false);
    expect(
      fillActionSchema.safeParse({ ...base, action: 'select_multiple', value: ['one'] }).success,
    ).toBe(true);
    expect(
      fillActionSchema.safeParse({ ...base, action: 'toggle_checkbox', value: 'true' }).success,
    ).toBe(false);
    expect(
      fillActionSchema.safeParse({ ...base, action: 'toggle_checkbox', value: true }).success,
    ).toBe(true);
  });

  it('allows skip and manual_review without a value', () => {
    expect(fillActionSchema.safeParse({ ...base, action: 'skip' }).success).toBe(true);
    expect(fillActionSchema.safeParse({ ...base, action: 'manual_review' }).success).toBe(true);
  });

  it('rejects confidence outside 0..1', () => {
    expect(fillActionSchema.safeParse({ ...base, action: 'skip', confidence: 1.5 }).success).toBe(
      false,
    );
  });

  it('has no field through which a model could express a DOM operation', () => {
    const keys = Object.keys(
      fillActionSchema.parse({ ...base, action: 'fill_text', value: 'Jordan' }),
    );
    for (const forbidden of ['selector', 'script', 'js', 'code', 'xpath', 'element']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('strips unknown keys a model might invent', () => {
    const parsed = fillActionSchema.parse({
      ...base,
      action: 'fill_text',
      value: 'Jordan',
      selector: '#first_name',
      script: 'document.querySelector("#x").click()',
    }) as Record<string, unknown>;

    expect(parsed['selector']).toBeUndefined();
    expect(parsed['script']).toBeUndefined();
  });
});

describe('applicationPlanSchema', () => {
  it('parses a complete plan', () => {
    const plan = applicationPlanSchema.parse({
      runId: 'run-1',
      applicationUrl: 'https://boards.example.com/apply/123',
      ats: 'greenhouse',
      actions: [
        {
          fieldId: 'f1',
          question: 'Email',
          fieldType: 'email',
          action: 'fill_text',
          value: 'jordan@example.com',
          source: 'profile',
          confidence: 0.99,
          requiresReview: false,
        },
      ],
      requiresUserReview: true,
    });

    expect(plan.warnings).toEqual([]);
    expect(plan.actions).toHaveLength(1);
  });

  it('rejects an unknown ATS id and a non-URL application url', () => {
    const base = {
      runId: 'r',
      applicationUrl: 'https://a.test/x',
      ats: 'generic',
      actions: [],
      requiresUserReview: false,
    };
    expect(applicationPlanSchema.safeParse({ ...base, ats: 'workable' }).success).toBe(false);
    expect(applicationPlanSchema.safeParse({ ...base, applicationUrl: 'not-a-url' }).success).toBe(
      false,
    );
  });
});

describe('Milestone 3 deterministic fill schemas', () => {
  it('validates a deterministic match, plan, verified result, and non-submitting report', () => {
    const match = fieldMatchSchema.parse({
      fieldId: 'field-1',
      matched: true,
      source: 'profile',
      sourceReference: 'profile.personal.email',
      rawValue: 'jordan@example.com',
      formattedValue: 'jordan@example.com',
      confidence: 1,
      requiresReview: false,
      sensitive: false,
      reason: 'Exact canonical key.',
    });
    const plan = deterministicFillPlanSchema.parse({
      id: 'plan-1',
      scanId: 'scan-1',
      createdAt: NOW,
      updatedAt: NOW,
      url: 'https://example.test/apply',
      domain: 'example.test',
      ats: 'generic',
      actions: [
        {
          id: 'action-1',
          fieldId: match.fieldId,
          question: 'Email',
          fieldType: 'email',
          action: 'fill_text',
          proposedValue: match.formattedValue,
          source: match.source,
          sourceReference: match.sourceReference,
          confidence: match.confidence,
          sensitive: false,
          requiresReview: false,
          approved: true,
          reason: match.reason,
          originalMatch: match,
        },
      ],
      statistics: { total: 1, ready: 1, review: 0, skipped: 0, unsupported: 0, sensitive: 0 },
    });
    const result = fillExecutionResultSchema.parse({
      actionId: 'action-1',
      fieldId: 'field-1',
      status: 'verified',
      expectedValue: 'jordan@example.com',
      actualValue: 'jordan@example.com',
      attempts: 1,
      durationMs: 12,
    });
    const report = fillRunReportSchema.parse({
      id: 'run-1',
      planId: plan.id,
      scanId: plan.scanId,
      startedAt: NOW,
      completedAt: NOW,
      url: plan.url,
      ats: plan.ats,
      totalActions: 1,
      approvedActions: 1,
      verifiedActions: 1,
      failedActions: 0,
      reviewActions: 0,
      skippedActions: 0,
      unsupportedActions: 0,
      status: 'completed',
      results: [result],
    });
    expect(report.submitted).toBe(false);
  });

  it('rejects invented select options and approval of unsupported actions', () => {
    const action = {
      id: 'action-1',
      fieldId: 'field-1',
      question: 'Country',
      fieldType: 'select',
      action: 'select_option',
      proposedValue: 'invented',
      source: 'profile',
      confidence: 1,
      sensitive: false,
      requiresReview: false,
      approved: true,
      reason: 'test',
    };
    expect(
      deterministicFillPlanSchema.safeParse({
        id: 'plan-1',
        scanId: 'scan-1',
        createdAt: NOW,
        updatedAt: NOW,
        url: 'https://example.test/apply',
        domain: 'example.test',
        ats: 'generic',
        actions: [action],
        statistics: { total: 1, ready: 1, review: 0, skipped: 0, unsupported: 0, sensitive: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('applicationRunSchema', () => {
  it('defaults submitted to false and rejects submitted: true', () => {
    const base = {
      id: 'run-1',
      startedAt: NOW,
      url: 'https://a.test/apply',
      domain: 'a.test',
      ats: 'generic',
      totalFields: 10,
      filledFields: 8,
      verifiedFields: 8,
      skippedFields: 1,
      reviewFields: 1,
      failedFields: 0,
      status: 'completed',
    };

    expect(applicationRunSchema.parse(base).submitted).toBe(false);
    expect(applicationRunSchema.safeParse({ ...base, submitted: true }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  it('never invents data: an empty profile stays empty', () => {
    const profile = profileSchema.parse({ updatedAt: NOW });

    expect(profile.id).toBe('primary');
    expect(profile.education).toEqual([]);
    expect(profile.personal.legalFirstName).toBeUndefined();
    expect(profile.skills.technical).toEqual([]);
    expect(profile.eligibility.workAuthorization).toBeUndefined();
  });

  it('rejects malformed contact details rather than coercing them', () => {
    expect(
      profileSchema.safeParse({ updatedAt: NOW, personal: { email: 'not-an-email' } }).success,
    ).toBe(false);
    expect(
      profileSchema.safeParse({ updatedAt: NOW, personal: { linkedin: 'linkedin' } }).success,
    ).toBe(false);
  });

  it('accepts sensitive-question policies from the fixed set', () => {
    const profile = profileSchema.parse({
      updatedAt: NOW,
      sensitivePolicies: [
        { category: 'veteran_status', policy: 'decline_to_answer' },
        { category: 'sponsorship', policy: 'approved_auto_fill', value: 'No' },
      ],
    });
    expect(profile.sensitivePolicies).toHaveLength(2);

    expect(
      profileSchema.safeParse({
        updatedAt: NOW,
        sensitivePolicies: [{ category: 'astrology', policy: 'review_required' }],
      }).success,
    ).toBe(false);
  });
});

describe('approvedAnswerSchema and savedDocumentSchema', () => {
  it('parses an approved answer', () => {
    const answer = approvedAnswerSchema.parse({
      id: 'ans-1',
      canonicalQuestion: 'Are you legally authorized to work in the United States?',
      answerType: 'boolean',
      answer: true,
      category: 'eligibility',
      approved: true,
      autoFillAllowed: true,
      sensitive: false,
      tailoringAllowed: false,
      requiresReview: false,
      lastUpdatedAt: NOW,
    });
    expect(answer.aliases).toEqual([]);
  });

  it('parses a saved document', () => {
    const doc = savedDocumentSchema.parse({
      id: 'doc-1',
      name: 'Computer Engineering Resume.pdf',
      type: 'resume',
      filePath: 'C:/Users/example/local-data/documents/doc-1-ce-resume.pdf',
      fileName: 'doc-1-ce-resume.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 148_221,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(doc.isDefault).toBe(false);
    expect(doc.tags).toEqual([]);
  });
});
