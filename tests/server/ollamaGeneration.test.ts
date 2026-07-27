import { describe, expect, it, vi } from 'vitest';
import { createOllamaClient, OllamaGenerationError } from '../../agent-server/src/ollama/client.js';
import { silentLogger } from './helpers.js';

function fetchWithChat(
  chat: (init?: RequestInit) => Promise<Response>,
  models = ['test-model'],
): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(
        new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/version')) {
      return Promise.resolve(new Response(JSON.stringify({ version: 'test' }), { status: 200 }));
    }
    return chat(init);
  };
}

function client(fetchImpl: typeof fetch) {
  return createOllamaClient({
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'test-model',
    logger: silentLogger,
    fetchImpl,
  });
}

const request = {
  model: 'test-model',
  system: 'Return JSON.',
  prompt: 'Synthetic prompt.',
  temperature: 0,
  maximumTokens: 100,
  timeoutMs: 1000,
};

describe('Ollama structured generation controls', () => {
  it('rejects an empty configured model before contacting Ollama', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      client(fetchImpl).generateStructured({ ...request, model: '   ' }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a trimmed base model name to the actual installed tag', async () => {
    let postedModel = '';
    const fetchImpl = fetchWithChat(
      (init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
        postedModel = (JSON.parse(init.body) as { model: string }).model;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'Test-Model:latest',
              message: { role: 'assistant', content: '{"status":"ok"}' },
            }),
            { status: 200 },
          ),
        );
      },
      ['Test-Model:latest'],
    );
    const result = await client(fetchImpl).generateStructured({
      ...request,
      model: '  test-model  ',
    });
    expect(postedModel).toBe('Test-Model:latest');
    expect(result.model).toBe('Test-Model:latest');
  });

  it('rejects a model that is not installed before generation', async () => {
    const pending = expect(
      client(
        fetchWithChat(() => Promise.resolve(new Response('{}')), ['other-model']),
      ).generateStructured(request),
    ).rejects;
    await pending.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      debugContext: {
        configuredModel: 'test-model',
        availableModels: ['other-model'],
      },
    });
  });

  it('distinguishes an unavailable Ollama server from a missing model', async () => {
    await expect(
      client(vi.fn().mockRejectedValue(new TypeError('connection refused'))).generateStructured(
        request,
      ),
    ).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
  });

  it('terminates on timeout', async () => {
    const hanging = fetchWithChat(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await expect(
      client(hanging).generateStructured({ ...request, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'GENERATION_TIMEOUT' });
  });

  it('terminates on explicit cancellation', async () => {
    const hanging = fetchWithChat(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const pending = client(hanging).generateStructured({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OllamaGenerationError);
    await expect(pending).rejects.toMatchObject({ code: 'GENERATION_CANCELLED' });
  });

  it('rejects malformed Ollama envelopes', async () => {
    const malformed = fetchWithChat(() =>
      Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );
    await expect(client(malformed).generateStructured(request)).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    });
  });

  it('rejects an empty model response', async () => {
    const empty = fetchWithChat(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'test-model',
            message: { role: 'assistant', content: '   ' },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(client(empty).generateStructured(request)).rejects.toMatchObject({
      code: 'INVALID_MODEL_OUTPUT',
    });
  });
});
