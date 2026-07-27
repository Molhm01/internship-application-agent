import { z } from 'zod';
import {
  TIMEOUTS,
  type ModelsResponse,
  type OllamaStatus,
  DEFAULT_ERROR_GUIDANCE,
} from '@internship-agent/shared';
import type { Logger } from '../logging/logger.js';

/** Shape of `GET /api/tags` as served by Ollama. Unknown keys are ignored. */
const tagsResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        size: z.number().optional(),
        modified_at: z.string().optional(),
        details: z
          .object({
            parameter_size: z.string().optional(),
            quantization_level: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

const versionResponseSchema = z.object({ version: z.string() });
const chatResponseSchema = z.object({
  model: z.string(),
  message: z.object({ role: z.string(), content: z.string() }),
  done: z.boolean().optional(),
  total_duration: z.number().optional(),
});

export interface OllamaStructuredGenerationRequest {
  model: string;
  system: string;
  prompt: string;
  temperature: number;
  maximumTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OllamaStructuredGenerationResult {
  model: string;
  content: string;
  durationMs: number;
}

export class OllamaGenerationError extends Error {
  constructor(
    readonly code:
      | 'OLLAMA_UNAVAILABLE'
      | 'MODEL_NOT_CONFIGURED'
      | 'MODEL_NOT_FOUND'
      | 'GENERATION_TIMEOUT'
      | 'GENERATION_CANCELLED'
      | 'INVALID_MODEL_OUTPUT',
    message: string,
    readonly debugContext: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OllamaGenerationError';
  }
}

export interface OllamaClientOptions {
  baseUrl: string;
  defaultModel: string;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface OllamaClient {
  /** Live probe. Never throws — failures are returned as an actionable status. */
  checkStatus(): Promise<OllamaStatus>;
  listModels(): Promise<ModelsResponse>;
  generateStructured(
    request: OllamaStructuredGenerationRequest,
  ): Promise<OllamaStructuredGenerationResult>;
  readonly baseUrl: string;
  readonly defaultModel: string;
}

class OllamaTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Ollama did not respond within ${timeoutMs}ms`);
    this.name = 'OllamaTimeoutError';
  }
}

export function createOllamaClient(options: OllamaClientOptions): OllamaClient {
  const { baseUrl, defaultModel, logger } = options;
  const doFetch = options.fetchImpl ?? fetch;

  // The third type argument keeps inference on the schema's *output* type;
  // `z.ZodType<T>` would resolve T to the input shape, making defaulted fields
  // look optional to callers.
  async function request<T>(
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Ollama responded ${response.status} ${response.statusText} for ${path}`);
      }
      const body: unknown = await response.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`Unexpected response shape from ${path}: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new OllamaTimeoutError(timeoutMs);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchTags(): Promise<ModelsResponse> {
    const tags = await request('/api/tags', tagsResponseSchema, TIMEOUTS.ollamaProbeMs);
    const models = tags.models.map((model) => ({
      name: model.name,
      ...(model.size !== undefined ? { size: model.size } : {}),
      ...(model.details?.parameter_size !== undefined
        ? { parameterSize: model.details.parameter_size }
        : {}),
      ...(model.details?.quantization_level !== undefined
        ? { quantization: model.details.quantization_level }
        : {}),
      ...(model.modified_at !== undefined ? { modifiedAt: model.modified_at } : {}),
    }));
    return {
      models,
      selectedModel: defaultModel,
      selectedModelInstalled: models.some((model) => matchesModel(model.name, defaultModel)),
    };
  }

  async function generateStructured(
    input: OllamaStructuredGenerationRequest,
  ): Promise<OllamaStructuredGenerationResult> {
    const configuredModel = input.model.trim();
    if (!configuredModel) {
      throw new OllamaGenerationError(
        'MODEL_NOT_CONFIGURED',
        'No Ollama generation model is configured.',
      );
    }
    const models = await fetchTags().catch((cause: unknown) => {
      throw new OllamaGenerationError(
        'OLLAMA_UNAVAILABLE',
        `Could not query installed Ollama models: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
    logger.info('resolved models for structured generation', {
      configuredModel,
      installedModelCount: models.models.length,
    });
    const installedModel = models.models.find((model) => matchesModel(model.name, configuredModel));
    if (!installedModel) {
      throw new OllamaGenerationError(
        'MODEL_NOT_FOUND',
        `Configured model "${configuredModel}" is not installed.`,
        {
          configuredModel,
          availableModels: models.models.map((model) => model.name),
        },
      );
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    const started = Date.now();
    try {
      if (controller.signal.aborted) {
        throw new OllamaGenerationError('GENERATION_CANCELLED', 'Ollama generation was cancelled.');
      }
      const response = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: installedModel.name,
          stream: false,
          // Reasoning-capable models can otherwise spend the entire bounded
          // token budget in `message.thinking` and leave structured content empty.
          think: false,
          format: 'json',
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          options: {
            temperature: input.temperature,
            num_predict: input.maximumTokens,
          },
        }),
      });
      if (!response.ok) {
        throw new OllamaGenerationError(
          'OLLAMA_UNAVAILABLE',
          `Ollama responded ${response.status} ${response.statusText} for /api/chat.`,
        );
      }
      const parsed = chatResponseSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.message.content.trim()) {
        throw new OllamaGenerationError(
          'INVALID_MODEL_OUTPUT',
          'Ollama returned an empty or malformed chat response.',
        );
      }
      logger.info('ollama structured generation completed', {
        model: parsed.data.model,
        durationMs: Date.now() - started,
        outputCharacters: parsed.data.message.content.length,
      });
      return {
        model: parsed.data.model,
        content: parsed.data.message.content,
        durationMs: Date.now() - started,
      };
    } catch (cause) {
      if (cause instanceof OllamaGenerationError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new OllamaGenerationError(
          timedOut ? 'GENERATION_TIMEOUT' : 'GENERATION_CANCELLED',
          timedOut
            ? `Ollama generation exceeded ${input.timeoutMs}ms.`
            : 'Ollama generation was cancelled.',
        );
      }
      throw new OllamaGenerationError(
        'OLLAMA_UNAVAILABLE',
        `Ollama generation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    baseUrl,
    defaultModel,

    async checkStatus(): Promise<OllamaStatus> {
      const startedAt = Date.now();
      const checkedAt = new Date().toISOString();
      try {
        const [version, tags] = await Promise.all([
          request('/api/version', versionResponseSchema, TIMEOUTS.ollamaProbeMs),
          fetchTags(),
        ]);
        return {
          state: 'connected',
          baseUrl,
          version: version.version,
          modelCount: tags.models.length,
          selectedModel: defaultModel,
          selectedModelInstalled: tags.selectedModelInstalled,
          checkedAt,
          latencyMs: Date.now() - startedAt,
        };
      } catch (cause) {
        const timedOut = cause instanceof OllamaTimeoutError;
        const message =
          cause instanceof Error ? cause.message : `Unknown error contacting Ollama at ${baseUrl}`;
        logger.warn('ollama probe failed', { baseUrl, timedOut, error: message });
        return {
          state: 'disconnected',
          baseUrl,
          selectedModel: defaultModel,
          error: {
            code: timedOut ? 'OLLAMA_TIMEOUT' : 'OLLAMA_UNAVAILABLE',
            message: timedOut
              ? `Ollama at ${baseUrl} did not respond within ${TIMEOUTS.ollamaProbeMs}ms.`
              : `Could not reach Ollama at ${baseUrl}: ${message}`,
            suggestedAction: timedOut
              ? DEFAULT_ERROR_GUIDANCE.OLLAMA_TIMEOUT
              : DEFAULT_ERROR_GUIDANCE.OLLAMA_UNAVAILABLE,
          },
          checkedAt,
          latencyMs: Date.now() - startedAt,
        };
      }
    },

    listModels: fetchTags,
    generateStructured,
  };
}

/** `llama3.1:8b` and `llama3.1` refer to the same model family for our purposes. */
function matchesModel(installed: string, wanted: string): boolean {
  const normalize = (name: string): string => name.trim().toLowerCase();
  const normalizedInstalled = normalize(installed);
  const normalizedWanted = normalize(wanted);
  if (normalizedInstalled === normalizedWanted) return true;
  const base = (name: string): string => name.split(':')[0] ?? name;
  return (
    base(normalizedInstalled) === base(normalizedWanted) && normalizedWanted.includes(':') === false
  );
}
