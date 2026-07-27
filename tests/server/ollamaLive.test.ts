import { describe, expect, it } from 'vitest';
import {
  aiGenerationSettingsSchema,
  answerContextBundleSchema,
  containsUnexpectedModelInstructions,
} from '@internship-agent/shared';
import { createLogger } from '../../agent-server/src/logging/logger.js';
import { createOllamaClient } from '../../agent-server/src/ollama/client.js';
import { buildAnswerPrompt } from '../../agent-server/src/ai/prompt.js';
import { parseStructuredCandidate } from '../../agent-server/src/ai/parser.js';
import { validateGeneratedAnswer } from '../../agent-server/src/ai/validator.js';

const live = process.env.RUN_LIVE_OLLAMA === '1';

describe.skipIf(!live)('live Ollama grounded generation', () => {
  it('selects an installed model and returns a grounded achievement candidate', async (testContext) => {
    const preferredModel = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
    const client = createOllamaClient({
      baseUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
      defaultModel: preferredModel,
      logger: createLogger({ level: 'error', console: false }),
    });
    const status = await client.checkStatus();
    expect(status.state).toBe('connected');
    const available = await client.listModels();
    if (available.models.length === 0) {
      testContext.skip();
      return;
    }
    const model =
      available.models.find((candidate) => candidate.name === preferredModel)?.name ??
      available.models[0]!.name;
    aiGenerationSettingsSchema.parse({ generationModel: model });
    const context = answerContextBundleSchema.parse({
      question:
        'Tell me 2 or 3 personal engineering achievements that you are most proud of and why?',
      classification: 'achievement',
      constraints: {
        maxWords: 180,
        maxCharacters: 1200,
        requestedExamples: { minimum: 2, maximum: 3 },
      },
      jobContext: {
        company: 'Fixture Labs',
        jobTitle: 'Software Engineering Intern',
        responsibilities: ['Build and test TypeScript tools'],
      },
      evidence: [
        {
          id: 'ev-project',
          source: 'profile',
          sourceReference: 'profile.projects.synthetic',
          category: 'project',
          text: 'Built and tested a TypeScript workflow application.',
          facts: ['Built a TypeScript workflow application', 'Added automated tests'],
          relevanceScore: 100,
          sensitive: false,
          verified: true,
        },
        {
          id: 'ev-experience',
          source: 'profile',
          sourceReference: 'profile.experience.synthetic',
          category: 'experience',
          text: 'Improved an automated engineering workflow while collaborating with a team.',
          facts: [
            'Improved automated workflow reliability',
            'Collaborated with a team on engineering tools',
          ],
          relevanceScore: 95,
          sensitive: false,
          verified: true,
        },
      ],
      approvedAnswerExamples: [],
      stylePreferences: {
        tone: 'natural and professional',
        verbosity: 'short',
        useStarWhenAppropriate: true,
        avoidCliches: true,
      },
      promptInjectionWarnings: [],
    });
    const prompt = buildAnswerPrompt(context, 'field-live', 'default');
    const result = await client.generateStructured({
      model,
      system: prompt.system,
      prompt: prompt.user,
      temperature: 0,
      maximumTokens: 400,
      timeoutMs: 90_000,
    });
    const candidate = parseStructuredCandidate(result.content).candidate;
    expect(candidate.evidenceUsed).toContain('ev-project');
    expect(candidate.answer?.trim().length).toBeGreaterThan(0);
    expect(candidate.wordCount).toBeGreaterThan(0);
    expect(candidate.characterCount).toBeGreaterThan(0);
    expect(candidate.wordCount).toBeLessThanOrEqual(180);
    expect(result.model).toBe(model);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(containsUnexpectedModelInstructions(candidate.answer ?? '')).toBe(false);
    expect(validateGeneratedAnswer(candidate, context).valid).toBe(true);
  }, 120_000);
});
