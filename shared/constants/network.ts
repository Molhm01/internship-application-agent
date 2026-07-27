/** The local agent server binds to loopback only. Never change this to 0.0.0.0. */
export const AGENT_SERVER_HOST = '127.0.0.1';
export const AGENT_SERVER_PORT = 4317;
export const AGENT_SERVER_URL = `http://${AGENT_SERVER_HOST}:${AGENT_SERVER_PORT}`;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
/**
 * Verified locally to honour Ollama's JSON-schema `format` constraint, which
 * Milestone 4 depends on. Override with `OLLAMA_MODEL`; `npm run check:ollama`
 * re-runs the structured-output probe against whatever is configured.
 */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b';

/** Header carrying the extension's authentication token. */
export const AUTH_HEADER = 'x-agent-token';

export const TIMEOUTS = {
  /** Health/version probes from the popup must feel instant. */
  healthMs: 3_000,
  /** Probing the Ollama daemon for reachability and model list. */
  ollamaProbeMs: 5_000,
  /** A single model generation request. */
  ollamaGenerateMs: 120_000,
} as const;

export const LIMITS = {
  /** Fastify body limit. Field payloads for large applications stay well under this. */
  maxRequestBytes: 2 * 1024 * 1024,
  /**
   * Document registration carries a base64 payload, so that route raises the
   * limit. base64 inflates by ~33%, hence the headroom over `maxDocumentBytes`.
   */
  maxDocumentRequestBytes: 14 * 1024 * 1024,
  /** Largest document file accepted, before base64 encoding. */
  maxDocumentBytes: 10 * 1024 * 1024,
  /** Requests per window, per client, across all routes. */
  rateLimitMax: 240,
  rateLimitWindowMs: 60_000,
} as const;
