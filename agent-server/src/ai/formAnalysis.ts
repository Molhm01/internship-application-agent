import {
  PLANNED_ACTIONS,
  formFillPlanSchema,
  sanitizeFormFillPlan,
  type FormAnalysisRequest,
  type FormAnalysisResponse,
  type NormalizedQuestion,
} from '@internship-agent/shared';
import { OllamaGenerationError, type OllamaClient } from '../ollama/client.js';
import type { Logger } from '../logging/logger.js';

/**
 * Batched, page-level form analysis.
 *
 * One request per page, never one per field. The extension has already resolved
 * everything it can deterministically; what arrives here is the remainder, plus
 * only the saved facts those questions could plausibly need.
 *
 * The model's entire authority is: pick an action from a fixed list, name a
 * question id it was given, and optionally quote an option label the page
 * really offers. It cannot express a selector, a script, or a DOM operation —
 * there is no field for one, and unknown keys are stripped before the plan is
 * ever looked at.
 */

const SYSTEM_PROMPT = [
  'You map job-application questions to a candidate\'s saved facts.',
  '',
  'You receive QUESTIONS (each with a questionId, its wording, its control type,',
  'and where applicable the exact options the page offers) and FACTS (each with',
  'an id, a label, and a value).',
  '',
  'Return ONE JSON object and nothing else:',
  '{"pageId":"<the pageId given>","answers":[{"questionId":"...","action":"...",',
  '"value":"...","selectedOption":"...","confidence":0.0,"sourceFactIds":["..."],',
  '"requiresReview":true,"reason":"..."}]}',
  '',
  `action must be one of: ${PLANNED_ACTIONS.join(', ')}.`,
  '',
  'Rules you must not break:',
  '1. Answer only from the FACTS given. If no fact answers a question, use',
  '   LEAVE_BLANK or REQUIRE_USER_REVIEW. Never invent a school, degree, major,',
  '   GPA, graduation date, employer, job title, skill, certification, salary,',
  '   citizenship, work authorization, or sponsorship status.',
  '2. Any question about race, ethnicity, gender, sexual orientation, disability,',
  '   veteran status, religion, citizenship, sponsorship, criminal history,',
  '   medical information, security clearance, or salary expectations must be',
  '   REQUIRE_USER_REVIEW unless a FACT explicitly states the saved preference.',
  '3. When a question lists options, selectedOption must be copied character for',
  '   character from that list. Recognize equivalent wording: "I do not wish to',
  '   answer", "Decline to self-identify", "Prefer not to disclose" and "I choose',
  '   not to answer" are the same choice.',
  '4. Recognize equivalent questions. "Are you legally authorized to work?",',
  '   "Do you have permission to work in the country of employment?" and "Can you',
  '   provide evidence of employment eligibility?" all ask the same thing.',
  '5. sourceFactIds must list the fact ids you used, and only ids you were given.',
  '6. confidence is 0 to 1 and must reflect real uncertainty.',
  '7. Never propose submitting, sending, or completing the application.',
].join('\n');

/** The model sees text only — no selectors, no element handles, no DOM paths. */
function renderQuestion(question: NormalizedQuestion): string {
  const lines = [
    `- questionId: ${question.questionId}`,
    `  question: ${question.questionText}`,
    `  control: ${question.controlType}${question.required ? ' (required)' : ''}`,
  ];
  if (question.contextualText) lines.push(`  context: ${question.contextualText}`);
  if (question.sensitiveCategory) {
    lines.push(`  sensitive: ${question.sensitiveCategory} — needs an explicit saved preference`);
  }
  if (question.options?.length) {
    const options = question.options
      .filter((option) => !option.disabled)
      .slice(0, 80)
      .map((option) => `"${option.label}"`)
      .join(', ');
    lines.push(`  options: ${options}`);
  }
  if (question.validation) lines.push(`  validation: ${question.validation}`);
  return lines.join('\n');
}

