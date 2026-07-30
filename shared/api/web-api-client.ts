import { applicationSessionSchema, applicationSessionInputSchema } from '../schemas/application-session.js';

export default class WebApiClient {
  private baseUrl: string;
  private cache = new Map<string, any>(); // store ApplicationSession

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/*$/, ''); // remove trailing slash
  }

  /**
   * Retrieve an application session by ID.
   * Caches the most recently fetched session.
   */
  async getApplicationSession(sessionId: string): Promise<any> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const resp = await fetch(`${this.baseUrl}/application-sessions/${sessionId}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const json: unknown = await resp.json();
    const parsed = applicationSessionSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid response');
    }
    this.cache.set(sessionId, parsed.data);
    return parsed.data;
  }

  /**
   * Create a new application session.
   */
  async createApplicationSession(input: any): Promise<any> {
    const parsedInput = applicationSessionInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error('Invalid input');
    }
  
    const resp = await fetch(`${this.baseUrl}/application-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsedInput.data),
    });
    
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    
    const json: unknown = await resp.json();
    const parsed = applicationSessionSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid response from server');
    }
    
    // Cache the newly created session
    this.cache.set(parsed.data.sessionId, parsed.data);
    return parsed.data;
  }

  /**
   * Claim an application session.
   */
  async claimApplicationSession(sessionId: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/application-sessions/${sessionId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    
    const json: unknown = await resp.json();
    const parsed = applicationSessionSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid response from server');
    }
    
    // Update the cached session
    this.cache.set(sessionId, parsed.data);
    return parsed.data;
  }

  /**
   * Update an application session status.
   */
  async updateApplicationSessionStatus(sessionId: string, status: 'available' | 'claimed' | 'completed'): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/application-sessions/${sessionId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    
    const json: unknown = await resp.json();
    const parsed = applicationSessionSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid response from server');
    }
    
    // Update the cached session
    this.cache.set(sessionId, parsed.data);
    return parsed.data;
  }

  /**
   * Clear the in-memory cache.
   */
  clearApplicationSessionCache(): void {
    this.cache.clear();
  }
}
