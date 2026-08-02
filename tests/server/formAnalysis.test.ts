import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_HEADER, formAnalysisResponseSchema } from '@internship-agent/shared';
import { createTestServer, TEST_TOKEN, type TestServer } from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/**
 * A fake Ollama that records every generation call, so a test can assert the
 * number of model requests as well as their content.
 */
function ollamaReturning(content: string | (() => string)) {
  const calls: Array<{ body: unknown }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch returns a promise.
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/version')) {
      return new Response(JSON.stringify({ version: '0.5.0' }), { status: 200 });
    }
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }), { status: 200 });
    }
    if (url.endsWith('/api/chat')) {
      const body = typeof init?.body === 'string' ? init.body : '{}';
      calls.push({ body: JSON.parse(body) as unknown });
      return new Response(
        JSON.stringify({
          model: 'llama3.1:8b',
          message: { role: 'assistant', content: typeof content === 'function' ? content() : content },
          done: true,
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    questionId: 'question-a',
    fieldIds: ['field-a'],
    questionText: 'Do you currently have permission to work in the country of employment?',
    contextualText: '',
    controlType: 'radio_group',
    required: true,
    options: [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
    likelyIntent: 'work_authorization',
    ...overrides,
  };
}

function analyzeBody(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 'scan-1',
    questions: [question()],
    facts: [{ id: 'fact-1', label: 'work authorization', value: 'Authorized without sponsorship' }],
    approvedAnswers: [],
    jobContext: { company: 'Northwind' },
    documents: [],
    timeoutMs: 5000,
    ...overrides,
  };
}

async function analyze(body: Record<string, unknown>) {
  return server!.app.inject({
    method: 'POST',
    url: '/ai/analyze-form',
    headers: { [AUTH_HEADER]: TEST_TOKEN },
    payload: body,
  });
}

describe('POST /ai/analyze-form', () => {
  it('answers a whole page with exactly one model call', async () => {
    const ollama = ollamaReturning(
      JSON.stringify({
        pageId: 'scan-1',
        answers: [
          {
            questionId: 'question-a',
            action: 'SELECT_RADIO',
            selectedOption: 'Yes',
            confidence: 0.9,
            sourceFactIds: ['fact-1'],
            requiresReview: false,
            reason: 'Saved work authorization.',
          },
          {
            questionId: 'question-b',
            action: 'SET_TEXT',
            value: 'LinkedIn',
            confidence: 0.7,
            sourceFactIds: [],
            requiresReview: true,
            reason: 'Saved discovery source.',
          },
        ],
      }),
    );
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });

    const response = await analyze(
      analyzeBody({
        questions: [
          question(),
          question({
            questionId: 'question-b',
            fieldIds: ['field-b'],
            questionText: 'How did you come across this opening?',
            controlType: 'text',
            options: undefined,
            likelyIntent: 'how_did_you_hear',
          }),
        ],
      }),
    );

    expect(response.statusCode).toBe(200);
    const parsed = formAnalysisResponseSchema.parse(
      (response.json()).data,
    );
    expect(parsed.plan.answers).toHaveLength(2);
    // Two questions, one request. This is the property the whole design exists for.
    expect(ollama.calls).toHaveLength(1);
  });

  it('sends no selector, DOM path, or document bytes to the model', async () => {
    const ollama = ollamaReturning(JSON.stringify({ pageId: 'scan-1', answers: [] }));
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    await analyze(
      analyzeBody({
        documents: [{ kind: 'resume', filename: 'Resume.pdf', mimeType: 'application/pdf' }],
      }),
    );
    const prompt = JSON.stringify(ollama.calls[0]!.body);
    expect(prompt).not.toContain('selector');
    expect(prompt).not.toContain('contentBase64');
    expect(prompt).not.toMatch(/#field-|querySelector/);
    // Metadata about the document is fine; the bytes are not.
    expect(prompt).toContain('resume');
  });

  it('discards an answer for a question it was not asked about', async () => {
    const ollama = ollamaReturning(
      JSON.stringify({
        pageId: 'scan-1',
        answers: [
          {
            questionId: 'question-invented',
            action: 'SET_TEXT',
            value: 'x',
            confidence: 1,
            sourceFactIds: [],
            requiresReview: false,
            reason: '',
          },
        ],
      }),
    );
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    const parsed = formAnalysisResponseSchema.parse(
      ((await analyze(analyzeBody())).json()).data,
    );
    expect(parsed.plan.answers).toEqual([]);
    expect(parsed.rejected[0]).toContain('question-invented');
  });

  it('rejects a malformed plan rather than acting on part of it', async () => {
    const ollama = ollamaReturning('I think the answer is probably yes!');
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    const parsed = formAnalysisResponseSchema.parse(
      ((await analyze(analyzeBody())).json()).data,
    );
    expect(parsed.plan.answers).toEqual([]);
    expect(parsed.error?.code).toBe('ANALYSIS_REJECTED');
    expect(parsed.error?.recoverable).toBe(true);
    expect(parsed.error?.suggestedAction).toContain('Nothing was filled');
  });

  it('discards a plan that names a different page', async () => {
    const ollama = ollamaReturning(
      JSON.stringify({
        pageId: 'some-other-page',
        answers: [
          {
            questionId: 'question-a',
            action: 'SELECT_RADIO',
            selectedOption: 'Yes',
            confidence: 1,
            sourceFactIds: [],
            requiresReview: false,
            reason: '',
          },
        ],
      }),
    );
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    const parsed = formAnalysisResponseSchema.parse(
      ((await analyze(analyzeBody())).json()).data,
    );
    expect(parsed.plan.answers).toEqual([]);
    expect(parsed.rejected.some((entry) => entry.includes('some-other-page'))).toBe(true);
  });

  it('strips any key that could express a DOM operation', async () => {
    const ollama = ollamaReturning(
      JSON.stringify({
        pageId: 'scan-1',
        answers: [
          {
            questionId: 'question-a',
            action: 'SELECT_RADIO',
            selectedOption: 'Yes',
            confidence: 1,
            sourceFactIds: [],
            requiresReview: false,
            reason: '',
            selector: '#submit',
            script: 'document.forms[0].submit()',
          },
        ],
      }),
    );
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    const parsed = formAnalysisResponseSchema.parse(
      ((await analyze(analyzeBody())).json()).data,
    );
    expect(parsed.plan.answers).toHaveLength(1);
    expect(JSON.stringify(parsed.plan.answers[0])).not.toContain('submit');
  });

  it('rejects a request with no questions rather than calling the model', async () => {
    const ollama = ollamaReturning(JSON.stringify({ pageId: 'scan-1', answers: [] }));
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    const response = await analyze(analyzeBody({ questions: [] }));
    expect(response.statusCode).toBe(422);
    expect(ollama.calls).toHaveLength(0);
  });

  it('instructs the model never to invent unsupported facts or answer sensitive questions', async () => {
    const ollama = ollamaReturning(JSON.stringify({ pageId: 'scan-1', answers: [] }));
    server = await createTestServer({ fetchImpl: ollama.fetchImpl });
    await analyze(analyzeBody());
    const body = ollama.calls[0]!.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('Never invent');
    expect(system).toContain('REQUIRE_USER_REVIEW unless a FACT explicitly states');
    expect(system).toContain('Never propose submitting');
  });
});
