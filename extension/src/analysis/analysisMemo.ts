import type { NormalizedQuestion } from '@internship-agent/shared';

/**
 * Remembers which set of questions has already been sent to the model.
 *
 * The batched analysis lives inside `buildPlan()`, and the orchestrator calls
 * `buildPlan()` once per pass — up to five times per click. Nothing compared
 * the question set between passes, so a page that revealed nothing new still
 * paid for a second, third, fourth and fifth full model call, each with a
 * sixty-second ceiling. That is the whole of the "Matching profile
 * information" wait, and the reason clicking Autofill again reproduced it
 * exactly.
 *
 * A fingerprint answers the only question that matters: *has anything about
 * what I would ask changed?* It deliberately covers the page, the control, and
 * the options — a dependent dropdown that repopulated is a genuinely different
 * question and must be re-analyzed — and deliberately excludes anything
 * cosmetic, so a re-render is not mistaken for new information.
 */

function hash(value: string): string {
  let digest = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    digest ^= value.charCodeAt(index);
    digest = Math.imul(digest, 16777619);
  }
  return (digest >>> 0).toString(36);
}

/** One question's contribution: what it is, and what it currently offers. */
function questionSignature(question: NormalizedQuestion): string {
  const options = (question.options ?? [])
    .map((option) => `${option.value}${option.label}`)
    .sort()
    .join('');
  return [
    question.questionId,
    question.controlType,
    question.questionText.replace(/\s+/gu, ' ').trim().toLowerCase(),
    question.required ? 'req' : 'opt',
    options ? `o:${hash(options)}` : 'o:none',
  ].join('|');
}

/**
 * A stable identity for "this page, these unresolved questions, these choices".
 *
 * `pageId` is included so navigating to a new step always re-analyzes, and the
 * signatures are sorted so document order cannot make an unchanged page look
 * different.
 */
export function analysisFingerprint(
  pageId: string,
  questions: readonly NormalizedQuestion[],
): string {
  if (questions.length === 0) return `${pageId}:empty`;
  return `${pageId}:${hash(questions.map(questionSignature).sort().join(''))}`;
}

export interface MemoEntry {
  fingerprint: string;
  /** True when the model answered. A malformed or failed response is not cached. */
  succeeded: boolean;
  at: number;
}

/**
 * A per-run record of analyses already performed.
 *
 * Scoped to one run rather than stored globally: a new click is the user
 * telling us to look again, and a memo that outlived the run would make the
 * second click a no-op — which is a different bug of the same shape.
 */
export class AnalysisMemo {
  private readonly entries = new Map<string, MemoEntry>();

  /**
   * Whether the model should be asked about this question set.
   *
   * False only when the identical set was already analyzed *successfully*. A
   * failed or malformed response is not remembered, so a transient failure
   * gets one more chance on the next pass rather than being cached as an
   * answer nobody received.
   */
  shouldAnalyze(fingerprint: string): boolean {
    const entry = this.entries.get(fingerprint);
    return entry === undefined || !entry.succeeded;
  }

  record(fingerprint: string, succeeded: boolean): void {
    this.entries.set(fingerprint, { fingerprint, succeeded, at: Date.now() });
  }

  /** How many model calls this run has made. Reported, and asserted in tests. */
  get analysisCount(): number {
    return [...this.entries.values()].filter((entry) => entry.succeeded).length;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The memo for the run currently in flight.
 *
 * A module-level handle rather than a parameter because `buildPlan()` is
 * reached through a message handler as well as through the orchestrator, and
 * threading it through every caller would mean changing signatures that have
 * nothing to do with analysis. `beginAnalysisScope` is called once per run.
 */
let current: AnalysisMemo | null = null;

export function beginAnalysisScope(): AnalysisMemo {
  current = new AnalysisMemo();
  return current;
}

export function endAnalysisScope(): void {
  current = null;
}

/** The active memo, or a throwaway one when no run owns the scope. */
export function analysisScope(): AnalysisMemo {
  return current ?? new AnalysisMemo();
}
