import type { DetectedField } from '../schemas/fields.js';
import type { QuestionClassification, QuestionConstraints } from '../schemas/ai.js';

export interface QuestionClassificationResult {
  classification: QuestionClassification;
  deterministic: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const SIMILARITY_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'at',
  'be',
  'do',
  'for',
  'in',
  'is',
  'of',
  'our',
  'please',
  'the',
  'this',
  'to',
  'us',
  'what',
  'why',
  'with',
  'you',
  'your',
]);

function similarityTokens(question: string): Set<string> {
  const canonical = question
    .toLowerCase()
    .replace(/\b(interested|interest|want|motivation|motivated)\b/g, ' interest ')
    .replace(/\b(position|job|opportunity)\b/g, ' role ')
    .replace(/\b(organization|employer|here)\b/g, ' company ')
    .replace(/\b(working|worked)\b/g, ' work ')
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(
    canonical.split(/\s+/).filter((token) => token.length > 1 && !SIMILARITY_STOP_WORDS.has(token)),
  );
}

/** Deterministic Jaccard similarity for approved-answer reuse, never embeddings. */
export function questionSimilarity(left: string, right: string): number {
  const leftTokens = similarityTokens(left);
  const rightTokens = similarityTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

export function areQuestionsHighlySimilar(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedRight = right.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalizedLeft === normalizedRight || questionSimilarity(left, right) >= 0.65;
}

const LEGAL =
  /\b(attest|certif(?:y|ication)|signature|sign here|legally binding|under penalty|terms and conditions|consent|acknowledge)\b/i;
const SENSITIVE =
  /\b(race|ethnicity|gender|disability|veteran|religion|sexual orientation|criminal|citizenship|sponsor(?:ship)?|security clearance|salary|medical)\b/i;

const RULES: ReadonlyArray<{
  classification: QuestionClassification;
  pattern: RegExp;
}> = [
  {
    classification: 'why_company_and_role',
    pattern:
      /\bwhy\b.*\b(company|organization)\b.*\b(role|position|job)\b|\bwhy\b.*\b(role|position|job)\b.*\b(company|organization)\b/i,
  },
  { classification: 'why_company', pattern: /\bwhy\b.*\b(company|organization|work here)\b/i },
  { classification: 'why_role', pattern: /\bwhy\b.*\b(role|position|job)\b/i },
  {
    classification: 'tell_me_about_yourself',
    pattern: /\b(tell us about yourself|tell me about yourself|introduce yourself|about you)\b/i,
  },
  {
    classification: 'relevant_project',
    pattern: /\b(project|built|developed|portfolio piece)\b/i,
  },
  {
    classification: 'technical_skills',
    pattern: /\b(technical (?:skills|experience)|programming|technologies|tools|software)\b/i,
  },
  { classification: 'leadership', pattern: /\b(leadership|led a|managed a|mentored)\b/i },
  {
    classification: 'teamwork',
    pattern: /\b(teamwork|team project|collaborat|worked with a team)\b/i,
  },
  { classification: 'conflict', pattern: /\b(conflict|disagreement|difficult teammate)\b/i },
  { classification: 'failure', pattern: /\b(fail(?:ure|ed)?|mistake|went wrong)\b/i },
  {
    classification: 'challenge',
    pattern: /\b(challenge|obstacle|adversity|overcame|difficult situation)\b/i,
  },
  {
    classification: 'achievement',
    pattern: /\b(achievement|accomplishment|proud of|success)\b/i,
  },
  {
    classification: 'problem_solving',
    pattern: /\b(problem.solving|solved a problem|debugged|troubleshoot)\b/i,
  },
  {
    classification: 'career_goals',
    pattern: /\b(career goals?|where do you see yourself|professional goals?)\b/i,
  },
  { classification: 'industry_interest', pattern: /\bwhy\b.*\bindustry\b|\bindustry interest\b/i },
  { classification: 'strengths', pattern: /\b(strengths?|strong candidate)\b/i },
  {
    classification: 'qualifications_summary',
    pattern: /\b(qualif(?:y|ied|ications)|experience align|good fit|makes you a candidate)\b/i,
  },
  {
    classification: 'relevant_experience',
    pattern: /\b(relevant experience|describe your experience|experience with)\b/i,
  },
  {
    classification: 'additional_information',
    pattern: /\b(anything else|additional information|other information)\b/i,
  },
  {
    classification: 'availability_explanation',
    pattern: /\b(explain|describe).*\bavailability\b/i,
  },
  {
    classification: 'relocation_explanation',
    pattern: /\b(explain|describe).*\brelocat/i,
  },
  { classification: 'work_style', pattern: /\b(work style|how do you work|working style)\b/i },
  {
    classification: 'values_alignment',
    pattern: /\b(values?|mission).*\b(align|resonate|connect)\b/i,
  },
];

export function classifyQuestionDeterministically(question: string): QuestionClassificationResult {
  const normalized = question.replace(/\s+/g, ' ').trim();
  if (LEGAL.test(normalized)) {
    return {
      classification: 'prohibited_legal',
      deterministic: true,
      confidence: 'high',
      reason: 'The question contains legal attestation or signature language.',
    };
  }
  if (SENSITIVE.test(normalized)) {
    return {
      classification: 'prohibited_sensitive',
      deterministic: true,
      confidence: 'high',
      reason: 'The question asks for a protected, eligibility, or sensitive answer.',
    };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        classification: rule.classification,
        deterministic: true,
        confidence: 'high',
        reason: `Matched the deterministic ${rule.classification} question rule.`,
      };
    }
  }
  const openEnded =
    /\b(describe|explain|discuss|share|tell|provide|give|summarize|outline|how|what|why|anything else|additional details?)\b/i.test(
      normalized,
    );
  return {
    classification: normalized.endsWith('?') || openEnded ? 'other_custom' : 'unsupported',
    deterministic: false,
    confidence: 'low',
    reason:
      normalized.endsWith('?') || openEnded
        ? 'No specific rule matched; treating this open-ended prompt as other_custom.'
        : 'No deterministic classification rule matched.',
  };
}

