import type { ExtensionMessage } from '../messaging/messages.js';

export const SESSION_FRAGMENT_KEY = 'internship-agent-session';

export function readSessionIdFromUrl(value: string): string | null {
  const url = new URL(value);
  const id = new URLSearchParams(url.hash.replace(/^#/, '')).get(SESSION_FRAGMENT_KEY);
  return id && /^[a-zA-Z0-9-]{16,64}$/.test(id) ? id : null;
}

export function withoutSessionFragment(value: string): string {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  fragment.delete(SESSION_FRAGMENT_KEY);
  const remaining = fragment.toString();
  url.hash = remaining ? remaining : '';
  return url.toString();
}

export async function claimSessionFromCurrentPage(): Promise<void> {
  const sessionId = readSessionIdFromUrl(window.location.href);
  if (!sessionId) return;

  // Remove the opaque handoff value before any page script, analytics call, or
  // copied URL can retain it. The background worker still receives it directly.
  window.history.replaceState(
    window.history.state,
    document.title,
    withoutSessionFragment(window.location.href),
  );
  const message: ExtensionMessage = { type: 'APPLICATION_SESSION_CLAIM', sessionId };
  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

