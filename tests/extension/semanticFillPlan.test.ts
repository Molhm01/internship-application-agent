import { describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  buildNormalizedQuestions,
  detectedFieldSchema,
  matchCanonicalQuestion,
  sanitizeFormFillPlan,
  formFillPlanSchema,
  plannedAnswerSchema,
  scoreQuestionIntent,
  type ApplicationBundle,
  type ApplicationScanResult,
  type DetectedField,
  type FormFillPlan,
  type Profile,
} from '@internship-agent/shared';
import {
  applyAnalysisToPlan,
  buildAnalysisRequest,
  relevantFacts,
} from '../../extension/src/analysis/formAnalysis.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { profileFixture } from './popupFixtures.js';

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return detectedFieldSchema.parse({
    id: overrides.id ?? 'field-1',
    pageId: 'page-1',
    label: 'Question',
    normalizedLabel: 'question',
    question: 'Question',
    fieldType: 'text',
    selector: `#${overrides.id ?? 'field-1'}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  });
}

function scanOf(
  fields: DetectedField[],
  url = 'https://boards.example.com/apply',
): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: 'scan-1',
    createdAt: new Date().toISOString(),
    url,
    domain: 'boards.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'test',
      supported: true,
    },
    jobContext: { company: 'Northwind Robotics', jobTitle: 'SWE Intern' },
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: fields.length,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      bySection: {},
    },
    durationMs: 5,
    status: 'completed',
    readOnly: true,
  });
}

const PROFILE: Profile = profileFixture();

const BUNDLE: ApplicationBundle = {
  id: 'bundle-abc-job-42',
  websiteJobId: 'job-42',
  company: 'Northwind Robotics',
  jobTitle: 'SWE Intern',
  jobDescription: 'Robots.',
  officialApplicationUrl: 'https://boards.example.com/apply',
  resume: {
    kind: 'resume',
    filename: 'Resume-Northwind.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-abc-job-42:resume',
    byteLength: 100,
    generatedAt: '2026-08-02T08:00:00.000Z',
  },
  coverLetter: {
    kind: 'cover_letter',
    filename: 'Cover-Letter-Northwind.pdf',
    mimeType: 'application/pdf',
    bytesReference: 'bundle-abc-job-42:cover_letter',
    byteLength: 90,
    generatedAt: '2026-08-02T08:01:00.000Z',
  },
  approvedAnswers: [],
  createdAt: '2026-08-02T08:02:00.000Z',
};

function planFor(fields: DetectedField[]) {
  const scan = scanOf(fields);
  return { scan, plan: buildDeterministicPlan(scan, PROFILE, []) };
}

describe('semantic equivalence of question wording', () => {
  it.each([
    ['Are you legally authorized to work in the United States?', 'work_authorization'],
    [
      'Do you currently have permission to work in the country of employment?',
      'work_authorization',
    ],
    ['Can you provide evidence of employment eligibility?', 'work_authorization'],
    ['Do you have the legal right to work in this country?', 'work_authorization'],
  ])('maps %s to %s', (label, expected) => {
    expect(matchCanonicalQuestion(label).question).toBe(expected);
  });

  it.each([
    ['Will you now or in the future require sponsorship?', 'sponsorship_required'],
    ['Do you require visa sponsorship?', 'sponsorship_required'],
    ['Would the company need to sponsor your employment authorization?', 'sponsorship_required'],
    ['Do you need immigration support to work here?', 'sponsorship_required'],
  ])('maps %s to %s', (label, expected) => {
    expect(matchCanonicalQuestion(label).question).toBe(expected);
  });

  it('separates a graduation month control from a graduation year control', () => {
    expect(matchCanonicalQuestion('Graduation month').question).toBe('graduation_month');
    expect(matchCanonicalQuestion('Year of graduation').question).toBe('graduation_year');
  });

  it('reports an unrecognized question as unrecognized rather than guessing', () => {
    const match = matchCanonicalQuestion('What is your favourite type of sandwich?');
    expect(match.question).toBe('unknown');
    expect(match.confidence).toBe(0);
  });

  it('scores a reworded question below certainty, never at 1', () => {
    const scored = scoreQuestionIntent('Roughly how soon could you begin?');
    expect(scored.question).toBe('earliest_start_date');
    expect(scored.confidence).toBeGreaterThan(0);
    expect(scored.confidence).toBeLessThan(1);
  });
});

describe('the normalized question model', () => {
  it('turns a radio group into exactly one question carrying its options', () => {
    const questions = buildNormalizedQuestions([
      field({
        id: 'field-auth',
        label: 'Are you authorized to work in the US?',
        normalizedLabel: 'are you authorized to work in the us',
        fieldType: 'radio',
        canonicalKey: 'work_authorization',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      }),
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.controlType).toBe('radio_group');
    expect(questions[0]!.options).toHaveLength(2);
    expect(questions[0]!.fieldIds).toEqual(['field-auth']);
  });

  it('marks a demographic question with its sensitive category', () => {
    const [question] = buildNormalizedQuestions([
      field({
        id: 'field-race',
        label: 'Race / Ethnicity',
        normalizedLabel: 'race / ethnicity',
        canonicalKey: 'race_ethnicity',
        fieldType: 'select',
      }),
    ]);
    expect(question!.sensitiveCategory).toBe('ethnicity');
  });

  it('excludes fields that are not being asked right now', () => {
    expect(
      buildNormalizedQuestions([
        field({ id: 'a', visible: false }),
        field({ id: 'b', disabled: true }),
      ]),
    ).toEqual([]);
  });

  it('carries nearby context without folding it into the question text', () => {
    const [question] = buildNormalizedQuestions([
      field({
        id: 'field-x',
        label: 'Start date',
        normalizedLabel: 'start date',
        metadata: { nearbyText: 'We can be flexible for the right candidate.' },
      }),
    ]);
    expect(question!.questionText).toBe('Start date');
    expect(question!.contextualText).toContain('flexible');
  });
});

describe('what the model is sent', () => {
  it('makes exactly one request for a whole page', () => {
    const fields = Array.from({ length: 12 }, (_, index) =>
      field({
        id: `field-${index}`,
        label: `Mystery question ${index}`,
        normalizedLabel: `mystery question ${index}`,
        selector: `#field-${index}`,
      }),
    );
    const { scan, plan } = planFor(fields);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    expect(built.request).not.toBeNull();
    expect(built.request!.questions.length).toBeGreaterThan(1);
  });

  it('makes no request at all when nothing is unresolved', () => {
    const { scan, plan } = planFor([
      field({
        id: 'field-email',
        label: 'Email',
        normalizedLabel: 'email',
        canonicalKey: 'email',
        fieldType: 'email',
      }),
    ]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    expect(built.request).toBeNull();
  });

  it('sends only the facts the questions could need', () => {
    const facts = relevantFacts(
      PROFILE,
      buildNormalizedQuestions([
        field({
          id: 'field-school',
          label: 'University',
          normalizedLabel: 'university',
          canonicalKey: 'school',
        }),
      ]),
    );
    const ids = facts.map((fact) => fact.id);
    expect(ids).toContain('profile.education[0].institution');
    expect(ids).not.toContain('profile.personal.address.postalCode');
    expect(ids).not.toContain('profile.personal.phone');
  });

  it('never offers a sensitive trait as a fact', () => {
    const facts = relevantFacts(
      PROFILE,
      buildNormalizedQuestions([
        field({ id: 'f', label: 'Anything at all', normalizedLabel: 'anything at all' }),
      ]),
    );
    const serialized = JSON.stringify(facts).toLowerCase();
    for (const trait of ['gender', 'race', 'ethnic', 'veteran', 'disabilit', 'citizenship']) {
      expect(serialized).not.toContain(trait);
    }
  });

  it('sends document metadata but never document bytes', () => {
    const { scan, plan } = planFor([
      field({ id: 'field-q', label: 'Custom question', normalizedLabel: 'custom question' }),
    ]);
    const built = buildAnalysisRequest({
      scan,
      plan,
      profile: PROFILE,
      answers: [],
      bundle: BUNDLE,
    });
    expect(built.request!.documents).toEqual([
      { kind: 'resume', filename: 'Resume-Northwind.pdf', mimeType: 'application/pdf' },
      { kind: 'cover_letter', filename: 'Cover-Letter-Northwind.pdf', mimeType: 'application/pdf' },
    ]);
    expect(JSON.stringify(built.request)).not.toContain('contentBase64');
    expect(JSON.stringify(built.request)).not.toContain('bytesReference');
  });

  it('sends no selector, DOM path, or element handle', () => {
    const { scan, plan } = planFor([
      field({ id: 'field-q', label: 'Custom question', normalizedLabel: 'custom question' }),
    ]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    const serialized = JSON.stringify(built.request);
    expect(serialized).not.toContain('#field-q');
    expect(serialized).not.toContain('selector');
  });
});

