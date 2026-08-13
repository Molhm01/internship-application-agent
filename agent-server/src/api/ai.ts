import type { FastifyInstance } from 'fastify';
import {
  classifyQuestionRequestSchema,
  classifyQuestionResponseSchema,
  documentExtractionSchema,
  generateAnswerRequestSchema,
  generateAnswerResponseSchema,
  aiGenerationTestRequestSchema,
  aiGenerationTestResponseSchema,
  generateBatchRequestSchema,
  generateBatchResponseSchema,
  generationCancelRequestSchema,
  generationCancelResponseSchema,
  formAnalysisRequestSchema,
  formAnalysisResponseSchema,
  agentChoiceDecisionSchema,
  agentChoiceRequestSchema,
} from '@internship-agent/shared';
import { z } from 'zod';
import { OllamaGenerationError } from '../ollama/client.js';
import type { ServerContext } from '../types/context.js';
import { fail, sendValidated } from './responses.js';
import { parseBody } from '../validation/request.js';

export function registerAiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/ai/choose-agent-option', async (request, reply) => {
    const parsed = parseBody(agentChoiceRequestSchema, request.body);
    if (!parsed.ok) return reply.status(422).send({ ok: false, error: parsed.error });
    try {
      const response = await ctx.ollama.generateStructured({
        model: ctx.ollama.defaultModel,
        system: [
          'You choose answers for job-application multiple-choice controls.',
          'Use only the trusted candidate context and the actual webpage choices.',
          'Never invent personal facts. If the context does not answer the question, return ASK_USER.',
          'For SELECT, copy exactly one optionId from the supplied choices, or optionIds for a checkbox group. Return JSON only.',
        ].join(' '),
        prompt: JSON.stringify(parsed.data),
        temperature: 0,
        maximumTokens: 300,
        timeoutMs: 30_000,
      });
      const start = response.content.indexOf('{');
      const end = response.content.lastIndexOf('}');
      const raw: unknown = JSON.parse(
        start >= 0 && end > start ? response.content.slice(start, end + 1) : response.content,
      );
      const decision = agentChoiceDecisionSchema.parse(raw);
      const selectedIds = decision.optionIds ?? (decision.optionId ? [decision.optionId] : []);
      if (
        decision.decision === 'SELECT' &&
        selectedIds.some(
          (optionId) => !parsed.data.choices.some((choice) => choice.optionId === optionId),
        )
      ) {
        return fail(reply, {
          code: 'INVALID_OPTION_ID',
          message: 'The model named an optionId outside the choices it received.',
        });
      }
      return sendValidated(reply, agentChoiceDecisionSchema, decision);
    } catch (cause) {
      return fail(reply, {
        code: 'INVALID_MODEL_OUTPUT',
        message: cause instanceof Error ? cause.message : 'The option decision was invalid.',
      });
    }
  });
  app.post('/ai/test-generation', async (request, reply) => {
    const parsed = parseBody(aiGenerationTestRequestSchema, request.body);
    if ('error' in parsed) return fail(reply, parsed.error);
    ctx.logger.info('AI generation connectivity test started', {
      model: parsed.data.model,
      timeoutMs: parsed.data.timeoutMs,
    });
    try {
      const result = await ctx.ollama.generateStructured({
        model: parsed.data.model,
        system:
          'Return one small JSON object for a local connectivity test. Do not include prose or markdown.',
        prompt: 'Return exactly {"status":"ok"}.',
        temperature: 0,
        maximumTokens: 64,
        timeoutMs: parsed.data.timeoutMs,
      });
      const unfenced = result.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const start = unfenced.indexOf('{');
      const end = unfenced.lastIndexOf('}');
      const value = JSON.parse(
        start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced,
      ) as unknown;
      z.object({ status: z.literal('ok') }).parse(value);
      ctx.logger.info('AI generation connectivity test completed', {
        model: result.model,
        durationMs: result.durationMs,
      });
      return sendValidated(reply, aiGenerationTestResponseSchema, {
        connected: true,
        model: result.model,
        durationMs: result.durationMs,
        structuredOutputValid: true,
      });
    } catch (cause) {
      ctx.logger.warn('AI generation connectivity test failed', {
        model: parsed.data.model,
        code: cause instanceof OllamaGenerationError ? cause.code : 'OUTPUT_SCHEMA_INVALID',
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return fail(reply, {
        code: cause instanceof OllamaGenerationError ? cause.code : 'OUTPUT_SCHEMA_INVALID',
        message: cause instanceof Error ? cause.message : 'AI generation test failed.',
        debugContext: cause instanceof OllamaGenerationError ? cause.debugContext : {},
      });
    }
  });
  /**
   * Batched page-level analysis. One request per page — the extension has
   * already resolved everything it could deterministically, and sends only the
   * remainder together with the facts those questions could need.
   */
  app.post('/ai/analyze-form', async (request, reply) => {
    const parsed = parseBody(formAnalysisRequestSchema, request.body);
    if ('error' in parsed) return fail(reply, parsed.error);
    const result = await ctx.formAnalysis.analyze(parsed.data);
    return sendValidated(reply, formAnalysisResponseSchema, result);
  });

  app.post('/ai/classify-question', async (request, reply) => {
    const parsed = parseBody(classifyQuestionRequestSchema, request.body);
    if (!parsed.ok) return reply.status(422).send({ ok: false, error: parsed.error });
    const settings = {
      generationModel: ctx.ollama.defaultModel,
      temperature: 0,
      maximumGenerationTokens: 160,
      defaultAnswerLength: 'medium' as const,
      generationTimeoutMs: 30_000,
      maximumRetries: 0,
      maximumConcurrentGenerations: 1,
      regenerateBehavior: 'keep_previous' as const,
      preferredTone: 'natural and professional',
    };
    try {
      return sendValidated(
        reply,
        classifyQuestionResponseSchema,
        await ctx.aiAnswers.classify(parsed.data.question, settings),
      );
    } catch (cause) {
      return fail(reply, {
        code: 'INVALID_MODEL_OUTPUT',
        message: `Question classification failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        fieldId: parsed.data.questionId,
      });
    }
  });

  app.post('/ai/generate-answer', async (request, reply) => {
    const parsed = parseBody(generateAnswerRequestSchema, request.body);
    if (!parsed.ok) return reply.status(422).send({ ok: false, error: parsed.error });
    const record = await ctx.aiAnswers.generate(parsed.data);
    return sendValidated(reply, generateAnswerResponseSchema, { record });
  });

  app.post('/ai/generate-batch', async (request, reply) => {
    const parsed = parseBody(generateBatchRequestSchema, request.body);
    if (!parsed.ok) return reply.status(422).send({ ok: false, error: parsed.error });
    const records = await ctx.aiAnswers.generateBatch(parsed.data.requests);
    return sendValidated(reply, generateBatchResponseSchema, { records });
  });

  app.post('/ai/cancel-generation', (request, reply) => {
    const parsed = parseBody(generationCancelRequestSchema, request.body);
    if (!parsed.ok) return reply.status(422).send({ ok: false, error: parsed.error });
    const cancelled = ctx.aiAnswers.cancel(parsed.data.generationId);
    return sendValidated(reply, generationCancelResponseSchema, {
      cancelled,
      ...(parsed.data.generationId ? { generationId: parsed.data.generationId } : {}),
    });
  });

  app.get<{ Params: { id: string } }>('/ai/generations/:id', (request, reply) => {
    const record = ctx.generations.find(request.params.id);
    if (!record) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: `No answer generation with id ${request.params.id} exists.`,
      });
    }
    return sendValidated(reply, generateAnswerResponseSchema, { record });
  });

  app.post<{ Params: { id: string } }>('/documents/:id/extract', async (request, reply) => {
    const document = ctx.documents.find(request.params.id);
    if (!document) {
      return fail(reply, {
        code: 'DOCUMENT_MISSING',
        message: `No document with id ${request.params.id} is registered.`,
      });
    }
    const extraction = await ctx.resumeExtractor.extract(document);
    return sendValidated(reply, documentExtractionSchema, extraction);
  });

  app.get<{ Params: { id: string } }>('/documents/:id/extraction', (request, reply) => {
    const extraction = ctx.extractions.find(request.params.id);
    if (!extraction) {
      return fail(reply, {
        code: 'NOT_FOUND',
        message: `No extraction exists for document ${request.params.id}.`,
      });
    }
    return sendValidated(reply, documentExtractionSchema, extraction);
  });
}
