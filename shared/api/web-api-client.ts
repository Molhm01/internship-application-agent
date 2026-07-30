import { applicationSessionSchema } from '../schemas/application-session.js';

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
   * Clear the in-memory cache.
   */
  clearApplicationSessionCache(): void {
    this.cache.clear();
  }
}
