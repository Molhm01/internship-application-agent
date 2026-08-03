import type { Profile } from '../schemas/profile.js';

/**
 * "Highest level of education" is a question about a credential you *hold*.
 *
 * Answering it with the degree someone is currently pursuing is a
 * misstatement — a bachelor's student has a high-school diploma, not a
 * bachelor's degree — so the two are stored and read as separate facts and are
 * never substituted for one another.
 *
 * `highestCompletedDegree` and `currentDegreeInProgress` on the profile are the
 * authoritative answers. When Internship Pilot has not set them, they are
 * derived from the education entries, and only from evidence that is actually
 * there: an entry marked completed, or one whose graduation date has passed.
 * An entry that says neither is not treated as either.
 */

/** How far through a credential an education entry is. */
export const EDUCATION_STATUSES = ['completed', 'in_progress'] as const;
export type EducationStatus = (typeof EDUCATION_STATUSES)[number];

/** Ranked lowest to highest, so "which is the highest" has one answer. */
const DEGREE_RANK: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(high school|secondary|hsd|ged|diploma)\b/i, 1],
  [/\b(certificate|certification|vocational|trade)\b/i, 2],
  [/\b(associate|a\.?a\.?|a\.?s\.?)\b/i, 3],
  [/\b(bachelor|undergraduate|b\.?s\.?|b\.?a\.?|b\.?eng\b)/i, 4],
  [/\b(master|graduate|m\.?s\.?|m\.?a\.?|mba|m\.?eng\b)/i, 5],
  [/\b(doctor|doctorate|ph\.?d|md\b|j\.?d\.?)\b/i, 6],
];

/** A comparable rank for a degree name, or 0 when it names no known level. */
export function degreeRank(degree: string | undefined): number {
  if (!degree) return 0;
  let best = 0;
  for (const [pattern, rank] of DEGREE_RANK) {
    if (pattern.test(degree) && rank > best) best = rank;
  }
  return best;
}

/**
 * Whether an entry represents a credential already awarded.
 *
 * `undefined` — not "false" — when the entry says nothing either way. The
 * caller must be able to tell "not completed" from "we do not know", because
 * only the first is safe to reason from.
 */
export function entryIsCompleted(entry: {
  status?: string;
  graduationDate?: string;
}): boolean | undefined {
  if (entry.status === 'completed') return true;
  if (entry.status === 'in_progress') return false;
  if (!entry.graduationDate) return undefined;
  // A graduation date in the past is the entry stating the degree was awarded.
  // A future one states the opposite. Both are evidence; silence is not.
  const parsed = Date.parse(
    /^\d{4}-\d{2}$/.test(entry.graduationDate)
      ? `${entry.graduationDate}-01`
      : entry.graduationDate,
  );
  if (Number.isNaN(parsed)) return undefined;
  return parsed <= Date.now();
}

export interface DegreeAnswers {
  /** The highest credential actually awarded, when the profile establishes one. */
  highestCompletedDegree?: string;
  /** What is being studied now, when the profile establishes it. */
  currentDegreeInProgress?: string;
}

/**
 * Reads both degree facts from a profile.
 *
 * Explicit profile fields win outright. Otherwise the education entries are
 * read, and an entry that establishes neither status contributes to neither
 * answer — which is why a profile with one undated "Bachelor of Science" row
 * yields no highest-completed degree at all rather than claiming one.
 */
export function degreeAnswersFor(profile: Profile): DegreeAnswers {
  const explicitCompleted = profile.highestCompletedDegree?.trim();
  const explicitCurrent = profile.currentDegreeInProgress?.trim();

  let completed = explicitCompleted || undefined;
  let current = explicitCurrent || undefined;

  for (const entry of profile.education) {
    const degree = entry.degree?.trim();
    if (!degree) continue;
    const isCompleted = entryIsCompleted(entry);
    if (isCompleted === true && !explicitCompleted) {
      if (degreeRank(degree) >= degreeRank(completed)) completed = degree;
    }
    if (isCompleted === false && !explicitCurrent) {
      if (degreeRank(degree) >= degreeRank(current)) current = degree;
    }
  }

  return {
    ...(completed ? { highestCompletedDegree: completed } : {}),
    ...(current ? { currentDegreeInProgress: current } : {}),
  };
}

/**
 * Wordings that ask what is being studied *now* rather than what was awarded.
 *
 * Checked so the one legitimate case for answering with the in-progress degree
 * — a form that explicitly asks for it — is not swept up by the same rule that
 * protects the "highest awarded" question.
 */
const IN_PROGRESS_PHRASING =
  /\b(currently (pursuing|studying|enrolled)|in progress|working towards?|degree you are (pursuing|studying|working))\b/i;

export function asksForDegreeInProgress(questionText: string): boolean {
  return IN_PROGRESS_PHRASING.test(questionText);
}