function buildPrompt(request: FormAnalysisRequest): string {
  const sections = [`pageId: ${request.pageId}`, '', 'QUESTIONS:'];
  sections.push(request.questions.map(renderQuestion).join('\n'));
  sections.push('', 'FACTS:');
  sections.push(
    request.facts.length
      ? request.facts.map((fact) => `- ${fact.id}: ${fact.label} = ${fact.value}`).join('\n')
      : '(none saved)',
  );
  if (request.approvedAnswers.length) {
    sections.push('', 'PREVIOUSLY APPROVED ANSWERS:');
    sections.push(
      request.approvedAnswers
        .map((answer) => `- ${answer.id}: "${answer.question}" -> ${answer.answer}`)
        .join('\n'),
    );
  }
  const job = request.jobContext;
  if (job.company || job.jobTitle || job.jobDescriptionExcerpt) {
    sections.push('', 'JOB:');
    if (job.company) sections.push(`company: ${job.company}`);
    if (job.jobTitle) sections.push(`title: ${job.jobTitle}`);
    if (job.jobDescriptionExcerpt) sections.push(`description: ${job.jobDescriptionExcerpt}`);
  }
  if (request.documents.length) {
    sections.push('', 'DOCUMENTS LOADED:');
    sections.push(request.documents.map((document) => `- ${document.kind}`).join('\n'));
  }
  sections.push('', 'Return the JSON object now.');
  return sections.join('\n');
}

/** Pulls the JSON object out of a response that may be fenced or prefixed. */
export function extractJsonObject(content: string): unknown {
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  return JSON.parse(candidate) as unknown;
}

export interface FormAnalysisService {
  analyze(request: FormAnalysisRequest): Promise<FormAnalysisResponse>;
}

export function createFormAnalysisService(
  ollama: OllamaClient,
  logger: Logger,
): FormAnalysisService {
  return {
    async analyze(request: FormAnalysisRequest): Promise<FormAnalysisResponse> {
      const model = request.model ?? ollama.defaultModel;
      const askedIds = request.questions.map((question) => question.questionId);
      const availableDocuments = request.documents.map((document) => document.kind);
      const started = Date.now();

      logger.info('Batched form analysis started', {
        pageId: request.pageId,
        questions: request.questions.length,
        facts: request.facts.length,
        model,
      });

      let content: string;
      try {
        const result = await ollama.generateStructured({
          model,
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(request),
          temperature: 0,
          // Enough for ~120 answers; the schema caps the plan at 200 either way.
          maximumTokens: 4096,
          timeoutMs: request.timeoutMs,
        });
        content = result.content;
      } catch (cause) {
        const code =
          cause instanceof OllamaGenerationError ? cause.code : ('ANALYSIS_FAILED' as const);
        logger.warn('Batched form analysis failed', { pageId: request.pageId, code });
        return {
          plan: { pageId: request.pageId, answers: [] },
          model,
          durationMs: Date.now() - started,
          rejected: [],
          error: {
            code: code === 'INVALID_MODEL_OUTPUT' ? 'ANALYSIS_REJECTED' : 'ANALYSIS_FAILED',
            message: cause instanceof Error ? cause.message : 'Form analysis failed.',
            recoverable: true,
            suggestedAction:
              'Retry the analysis, or fill the highlighted fields yourself. Nothing was filled from a failed analysis.',
            debugContext: { pageId: request.pageId },
          },
        };
      }

      // Parsing and validation are separate from execution on purpose: a plan
      // that fails either is data that gets discarded, never something acted on.
      const parsed = formFillPlanSchema.safeParse(safeJson(content));
      if (!parsed.success) {
        logger.warn('Batched form analysis returned an unusable plan', {
          pageId: request.pageId,
          issues: parsed.success ? 0 : parsed.error.issues.length,
        });
        return {
          plan: { pageId: request.pageId, answers: [] },
          model,
          durationMs: Date.now() - started,
          rejected: parsed.error.issues
            .slice(0, 20)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          error: {
            code: 'ANALYSIS_REJECTED',
            message: 'The model returned an answer plan that failed validation and was discarded.',
            recoverable: true,
            suggestedAction:
              'Retry, or choose a model that follows JSON instructions. Nothing was filled from the rejected plan.',
            debugContext: { pageId: request.pageId },
          },
        };
      }

      const sanitized = sanitizeFormFillPlan(parsed.data, askedIds, availableDocuments);
      // A plan for a different page is not this page's plan.
      const plan =
        sanitized.plan.pageId === request.pageId
          ? sanitized.plan
          : { pageId: request.pageId, answers: [] };
      const rejected = [
        ...sanitized.rejected,
        ...(sanitized.plan.pageId === request.pageId
          ? []
          : [`Plan was for page "${sanitized.plan.pageId}", not "${request.pageId}".`]),
      ];

      logger.info('Batched form analysis completed', {
        pageId: request.pageId,
        answers: plan.answers.length,
        rejected: rejected.length,
        durationMs: Date.now() - started,
      });

      return { plan, model, durationMs: Date.now() - started, rejected };
    },
  };
}

function safeJson(content: string): unknown {
  try {
    return extractJsonObject(content);
  } catch {
    return null;
  }
}