describe('validating what the model returns', () => {
  const asked = ['question-a', 'question-b'];

  it('discards an answer for a question that was never asked', () => {
    const { plan, rejected } = sanitizeFormFillPlan(
      formFillPlanSchema.parse({
        pageId: 'scan-1',
        answers: [
          { questionId: 'question-a', action: 'SET_TEXT', value: 'x', confidence: 0.9 },
          { questionId: 'question-elsewhere', action: 'SET_TEXT', value: 'y', confidence: 0.9 },
        ],
      }),
      asked,
    );
    expect(plan.answers).toHaveLength(1);
    expect(rejected[0]).toContain('question-elsewhere');
  });

  it('discards a duplicate answer for the same question', () => {
    const { plan, rejected } = sanitizeFormFillPlan(
      formFillPlanSchema.parse({
        pageId: 'scan-1',
        answers: [
          { questionId: 'question-a', action: 'SET_TEXT', value: 'first', confidence: 0.9 },
          { questionId: 'question-a', action: 'SET_TEXT', value: 'second', confidence: 0.9 },
        ],
      }),
      asked,
    );
    expect(plan.answers).toHaveLength(1);
    expect(plan.answers[0]!.value).toBe('first');
    expect(rejected[0]).toContain('Duplicate');
  });

  it('discards an upload for a document that is not loaded', () => {
    const { plan, rejected } = sanitizeFormFillPlan(
      formFillPlanSchema.parse({
        pageId: 'scan-1',
        answers: [{ questionId: 'question-a', action: 'UPLOAD_COVER_LETTER', confidence: 1 }],
      }),
      asked,
      ['resume'],
    );
    expect(plan.answers).toEqual([]);
    expect(rejected[0]).toContain('No cover letter is loaded');
  });

  it('rejects an action that is not one of the fixed set', () => {
    expect(() =>
      plannedActionOrThrow({ questionId: 'question-a', action: 'RUN_SCRIPT', confidence: 1 }),
    ).toThrow();
  });

  it('rejects a text answer with no value and an option answer with no option', () => {
    expect(() =>
      plannedActionOrThrow({ questionId: 'question-a', action: 'SET_TEXT', confidence: 1 }),
    ).toThrow();
    expect(() =>
      plannedActionOrThrow({ questionId: 'question-a', action: 'SELECT_OPTION', confidence: 1 }),
    ).toThrow();
  });

  it('strips any key that could express a DOM operation', () => {
    const parsed = plannedAnswerSchema.parse({
      questionId: 'question-a',
      action: 'SET_TEXT',
      value: 'hello',
      confidence: 0.8,
      selector: '#password',
      script: 'document.forms[0].submit()',
      javascript: 'alert(1)',
    });
    expect(parsed).not.toHaveProperty('selector');
    expect(parsed).not.toHaveProperty('script');
    expect(parsed).not.toHaveProperty('javascript');
  });
});

