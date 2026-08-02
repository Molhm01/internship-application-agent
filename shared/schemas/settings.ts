import { z } from 'zod';
import { aiGenerationSettingsSchema } from './ai.js';
import { isoDateTimeSchema } from './common.js';
import { autofillSettingsSchema } from './autofill.js';

/**
 * The single persisted extension-settings contract. AI enablement is deliberately
 * separate from model tuning so an invalid optional model field cannot reset a
 * valid user permission.
 */
export const extensionSettingsSchema = z.object({
  serverUrl: z.string().url().max(2048),
  authToken: z.string().max(4096),
  selectedModel: z.string().trim().min(1).max(200),
  selectedDocumentId: z.string().min(1).nullable(),
  aiGenerationEnabled: z.boolean().default(false),
  ai: aiGenerationSettingsSchema,
  /**
   * What one-button autofill may apply without a person looking first. Every
   * member defaults, so an installation that predates these keys is upgraded on
   * read rather than being rejected.
   */
  autofill: autofillSettingsSchema.default({}),
  settingsVersion: z.number().int().nonnegative(),
  settingsUpdatedAt: isoDateTimeSchema,
});

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;
