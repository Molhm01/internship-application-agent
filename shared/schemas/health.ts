import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';

export const connectionStateSchema = z.enum(['connected', 'disconnected', 'unknown']);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const ollamaStatusSchema = z.object({
  state: connectionStateSchema,
  baseUrl: z.string().url(),
  /** Populated only when the daemon answered. */
  version: z.string().optional(),
  modelCount: z.number().int().nonnegative().optional(),
  /** Configured default model, and whether the daemon actually has it pulled. */
  selectedModel: z.string().optional(),
  selectedModelInstalled: z.boolean().optional(),
  /**
   * Every model the daemon actually has, by name.
   *
   * Reported so availability can be decided against the model the *caller* has
   * configured rather than against the server's own default. Those are two
   * different settings, and a live run refused to analyze a page because the
   * server's default was missing while the model the request would actually
   * have used was installed all along.
   */
  installedModels: z.array(z.string()).max(500).optional(),
  /** Present whenever `state` is not `connected`. Always actionable. */
  error: z
    .object({
      code: z.enum(['OLLAMA_UNAVAILABLE', 'OLLAMA_TIMEOUT']),
      message: z.string().min(1),
      suggestedAction: z.string().min(1),
    })
    .optional(),
  checkedAt: isoDateTimeSchema,
  latencyMs: z.number().nonnegative().optional(),
});

export type OllamaStatus = z.infer<typeof ollamaStatusSchema>;

export const databaseStatusSchema = z.object({
  state: z.enum(['ready', 'error']),
  path: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export const completenessSectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  complete: z.boolean(),
  missing: z.array(z.string().min(1)),
});

export const profileCompletenessSchema = z.object({
  percent: z.number().int().min(0).max(100),
  completeSections: z.number().int().nonnegative(),
  totalRequiredSections: z.number().int().nonnegative(),
  sections: z.array(completenessSectionSchema),
});

/** Enough for the popup to name the resume that would be attached. */
export const resumeSelectionSchema = z.object({
  documentId: z.string().min(1),
  name: z.string().min(1),
  /** Why this document won: an explicit choice, or the stored default. */
  reason: z.enum(['user_selected', 'default']),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('internship-application-agent'),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  checkedAt: isoDateTimeSchema,
  ollama: ollamaStatusSchema,
  database: databaseStatusSchema,
  /** Whether a profile record exists yet. Drives the popup "Profile" row. */
  profileLoaded: z.boolean(),
  /**
   * Stored-data detail is returned only to an authenticated caller, so an
   * unauthenticated probe learns connection facts and nothing about the user.
   * Absent until a profile exists — never a fabricated zero-filled profile.
   */
  profileCompleteness: profileCompletenessSchema.optional(),
  documentCounts: z
    .object({
      total: z.number().int().nonnegative(),
      resumes: z.number().int().nonnegative(),
      hasDefaultResume: z.boolean(),
    })
    .optional(),
  approvedAnswerCount: z.number().int().nonnegative().optional(),
  /** True when the caller supplied a valid token; the popup uses it to prompt setup. */
  authenticated: z.boolean(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const versionResponseSchema = z.object({
  name: z.literal('internship-application-agent'),
  version: z.string().min(1),
  milestone: z.string().min(1),
  node: z.string().min(1),
  platform: z.string().min(1),
  startedAt: isoDateTimeSchema,
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;

export const ollamaModelSchema = z.object({
  name: z.string().min(1),
  size: z.number().nonnegative().optional(),
  parameterSize: z.string().optional(),
  quantization: z.string().optional(),
  modifiedAt: z.string().optional(),
});

export const modelsResponseSchema = z.object({
  models: z.array(ollamaModelSchema),
  selectedModel: z.string(),
  selectedModelInstalled: z.boolean(),
});

export type ModelsResponse = z.infer<typeof modelsResponseSchema>;
