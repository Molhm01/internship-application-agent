import { z } from 'zod';
import { aiGenerationSettingsSchema } from './ai.js';
import { isoDateTimeSchema } from './common.js';
import { autofillSettingsSchema } from './autofill.js';
import { employerAccountSettingsSchema } from './employerAccounts.js';

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
  /**
   * Employer-portal account creation. Defaults so an installation that predates
   * these keys upgrades on read — and defaults to off, so the upgrade never
   * silently grants a permission the user was never asked for.
   */
  employerAccounts: employerAccountSettingsSchema.default({}),
  /**
   * Shows the diagnostic surfaces: the read-only analysis page, the fill-plan
   * builder, the JSON copy/export controls, raw confidence numbers, and raw
   * validation output.
   *
   * Off by default. Those tools were built for developing the agent and ended
   * up as the product: a normal user opening the popup on a 26-field form was
   * offered "Build Fill Plan", "Rescan", "Copy JSON" and a per-field review
   * list, none of which is a thing they want to do. Someone applying for a job
   * wants one button.
   */
  developerMode: z.boolean().default(false),
  settingsVersion: z.number().int().nonnegative(),
  settingsUpdatedAt: isoDateTimeSchema,
});

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;
