import { describe, test, expect, vi } from 'vitest';
import { WebApiClient } from './web-api-client.js';

// Mock the global fetch API
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch; // restore after each test
});

describe('WebApiClient', () => {
  const baseUrl = 'http://localhost:4317';
  const client = new WebApiClient(baseUrl);

  test('returns validated application session', async () => {
    const mockSession = { sessionId: '1234567890123456', createdAt: 1700000000, expiresAt: 1700003600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSession,
    });

    const session = await client.getApplicationSession('1234567890123456');
    expect(session).toEqual(mockSession);
  });

  test('throws on invalid response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bad: 'data' }),
    });
    await expect(client.getApplicationSession('bad')).rejects.toThrow('Invalid response');
  });

  test('caches same session ID', async () => {
    const mock = { sessionId: 'sameid12345678', createdAt: 1700000000, expiresAt: 1700003600 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mock });
    globalThis.fetch = fetchMock;

    await client.getApplicationSession('sameid12345678');
    await client.getApplicationSession('sameid12345678');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('different session ID triggers new request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessionId: 'id1', createdAt: 0, expiresAt: 10 }) });
    await client.getApplicationSession('id1');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessionId: 'id2', createdAt: 20, expiresAt: 30 }) });
    await client.getApplicationSession('id2');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('clearing cache forces new request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessionId: 'clearid', createdAt: 0, expiresAt: 10 }) });
    await client.getApplicationSession('clearid');
    client.clearApplicationSessionCache();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sessionId: 'clearid', createdAt: 20, expiresAt: 30 }) });
    await client.getApplicationSession('clearid');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('network failure throws error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network'));
    await expect(client.getApplicationSession('net')).rejects.toThrow('Network');
  });
});