function plannedActionOrThrow(value: unknown): unknown {
  return plannedAnswerSchema.parse(value);
}

describe('applying a fill plan', () => {
  function analysis(answers: FormFillPlan['answers']): FormFillPlan {
    return { pageId: 'scan-1', answers };
  }

  it('fills an unresolved text question and marks its source', () => {
    const target = field({
      id: 'field-hear',
      label: 'How did you come across this opening?',
      normalizedLabel: 'how did you come across this opening',
    });
    const { scan, plan } = planFor([target]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    const questionId = built.questions[0]!.questionId;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId,
          action: 'SET_TEXT',
          value: 'LinkedIn',
          confidence: 0.82,
          sourceFactIds: ['profile.preferences.discoverySource'],
          requiresReview: true,
          reason: 'Saved discovery source.',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
    );

    const action = applied.plan.actions.find((entry) => entry.fieldId === 'field-hear');
    expect(applied.applied).toBe(1);
    expect(action?.action).toBe('fill_text');
    expect(action?.proposedValue).toBe('LinkedIn');
    expect(action?.source).toBe('ai_suggestion');
    expect(action?.approved).toBe(false);
  });

  it('refuses a sensitive answer even when the model returns one', () => {
    const target = field({
      id: 'field-gender',
      label: 'Gender',
      normalizedLabel: 'gender',
      canonicalKey: 'gender',
      fieldType: 'select',
      options: [
        { label: 'Male', value: 'm' },
        { label: 'Female', value: 'f' },
        { label: 'Decline to self-identify', value: 'decline' },
      ],
    });
    const { scan, plan } = planFor([target]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    const questionId = built.questions[0]!.questionId;

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId,
          action: 'SELECT_OPTION',
          selectedOption: 'Male',
          confidence: 0.99,
          sourceFactIds: [],
          requiresReview: false,
          reason: 'Guessed.',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
    );

    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]!.reason).toContain('gender');
    expect(
      applied.plan.actions.find((entry) => entry.fieldId === 'field-gender')?.proposedValue,
    ).toBeUndefined();
  });

  it('discards an option label the page does not offer', () => {
    const target = field({
      id: 'field-degree',
      label: 'Highest level of study completed',
      normalizedLabel: 'highest level of study completed',
      fieldType: 'select',
      options: [
        { label: "Bachelor's Degree", value: 'bachelors' },
        { label: "Master's Degree", value: 'masters' },
      ],
    });
    const { scan, plan } = planFor([target]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId: built.questions[0]!.questionId,
          action: 'SELECT_OPTION',
          selectedOption: 'Doctorate',
          confidence: 0.9,
          sourceFactIds: [],
          requiresReview: false,
          reason: 'Invented.',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
    );
    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]!.reason).toContain('not one of the options');
  });

  it('recognizes an equivalently worded decline option', () => {
    const target = field({
      id: 'field-decline',
      label: 'Voluntary self-identification of veteran status',
      normalizedLabel: 'voluntary self identification of veteran status',
      fieldType: 'select',
      options: [
        { label: 'I identify as a protected veteran', value: 'yes' },
        { label: 'I am not a protected veteran', value: 'no' },
        { label: 'I do not wish to answer', value: 'decline' },
      ],
    });
    const { scan, plan } = planFor([target]);
    const built = buildAnalysisRequest({ scan, plan, profile: PROFILE, answers: [] });
    // Sensitive, so the answer must still be refused — the point of this test is
    // that the refusal comes from the sensitivity rule, not from a failed match.
    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId: built.questions[0]!.questionId,
          action: 'SELECT_OPTION',
          selectedOption: 'Prefer not to disclose',
          confidence: 0.95,
          sourceFactIds: [],
          requiresReview: false,
          reason: 'Decline.',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
    );
    expect(applied.applied).toBe(0);
    expect(applied.discarded[0]!.reason).toContain('veteran_status');
  });

  it('never displaces an answer the deterministic pass already made', () => {
    const target = field({
      id: 'field-email',
      label: 'Email',
      normalizedLabel: 'email',
      canonicalKey: 'email',
      fieldType: 'email',
    });
    const { scan, plan } = planFor([target]);
    const before = plan.actions.find((action) => action.fieldId === 'field-email');
    expect(before?.source).toBe('profile');

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId: 'question-anything',
          action: 'SET_TEXT',
          value: 'someone.else@example.com',
          confidence: 1,
          sourceFactIds: [],
          requiresReview: false,
          reason: 'Overriding.',
        },
      ]),
      new Map(),
      [],
    );
    expect(applied.plan.actions.find((action) => action.fieldId === 'field-email')).toEqual(before);
  });

  it('turns an upload answer into a bundle-backed attachment', () => {
    const target = field({
      id: 'field-upload',
      label: 'Attach your CV',
      normalizedLabel: 'attach your cv',
      fieldType: 'file',
    });
    const { scan, plan } = planFor([target]);
    const built = buildAnalysisRequest({
      scan,
      plan,
      profile: PROFILE,
      answers: [],
      bundle: BUNDLE,
    });

    const applied = applyAnalysisToPlan(
      plan,
      scan,
      analysis([
        {
          questionId: built.questions[0]!.questionId,
          action: 'UPLOAD_RESUME',
          confidence: 1,
          sourceFactIds: [],
          requiresReview: true,
          reason: 'CV field.',
        },
      ]),
      built.fieldsByQuestionId,
      built.questions,
      BUNDLE,
    );
    const action = applied.plan.actions.find((entry) => entry.fieldId === 'field-upload');
    expect(action?.action).toBe('upload_file');
    expect(action?.documentId).toBe('bundle-abc-job-42:resume');
    expect(action?.documentName).toBe('Resume-Northwind.pdf');
  });
});
