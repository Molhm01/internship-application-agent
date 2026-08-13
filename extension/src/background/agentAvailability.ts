import {
  modelInstalled,
  DEFAULT_ERROR_GUIDANCE,
  type AgentError,
  type HealthResponse,
} from '@internship-agent/shared';

/**
 * Whether the local AI agent is reachable, answered honestly and cheaply.
 *
 * Two failures this replaces:
 *
 * 1. `AGENT_SERVER_UNAVAILABLE` was surfaced as a raw error where the user
 *    expected an application to be filled, with no indication that deterministic
 *    autofill still worked. The status below distinguishes "the AI is down" from
 *    "nothing works", because those are very different situations.
 * 2. Health was re-checked far too often. It is now checked once and cached for
 *    a short window, so opening the popup costs one request rather than one per
 *    field.
 */

export type AgentAvailability =
  | { state: 'connected'; health: HealthResponse; checkedAt: number }
  | { state: 'unreachable'; error: AgentError; checkedAt: number }
  | { state: 'unauthorized'; error: AgentError; checkedAt: number }
  | { state: 'model_unavailable'; health: HealthResponse; error: AgentError; checkedAt: number };

/** How long a health answer is trusted. Long enough to cover one popup session. */
export const HEALTH_CACHE_MS = 15_000;

let cached: AgentAvailability | null = null;
let inFlight: Promise<AgentAvailability> | null = null;

export function clearAgentAvailabilityCache(): void {
  cached = null;
  inFlight = null;
}

function agentError(code: AgentError['code'], message: string): AgentError {
  return {
    code,
    message,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE[code],
    debugContext: {},
  };
}

/**
 * Turns a health probe into a state the UI can state plainly.
 *
 * A reachable server whose model is missing is `model_unavailable`, not
 * `connected` — saying "AI agent connected" when no model can answer would be
 * a lie the user only discovers when analysis silently produces nothing.
 */
export function interpretHealth(
  result: { health?: HealthResponse; error?: AgentError },
  now: () => number = Date.now,
  /**
   * The model this extension will actually ask for — `settings.ai.generationModel`.
   *
   * Load-bearing, and the reason this parameter exists. The health payload's
   * own `selectedModel` is the *server's* default (`OLLAMA_MODEL`, falling back
   * to `DEFAULT_OLLAMA_MODEL`), which is a different setting that no request
   * ever uses. Gating on it meant a live run refused to analyze a page because
   * `qwen3.5:9b` was missing, while the model the request would have sent was
   * installed the whole time. Availability is decided about the model that will
   * be called, or it is not availability.
   */
  configuredModel?: string,
): AgentAvailability {
  // The clock is injectable so the cache window is testable, and so a probe
  // and its cache entry are always stamped from the same source.
  const checkedAt = now();
  if (result.error) {
    return result.error.code === 'SERVER_AUTH_FAILED' || result.error.code === 'UNAUTHORIZED'
      ? { state: 'unauthorized', error: result.error, checkedAt }
      : { state: 'unreachable', error: result.error, checkedAt };
  }
  if (!result.health) {
    return {
      state: 'unreachable',
      error: agentError('AGENT_SERVER_UNAVAILABLE', 'The local agent server did not answer.'),
      checkedAt,
    };
  }
  const ollama = result.health.ollama;
  if (ollama.state !== 'connected') {
    return {
      state: 'model_unavailable',
      health: result.health,
      // The health payload's own error carries no `recoverable` or debug
      // context, so its message is re-wrapped rather than passed through as a
      // half-formed AgentError.
      error: agentError(
        'OLLAMA_UNAVAILABLE',
        ollama.error?.message ?? 'Ollama is not answering, so questions cannot be analyzed.',
      ),
      checkedAt,
    };
  }
  // The model this extension will actually send, judged against what the daemon
  // actually has. Only when neither is known does the server's own default get
  // to speak, and then only about itself.
  const wanted = configuredModel?.trim() ?? '';
  const installed = ollama.installedModels;
  const missing = wanted
    ? installed
      ? !modelInstalled(installed, wanted)
      : // An older server that does not report its inventory cannot answer the
        // question that matters, and its answer about a *different* model is
        // not evidence about this one. The run proceeds and a genuinely absent
        // model surfaces as MODEL_NOT_FOUND from the request itself, which is
        // the honest place for it.
        false
    : Boolean(ollama.selectedModel) && ollama.selectedModelInstalled === false;
  if (missing) {
    const named = wanted || ollama.selectedModel;
    return {
      state: 'model_unavailable',
      health: result.health,
      error: agentError(
        'MODEL_NOT_FOUND',
        `The selected model "${named}" is not installed, so questions cannot be analyzed.`,
      ),
      checkedAt,
    };
  }
  return { state: 'connected', health: result.health, checkedAt };
}

/**
 * The cached availability, probing at most once per window.
 *
 * Concurrent callers share one in-flight probe, so opening the popup while a
 * run is starting does not produce two requests.
 */
export async function agentAvailability(
  probe: () => Promise<{ health?: HealthResponse; error?: AgentError }>,
  now: () => number = Date.now,
  /** The model the caller will actually send. See `interpretHealth`. */
  configuredModel?: string,
): Promise<AgentAvailability> {
  if (cached && now() - cached.checkedAt < HEALTH_CACHE_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = probe()
    .then((result) => {
      cached = interpretHealth(result, now, configuredModel);
      return cached;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** True when the batched analysis can run at all. */
export function canAnalyze(availability: AgentAvailability): boolean {
  return availability.state === 'connected';
}

/** One sentence naming what still works, in the user's terms. */
export function availabilityMessage(availability: AgentAvailability): string {
  switch (availability.state) {
    case 'connected':
      return 'AI agent connected.';
    case 'unauthorized':
      return 'The local agent server rejected the saved token. Deterministic autofill still works; questions that need interpreting are left for you.';
    case 'model_unavailable':
      return `AI agent unavailable: ${availability.error.message} Deterministic autofill still works; questions that need interpreting are left for you.`;
    case 'unreachable':
      return 'AI agent unavailable. Deterministic autofill still works from your saved profile; questions that need interpreting are left for you.';
  }
}
