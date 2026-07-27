import {
  answerValidationResultSchema,
  generatedAnswerCandidateSchema,
  type AnswerGenerationRecord,
  type AnswerValidationResult,
  type GeneratedAnswerCandidate,
} from '../schemas/ai.js';
import { containsUnexpectedModelInstructions } from './promptSafety.js';

export function validateManualAnswer(
  answer: string,
  record: AnswerGenerationRecord,
): {
  candidate: GeneratedAnswerCandidate;
  validation: AnswerValidationResult;
} {
  const wordCount = answer.trim() ? answer.trim().split(/\s+/).length : 0;
  const issues: AnswerValidationResult['issues'] = [];
  if (!answer.trim()) issues.push({ code: 'ANSWER_EMPTY', message: 'The answer is empty.' });
  if (record.constraints.maxWords !== undefined && wordCount > record.constraints.maxWords) {
    issues.push({
      code: 'ANSWER_LIMIT_EXCEEDED',
      message: `${wordCount} words exceeds the ${record.constraints.maxWords}-word limit.`,
    });
  }
  if (record.constraints.minWords !== undefined && wordCount < record.constraints.minWords) {
    issues.push({
      code: 'ANSWER_LIMIT_EXCEEDED',
      message: `${wordCount} words is below the ${record.constraints.minWords}-word minimum.`,
    });
  }
  if (
    record.constraints.maxCharacters !== undefined &&
    answer.length > record.constraints.maxCharacters
  ) {
    issues.push({
      code: 'ANSWER_LIMIT_EXCEEDED',
      message: `${answer.length} characters exceeds the ${record.constraints.maxCharacters}-character limit.`,
    });
  }
  if (
    record.constraints.minCharacters !== undefined &&
    answer.length < record.constraints.minCharacters
  ) {
    issues.push({
      code: 'ANSWER_LIMIT_EXCEEDED',
      message: `${answer.length} characters is below the ${record.constraints.minCharacters}-character minimum.`,
    });
  }
  if (containsUnexpectedModelInstructions(answer)) {
    issues.push({
      code: 'PROMPT_INJECTION_DETECTED',
      message: 'The edited answer contains code, prompt, tool, or browser-action instructions.',
    });
  }
  const candidate = generatedAnswerCandidateSchema.parse({
    questionId: record.fieldId,
    status: answer.trim() ? 'generated' : 'failed',
    classification: record.classification,
    ...(answer.trim() ? { answer } : {}),
    evidenceUsed: record.contextEvidence.map((item) => item.id),
    factualClaims: [],
    missingInformation: [],
    warnings: ['This answer was manually edited and is treated as an explicit user override.'],
    confidence: 'high',
    wordCount,
    characterCount: answer.length,
  });
  const validation = answerValidationResultSchema.parse({
    valid: issues.length === 0,
    checkedAt: new Date().toISOString(),
    issues,
    warnings: ['Manual edits must still be reviewed before filling.'],
  });
  return { candidate, validation };
}
