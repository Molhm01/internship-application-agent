import {
  answerValidationResultSchema,
  containsUnexpectedModelInstructions,
  type AnswerContextBundle,
  type AnswerValidationResult,
  type GeneratedAnswerCandidate,
} from '@internship-agent/shared';

const PLACEHOLDER =
  /\[(?:insert|company|role|project|name|date|metric)[^\]]*\]|\{\{[^}]+\}\}|<[^>]*(?:insert|placeholder)[^>]*>/i;

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ');
}

function significantTokens(text: string): string[] {
  return normalized(text)
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length >= 3);
}

export function validateGeneratedAnswer(
  candidate: GeneratedAnswerCandidate,
  context: AnswerContextBundle,
): AnswerValidationResult {
  const issues: AnswerValidationResult['issues'] = [];
  const warnings = [...context.promptInjectionWarnings];
  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  if (candidate.status !== 'generated' || !candidate.answer?.trim()) {
    issues.push({
      code: candidate.status === 'needs_user_input' ? 'INSUFFICIENT_EVIDENCE' : 'ANSWER_EMPTY',
      message:
        candidate.status === 'needs_user_input'
          ? 'The model reported that more user evidence is required.'
          : 'No generated answer was returned.',
    });
  }
  for (const evidenceId of candidate.evidenceUsed) {
    if (!evidence.has(evidenceId)) {
      issues.push({
        code: 'ANSWER_NOT_GROUNDED',
        message: `The answer references unknown evidence id ${evidenceId}.`,
        evidenceId,
      });
    }
  }
  for (const claim of candidate.factualClaims) {
    for (const evidenceId of claim.evidenceIds) {
      const item = evidence.get(evidenceId);
      if (!item) {
        issues.push({
          code: 'ANSWER_NOT_GROUNDED',
          message: `Claim "${claim.claim}" references unknown evidence.`,
          evidenceId,
        });
        continue;
      }
      const factTokens = new Set(significantTokens(`${item.text} ${item.facts.join(' ')}`));
      const claimTokens = significantTokens(claim.claim);
      const overlap = claimTokens.filter((token) => factTokens.has(token)).length;
      if (claimTokens.length >= 3 && overlap === 0) {
        issues.push({
          code: 'ANSWER_NOT_GROUNDED',
          message: `Claim "${claim.claim}" has no lexical support in ${evidenceId}.`,
          evidenceId,
        });
      }
    }
  }
  if (candidate.answer) {
    const supplied = normalized(
      [
        context.question,
        JSON.stringify(context.jobContext),
        ...context.evidence.flatMap((item) => [item.text, ...item.facts]),
      ].join(' '),
    );
    for (const number of candidate.answer.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? []) {
      if (!supplied.includes(normalized(number).trim())) {
        issues.push({
          code: 'ANSWER_NOT_GROUNDED',
          message: `Numeric claim "${number}" does not appear in supplied evidence.`,
        });
      }
    }
    if (PLACEHOLDER.test(candidate.answer)) {
      issues.push({ code: 'INVALID_MODEL_OUTPUT', message: 'The answer contains a placeholder.' });
    }
    if (containsUnexpectedModelInstructions(candidate.answer)) {
      issues.push({
        code: 'PROMPT_INJECTION_DETECTED',
        message: 'The output contains unexpected tool, prompt, code, or browser instructions.',
      });
    }
    if (
      context.constraints.maxWords !== undefined &&
      candidate.wordCount > context.constraints.maxWords
    ) {
      issues.push({
        code: 'ANSWER_LIMIT_EXCEEDED',
        message: `${candidate.wordCount} words exceeds the ${context.constraints.maxWords}-word limit.`,
      });
    }
    if (
      context.constraints.minWords !== undefined &&
      candidate.wordCount < context.constraints.minWords
    ) {
      issues.push({
        code: 'ANSWER_LIMIT_EXCEEDED',
        message: `${candidate.wordCount} words is below the ${context.constraints.minWords}-word minimum.`,
      });
    }
    if (
      context.constraints.maxCharacters !== undefined &&
      candidate.characterCount > context.constraints.maxCharacters
    ) {
      issues.push({
        code: 'ANSWER_LIMIT_EXCEEDED',
        message: `${candidate.characterCount} characters exceeds the ${context.constraints.maxCharacters}-character limit.`,
      });
    }
    if (
      context.constraints.minCharacters !== undefined &&
      candidate.characterCount < context.constraints.minCharacters
    ) {
      issues.push({
        code: 'ANSWER_LIMIT_EXCEEDED',
        message: `${candidate.characterCount} characters is below the ${context.constraints.minCharacters}-character minimum.`,
      });
    }
    const questionTokens = new Set(significantTokens(context.question));
    const answerTokens = new Set(significantTokens(candidate.answer));
    const addressesQuestion = [...questionTokens].some((token) => answerTokens.has(token));
    if (questionTokens.size > 3 && !addressesQuestion) {
      issues.push({
        code: 'ANSWER_NOT_GROUNDED',
        message: 'The answer does not appear to address the application question.',
      });
    }
  }
  return answerValidationResultSchema.parse({
    valid: issues.length === 0,
    checkedAt: new Date().toISOString(),
    issues,
    warnings,
  });
}
