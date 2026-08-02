import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  autofillSettingsSchema,
  deterministicFillActionSchema,
  extensionSettingsSchema,
  type ApplicationScanResult,
  type AutofillSettings,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FillRunReport,
} from '@internship-agent/shared';
import { decideApproval, isNeverGuessed } from '../../extension/src/autofill/approvalPolicy.js';
import {
  MAX_ITERATIONS,
  isFinalSubmissionStage,
  runApplicationAutofill,
  type AutofillDependencies,
} from '../../extension/src/autofill/orchestrator.js';

function action(overrides: Partial<DeterministicFillAction> = {}): DeterministicFillAction {
  return deterministicFillActionSchema.parse({
    id: 'action-1',
    fieldId: 'field-1',
    question: 'Question',
    fieldType: 'text',
    action: 'fill_text',
    proposedValue: 'Jordan',
    source: 'profile',
    confidence: 1,
    sensitive: false,
    requiresReview: false,
    approved: false,
    reason: 'Exact canonical key.',
    warnings: [],
    ...overrides,
  });
}

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    pageId: 'page-1',
    label: 'Question',
    normalizedLabel: 'question',
    question: 'Question',
    fieldType: 'text',
    selector: '#field-1',
    required: false,
    visible: true,
    disabled: false,
    confidence: 1,
    sourceSignals: [],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

const SETTINGS = DEFAULT_AUTOFILL_SETTINGS;

describe('autofill settings', () => {
  it('ships the documented defaults', () => {
    expect(SETTINGS.applicationAutofillEnabled).toBe(true);
    expect(SETTINGS.autoFillExactProfileValues).toBe(true);
    expect(SETTINGS.autoFillSemanticProfileMatches).toBe(true);
    expect(SETTINGS.autoFillApprovedAnswers).toBe(true);
    // Generated prose and guessing are opt-in.
    expect(SETTINGS.autoFillValidatedAiAnswers).toBe(false);
    expect(SETTINGS.allowGroundedNonSensitiveGuesses).toBe(false);
    expect(SETTINGS.autoFillSensitiveDisclosurePresets).toBe(true);
    expect(SETTINGS.autoAttachApprovedDocuments).toBe(false);
    expect(SETTINGS.scrollToFirstReviewField).toBe(true);
    expect(SETTINGS.neverSubmit).toBe(true);
  });

  it('refuses to store neverSubmit as anything but true', () => {
    expect(() => autofillSettingsSchema.parse({ neverSubmit: false })).toThrow();
  });

  it('persists inside the extension settings contract', () => {
    const parsed = extensionSettingsSchema.parse({
      serverUrl: 'http://127.0.0.1:4318',
      authToken: 'token',
      selectedModel: 'model:latest',
      selectedDocumentId: null,
      ai: { generationModel: 'model:latest' },
      settingsVersion: 1,
      settingsUpdatedAt: new Date().toISOString(),
    });
    expect(parsed.autofill.neverSubmit).toBe(true);
    expect(parsed.autofill.applicationAutofillEnabled).toBe(true);
  });
});

