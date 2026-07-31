import {
  applicationSessionSchema,
  type ApplicationSession,
} from '@internship-agent/shared';

const ACTIVE_SESSION_KEY = 'activeApplicationSession';

export async function loadApplicationSession(): Promise<ApplicationSession | null> {
  const stored = await chrome.storage.local.get(ACTIVE_SESSION_KEY);
  const parsed = applicationSessionSchema.safeParse(stored[ACTIVE_SESSION_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveApplicationSession(session: ApplicationSession): Promise<void> {
  await chrome.storage.local.set({
    [ACTIVE_SESSION_KEY]: applicationSessionSchema.parse(session),
  });
}

