import {
  AGENT_SERVER_URL,
  DEFAULT_OLLAMA_MODEL,
  aiGenerationSettingsSchema,
  employerAccountSettingsSchema,
  extensionSettingsSchema,
  type AiGenerationSettings,
  type EmployerAccountSettings,
  type ExtensionSettings,
} from '@internship-agent/shared';

export type { ExtensionSettings } from '@internship-agent/shared';

export type ExtensionSettingsUpdate = Partial<
  Omit<ExtensionSettings, 'ai' | 'employerAccounts' | 'settingsVersion' | 'settingsUpdatedAt'>
> & {
  ai?: Partial<AiGenerationSettings>;
  employerAccounts?: Partial<EmployerAccountSettings>;
};

const now = (): string => new Date().toISOString();

export const DEFAULT_SETTINGS: ExtensionSettings = extensionSettingsSchema.parse({
  serverUrl: AGENT_SERVER_URL,
  authToken: '',
  selectedModel: DEFAULT_OLLAMA_MODEL,
  selectedDocumentId: null,
  aiGenerationEnabled: false,
  ai: aiGenerationSettingsSchema.parse({
    generationModel: DEFAULT_OLLAMA_MODEL,
  }),
  // Off, and with no acknowledgement. Creating an account on someone else's
  // system under the user's name is not a default.
  employerAccounts: employerAccountSettingsSchema.parse({}),
  settingsVersion: 1,
  settingsUpdatedAt: now(),
});

const STORAGE_KEY = 'settings';
const ENABLEMENT_KEYS = [
  'aiGenerationEnabled',
  'localAiEnabled',
  'aiEnabled',
  'enableAi',
  'enableAI',
] as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Canonical value wins, followed by legacy keys in the documented migration
 * order. The former nested `ai.enabled` key is handled last because it predates
 * the canonical contract in this repository.
 */
function migrateEnablement(
  candidate: Record<string, unknown>,
  ai: Record<string, unknown>,
): boolean {
  for (const key of ENABLEMENT_KEYS) {
    if (typeof candidate[key] === 'boolean') return candidate[key];
    if (typeof ai[key] === 'boolean') return ai[key];
  }
  return typeof ai.enabled === 'boolean' ? ai.enabled : false;
}

function requiresMigration(
  candidate: Record<string, unknown>,
  ai: Record<string, unknown>,
): boolean {
  return (
    typeof candidate.aiGenerationEnabled !== 'boolean' ||
    'enabled' in ai ||
    ENABLEMENT_KEYS.slice(1).some((key) => key in candidate || key in ai)
  );
}

function normalizeStoredSettings(raw: unknown): {
  settings: ExtensionSettings;
  migrated: boolean;
} {
  const candidate = objectValue(raw);
  const rawAi = objectValue(candidate.ai);
  const selectedModel =
    typeof candidate.selectedModel === 'string' && candidate.selectedModel.trim()
      ? candidate.selectedModel.trim()
      : typeof rawAi.generationModel === 'string' && rawAi.generationModel.trim()
        ? rawAi.generationModel.trim()
        : DEFAULT_OLLAMA_MODEL;
  const aiCandidate = aiGenerationSettingsSchema.safeParse({
    ...DEFAULT_SETTINGS.ai,
    ...rawAi,
    generationModel: selectedModel,
    ...(rawAi.validationModel === '' ? { validationModel: undefined } : {}),
  });
  const ai = aiCandidate.success
    ? aiCandidate.data
    : aiGenerationSettingsSchema.parse({ generationModel: selectedModel });
  const settings = extensionSettingsSchema.parse({
    serverUrl:
      typeof candidate.serverUrl === 'string' && candidate.serverUrl
        ? candidate.serverUrl
        : DEFAULT_SETTINGS.serverUrl,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : '',
    selectedModel: ai.generationModel,
    selectedDocumentId:
      typeof candidate.selectedDocumentId === 'string' ? candidate.selectedDocumentId : null,
    aiGenerationEnabled: migrateEnablement(candidate, rawAi),
    ai,
    settingsVersion: typeof candidate.settingsVersion === 'number' ? candidate.settingsVersion : 1,
    // Parsed leniently and defaulted on failure. A corrupt block must never
    // grant the permission, and `employerAccountSettingsSchema` defaults
    // `autoCreateEnabled` to false — so the failure direction is "off".
    employerAccounts: employerAccountSettingsSchema.safeParse(candidate.employerAccounts).data ??
      employerAccountSettingsSchema.parse({}),
    settingsUpdatedAt:
      typeof candidate.settingsUpdatedAt === 'string'
        ? candidate.settingsUpdatedAt
        : DEFAULT_SETTINGS.settingsUpdatedAt,
  });
  return { settings, migrated: requiresMigration(candidate, rawAi) };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw: unknown = stored[STORAGE_KEY];
  if (!raw || typeof raw !== 'object')
    return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai } };

  const normalized = normalizeStoredSettings(raw);
  if (normalized.migrated) {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized.settings });
  }
  return normalized.settings;
}

export async function saveSettings(update: ExtensionSettingsUpdate): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const mergedAi = aiGenerationSettingsSchema.parse({
    ...current.ai,
    ...(update.ai ?? {}),
  });
  // Turning the switch off drops the acknowledgement with it. Otherwise a user
  // who turned this off and later back on would be silently re-granted the
  // permission on the strength of a confirmation they gave for a past decision.
  const mergedAccounts = employerAccountSettingsSchema.parse({
    ...current.employerAccounts,
    ...(update.employerAccounts ?? {}),
    ...(update.employerAccounts?.autoCreateEnabled === false
      ? { acknowledgedAt: undefined, acknowledgedDisclosureVersion: undefined }
      : {}),
  });
  const next = extensionSettingsSchema.parse({
    ...current,
    ...update,
    ai: mergedAi,
    employerAccounts: mergedAccounts,
    selectedModel: mergedAi.generationModel,
    settingsVersion: current.settingsVersion + 1,
    settingsUpdatedAt: now(),
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  await chrome.runtime
    .sendMessage({
      type: 'SETTINGS_UPDATED',
      aiGenerationEnabled: next.aiGenerationEnabled,
      settingsVersion: next.settingsVersion,
      settingsUpdatedAt: next.settingsUpdatedAt,
    })
    .catch(() => undefined);
  return next;
}
