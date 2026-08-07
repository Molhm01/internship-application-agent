import type { EducationEntry, Profile } from '../schemas/profile.js';
import { parseStoredDate } from './dateValues.js';

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
export function entryIsCompleted(
  entry: {
    status?: string;
    graduationDate?: string;
  },
  now: Date = new Date(),
): boolean | undefined {
  if (entry.status === 'completed') return true;
  if (entry.status === 'in_progress') return false;
  const parts = parseStoredDate(entry.graduationDate);
  if (!parts?.month) return undefined;
  // A graduation date in the past is the entry stating the degree was awarded.
  // A future one states the opposite. Both are evidence; silence is not.
  //
  // The clock is read here to *reason* about a date the profile stated. It is
  // never read to produce one: nothing in this comparison reaches a form, and
  // `dateValues.ts` — the only module that turns a date into a value — has no
  // access to a clock at all.
  const stored = Number(parts.year) * 12 + Number(parts.month);
  const current = now.getFullYear() * 12 + (now.getMonth() + 1);
  return stored <= current;
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
export function degreeAnswersFor(profile: Profile, now: Date = new Date()): DegreeAnswers {
  const explicitCompleted = profile.highestCompletedDegree?.trim();
  const explicitCurrent = profile.currentDegreeInProgress?.trim();

  let completed = explicitCompleted || undefined;
  let current = explicitCurrent || undefined;

  for (const entry of profile.education) {
    const degree = entry.degree?.trim();
    if (!degree) continue;
    const isCompleted = entryIsCompleted(entry, now);
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

/**
 * The education record an application is asking about.
 *
 * `profile.education[0]` — which every education lookup used to read — means
 * "the first row the user happened to enter". For a profile that lists high
 * school first, that row is a *completed* credential, so "Current Degree
 * Program" was answered "High School Diploma", "School" named the high school,
 * and the graduation date offered was one that had already passed.
 *
 * The active record is the one the applicant is in: an entry that says
 * `in_progress`, then an entry whose graduation date has not arrived. Only when
 * no entry states either does the first row stand in — at which point it is the
 * only record there is, and reporting it is not a guess.
 */
export function activeEducationEntry(
  profile: Profile,
  now: Date = new Date(),
): EducationEntry | undefined {
  const inProgress = profile.education.find((entry) => entry.status === 'in_progress');
  if (inProgress) return inProgress;
  const future = profile.education.find((entry) => entryIsCompleted(entry, now) === false);
  if (future) return future;
  return profile.education[0];
}

/** Whether the profile establishes that the applicant is enrolled right now. */
export interface EnrollmentFact {
  enrolled: boolean;
  /** The record the answer came from, named so the trace can cite it. */
  reference: string;
  reason: string;
}

/**
 * Current-student status, derived only from an active education record.
 *
 * Returns `null` — not `false` — when nothing establishes it, because "we do not
 * know" and "no" are different answers and only one of them may be typed onto an
 * application. Age, résumé wording and the name of the school are never
 * consulted: none of them is evidence of enrolment.
 */
export function currentEnrollment(profile: Profile, now: Date = new Date()): EnrollmentFact | null {
  const index = profile.education.findIndex(
    (entry) => entry.status === 'in_progress' || entryIsCompleted(entry, now) === false,
  );
  const entry = profile.education[index];
  if (entry) {
    return {
      enrolled: true,
      reference: `profile.education[${index}].status`,
      reason:
        entry.status === 'in_progress'
          ? `Your saved education lists ${entry.institution} as in progress.`
          : `Your saved education at ${entry.institution} has a graduation date that has not arrived.`,
    };
  }
  // Every stored record is finished, which positively answers "no". A profile
  // with no education at all states nothing and gets no answer.
  const allCompleted =
    profile.education.length > 0 &&
    profile.education.every((candidate) => entryIsCompleted(candidate, now) === true);
  if (allCompleted) {
    return {
      enrolled: false,
      reference: 'profile.education',
      reason: 'Every saved education record is completed.',
    };
  }
  return null;
}

/** Which of the two degree facts a question about education level is asking for. */
export type DegreeIntent = 'completed' | 'current';

const COMPLETED_PHRASING =
  /\b(completed|awarded|attained|obtained|earned|received|conferred|achieved|highest)\b/i;

const CURRENT_PHRASING =
  /\b(current|currently|in progress|pursuing|studying|working towards?|enrolled in|anticipated|expected)\b/i;

/**
 * Reads a degree question's intent from the words around it and the choices it
 * offers.
 *
 * "Highest Degree Completed" and "Degree Currently Pursuing" are unambiguous and
 * settled by wording alone. "Highest Level of Education" on its own is the case
 * this exists for: it is a question about a level *held*, so it resolves to
 * `completed` unless the page says otherwise — which is what stops a bachelor's
 * student being recorded as holding a bachelor's degree. Current phrasing beats
 * completed phrasing when both appear, because "the highest degree you are
 * currently pursuing" is a current question wearing the word "highest".
 */
export function educationLevelIntent(input: {
  label: string;
  helpText?: string;
  optionLabels?: readonly string[];
}): DegreeIntent {
  const text = `${input.label} ${input.helpText ?? ''}`;
  if (CURRENT_PHRASING.test(text)) return 'current';
  if (COMPLETED_PHRASING.test(text)) return 'completed';
  // A list whose choices are themselves phrased as enrolment ("Currently
  // enrolled — Bachelor's") is the page saying which fact it wants.
  const options = (input.optionLabels ?? []).join(' ');
  if (options && CURRENT_PHRASING.test(options)) return 'current';
  return 'completed';
}
