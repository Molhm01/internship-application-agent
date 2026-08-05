import { runTraceSchema, type RunTrace } from '@internship-agent/shared';

/**
 * The last few run traces, kept so a failure can be diagnosed after the fact.
 *
 * The live failure was reported as "it filled two of twenty-seven fields", and
 * answering *why* required attaching a debugger to a service worker that Chrome
 * suspends whenever it is idle. Storing the trace means the same question is
 * answered by exporting it.
 *
 * Bounded on purpose. This is a diagnostic, not a history: three runs is enough
 * to compare a failure against the run before it, and an unbounded log of
 * everything the extension has ever done is a liability rather than a feature.
 */

const KEY = 'autofillRunTraces';
const LIMIT = 3;

export async function saveRunTrace(trace: RunTrace): Promise<void> {
  const existing = await loadRunTraces();
  // Validated on the way in as well as on the way out. The schema is strict, so
  // this is also what guarantees no caller can attach a field value to a trace.
  const parsed = runTraceSchema.parse(trace);
  await chrome.storage.local.set({ [KEY]: [parsed, ...existing].slice(0, LIMIT) });
}

export async function loadRunTraces(): Promise<RunTrace[]> {
  const stored = await chrome.storage.local.get(KEY);
  const raw: unknown = stored[KEY];
  if (!Array.isArray(raw)) return [];
  // A trace written by an earlier build may no longer parse. It is dropped
  // rather than repaired: a partially-understood diagnostic is worse than none.
  return raw.flatMap((entry) => {
    const parsed = runTraceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function clearRunTraces(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
