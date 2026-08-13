/**
 * Whether an installed Ollama model is the one that was asked for.
 *
 * Shared rather than duplicated because both sides of the system ask this
 * question and a disagreement between them is invisible: the server decides
 * whether its own default is pulled, and the extension decides whether the
 * model saved in AI Answers is available before it starts a run. When those
 * two used different rules — or, as the live SuccessFactors run proved, asked
 * about two different models entirely — the extension refused to analyze a
 * page over a model it was never going to call.
 *
 * A bare name matches any tag of it (`qwen3-coder` matches
 * `qwen3-coder:30b`), because that is how Ollama itself resolves an untagged
 * name. A tagged name matches only that exact tag.
 */
export function matchesModelName(installed: string, wanted: string): boolean {
  const normalize = (name: string): string => name.trim().toLowerCase();
  const normalizedInstalled = normalize(installed);
  const normalizedWanted = normalize(wanted);
  if (normalizedInstalled === normalizedWanted) return true;
  const base = (name: string): string => name.split(':')[0] ?? name;
  return (
    base(normalizedInstalled) === base(normalizedWanted) && normalizedWanted.includes(':') === false
  );
}

/** Whether any of these installed models satisfies the configured one. */
export function modelInstalled(
  installed: readonly string[],
  wanted: string,
): boolean {
  const target = wanted.trim();
  if (!target) return false;
  return installed.some((name) => matchesModelName(name, target));
}
