import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_HEADER } from '@internship-agent/shared';
import { fetchAgentStatus, listOllamaModels } from '../../extension/src/background/agentClient.js';
import { loadSettings, saveSettings } from '../../extension/src/storage/settings.js';
import { installChromeMock } from './setup.js';

const HEALTH_PAYLOAD = {
  ok: true,
  data: {
    status: 'ok',
    service: 'internship-application-agent',
    version: '0.1.0',
    uptimeSeconds: 4,
    checkedAt: '2026-07-26T12:00:00.000Z',
    ollama: {
      state: 'connected',
      baseUrl: 'http://127.0.0.1:11434',
      version: '0.5.4',
      modelCount: 1,
      selectedModel: 'llama3.1:8b',
      selectedModelInstalled: true,
      checkedAt: '2026-07-26T12:00:00.000Z',
    },
    database: { state: 'ready', path: 'local-data/agent.db', schemaVersion: 1 },
    profileLoaded: false,
    authenticated: false,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extension settings storage', () => {
  it('falls back to documented defaults when nothing is stored', async () => {
    installChromeMock();
    const settings = await loadSettings();
    expect(settings.serverUrl).toBe('http://127.0.0.1:4317');
    expect(settings.authToken).toBe('');
    expect(settings.selectedDocumentId).toBeNull();
  });

  it('round-trips a saved token', async () => {
    installChromeMock();
    await saveSettings({ authToken: 'abc123' });
    expect((await loadSettings()).authToken).toBe('abc123');
  });

  it('persists canonical AI enablement and preserves it through partial updates', async () => {
    const chromeMock = installChromeMock();
    const enabled = await saveSettings({ aiGenerationEnabled: true });
    expect(enabled.aiGenerationEnabled).toBe(true);

    await saveSettings({ authToken: 'updated-token' });
    const reloaded = await loadSettings();
    expect(reloaded.aiGenerationEnabled).toBe(true);
    expect(reloaded.authToken).toBe('updated-token');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SETTINGS_UPDATED',
        aiGenerationEnabled: true,
      }),
    );
  });

  it.each(['localAiEnabled', 'aiEnabled', 'enableAi', 'enableAI'] as const)(
    'migrates legacy %s=true and persists only the canonical enablement key',
    async (legacyKey) => {
      const chromeMock = installChromeMock();
      chromeMock.storage.local.get.mockResolvedValue({
        settings: {
          serverUrl: 'http://127.0.0.1:4317',
          authToken: '',
          selectedModel: 'qwen3.5:9b',
          selectedDocumentId: null,
          [legacyKey]: true,
          ai: { generationModel: 'qwen3.5:9b' },
        },
      });

      const migrated = await loadSettings();
      expect(migrated.aiGenerationEnabled).toBe(true);
      expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
        settings: expect.objectContaining({ aiGenerationEnabled: true }),
      });
      const persisted = chromeMock.storage.local.set.mock.calls.at(-1)?.[0] as {
        settings: Record<string, unknown>;
      };
      expect(persisted.settings).not.toHaveProperty(legacyKey);
    },
  );

  it('migrates the repository legacy ai.enabled flag without losing true', async () => {
    const chromeMock = installChromeMock();
    chromeMock.storage.local.get.mockResolvedValue({
      settings: {
        selectedModel: 'qwen3.5:9b',
        ai: { enabled: true, generationModel: 'qwen3.5:9b' },
      },
    });
    expect((await loadSettings()).aiGenerationEnabled).toBe(true);
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        aiGenerationEnabled: true,
        ai: expect.not.objectContaining({ enabled: expect.anything() }),
      }),
    });
  });

  it('preserves the selected generation model across settings reloads', async () => {
    installChromeMock();
    await saveSettings({
      selectedModel: 'installed-model:latest',
      ai: { ...(await loadSettings()).ai, generationModel: 'installed-model:latest' },
    });
    const reloaded = await loadSettings();
    expect(reloaded.selectedModel).toBe('installed-model:latest');
    expect(reloaded.ai.generationModel).toBe('installed-model:latest');
  });

  it('ignores malformed stored values instead of trusting them', async () => {
    const chromeMock = installChromeMock();
    chromeMock.storage.local.get.mockResolvedValue({
      settings: { serverUrl: 42, authToken: null },
    });

    const settings = await loadSettings();
    expect(settings.serverUrl).toBe('http://127.0.0.1:4317');
    expect(settings.authToken).toBe('');
  });
});

describe('fetchAgentStatus', () => {
  it('returns the validated health payload and sends the token header', async () => {
    installChromeMock();
    await saveSettings({ authToken: 'token-value' });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(HEALTH_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAgentStatus();

    expect(result.error).toBeUndefined();
    expect(result.health?.ollama.state).toBe('connected');
    expect(result.tokenConfigured).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4317/health');
    expect((init.headers as Record<string, string>)[AUTH_HEADER]).toBe('token-value');
  });

  it('reports an unreachable server as an actionable error, not an exception', async () => {
    installChromeMock();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await fetchAgentStatus();

    expect(result.health).toBeUndefined();
    expect(result.error?.code).toBe('AGENT_SERVER_UNAVAILABLE');
    expect(result.error?.message).toContain('http://127.0.0.1:4317');
    expect(result.error?.suggestedAction.length ?? 0).toBeGreaterThan(10);
  });

  it('surfaces a schema mismatch instead of passing bad data to the UI', async () => {
    installChromeMock();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, data: { status: 'ok' } }), { status: 200 }),
        ),
    );

    const result = await fetchAgentStatus();

    expect(result.health).toBeUndefined();
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.error?.recoverable).toBe(false);
  });

  it('passes through a structured error body from the server', async () => {
    installChromeMock();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'Rate limit exceeded.',
              recoverable: true,
              suggestedAction: 'Wait a moment and retry.',
              debugContext: {},
            },
          }),
          { status: 429 },
        ),
      ),
    );

    const result = await fetchAgentStatus();
    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('converts server authentication rejection to SERVER_AUTH_FAILED', async () => {
    installChromeMock();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Missing or invalid token.',
              recoverable: true,
              suggestedAction: 'Configure the token.',
              debugContext: {},
            },
          }),
          { status: 401 },
        ),
      ),
    );

    const result = await listOllamaModels();
    expect(result.error?.code).toBe('SERVER_AUTH_FAILED');
    expect(result.error?.message).toContain('access token');
  });
});
