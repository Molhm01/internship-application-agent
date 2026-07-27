import {
  generatedAnswerCandidateSchema,
  type GeneratedAnswerCandidate,
} from '@internship-agent/shared';

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly repaired: boolean,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

function normalizeCounts(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = { ...(value as Record<string, unknown>) };
  // Some structured-output models materialize optional strings as "". Treat
  // that as omission; never repair or synthesize the required answer itself.
  if (record.shortAnswer === '') delete record.shortAnswer;
  if (record.answer === '' && record.status !== 'generated') delete record.answer;
  if (typeof record.answer === 'string') {
    record.wordCount = record.answer.trim() ? record.answer.trim().split(/\s+/).length : 0;
    record.characterCount = record.answer.length;
  } else {
    record.wordCount = 0;
    record.characterCount = 0;
  }
  return record;
}

function validate(value: unknown): GeneratedAnswerCandidate {
  const parsed = generatedAnswerCandidateSchema.safeParse(normalizeCounts(value));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

export function parseStructuredCandidate(raw: string): {
  candidate: GeneratedAnswerCandidate;
  repaired: boolean;
} {
  try {
    return { candidate: validate(JSON.parse(raw) as unknown), repaired: false };
  } catch (initial) {
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return {
          candidate: validate(JSON.parse(unfenced.slice(start, end + 1)) as unknown),
          repaired: true,
        };
      } catch (repair) {
        throw new StructuredOutputError(
          `Structured output remained invalid after one controlled repair: ${
            repair instanceof Error ? repair.message : String(repair)
          }`,
          true,
        );
      }
    }
    throw new StructuredOutputError(
      `Structured output was invalid and contained no repairable JSON object: ${
        initial instanceof Error ? initial.message : String(initial)
      }`,
      true,
    );
  }
}
