import { useEffect, useState } from 'react';
import { agentProgressSchema, type AgentProgress } from '@internship-agent/shared';

/**
 * The agent loop's own progress, as it happens.
 *
 * Read-only, and deliberately so. The loop already broadcasts `AGENT_PROGRESS`
 * on every step — the activity sentence, the controls it has *verified*, the
 * questions it stopped to ask — and until now nothing rendered it. This hook
 * subscribes; it does not ask the loop for anything, does not change what the
 * loop sends, and cannot influence a run.
 *
 * Every message is parsed with the shared schema before it is kept. A broadcast
 * is an untrusted input like any other, and a popup that rendered an unvalidated
 * one would be the one place in the product that skipped the rule.
 *
 * The newest broadcast replaces the previous one whole, rather than being
 * merged into it: a run reports its complete state on every step, and merging
 * two runs would let one run's verified list survive into the next.
 */
export function useAgentProgress(): AgentProgress | null {
  const [progress, setProgress] = useState<AgentProgress | null>(null);

  useEffect(() => {
    const listener = (message: unknown): void => {
      const envelope = message as { type?: unknown; progress?: unknown } | null;
      if (!envelope || envelope.type !== 'AGENT_PROGRESS') return;
      const parsed = agentProgressSchema.safeParse(envelope.progress);
      if (!parsed.success) return;
      // The newest broadcast always wins: two runs cannot own the page at once,
      // so an older run's progress is stale by definition.
      setProgress(parsed.data);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener?.(listener);
  }, []);

  return progress;
}
