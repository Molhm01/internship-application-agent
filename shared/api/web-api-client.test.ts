import { describe, it, expect, vi, beforeEach } from 'vitest';
import WebApiClient from '../shared/api/web-api-client.js';
import { applicationSessionSchema } from '../shared/schemas/application-session.js';

// Mock fetch to test HTTP requests without actually making them
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('WebApiClient', () => {
  let client: WebApiClient;
  
  beforeEach(() => {
    client = new WebApiClient('http://localhost:3000');
    mockFetch.mockReset();
  });

  it('should create a new instance with correct base URL', () => {
    const client = new WebApiClient('http://localhost:3000/');
    expect((client as any).baseUrl).toBe('http://localhost:3000');
  });

  describe('getApplicationSession', () => {
    it('should fetch and return a valid session', async () => {
      const mockResponse = {
        sessionId: 'test-session-id',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        status: 'available',
        url: 'https://example.com',
        domain: 'example.com',
        ats: 'ats-system',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getApplicationSession('test-session-id');
      
      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/application-sessions/test-session-id');
    });

    it('should throw error for invalid response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'data' }),
      });

      await expect(client.getApplicationSession('test-session-id')).rejects.toThrow('Invalid response');
    });
  });

  describe('createApplicationSession', () => {
    it('should create a new session', async () => {
      const input = {
        url: 'https://example.com',
        domain: 'example.com',
        ats: 'ats-system',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      const mockResponse = {
        ...input,
        sessionId: 'new-session-id',
        status: 'available',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.createApplicationSession(input);
      
      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/application-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    });

    it('should throw error for invalid input', async () => {
      await expect(client.createApplicationSession({ invalid: 'data' })).rejects.toThrow('Invalid input');
    });
  });

  describe('claimApplicationSession', () => {
    it('should claim a session', async () => {
      const mockResponse = {
        sessionId: 'test-session-id',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        claimedAt: Date.now(),
        status: 'claimed',
        url: 'https://example.com',
        domain: 'example.com',
        ats: 'ats-system',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.claimApplicationSession('test-session-id');
      
      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/application-sessions/test-session-id/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  describe('updateApplicationSessionStatus', () => {
    it('should update session status', async () => {
      const mockResponse = {
        sessionId: 'test-session-id',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        status: 'completed',
        url: 'https://example.com',
        domain: 'example.com',
        ats: 'ats-system',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.updateApplicationSessionStatus('test-session-id', 'completed');
      
      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/application-sessions/test-session-id/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
    });
  });

  describe('clearApplicationSessionCache', () => {
    it('should clear the cache', () => {
      const mockResponse = {
        sessionId: 'test-session-id',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        status: 'available',
        url: 'https://example.com',
        domain: 'example.com',
        ats: 'ats-system',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      client.getApplicationSession('test-session-id');
      expect((client as any).cache.size).toBe(1);
      
      client.clearApplicationSessionCache();
      expect((client as any).cache.size).toBe(0);
    });
  });
});