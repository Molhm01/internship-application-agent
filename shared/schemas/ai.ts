import { z } from 'zod';
import { agentErrorSchema } from './error.js';
import { idSchema, isoDateTimeSchema, jobContextSchema } from './common.js';
import { detectedFieldSchema } from './fields.js';

export const questionClassificationSchema = z.enum([
  'why_company',
  'why_role',
  'why_company_and_role',
  'tell_me_about_yourself',
  'relevant_experience',
  'relevant_project',
  'technical_skills',
  'leadership',
  'teamwork',
  'challenge',
  'conflict',
  'failure',
  'achievement',
  'problem_solving',
  'career_goals',
  'industry_interest',
  'strengths',
  'qualifications_summary',
  'additional_information',
  'availability_explanation',
  'relocation_explanation',
  'work_style',
  'values_alignment',
  'other_custom',
  'prohibited_sensitive',
  'prohibited_legal',
  'unsupported',
]);

export type QuestionClassification = z.infer<typeof questionClassificationSchema>;

export const requestedFormatSchema = z.enum(['paragraph', 'bullets', 'list', 'short_answer']);

export const requestedExampleRangeSchema = z
  .object({
    minimum: z.number().int().positive().max(20),
    maximum: z.number().int().positive().max(20),
  })
  .refine((range) => range.minimum <= range.maximum, {
    message: 'minimum cannot exceed maximum',
    path: ['minimum'],
  });

export const questionConstraintsSchema = z
  .object({
    minWords: z.number().int().positive().max(5000).optional(),
    maxWords: z.number().int().positive().max(5000).optional(),
    minCharacters: z.number().int().positive().max(50_000).optional(),
    maxCharacters: z.number().int().positive().max(50_000).optional(),
    requestedExamples: requestedExampleRangeSchema.optional(),
    requestedFormat: requestedFormatSchema.optional(),
    useStar: z.boolean().default(false),
    asksCompany: z.boolean().default(false),
    asksRole: z.boolean().default(false),
    asksProject: z.boolean().default(false),
    asksTechnical: z.boolean().default(false),
    asksLeadership: z.boolean().default(false),
    asksTeamwork: z.boolean().default(false),
    asksChallenge: z.boolean().default(false),
    asksCareerGoals: z.boolean().default(false),
  })
  .superRefine((constraints, ctx) => {
    if (
      constraints.minWords !== undefined &&
      constraints.maxWords !== undefined &&
      constraints.minWords > constraints.maxWords
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minWords'],
        message: 'minWords cannot exceed maxWords',
      });
    }
    if (
      constraints.minCharacters !== undefined &&
      constraints.maxCharacters !== undefined &&
      constraints.minCharacters > constraints.maxCharacters
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minCharacters'],
        message: 'minCharacters cannot exceed maxCharacters',
      });
    }
  });

export type QuestionConstraints = z.infer<typeof questionConstraintsSchema>;

export const evidenceSourceSchema = z.enum([
  'profile',
  'resume',
  'approved_answer',
  'job_context',
  'user_override',
]);

export const evidenceCategorySchema = z.enum([
  'personal',
  'education',
  'experience',
  'project',
  'skill',
  'activity',
  'volunteering',
  'eligibility',
  'company',
  'job',
  'other',
]);
export type EvidenceCategory = z.infer<typeof evidenceCategorySchema>;

