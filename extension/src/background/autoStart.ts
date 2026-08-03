import { bundleSharesPortal, type ApplicationBundle } from '@internship-agent/shared';

/**
 * Starting the run without a second click.
 *
 * "Apply with Agent" on Internship Pilot is one action, and it has to stay one
 * action. Before this, clicking it stored a bundle, opened the employer tab,
 * and then waited for the user to open the popup and click "Autofill
 * Application" — a second button for a decision they had already made.
 *
 * The mechanism is deliberately an *arming* rather than a standing rule:
 * accepting a bundle arms exactly one origin, the first run on that origin
 * disarms it, and the arming expires. So a bundle stored an hour ago cannot
 * cause a form to start filling itself because the user happened to revisit the
 * employer's site — automation begins only in the window the user opened.
 */

const KEY = 'autoStartArmed';
/** Long enough for a slow employer page to load; short enough not to linger. */
const ARMED_TTL_MS = 5 * 60 * 1000;

interface Armed {
  bundleId: string;
  origin: string;
  armedAt: number;
}

export async function armAutoStart(bundle: ApplicationBundle): Promise<void> {
  let origin: string;
  try {
    origin = new URL(bundle.officialApplicationUrl).origin;
  } catch {
    return;
  }
  await chrome.storage.local.set({
    [KEY]: { bundleId: bundle.id, origin, armedAt: Date.now() } satisfies Armed,
  });
}

async function readArmed(): Promise<Armed | null> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as Partial<Armed> | undefined;
  if (
    !raw ||
    typeof raw.bundleId !== 'string' ||
    typeof raw.origin !== 'string' ||
    typeof raw.armedAt !== 'number'
  ) {
    return null;
  }
  if (Date.now() - raw.armedAt > ARMED_TTL_MS) return null;
  return raw as Armed;
}

export async function disarmAutoStart(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/**
 * Whether this page should start filling on its own, consuming the arming if so.
 *
 * Consuming it here — rather than after the run finishes — is what makes a
 * double-fire impossible when two frames or a re-navigation both ask at once.
 */
export async function shouldAutoStart(
  url: string,
  bundle: ApplicationBundle | null,
): Promise<boolean> {
  const armed = await readArmed();
  if (!armed || !bundle) return false;
  if (armed.bundleId !== bundle.id) return false;
  if (!bundleSharesPortal(bundle, url)) return false;
  await disarmAutoStart();
  return true;
}