export function isAiEligibleField(field: DetectedField): boolean {
  if (!field.visible || field.disabled || field.currentValue) return false;
  if (field.semanticType && field.semanticType !== 'other') return false;
  if (!['textarea', 'contenteditable', 'text'].includes(field.fieldType)) return false;
  const classification = classifyQuestionDeterministically(field.question).classification;
  if (['prohibited_sensitive', 'prohibited_legal', 'unsupported'].includes(classification)) {
    return false;
  }
  return (
    field.fieldType === 'textarea' ||
    field.fieldType === 'contenteditable' ||
    (field.maxLength !== undefined && field.maxLength >= 150) ||
    /\b(describe|explain|discuss|why|tell us|tell me|share|provide|how|what|achievements?|projects?|leadership|teamwork|goals?|anything else)\b/i.test(
      field.question,
    )
  );
}

function firstNumber(text: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export function extractQuestionConstraints(field: DetectedField): QuestionConstraints {
  const text = [field.question, field.helpText, field.placeholder, field.validationText]
    .filter(Boolean)
    .join(' ');
  const lower = text.toLowerCase();
  const maxWords = firstNumber(lower, [
    /(?:maximum|max|no more than|up to|limit(?:ed)? to)\s+(\d+)\s+words?/i,
    /(\d+)\s+words?\s+or\s+(?:fewer|less)/i,
  ]);
  const minWords = firstNumber(lower, [/(?:minimum|min|at least)\s+(\d+)\s+words?/i]);
  const textMaxCharacters = firstNumber(lower, [
    /(?:maximum|max|no more than|up to|limit(?:ed)? to)\s+(\d+)\s+characters?/i,
    /(\d+)\s+characters?\s+or\s+(?:fewer|less)/i,
  ]);
  const textMinCharacters = firstNumber(lower, [/(?:minimum|min|at least)\s+(\d+)\s+characters?/i]);
  const rangeMatch =
    /(?:provide|give|include|describe|tell(?:\s+\w+){0,3})?\s*(\d+)\s*(?:or|to|[-–])\s*(\d+)\s+(?:personal\s+)?(?:engineering\s+)?(?:examples?|achievements?|accomplishments?|projects?|experiences?)/i.exec(
      lower,
    ) ??
    /(\d+)\s*(?:or|to|[-–])\s*(\d+)\s+(?:personal\s+)?(?:engineering\s+)?(?:examples?|achievements?|accomplishments?|projects?|experiences?)/i.exec(
      lower,
    );
  const singleExamples =
    firstNumber(lower, [
      /(?:provide|give|include|describe)\s+(\d+)\s+(?:examples?|achievements?|accomplishments?|projects?|experiences?)/i,
    ]) ?? (/\btwo examples?\b/i.test(lower) ? 2 : undefined);
  const requestedExamples = rangeMatch
    ? {
        minimum: Math.min(Number(rangeMatch[1]), Number(rangeMatch[2])),
        maximum: Math.max(Number(rangeMatch[1]), Number(rangeMatch[2])),
      }
    : singleExamples
      ? { minimum: singleExamples, maximum: singleExamples }
      : undefined;
  const behavioral =
    /\b(time when|example of|situation|challenge|conflict|failure|leadership)\b/i.test(lower);
  return {
    ...(minWords ? { minWords } : {}),
    ...(maxWords ? { maxWords } : {}),
    ...((field.minLength ?? textMinCharacters)
      ? { minCharacters: field.minLength ?? textMinCharacters }
      : {}),
    ...((field.maxLength ?? textMaxCharacters)
      ? {
          maxCharacters: Math.min(
            ...(field.maxLength ? [field.maxLength] : []),
            ...(textMaxCharacters ? [textMaxCharacters] : []),
          ),
        }
      : {}),
    ...(requestedExamples ? { requestedExamples } : {}),
    ...(field.fieldType === 'text' ? { requestedFormat: 'short_answer' as const } : {}),
    useStar: behavioral,
    asksCompany: /\b(company|organization|work here)\b/i.test(lower),
    asksRole: /\b(role|position|job)\b/i.test(lower),
    asksProject: /\bproject\b/i.test(lower),
    asksTechnical: /\b(technical|technology|programming|software|tools?)\b/i.test(lower),
    asksLeadership: /\b(leadership|led|managed|mentored)\b/i.test(lower),
    asksTeamwork: /\b(team|collaborat)\b/i.test(lower),
    asksChallenge: /\b(challenge|obstacle|overcame|conflict|failure)\b/i.test(lower),
    asksCareerGoals: /\b(career|professional goals?)\b/i.test(lower),
  };
}