export const evidenceItemSchema = z.object({
  id: idSchema,
  source: evidenceSourceSchema,
  sourceReference: z.string().min(1).max(500),
  category: evidenceCategorySchema,
  text: z.string().min(1).max(6000),
  facts: z.array(z.string().min(1).max(2000)).max(100),
  relevanceScore: z.number().min(0).max(100),
  sensitive: z.boolean(),
  verified: z.boolean(),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const answerLengthModeSchema = z.enum([
  'very_short',
  'short',
  'medium',
  'detailed',
  'field_limit',
]);

export const regenerationModeSchema = z.enum([
  'default',
  'shorter',
  'longer',
  'more_technical',
  'more_personal',
  'more_direct',
  'more_formal',
  'more_conversational',
  'emphasize_project',
  'emphasize_experience',
  'emphasize_leadership',
]);
export type RegenerationMode = z.infer<typeof regenerationModeSchema>;

export const answerStylePreferencesSchema = z.object({
  tone: z.string().min(1).max(120).default('natural and professional'),
  verbosity: answerLengthModeSchema.default('medium'),
  useStarWhenAppropriate: z.boolean().default(true),
  avoidCliches: z.boolean().default(true),
});

export const answerContextBundleSchema = z.object({
  question: z.string().min(1).max(4000),
  classification: questionClassificationSchema,
  constraints: questionConstraintsSchema,
  jobContext: jobContextSchema,
  evidence: z.array(evidenceItemSchema).max(30),
  approvedAnswerExamples: z.array(z.string().min(1).max(6000)).max(10),
  stylePreferences: answerStylePreferencesSchema,
  promptInjectionWarnings: z.array(z.string().min(1).max(1000)).max(20).default([]),
});

export type AnswerContextBundle = z.infer<typeof answerContextBundleSchema>;

export const factualClaimSchema = z.object({
  claim: z.string().min(1).max(2000),
  evidenceIds: z.array(idSchema).min(1).max(20),
});

export const generatedAnswerCandidateSchema = z
  .object({
    questionId: idSchema,
    status: z.enum(['generated', 'needs_user_input', 'prohibited', 'failed']),
    classification: questionClassificationSchema,
    answer: z.string().min(1).max(50_000).optional(),
    shortAnswer: z.string().min(1).max(10_000).optional(),
    evidenceUsed: z.array(idSchema).max(30),
    factualClaims: z.array(factualClaimSchema).max(100),
    missingInformation: z.array(z.string().min(1).max(1000)).max(30),
    warnings: z.array(z.string().min(1).max(1000)).max(30),
    confidence: z.enum(['high', 'medium', 'low']),
    wordCount: z.number().int().nonnegative(),
    characterCount: z.number().int().nonnegative(),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.status === 'generated' && !candidate.answer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer'],
        message: 'A generated candidate requires an answer',
      });
    }
    if (candidate.answer) {
      const words = candidate.answer.trim() ? candidate.answer.trim().split(/\s+/).length : 0;
      if (words !== candidate.wordCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['wordCount'],
          message: 'wordCount must equal the answer word count',
        });
      }
      if (candidate.answer.length !== candidate.characterCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['characterCount'],
          message: 'characterCount must equal the answer character count',
        });
      }
    }
  });

export type GeneratedAnswerCandidate = z.infer<typeof generatedAnswerCandidateSchema>;

export const answerValidationIssueSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  evidenceId: idSchema.optional(),
});

export const answerValidationResultSchema = z.object({
  valid: z.boolean(),
  checkedAt: isoDateTimeSchema,
  issues: z.array(answerValidationIssueSchema).max(100),
  warnings: z.array(z.string().min(1).max(1000)).max(30),
});

export type AnswerValidationResult = z.infer<typeof answerValidationResultSchema>;

export const answerGenerationStateSchema = z.enum([
  'not_requested',
  'queued',
  'gathering_context',
  'generating',
  'validating',
  'ready_for_review',
  'needs_user_input',
  'prohibited',
  'failed',
  'approved',
  'rejected',
  'filled',
  'verified',
  'cancelled',
]);

export type AnswerGenerationState = z.infer<typeof answerGenerationStateSchema>;

export const aiGenerationSettingsSchema = z.object({
  generationModel: z.string().trim().min(1).max(200),
  validationModel: z.string().min(1).max(200).optional(),
  temperature: z.number().min(0).max(1).default(0.2),
  maximumGenerationTokens: z.number().int().min(64).max(8192).default(768),
  defaultAnswerLength: answerLengthModeSchema.default('medium'),
  generationTimeoutMs: z.number().int().min(5000).max(180_000).default(60_000),
  maximumRetries: z.number().int().min(0).max(1).default(1),
  maximumConcurrentGenerations: z.number().int().min(1).max(2).default(1),
  regenerateBehavior: z.enum(['replace_draft', 'keep_previous']).default('keep_previous'),
  preferredTone: z.string().min(1).max(120).default('natural and professional'),
});

export type AiGenerationSettings = z.infer<typeof aiGenerationSettingsSchema>;