describe('automatic approval', () => {
  it('fills an exact saved profile value without review', () => {
    const decision = decideApproval(action(), SETTINGS, field());
    expect(decision.approved).toBe(true);
    expect(decision.reviewReason).toBeUndefined();
  });

  it('fills an exact approved answer without review', () => {
    const decision = decideApproval(
      action({ source: 'approved_answer', requiresReview: false }),
      SETTINGS,
      field(),
    );
    expect(decision.approved).toBe(true);
  });

  it('fills a high-confidence option match written in the form’s own words', () => {
    const decision = decideApproval(
      action({
        action: 'select_resolved_option',
        fieldType: 'combobox',
        proposedValue: 'United States of America',
        matchedOption: { label: 'United States of America', value: 'United States of America' },
        confidence: 0.9,
      }),
      SETTINGS,
      field({ fieldType: 'combobox', canonicalKey: 'country' }),
    );
    expect(decision.approved).toBe(true);
  });

  it('holds back a low-confidence match for review', () => {
    const decision = decideApproval(
      action({
        action: 'select_resolved_option',
        fieldType: 'combobox',
        proposedValue: 'Maybe',
        matchedOption: { label: 'Maybe', value: 'Maybe' },
        confidence: 0.5,
      }),
      SETTINGS,
      field({ fieldType: 'combobox' }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('ai_suggestion');
  });

  it('never approves an action that only asks for review', () => {
    for (const kind of ['manual_review', 'missing_information', 'unsupported'] as const) {
      const decision = decideApproval(action({ action: kind, proposedValue: undefined }), SETTINGS);
      expect(decision.approved, kind).toBe(false);
      expect(decision.reviewReason, kind).toBeDefined();
    }
  });

  it('respects each switch being turned off', () => {
    const off = (patch: Partial<AutofillSettings>): AutofillSettings =>
      autofillSettingsSchema.parse({ ...SETTINGS, ...patch });
    expect(decideApproval(action(), off({ autoFillExactProfileValues: false })).approved).toBe(
      false,
    );
    expect(
      decideApproval(action({ source: 'approved_answer' }), off({ autoFillApprovedAnswers: false }))
        .approved,
    ).toBe(false);
    expect(decideApproval(action(), off({ applicationAutofillEnabled: false })).approved).toBe(
      false,
    );
  });
});

describe('protected and legal questions', () => {
  const declineAction = action({
    action: 'select_suggested_option',
    fieldType: 'combobox',
    proposedValue: 'Decline to answer',
    matchedOption: { label: 'Decline to answer', value: 'Decline to answer' },
    source: 'approved_answer',
    sensitive: true,
  });

  it('applies an explicit decline preset, which discloses nothing', () => {
    const decision = decideApproval(
      declineAction,
      SETTINGS,
      field({ canonicalKey: 'gender', fieldType: 'combobox' }),
    );
    expect(decision.approved).toBe(true);
  });

  it('does not apply a decline when the disclosure switch is off', () => {
    const decision = decideApproval(
      declineAction,
      autofillSettingsSchema.parse({ ...SETTINGS, autoFillSensitiveDisclosurePresets: false }),
      field({ canonicalKey: 'gender', fieldType: 'combobox' }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('manual_required');
  });

  it('shows a substantive protected answer before disclosing it', () => {
    const decision = decideApproval(
      action({
        action: 'select_suggested_option',
        fieldType: 'combobox',
        proposedValue: 'Woman',
        matchedOption: { label: 'Woman', value: 'Woman' },
        source: 'approved_answer',
        sensitive: true,
      }),
      SETTINGS,
      field({ canonicalKey: 'gender', fieldType: 'combobox' }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('manual_required');
  });

  it('never guesses any protected, eligibility, or legal question', () => {
    const questions = [
      'gender',
      'transgender',
      'sexual_orientation',
      'race_ethnicity',
      'hispanic_latino',
      'veteran_status',
      'disability_status',
      'religion',
      'medical_information',
      'criminal_history',
      'citizenship',
      'work_authorization',
      'sponsorship_required',
      'security_clearance',
      'salary_expectation',
      'terms_attestation',
      'signature',
    ] as const;

    for (const canonicalKey of questions) {
      expect(isNeverGuessed(canonicalKey), canonicalKey).toBe(true);
      // Reaching it through an AI suggestion, with guessing fully enabled.
      const decision = decideApproval(
        action({ source: 'ai_suggestion', requiresReview: true, sensitive: false }),
        autofillSettingsSchema.parse({
          ...SETTINGS,
          allowGroundedNonSensitiveGuesses: true,
          autoFillValidatedAiAnswers: true,
        }),
        field({ canonicalKey }),
      );
      expect(decision.approved, canonicalKey).toBe(false);
      expect(decision.reviewReason, canonicalKey).toBe('manual_required');
    }
  });

  it('never accepts terms or a signature, whatever the settings say', () => {
    for (const canonicalKey of ['terms_attestation', 'signature'] as const) {
      const decision = decideApproval(
        action({ action: 'toggle_checkbox', fieldType: 'checkbox', proposedValue: true }),
        autofillSettingsSchema.parse({
          ...SETTINGS,
          autoFillSensitiveDisclosurePresets: true,
          allowGroundedNonSensitiveGuesses: true,
        }),
        field({ canonicalKey, fieldType: 'checkbox' }),
      );
      expect(decision.approved, canonicalKey).toBe(false);
      expect(decision.reviewReason, canonicalKey).toBe('manual_required');
    }
  });
});

describe('grounded guessing', () => {
  const suggestion = action({ source: 'ai_suggestion', requiresReview: true });

  it('leaves an uncertain answer for the user by default', () => {
    const decision = decideApproval(suggestion, SETTINGS, field());
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('ai_suggestion');
  });

  it('fills and flags it once guessing is enabled', () => {
    const decision = decideApproval(
      suggestion,
      autofillSettingsSchema.parse({ ...SETTINGS, allowGroundedNonSensitiveGuesses: true }),
      field(),
    );
    expect(decision.approved).toBe(true);
    // Filled, but still asking to be looked at.
    expect(decision.reviewReason).toBe('ai_suggestion');
  });

  it('fills a validated generated answer only after opt-in', () => {
    const generated = action({
      action: 'fill_generated_text',
      source: 'ai_generated',
      requiresReview: true,
      answerValidationPassed: true,
      proposedValue: 'A grounded paragraph.',
    });
    expect(decideApproval(generated, SETTINGS, field()).approved).toBe(false);
    expect(
      decideApproval(
        generated,
        autofillSettingsSchema.parse({ ...SETTINGS, autoFillValidatedAiAnswers: true }),
        field(),
      ).approved,
    ).toBe(true);
  });

  it('never fills a generated answer that failed validation', () => {
    const decision = decideApproval(
      action({
        action: 'fill_generated_text',
        source: 'ai_generated',
        requiresReview: true,
        answerValidationPassed: false,
        proposedValue: 'Unvalidated.',
      }),
      autofillSettingsSchema.parse({ ...SETTINGS, autoFillValidatedAiAnswers: true }),
      field(),
    );
    expect(decision.approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function scanResult(fields: DetectedField[], url = 'https://boards.example.com/apply'): ApplicationScanResult {
  return {
    id: `scan-${fields.length}-${url.length}`,
    pageId: 'page-1',
    url,
    domain: 'boards.example.com',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 10,
    ats: { id: 'greenhouse', displayName: 'Greenhouse', confidence: 1, detectionReason: 'markers' },
    fields,
    statistics: {
      total: fields.length,
      required: 0,
      visible: fields.length,
      sensitive: 0,
      unsupported: 0,
      sections: {},
    },
    warnings: [],
    issues: [],
  } as unknown as ApplicationScanResult;
}

function planFor(actions: DeterministicFillAction[]): DeterministicFillPlan {
  return {
    id: 'plan-1',
    scanId: 'scan-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: 'https://boards.example.com/apply',
    domain: 'boards.example.com',
    ats: 'greenhouse',
    actions,
    warnings: [],
    statistics: {
      total: actions.length,
      ready: 0,
      approved: 0,
      review: 0,
      missingInformation: 0,
      skipped: 0,
      unsupported: 0,
      sensitive: 0,
    },
  } as DeterministicFillPlan;
}

function runReport(results: FillRunReport['results']): FillRunReport {
  return {
    id: 'fill-1',
    planId: 'plan-1',
    scanId: 'scan-1',
    startedAt: new Date().toISOString(),
    url: 'https://boards.example.com/apply',
    ats: 'greenhouse',
    totalActions: results.length,
    approvedActions: results.length,
    verifiedActions: results.filter((result) => result.status === 'verified').length,
    failedActions: results.filter((result) => result.status === 'failed').length,
    reviewActions: 0,
    skippedActions: 0,
    unsupportedActions: 0,
    status: 'completed',
    results,
    warnings: [],
    submitted: false,
  } as FillRunReport;
}

interface HarnessOptions {
  scans: ApplicationScanResult[];
  plans: DeterministicFillPlan[];
  reports?: FillRunReport[];
  settings?: Partial<AutofillSettings>;
  cancelAfter?: number;
}

function harness(options: HarnessOptions): {
  dependencies: AutofillDependencies;
  highlighted: Array<{ fieldId: string; reason: string }>;
  phases: string[];
  scrolled: boolean[];
} {
  let scanIndex = 0;
  let planIndex = 0;
  let executeIndex = 0;
  let calls = 0;
  const highlighted: Array<{ fieldId: string; reason: string }> = [];
  const phases: string[] = [];
  const scrolled: boolean[] = [];

  const dependencies: AutofillDependencies = {
    loadSettings: () =>
      Promise.resolve(autofillSettingsSchema.parse({ ...SETTINGS, ...options.settings })),
    scan: () => {
      const scan = options.scans[Math.min(scanIndex, options.scans.length - 1)];
      scanIndex += 1;
      return Promise.resolve(scan ? { scan } : {});
    },
    plan: () => {
      const plan = options.plans[Math.min(planIndex, options.plans.length - 1)];
      planIndex += 1;
      return Promise.resolve(plan ? { plan } : {});
    },
    approve: () => Promise.resolve({}),
    execute: () => {
      const report = options.reports?.[Math.min(executeIndex, options.reports.length - 1)];
      executeIndex += 1;
      return Promise.resolve(report ? { report } : {});
    },
    highlight: (requests, scrollToFirst) => {
      for (const request of requests) {
        highlighted.push({ fieldId: request.fieldId, reason: request.reason });
      }
      scrolled.push(scrollToFirst);
      return Promise.resolve({});
    },
    onProgress: (progress) => phases.push(progress.phase),
    isCancelled: () => {
      calls += 1;
      return options.cancelAfter !== undefined && calls > options.cancelAfter;
    },
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  };
  return { dependencies, highlighted, phases, scrolled };
}

describe('the autofill run', () => {
  it('fills, verifies, and reports without a review screen', async () => {
    const one = action({ id: 'action-1', fieldId: 'field-1' });
    const { dependencies, phases } = harness({
      scans: [scanResult([field()])],
      plans: [planFor([one])],
      reports: [
        runReport([
          { actionId: 'action-1', fieldId: 'field-1', status: 'verified', attempts: 1, durationMs: 5 },
        ]),
      ],
    });

    const report = await runApplicationAutofill(dependencies);
    expect(report.status).toBe('completed');
    expect(report.fieldsVerified).toBe(1);
    expect(report.submissionPrevented).toBe(true);
    expect(phases).toContain('scanning');
    expect(phases).toContain('filling');
    expect(phases).toContain('completed');
  });

  it('reports fields needing review and highlights them', async () => {
    const blocked = action({
      id: 'action-2',
      fieldId: 'field-2',
      action: 'manual_review',
      proposedValue: undefined,
      sensitive: true,
    });
    const { dependencies, highlighted, scrolled } = harness({
      scans: [scanResult([field({ id: 'field-2', selector: '#field-2' })])],
      plans: [planFor([blocked])],
    });

    const report = await runApplicationAutofill(dependencies);
    expect(report.status).toBe('completed_with_review');
    expect(report.manualBlockers).toBe(1);
    expect(highlighted).toEqual([{ fieldId: 'field-2', reason: 'manual_required' }]);
    expect(scrolled).toEqual([true]);
  });

  it('does not scroll when the user turned that off', async () => {
    const { dependencies, scrolled } = harness({
      scans: [scanResult([field({ id: 'field-2', selector: '#field-2' })])],
      plans: [
        planFor([
          action({ id: 'action-2', fieldId: 'field-2', action: 'manual_review', proposedValue: undefined }),
        ]),
      ],
      settings: { scrollToFirstReviewField: false },
    });
    await runApplicationAutofill(dependencies);
    expect(scrolled).toEqual([false]);
  });

  it('picks up a field revealed by an earlier answer', async () => {
    const first = field({ id: 'field-1', selector: '#field-1' });
    const revealed = field({ id: 'field-2', selector: '#field-2', question: 'Revealed' });
    const { dependencies } = harness({
      scans: [scanResult([first]), scanResult([first, revealed])],
      plans: [
        planFor([action({ id: 'action-1', fieldId: 'field-1' })]),
        planFor([
          action({ id: 'action-1', fieldId: 'field-1' }),
          action({ id: 'action-2', fieldId: 'field-2', question: 'Revealed' }),
        ]),
      ],
      reports: [
        runReport([
          { actionId: 'action-1', fieldId: 'field-1', status: 'verified', attempts: 1, durationMs: 5 },
        ]),
        runReport([
          { actionId: 'action-2', fieldId: 'field-2', status: 'verified', attempts: 1, durationMs: 5 },
        ]),
      ],
    });

    const report = await runApplicationAutofill(dependencies);
    expect(report.iterations).toBeGreaterThan(1);
    expect(report.results.map((result) => result.fieldId).sort()).toEqual(['field-1', 'field-2']);
    expect(report.fieldsVerified).toBe(2);
  });

  it('stops after the bounded number of passes rather than looping', async () => {
    // A form that reveals a new field on every pass, forever.
    const { dependencies } = harness({
      scans: [scanResult([field()])],
      plans: [planFor([action()])],
      reports: [
        runReport([
          { actionId: 'action-1', fieldId: 'field-1', status: 'failed', attempts: 2, durationMs: 5 },
        ]),
      ],
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
  });

  it('stops when cancelled', async () => {
    const { dependencies } = harness({
      scans: [scanResult([field()])],
      plans: [planFor([action()])],
      cancelAfter: 0,
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.status).toBe('cancelled');
  });

  it('refuses to run when autofill is switched off', async () => {
    const { dependencies } = harness({
      scans: [scanResult([field()])],
      plans: [planFor([action()])],
      settings: { applicationAutofillEnabled: false },
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('AUTOFILL_DISABLED');
  });

  it('stops on a CAPTCHA instead of working around it', async () => {
    const { dependencies } = harness({
      scans: [scanResult([field({ question: 'Please complete the reCAPTCHA below' })])],
      plans: [planFor([action()])],
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.error?.code).toBe('CAPTCHA_DETECTED');
  });

  it('stops when a verification code is requested', async () => {
    const { dependencies } = harness({
      scans: [scanResult([field({ question: 'Enter the verification code we sent you' })])],
      plans: [planFor([action()])],
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.error?.code).toBe('MFA_DETECTED');
  });

  it('recognizes the final submission step and does not touch it', () => {
    const empty = scanResult([], 'https://boards.example.com/review-and-submit');
    expect(isFinalSubmissionStage(empty)).toBe(true);
    // A page with answerable questions is never the final step.
    expect(isFinalSubmissionStage(scanResult([field()]))).toBe(false);
  });

  it('always records that submission was prevented', async () => {
    const { dependencies } = harness({
      scans: [scanResult([field()])],
      plans: [planFor([action()])],
    });
    const report = await runApplicationAutofill(dependencies);
    expect(report.submissionPrevented).toBe(true);
  });

  it('terminates even when every dependency reports an error', async () => {
    const failing: AutofillDependencies = {
      loadSettings: () => Promise.resolve(SETTINGS),
      scan: () =>
        Promise.resolve({
          error: {
            code: 'SCAN_FAILED',
            message: 'no',
            recoverable: true,
            suggestedAction: 'retry',
            debugContext: {},
          },
        }),
      plan: () => Promise.resolve({}),
      approve: () => Promise.resolve({}),
      execute: () => Promise.resolve({}),
      highlight: () => Promise.resolve({}),
      onProgress: vi.fn(),
      isCancelled: () => false,
      waitForStability: () => Promise.resolve(),
      now: () => new Date().toISOString(),
    };
    const report = await runApplicationAutofill(failing);
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('SCAN_FAILED');
  });
});
