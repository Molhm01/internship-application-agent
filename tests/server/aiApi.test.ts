import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, completeProfileBody, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function groundedOllamaFetch(options: { malformed?: boolean; delay?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    if (url.endsWith('/api/version')) {
      return new Response(JSON.stringify({ version: 'test' }), { status: 200 });
    }
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }), {
        status: 200,
      });
    }
    if (!url.endsWith('/api/chat')) return new Response('not found', { status: 404 });
    if (options.delay) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    if (options.malformed) {
      return new Response(
        JSON.stringify({
          model: 'llama3.1:8b',
          message: { role: 'assistant', content: 'not valid json' },
        }),
        { status: 200 },
      );
    }
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(bodyText) as {
      messages: Array<{ content: string }>;
    };
    if (body.messages[0]?.content.includes('Classify an untrusted')) {
      return new Response(
        JSON.stringify({
          model: 'llama3.1:8b',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              classification: 'other_custom',
              confidence: 'medium',
              reason: 'Validated model fallback classification.',
            }),
          },
        }),
        { status: 200 },
      );
    }
    const prompt = body.messages.at(-1)?.content ?? '';
    if (prompt.includes('Return exactly {"status":"ok"}')) {
      return new Response(
        JSON.stringify({
          model: 'llama3.1:8b',
          message: { role: 'assistant', content: JSON.stringify({ status: 'ok' }) },
        }),
        { status: 200 },
      );
    }
    const evidence = JSON.parse(
      /<VERIFIED_EVIDENCE>\n([\s\S]*?)\n<\/VERIFIED_EVIDENCE>/.exec(prompt)?.[1] ?? '[]',
    ) as Array<{ id: string; text: string; facts: string[] }>;
    const selected = evidence[0]!;
    const fact = selected.facts[0] ?? selected.text;
    const answer = `I am interested in this role because my verified background includes ${fact}.`;
    const content = {
      questionId: /"questionId":"([^"]+)"/.exec(prompt)?.[1] ?? 'field-1',
      status: 'generated',
      classification: /Classification: ([a-z_]+)/.exec(prompt)?.[1] ?? 'why_role',
      answer,
      evidenceUsed: [selected.id],
      factualClaims: [{ claim: `My background includes ${fact}.`, evidenceIds: [selected.id] }],
      missingInformation: [],
      warnings: [],
      confidence: 'high',
      wordCount: 0,
      characterCount: 0,
    };
    return new Response(
      JSON.stringify({
        model: 'llama3.1:8b',
        message: { role: 'assistant', content: JSON.stringify(content) },
      }),
      { status: 200 },
    );
  };
}

async function seedProfile(app: FastifyInstance): Promise<void> {
  await app.inject({
    method: 'PUT',
    url: '/profile',
    headers: authHeaders,
    payload: completeProfileBody(),
  });
}

function generationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scanId: 'scan-1',
    planId: 'plan-1',
    fieldId: 'field-1',
    question: 'Why are you interested in this role?',
    classification: 'why_role',
    constraints: { maxWords: 100, maxCharacters: 500 },
    jobContext: {
      company: 'Fixture Labs',
      jobTitle: 'Embedded Software Intern',
      responsibilities: ['Build reliable embedded tools'],
      qualifications: ['C', 'Verilog'],
    },
    aiGenerationEnabled: true,
    settings: {
      generationModel: 'llama3.1:8b',
      temperature: 0.2,
      maximumGenerationTokens: 512,
      defaultAnswerLength: 'short',
      generationTimeoutMs: 5000,
      maximumRetries: 1,
      maximumConcurrentGenerations: 1,
      regenerateBehavior: 'keep_previous',
      preferredTone: 'natural and professional',
    },
    ...overrides,
  };
}