export const answerGenerationRecordSchema = z.object({
  id: idSchema,
  scanId: idSchema,
  planId: idSchema,
  fieldId: idSchema,
  /** Original scan target retained by the extension; the server may omit it. */
  targetField: detectedFieldSchema.optional(),
  pageUrl: z.string().url().max(2048).optional(),
  question: z.string().min(1).max(4000),
  classification: questionClassificationSchema,
  constraints: questionConstraintsSchema,
  state: answerGenerationStateSchema,
  candidate: generatedAnswerCandidateSchema.optional(),
  originalCandidate: generatedAnswerCandidateSchema.optional(),
  validation: answerValidationResultSchema.optional(),
  originalValidation: answerValidationResultSchema.optional(),
  contextEvidence: z.array(evidenceItemSchema).max(30).default([]),
  userEvidence: z.array(evidenceItemSchema).max(20).default([]),
  editedAnswer: z.string().max(50_000).optional(),
  source: z.enum(['ai_generated', 'user_override', 'approved_answer']).default('ai_generated'),
  approved: z.boolean().default(false),
  rejected: z.boolean().default(false),
  leaveBlank: z.boolean().default(false),
  model: z.string().max(200).optional(),
  generationDurationMs: z.number().nonnegative().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  error: agentErrorSchema.optional(),
  warnings: z.array(z.string().min(1).max(1000)).max(30).default([]),
});

export type AnswerGenerationRecord = z.infer<typeof answerGenerationRecordSchema>;

export const answerGenerationStoreSchema = z.object({
  scanId: idSchema,
  planId: idSchema,
  records: z.array(answerGenerationRecordSchema).max(100),
  updatedAt: isoDateTimeSchema,
});

export type AnswerGenerationStore = z.infer<typeof answerGenerationStoreSchema>;

export const classifyQuestionRequestSchema = z.object({
  questionId: idSchema,
  question: z.string().min(1).max(4000),
});

export const classifyQuestionResponseSchema = z.object({
  classification: questionClassificationSchema,
  deterministic: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string().min(1).max(1000),
});
export type ClassifyQuestionResponse = z.infer<typeof classifyQuestionResponseSchema>;

export const generateAnswerRequestSchema = z.object({
  generationId: idSchema.optional(),
  scanId: idSchema,
  planId: idSchema,
  fieldId: idSchema,
  question: z.string().min(1).max(4000),
  classification: questionClassificationSchema.optional(),
  constraints: questionConstraintsSchema.optional(),
  jobContext: jobContextSchema,
  selectedDocumentId: idSchema.nullable().optional(),
  userEvidence: z.array(z.string().min(1).max(4000)).max(20).default([]),
  aiGenerationEnabled: z.boolean().optional(),
  settingsUpdatedAt: isoDateTimeSchema.optional(),
  settingsVersion: z.number().int().nonnegative().optional(),
  settings: aiGenerationSettingsSchema,
  regenerationMode: regenerationModeSchema.default('default'),
});

export type GenerateAnswerRequest = z.infer<typeof generateAnswerRequestSchema>;

export const generateAnswerResponseSchema = z.object({
  record: answerGenerationRecordSchema,
});

export const generateBatchRequestSchema = z.object({
  requests: z.array(generateAnswerRequestSchema).min(1).max(20),
});

export const generateBatchResponseSchema = z.object({
  records: z.array(answerGenerationRecordSchema).max(20),
});

export const generationCancelRequestSchema = z.object({
  generationId: idSchema.optional(),
});

export const generationCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  generationId: idSchema.optional(),
});

export const aiGenerationTestRequestSchema = z.object({
  model: z.string().trim().min(1).max(200),
  timeoutMs: z.number().int().min(5000).max(180_000).default(30_000),
});

export const aiGenerationTestResponseSchema = z.object({
  connected: z.literal(true),
  model: z.string().min(1).max(200),
  durationMs: z.number().nonnegative(),
  structuredOutputValid: z.literal(true),
});

export type AiGenerationTestResponse = z.infer<typeof aiGenerationTestResponseSchema>;

export const documentExtractionStatusSchema = z.enum([
  'not_requested',
  'extracting',
  'completed',
  'failed',
  'unsupported',
]);

export const resumeSectionSchema = z.object({
  name: z.enum(['summary', 'education', 'experience', 'projects', 'skills', 'activities', 'other']),
  text: z.string().min(1).max(50_000),
});

export const documentExtractionSchema = z.object({
  documentId: idSchema,
  status: documentExtractionStatusSchema,
  normalizedText: z.string().max(200_000).default(''),
  sections: z.array(resumeSectionSchema).max(100).default([]),
  contentHash: z.string().max(128).optional(),
  extractedAt: isoDateTimeSchema.optional(),
  error: agentErrorSchema.optional(),
});

export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

export const promptInjectionAssessmentSchema = z.object({
  detected: z.boolean(),
  warnings: z.array(z.string().min(1).max(1000)).max(20),
});

export type PromptInjectionAssessment = z.infer<typeof promptInjectionAssessmentSchema>;
