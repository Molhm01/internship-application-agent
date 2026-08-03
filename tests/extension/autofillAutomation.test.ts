import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTOFILL_CONFIDENCE,
  DEFAULT_AUTOFILL_SETTINGS,
  applicationScanResultSchema,
  auditRequiredFields,
  classifyPage,
  confidenceBand,
  navigationIntentFor,
  selectPortalRoute,
  type DetectedField,
  type DeterministicFillAction,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import {
  applyAnalysisToPlan,
  buildAnalysisRequest,
} from '../../extension/src/analysis/formAnalysis.js';
import { decideApproval } from '../../extension/src/autofill/approvalPolicy.js';
import { profileFixture } from './popupFixtures.js';

/**
 * "Autofill Application" doing the whole job.
 *
 * The behaviour these pin down is one sentence: the user clicks once, and what
 * comes back is a filled form plus a short list of the questions nobody could
 * answer for them — not 26 fields to approve first. Everything below is either
 * an instance of that, or one of the limits that make it safe to do.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

const SETTINGS = DEFAULT_AUTOFILL_SETTINGS;

async function scanFixture(): Promise<{ fields: DetectedField[]; document: Document }> {
  const html = readFileSync(FIXTURE, 'utf8');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const { fields } = await scanDom(document, 'page-icims', new AbortController().signal);
  return { fields, document };
}

function action(overrides: Partial<DeterministicFillAction> = {}): DeterministicFillAction {
  return {
    id: 'action-1',
    fieldId: 'field-1',
    question: 'How did you hear about us?',
    fieldType: 'text',
    action: 'fill_text',
    proposedValue: 'LinkedIn',
    source: 'ai_suggestion',
    confidence: 0.95,
    sensitive: false,
    requiresReview: false,
    approved: false,
    reason: 'From your saved data.',
    warnings: [],
    ...overrides,
  };
}

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    pageId: 'page-1',
    label: 'How did you hear about us?',
    normalizedLabel: 'how did you hear about us',
    question: 'How did you hear about us?',
    fieldType: 'text',
    selector: '#field-1',
    required: false,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

describe('autofill does not require a review pass first', () => {
  it('produces executable actions straight from a scan, with no approval step', async () => {
    const { fields } = await scanFixture();
    const scan = applicationScanResultSchema.parse({
      id: 'scan-icims',
      createdAt: new Date().toISOString(),
      url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'hostname',
        supported: true,
      },
      jobContext: {},
      fields,
      warnings: [],
      statistics: {
        total: fields.length,
        supported: fields.length,
        unknown: 0,
        required: fields.filter((entry) => entry.required).length,
        optional: fields.filter((entry) => !entry.required).length,
        text: 0,
        textarea: 0,
        select: 0,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
        credentialFields: 0,
        navigationActions: 0,
      },
      durationMs: 5,
      status: 'completed',
      readOnly: true,
    });

    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const byId = new Map(fields.map((entry) => [entry.id, entry]));
    const approved = plan.actions.filter(
      (entry) => decideApproval(entry, SETTINGS, byId.get(entry.fieldId)).approved,
    );

    // The substantive claim: ordinary identity fields fill on the first click.
    // Nothing here consulted a review screen or a per-action approval.
    expect(approved.length).toBeGreaterThan(0);
    const filledQuestions = approved.map((entry) => entry.question.toLowerCase());
    expect(filledQuestions.some((question) => question.includes('first name'))).toBe(true);
    expect(filledQuestions.some((question) => question.includes('email'))).toBe(true);
  });

  it('fills deterministic profile answers automatically', () => {
    const decision = decideApproval(
      action({ source: 'profile', confidence: 1, action: 'fill_text' }),
      SETTINGS,
      field(),
    );
    expect(decision.approved).toBe(true);
    expect(decision.reviewReason).toBeUndefined();
  });
});

describe('confidence bands', () => {
  it('places each band where the policy says', () => {
    expect(AUTOFILL_CONFIDENCE.automatic).toBe(0.9);
    expect(AUTOFILL_CONFIDENCE.grounded).toBe(0.75);
    expect(confidenceBand(0.95)).toBe('automatic');
    expect(confidenceBand(0.9)).toBe('automatic');
    expect(confidenceBand(0.89)).toBe('grounded');
    expect(confidenceBand(0.75)).toBe('grounded');
    expect(confidenceBand(0.74)).toBe('confirm');
  });

  it('executes a high-confidence grounded AI answer automatically', () => {
    const decision = decideApproval(
      action({ confidence: 0.93, sourceFactIds: ['profile.personal.linkedin'] }),
      SETTINGS,
      field(),
    );
    expect(decision.approved).toBe(true);
  });

  it('asks for confirmation below 0.75', () => {
    const decision = decideApproval(
      action({ confidence: 0.6, sourceFactIds: ['profile.personal.linkedin'] }),
      SETTINGS,
      field(),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reviewReason).toBe('ai_suggestion');
  });

  it('never answers an employer-relationship question at any confidence', () => {
    for (const canonicalKey of [
      'previously_employed',
      'family_member_employed',
      'referral_name',
    ] as const) {
      const decision = decideApproval(
        action({ confidence: 1, sourceFactIds: ['profile.personal.legalFirstName'] }),
        SETTINGS,
        field({ canonicalKey }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.reviewReason).toBe('manual_required');
    }
  });

  it('repeats an eligibility fact the user explicitly saved, but never infers one', () => {
    const saved = decideApproval(
      action({ source: 'profile', confidence: 1, requiresReview: false }),
      SETTINGS,
      field({ canonicalKey: 'work_authorization' }),
    );
    expect(saved.approved).toBe(true);

    const inferred = decideApproval(
      action({ source: 'ai_suggestion', confidence: 0.99 }),
      SETTINGS,
      field({ canonicalKey: 'work_authorization' }),
    );
    expect(inferred.approved).toBe(false);
    expect(inferred.reviewReason).toBe('manual_required');
  });
});

describe('the batched AI request', () => {
  it('sends one request carrying every unresolved question and all its options', async () => {
    const { fields } = await scanFixture();
    const withOptions = fields.filter((entry) => (entry.options?.length ?? 0) > 0);
    expect(withOptions.length).toBeGreaterThan(0);

    const scan = applicationScanResultSchema.parse({
      id: 'scan-options',
      createdAt: new Date().toISOString(),
      url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
      domain: 'careers2-quanta.icims.com',
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        detectionReason: 'hostname',
        supported: true,
      },
      jobContext: {},
      fields,
      warnings: [],
      statistics: {
        total: fields.length,
        supported: fields.length,
        unknown: 0,
        required: 0,
        optional: fields.length,
        text: 0,
        textarea: 0,
        select: 0,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
        credentialFields: 0,
        navigationActions: 0,
      },
      durationMs: 5,
      status: 'completed',
      readOnly: true,
    });
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const built = buildAnalysisRequest({ scan, plan, profile: profileFixture(), answers: [] });

    // One request object, not one per field.
    expect(built.request).toBeDefined();
    expect(Array.isArray(built.request!.questions)).toBe(true);

    // Every option the page offers travels with its question, so the model
    // chooses among real choices rather than inventing a label.
    for (const question of built.request!.questions) {
      const source = built.fieldsByQuestionId.get(question.questionId)?.[0];
      if (!source?.options?.length) continue;
      expect(question.options?.length).toBe(source.options.length);
      for (const option of source.options) {
        expect(question.options?.some((entry) => entry.label === option.label)).toBe(true);
      }
    }
  });
});

describe('what the AI is not allowed to do', () => {
  const base = {
    id: 'scan-guard',
    createdAt: new Date().toISOString(),
    url: 'https://careers2-quanta.icims.com/jobs/12345/candidate',
    domain: 'careers2-quanta.icims.com',
    ats: {
      id: 'icims' as const,
      displayName: 'iCIMS',
      confidence: 0.98,
      detectionReason: 'hostname',
      supported: true,
    },
    jobContext: {},
    warnings: [],
    durationMs: 5,
    status: 'completed' as const,
    readOnly: true as const,
  };

  function setup(target: DetectedField) {
    const scan = applicationScanResultSchema.parse({
      ...base,
      fields: [target],
      statistics: {
        total: 1,
        supported: 1,
        unknown: 0,
        required: 0,
        optional: 1,
        text: 1,
        textarea: 0,
        select: 0,
        combobox: 0,
        radio: 0,
        checkbox: 0,
        file: 0,
        credentialFields: 0,
        navigationActions: 0,
      },
    });
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const built = buildAnalysisRequest({ scan, plan, profile: profileFixture(), answers: [] });
    return { scan, plan, built };
  }

  it('discards an option the page does not offer', () => {
    const target = field({
      id: 'field-source',
      label: 'How did you hear about us?',
      normalizedLabel: 'how did you hear about us',
      fieldType: 'select',
      options: [
        { label: 'LinkedIn', value: 'linkedin' },
        { label: 'Careers Fair', value: 'fair' },
      ],
    });
    const { scan, plan, built } = setup(target);
    const questionId = built.questions[0]!.questionId;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      {
        pageId: scan.id,
        answers: [
          {
            questionId,
            action: 'SELECT_OPTION',
            selectedOption: 'Carrier pigeon',
            confidence: 0.99,
            // Correctly grounded on purpose, so the only thing wrong with this
            // answer is the option itself.
            sourceFactIds: built.request!.facts.map((fact) => fact.id).slice(0, 1),
            requiresReview: false,
            reason: 'Invented.',
          },
        ],
      },
      built.fieldsByQuestionId,
      built.questions,
      null,
      built.request!.facts,
    );

    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]?.reason).toMatch(/not one of the options/i);
  });

  it('discards a factual claim that names no saved fact', () => {
    const target = field({
      id: 'field-school',
      label: 'School',
      normalizedLabel: 'school',
      question: 'School',
    });
    const { scan, plan, built } = setup(target);
    const questionId = built.questions[0]!.questionId;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      {
        pageId: scan.id,
        answers: [
          {
            questionId,
            action: 'SET_TEXT',
            value: 'Invented University',
            confidence: 0.99,
            sourceFactIds: [],
            requiresReview: false,
            reason: 'No grounding at all.',
          },
        ],
      },
      built.fieldsByQuestionId,
      built.questions,
      null,
      built.request!.facts,
    );

    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]?.reason).toMatch(/without naming any saved fact/i);
  });

  it('discards an answer citing a profile fact that does not exist', () => {
    const target = field({
      id: 'field-school-2',
      label: 'School',
      normalizedLabel: 'school',
      question: 'School',
    });
    const { scan, plan, built } = setup(target);
    const questionId = built.questions[0]!.questionId;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      {
        pageId: scan.id,
        answers: [
          {
            questionId,
            action: 'SET_TEXT',
            value: 'Invented University',
            confidence: 0.99,
            sourceFactIds: ['profile.education[7].secretDegree'],
            requiresReview: false,
            reason: 'Cites a fact nobody sent.',
          },
        ],
      },
      built.fieldsByQuestionId,
      built.questions,
      null,
      built.request!.facts,
    );

    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]?.reason).toMatch(/do(es)? not exist/i);
  });

  it('offers no action that could carry a selector or a script', () => {
    // The model names a question and an option label. There is no member of the
    // action union that can express "click this CSS selector" or "run this",
    // so arbitrary page manipulation is not a thing to be filtered out — it is
    // a thing that cannot be said.
    const target = field({ id: 'field-x' });
    const { built } = setup(target);
    const serialized = JSON.stringify(built.request);
    expect(serialized).not.toMatch(/selector/i);
    expect(serialized).not.toMatch(/javascript|<script/i);
  });
});

describe('required fields are accounted for after filling', () => {
  it('gives every required field a terminal outcome, including ones never reached', () => {
    const required = [
      field({ id: 'r1', label: 'First Name', required: true }),
      field({ id: 'r2', label: 'Email', required: true }),
      field({ id: 'r3', label: 'Have you previously worked here?', required: true }),
    ];
    const audit = auditRequiredFields({
      fields: required,
      results: [
        { fieldId: 'r1', status: 'verified' },
        { fieldId: 'r2', status: 'verified' },
        // r3 was never reached at all.
      ],
    });

    expect(audit.verdicts).toHaveLength(3);
    expect(audit.verdicts.map((verdict) => verdict.outcome)).toEqual([
      'FILLED_VERIFIED',
      'FILLED_VERIFIED',
      'USER_CONFIRMATION_REQUIRED',
    ]);
    // The unreached field is reported rather than omitted, which is what makes
    // a silent skip impossible.
    expect(audit.complete).toBe(false);
    expect(audit.outstanding).toHaveLength(1);
  });

  it('reports a blocked page as blocked rather than as unanswered', () => {
    const audit = auditRequiredFields({
      fields: [field({ id: 'r1', label: 'Verification code', required: true })],
      results: [],
      blockedReason: 'This page is asking for a verification code.',
    });
    expect(audit.verdicts[0]?.outcome).toBe('BLOCKED_BY_CAPTCHA_OR_VERIFICATION');
  });
});

describe('employer portal strategy', () => {
  const navigation = classifyPage({
    url: 'https://careers2-quanta.icims.com/jobs/12345/login',
    title: 'Sign in',
    bodyText: 'Returning applicants sign in. New users create an account.',
    fields: [],
    controls: [
      { label: 'Login', selector: '#login' },
      { label: 'New User', selector: '#newUser' },
      { label: 'Sign in with Google', selector: '#google' },
      { label: 'Continue with Apple', selector: '#apple' },
      { label: 'Log in with LinkedIn', selector: '#linkedin' },
      { label: 'Log in with Facebook', selector: '#facebook' },
    ],
  });

  it('chooses account creation when that strategy is saved', () => {
    const decision = selectPortalRoute(navigation, 'create_when_required');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    expect(decision.action.intent).toBe('create_account');
    expect(decision.action.selector).toBe('#newUser');
  });

  it('classifies social sign-in as navigation, not as a question or the portal login', () => {
    for (const label of [
      'Sign in with Google',
      'Continue with Apple',
      'Log in with LinkedIn',
      'Log in with Facebook',
      'Sign up with Microsoft',
    ]) {
      expect(navigationIntentFor(label)).toBe('social_login');
    }
    // The portal's own controls are unaffected.
    expect(navigationIntentFor('Login')).toBe('login');
    expect(navigationIntentFor('New User')).toBe('create_account');
  });

  it('never offers a social provider as a route the agent would take', () => {
    const decision = selectPortalRoute(navigation, 'use_existing_account');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    // The portal's own sign-in, never the identity provider's.
    expect(decision.action.selector).toBe('#login');

    // The page really does offer four of them...
    expect(navigation.actions.filter((entry) => entry.intent === 'social_login')).toHaveLength(4);
    // ...and none reaches the choices the user is shown. `PortalRouteAction`
    // cannot even express `social_login`, so this is a type-level guarantee as
    // well as a runtime one.
    const asked = selectPortalRoute(navigation, 'always_ask');
    if (asked.decision !== 'ask') throw new Error('unreachable');
    expect(asked.options).toHaveLength(2);
    expect(asked.options.map((option) => option.intent).sort()).toEqual([
      'create_account',
      'login',
    ]);
  });
});

describe('the final Submit', () => {
  it('is never something the policy can approve', () => {
    // A submit control is not a field, so it produces no fillable action. The
    // nearest thing — an attestation — is refused outright.
    for (const canonicalKey of ['terms_attestation', 'signature'] as const) {
      const decision = decideApproval(
        action({ confidence: 1, source: 'profile' }),
        SETTINGS,
        field({ canonicalKey }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.reviewReason).toBe('manual_required');
    }
  });

  it('is not a route any strategy will click', () => {
    const withSubmit = classifyPage({
      url: 'https://careers2-quanta.icims.com/jobs/12345/review',
      title: 'Review',
      bodyText: 'Review your application.',
      fields: [],
      controls: [
        { label: 'Submit Application', selector: '#submit' },
        { label: 'Apply as Guest', selector: '#guest' },
      ],
    });
    for (const strategy of ['prefer_guest', 'create_when_required', 'always_ask'] as const) {
      const decision = selectPortalRoute(withSubmit, strategy);
      if (decision.decision === 'act') expect(decision.action.endsApplication).toBe(false);
      if (decision.decision === 'ask') {
        expect(decision.options.every((option) => !option.endsApplication)).toBe(true);
      }
    }
  });
});
