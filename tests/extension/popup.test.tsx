import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse } from '@internship-agent/shared';
import { App } from '../../extension/src/popup/App.js';
import type { AgentStatusResult } from '../../extension/src/messaging/messages.js';
import { installChromeMock } from './setup.js';
import { emptyApplicationScan } from './popupFixtures.js';

afterEach(cleanup);

const NOW = '2026-07-26T12:00:00.000Z';

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    service: 'internship-application-agent',
    version: '0.1.0',
    uptimeSeconds: 12,
    checkedAt: NOW,
    ollama: {
      state: 'connected',
      baseUrl: 'http://127.0.0.1:11434',
      version: '0.5.4',
      modelCount: 2,
      selectedModel: 'llama3.1:8b',
      selectedModelInstalled: true,
      checkedAt: NOW,
      latencyMs: 8,
    },
    database: { state: 'ready', path: ':memory:', schemaVersion: 1 },
    profileLoaded: false,
    authenticated: true,
    ...overrides,
  };
}

function mockPopup(
  status: AgentStatusResult,
  tabUrl = 'https://boards.example.com/apply/123',
): void {
  const chromeMock = installChromeMock();
  chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
    if (message.type === 'GET_LAST_SCAN') {
      return Promise.resolve({ scan: emptyApplicationScan(tabUrl) });
    }
    if (message.type === 'GET_FILL_PLAN') {
      return Promise.resolve({ plan: null, report: null });
    }
    return Promise.resolve(status);
  });
  chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: tabUrl }]);
  chromeMock.tabs.sendMessage.mockResolvedValue({
    present: true,
    url: tabUrl,
    fieldsDetected: null,
  });
}

describe('popup connection status', () => {
  it('shows both services connected and reports the real model', async () => {
    mockPopup({
      health: health(),
      latencyMs: 7,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    });

    render(<App />);

    // Two rows read "Connected": the agent server and Ollama.
    await waitFor(() => expect(screen.getAllByText('Connected')).toHaveLength(2));
    expect(screen.getByText('llama3.1:8b')).toBeDefined();
    expect(screen.getByText('boards.example.com')).toBeDefined();
    expect(screen.getByText(/2 models installed/)).toBeDefined();
  });

  it('reports the server as disconnected with the cause and the fix', async () => {
    mockPopup({
      error: {
        code: 'AGENT_SERVER_UNAVAILABLE',
        message: 'Could not reach the agent server at http://127.0.0.1:4317: Failed to fetch',
        recoverable: true,
        suggestedAction: 'Start the local agent server with `npm run dev:server`, then retry.',
        debugContext: {},
      },
      latencyMs: 3000,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: false,
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText('Disconnected')).toBeDefined());
    // The failure must name the cause and the remedy, never just "failed".
    expect(screen.getByText(/Could not reach the agent server/)).toBeDefined();
    expect(screen.getByText(/npm run dev:server/)).toBeDefined();
  });

  it('does not claim Ollama is disconnected when the server itself is unreachable', async () => {
    mockPopup({
      error: {
        code: 'AGENT_SERVER_UNAVAILABLE',
        message: 'Could not reach the agent server.',
        recoverable: true,
        suggestedAction: 'Start the local agent server.',
        debugContext: {},
      },
      latencyMs: 5,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: false,
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText('Unknown — server unreachable')).toBeDefined());
  });

  it('surfaces the Ollama error when the daemon is down but the server is up', async () => {
    mockPopup({
      health: health({
        status: 'degraded',
        ollama: {
          state: 'disconnected',
          baseUrl: 'http://127.0.0.1:11434',
          selectedModel: 'llama3.1:8b',
          error: {
            code: 'OLLAMA_UNAVAILABLE',
            message: 'Could not reach Ollama at http://127.0.0.1:11434: ECONNREFUSED',
            suggestedAction: 'Start Ollama with `ollama serve`.',
          },
          checkedAt: NOW,
        },
      }),
      latencyMs: 12,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/ECONNREFUSED/)).toBeDefined());
    expect(screen.getByText(/ollama serve/)).toBeDefined();
  });

  it('warns when the selected model is not installed', async () => {
    mockPopup({
      health: health({
        ollama: {
          state: 'connected',
          baseUrl: 'http://127.0.0.1:11434',
          modelCount: 1,
          selectedModel: 'mistral-large:123b',
          selectedModelInstalled: false,
          checkedAt: NOW,
        },
      }),
      latencyMs: 9,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('mistral-large:123b (not installed)')).toBeDefined(),
    );
  });

  it('reports that no supported form was detected after scanning zero fields', async () => {
    mockPopup({
      health: health(),
      latencyMs: 7,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('No supported application form detected on this page')).toBeDefined(),
    );
    expect(screen.getByText('0')).toBeDefined();
  });

  it('keeps settings available when no supported form is detected', async () => {
    mockPopup({
      health: health(),
      latencyMs: 7,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    });

    render(<App />);
    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0));

    expect(screen.getByText('No supported application form detected on this page')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toHaveProperty('disabled', false);
  });

  it('tells the user to reload the page when the content script is unreachable', async () => {
    const chromeMock = installChromeMock();
    const status = {
      health: health(),
      latencyMs: 7,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
    } satisfies AgentStatusResult;
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'GET_LAST_SCAN') return Promise.resolve({ scan: null });
      if (message.type === 'GET_FILL_PLAN') return Promise.resolve({ plan: null, report: null });
      return Promise.resolve(status);
    });
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com/apply' }]);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/content script is not reachable/)).toBeDefined());
  });
});
