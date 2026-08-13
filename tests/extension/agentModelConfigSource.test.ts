import { describe, expect, it } from 'vitest';
import { matchesModelName, modelInstalled, type HealthResponse } from '@internship-agent/shared';
import {
  canAnalyze,
  interpretHealth,
} from '../../extension/src/background/agentAvailability.js';

/**
 * One model configuration source, and it is the one the request uses.
 *
 * The live run reported `Configured model "qwen3.5:9b" is not installed`
 * repeatedly while the extension's AI Answers model was set to something else
 * entirely. Two settings were in play: the *server's* `OLLAMA_MODEL` (falling
 * back to `DEFAULT_OLLAMA_MODEL`), which is what `/health` reports as
 * `selectedModel`, and the extension's saved `ai.generationModel`, which is what
 * every request actually sends. Availability was decided from the first and the
 * call was made with the second, so the agent refused to analyze a page over a
 * model it was never going to ask for.
 */

function health(ollama: Partial<HealthResponse['ollama']>): { health: HealthResponse } {
  return {
    health: {
      status: 'ok',
      version: '1.0.0',
      uptimeSeconds: 10,
      ollama: {
        state: 'connected',
        baseUrl: 'http://127.0.0.1:11434',
        checkedAt: '2026-08-13T00:00:00.000Z',
        ...ollama,
      },
      database: { state: 'ready', path: 'test.db', schemaVersion: 1 },
      checkedAt: '2026-08-13T00:00:00.000Z',
    } as HealthResponse,
  };
}

const clock = (): number => 0;

describe('the model gate reads the model the request will send', () => {
  it('stays connected when the server default is missing but the configured model is installed', () => {
    const availability = interpretHealth(
      health({
        // The server's own default, which nothing sends.
        selectedModel: 'qwen3.5:9b',
        selectedModelInstalled: false,
        installedModels: ['qwen3-coder:30b', 'llama3.1:8b'],
      }),
      clock,
      'qwen3-coder:30b',
    );
    expect(availability.state).toBe('connected');
    expect(canAnalyze(availability)).toBe(true);
  });

  it('reports the configured model by name when it is genuinely absent', () => {
    const availability = interpretHealth(
      health({
        selectedModel: 'qwen3.5:9b',
        selectedModelInstalled: true,
        installedModels: ['llama3.1:8b'],
      }),
      clock,
      'qwen3-coder:30b',
    );
    expect(availability.state).toBe('model_unavailable');
    expect(availability.state === 'model_unavailable' && availability.error.code).toBe(
      'MODEL_NOT_FOUND',
    );
    // Names the model that was actually wanted, not the server's default.
    expect(availability.state === 'model_unavailable' && availability.error.message).toContain(
      'qwen3-coder:30b',
    );
    expect(availability.state === 'model_unavailable' && availability.error.message).not.toContain(
      'qwen3.5:9b',
    );
  });

  it('never blocks on the stale server default once a model is configured', () => {
    const availability = interpretHealth(
      health({
        selectedModel: 'qwen3.5:9b',
        selectedModelInstalled: false,
        installedModels: ['qwen3-coder:30b'],
      }),
      clock,
      'qwen3-coder',
    );
    // An untagged name resolves to any tag of it, exactly as Ollama resolves it.
    expect(availability.state).toBe('connected');
  });

  it('falls back to the server default only when nothing is configured', () => {
    const availability = interpretHealth(
      health({ selectedModel: 'qwen3.5:9b', selectedModelInstalled: false }),
      clock,
    );
    expect(availability.state).toBe('model_unavailable');
  });

  it('does not invent a verdict from a server that cannot list its models', () => {
    // An older server reports no inventory. Its answer is about a different
    // model, so it is not evidence about this one — the run proceeds and a
    // genuinely absent model surfaces from the request itself.
    const availability = interpretHealth(
      health({ selectedModel: 'qwen3.5:9b', selectedModelInstalled: false }),
      clock,
      'qwen3-coder:30b',
    );
    expect(availability.state).toBe('connected');
  });
});

describe('one shared rule for whether a model is installed', () => {
  it('matches an exact tag and any tag of a bare name', () => {
    expect(matchesModelName('qwen3-coder:30b', 'qwen3-coder:30b')).toBe(true);
    expect(matchesModelName('qwen3-coder:30b', 'qwen3-coder')).toBe(true);
    expect(matchesModelName('QWEN3-CODER:30B', ' qwen3-coder ')).toBe(true);
  });

  it('refuses a different tag of the same family, and a different family', () => {
    expect(matchesModelName('qwen3-coder:30b', 'qwen3-coder:7b')).toBe(false);
    expect(matchesModelName('llama3.1:8b', 'qwen3-coder:30b')).toBe(false);
  });

  it('treats an empty configured model as never installed', () => {
    expect(modelInstalled(['qwen3-coder:30b'], '   ')).toBe(false);
  });
});