describe('Milestone 4 AI API', () => {
  it('generates, grounds, validates, persists, and never pre-approves an answer', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch() });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody(),
    });
    expect(response.statusCode).toBe(200);
    const record = response.json().data.record;
    expect(record.state).toBe('ready_for_review');
    expect(record.validation.valid).toBe(true);
    expect(record.approved).toBe(false);
    expect(record.candidate.answer).toContain('interested in this role');
    expect(record.candidate.answer.length).toBeGreaterThan(0);
    expect(record.model).toBe('llama3.1:8b');
    expect(record.generationDurationMs).toBeGreaterThanOrEqual(0);

    const stored = await server.app.inject({
      method: 'GET',
      url: `/ai/generations/${record.id}`,
      headers: authHeaders,
    });
    expect(stored.json().data.record.id).toBe(record.id);
  });

  it('tests private-data-free structured generation with the selected model', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch() });
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/test-generation',
      headers: authHeaders,
      payload: { model: 'llama3.1:8b', timeoutMs: 5000 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      connected: true,
      model: 'llama3.1:8b',
      structuredOutputValid: true,
    });
    expect(response.json().data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns AI_SETTINGS_INVALID without calling Ollama when enablement is missing', async () => {
    let chatCalls = 0;
    const fetchImpl = groundedOllamaFetch();
    server = await createTestServer({
      fetchImpl: async (input, init) => {
        if (urlOf(input).endsWith('/api/chat')) chatCalls += 1;
        return fetchImpl(input, init);
      },
    });
    await seedProfile(server.app);
    const body = generationBody();
    delete body.aiGenerationEnabled;
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: body,
    });
    expect(response.json().data.record).toMatchObject({
      state: 'failed',
      error: { code: 'AI_SETTINGS_INVALID' },
    });
    expect(chatCalls).toBe(0);
  });

  it('returns AI_DISABLED only for explicit false without calling Ollama', async () => {
    let chatCalls = 0;
    const fetchImpl = groundedOllamaFetch();
    server = await createTestServer({
      fetchImpl: async (input, init) => {
        if (urlOf(input).endsWith('/api/chat')) chatCalls += 1;
        return fetchImpl(input, init);
      },
    });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody({ aiGenerationEnabled: false }),
    });
    expect(response.json().data.record).toMatchObject({
      state: 'failed',
      error: { code: 'AI_DISABLED' },
    });
    expect(chatCalls).toBe(0);
  });

  it('persists MODEL_NOT_FOUND with the configured and available models', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch() });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody({
        settings: {
          ...(generationBody().settings as Record<string, unknown>),
          generationModel: 'missing-model',
        },
      }),
    });
    const record = response.json().data.record;
    expect(record.state).toBe('failed');
    expect(record.error).toMatchObject({
      code: 'MODEL_NOT_FOUND',
      debugContext: {
        configuredModel: 'missing-model',
        availableModels: ['llama3.1:8b'],
      },
    });
  });

  it('persists OLLAMA_UNAVAILABLE when installed models cannot be queried', async () => {
    const available = groundedOllamaFetch();
    server = await createTestServer({
      fetchImpl: async (input, init) => {
        if (urlOf(input).endsWith('/api/tags')) throw new TypeError('connection refused');
        return available(input, init);
      },
    });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody(),
    });
    expect(response.json().data.record).toMatchObject({
      state: 'failed',
      error: { code: 'OLLAMA_UNAVAILABLE' },
    });
  });

  it('persists GENERATION_TIMEOUT when Ollama exceeds the configured bound', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch({ delay: true }) });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody({
        settings: {
          ...(generationBody().settings as Record<string, unknown>),
          generationTimeoutMs: 5000,
          maximumRetries: 0,
        },
      }),
    });
    expect(response.json().data.record).toMatchObject({
      state: 'failed',
      error: { code: 'GENERATION_TIMEOUT' },
    });
  }, 10_000);

  it('uses validated Ollama classification only when deterministic rules are uncertain', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch() });
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/classify-question',
      headers: authHeaders,
      payload: { questionId: 'field-other', question: 'Share a perspective you value.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      classification: 'other_custom',
      deterministic: false,
    });
  });

  it('returns needs_user_input before calling the model when story evidence is missing', async () => {
    let chatCalls = 0;
    const fetchImpl = groundedOllamaFetch();
    server = await createTestServer({
      fetchImpl: async (input, init) => {
        if (urlOf(input).endsWith('/api/chat')) chatCalls += 1;
        return fetchImpl(input, init);
      },
    });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody({
        question: 'Describe a time you resolved a conflict.',
        classification: 'conflict',
      }),
    });
    expect(response.json().data.record.state).toBe('needs_user_input');
    expect(response.json().data.record.error.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(chatCalls).toBe(0);
  });

  it('rejects prohibited questions without calling Ollama', async () => {
    let chatCalls = 0;
    const fetchImpl = groundedOllamaFetch();
    server = await createTestServer({
      fetchImpl: async (input, init) => {
        if (urlOf(input).endsWith('/api/chat')) chatCalls += 1;
        return fetchImpl(input, init);
      },
    });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody({
        question: 'Describe your disability.',
        classification: 'prohibited_sensitive',
      }),
    });
    expect(response.json().data.record.state).toBe('prohibited');
    expect(chatCalls).toBe(0);
  });

  it('fails safely after one malformed-output retry', async () => {
    server = await createTestServer({ fetchImpl: groundedOllamaFetch({ malformed: true }) });
    await seedProfile(server.app);
    const response = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: generationBody(),
    });
    expect(response.json().data.record.state).toBe('failed');
    expect(response.json().data.record.error.code).toBe('OUTPUT_SCHEMA_INVALID');
  });

  it('extracts TXT resume sections locally and preserves the stored document', async () => {
    server = await createTestServer();
    const content = Buffer.from(
      'SUMMARY\nComputer engineering student\n\nPROJECTS\nSensor Monitor built with TypeScript',
    );
    const uploaded = await server.app.inject({
      method: 'POST',
      url: '/documents',
      headers: authHeaders,
      payload: {
        name: 'Text Resume',
        type: 'resume',
        fileName: 'resume.txt',
        mimeType: 'text/plain',
        contentBase64: content.toString('base64'),
        tags: [],
        targetRoles: [],
        targetIndustries: [],
        isDefault: true,
      },
    });
    const documentId = uploaded.json().data.id;
    const extracted = await server.app.inject({
      method: 'POST',
      url: `/documents/${documentId}/extract`,
      headers: authHeaders,
      payload: {},
    });
    expect(extracted.json().data.status).toBe('completed');
    expect(extracted.json().data.sections.map((section: { name: string }) => section.name)).toEqual(
      expect.arrayContaining(['summary', 'projects']),
    );
    const listed = await server.app.inject({
      method: 'GET',
      url: '/documents',
      headers: authHeaders,
    });
    expect(listed.json().data.documents[0].id).toBe(documentId);
  });

  it('requires authentication and validates generation request sizes and shapes', async () => {
    server = await createTestServer();
    const unauthorized = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      payload: generationBody(),
    });
    expect(unauthorized.statusCode).toBe(401);
    const invalid = await server.app.inject({
      method: 'POST',
      url: '/ai/generate-answer',
      headers: authHeaders,
      payload: { question: 'missing ids and settings' },
    });
    expect(invalid.statusCode).toBe(422);
  });
});
