import {
  dateShapeSchema,
  normalizedDateSchema,
  type DatePrecision,
  type DateShape,
  type DayConvention,
  type NormalizedDate,
} from '../schemas/dates.js';
import { MONTH_NAMES, parseStoredDate, shapeNeedsDay } from './dateValues.js';

/**
 * Turning a stored date into a value one specific control will accept — or
 * refusing to, and saying which fact is missing.
 *
 * ## The failure this closes
 *
 * The profile held `2021-07`. The employer's From Date box said `MM/DD/YYYY`.
 * The agent wrote `2021-07` and the form answered "Invalid date." Two separate
 * things were wrong and only one of them is a formatting bug:
 *
 *  1. Nothing converted the stored representation into the control's. Fixed by
 *     `formatNormalizedDate`, which renders against the shape the control asked
 *     for rather than the shape the profile happens to store.
 *  2. Even converted, the answer would have been a *fiction*: `MM/DD/YYYY`
 *     wants a day, and July 2021 does not contain one. `07/01/2021` is not a
 *     better rendering of the saved fact — it is a different fact, and it is
 *     one the applicant never stated.
 *
 * So the second case does not produce a value at all. It produces
 * `DATE_PRECISION_INSUFFICIENT`, and the run asks. A day appears only when the
 * applicant has stored a convention saying which day they want used, and even
 * then the produced date carries `dayFromConvention` so that every later layer
 * can see the day did not come from the record.
 *
 * ## No clock
 *
 * There is no `Date.now()` and no `new Date()` here, and there is no parameter
 * through which one could be supplied. A current role's end date is `present`,
 * which formats to nothing: the form's own "I currently work here" control is
 * the answer, and today's date is never it.
 */

/** Why a date could not be written, in the vocabulary the trace and UI share. */
export type DateFormatRefusal =
  'DATE_PRECISION_INSUFFICIENT' | 'DATE_USER_INPUT_REQUIRED' | 'DATE_FORMAT_UNSUPPORTED';

export type NormalizedDateFormat =
  | { kind: 'value'; value: string; shape: DateShape; usedConvention?: 'first_day' | 'last_day' }
  | { kind: 'refused'; code: DateFormatRefusal; reason: string };

/** A date holding nothing, used where a record simply does not state one. */
export const UNKNOWN_DATE: NormalizedDate = normalizedDateSchema.parse({
  year: null,
  month: null,
  day: null,
  precision: 'unknown',
});

/**
 * Reads a stored profile date into parts, at the precision it was stored at.
 *
 * Accepts only what `partialDateSchema` can hold — `YYYY`, `YYYY-MM`,
 * `YYYY-MM-DD` — through the existing `parseStoredDate`, so there is exactly
 * one parser in the repo and "Spring 2027" cannot become a date in one path and
 * not the other.
 *
 * `current: true` outranks the string entirely. A role the applicant marked
 * current has no end date, and a stale end date left in the record is not
 * evidence that it does.
 */
export function normalizeStoredDate(
  raw: string | undefined,
  options: { current?: boolean } = {},
): NormalizedDate {
  if (options.current === true) {
    return normalizedDateSchema.parse({ year: null, month: null, day: null, precision: 'present' });
  }
  const parts = parseStoredDate(raw);
  if (!parts) return UNKNOWN_DATE;
  const year = Number(parts.year);
  const month = parts.month === undefined ? null : Number(parts.month);
  const day = parts.day === undefined ? null : Number(parts.day);
  const precision: DatePrecision = day !== null ? 'day' : month !== null ? 'month' : 'year';
  return normalizedDateSchema.parse({ year, month, day, precision });
}

/** How many days that month has. Proleptic Gregorian, and no clock is consulted. */
export function lastDayOfMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Applies a stored day convention to a month-precision date, or leaves it alone.
 *
 * The *only* place in this repository where a day the applicant did not state
 * can be attached to a date, and it refuses to do so unless `convention` is
 * something other than `ask`. The result marks itself with `dayFromConvention`,
 * which the safety layer checks against the applicant's stored preference
 * before anything reaches the DOM — so a fabricated day cannot be laundered
 * into a legitimate one by an intermediate layer that forgot where it came
 * from.
 */
export function applyDayConvention(
  date: NormalizedDate,
  convention: DayConvention,
): NormalizedDate {
  if (convention === 'ask') return date;
  if (date.precision !== 'month' || date.year === null || date.month === null) return date;
  const day = convention === 'first_day' ? 1 : lastDayOfMonth(date.year, date.month);
  return normalizedDateSchema.parse({
    year: date.year,
    month: date.month,
    day,
    precision: 'day',
    dayFromConvention: convention,
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Renders a date that is known precisely enough for the shape asked of it.
 *
 * Separate from the checking above so that the check is unavoidable: this
 * function is only reachable with a date whose precision has already been
 * proven sufficient, and it has no branch that could substitute a missing part.
 */
function render(date: NormalizedDate, shape: DateShape): string | null {
  const { year, month, day } = date;
  if (year === null) return null;
  switch (shape) {
    case 'iso_full':
      return month === null || day === null ? null : `${year}-${pad(month)}-${pad(day)}`;
    case 'iso_month':
      return month === null ? null : `${year}-${pad(month)}`;
    case 'us_full':
      return month === null || day === null ? null : `${pad(month)}/${pad(day)}/${year}`;
    case 'us_month':
      return month === null ? null : `${pad(month)}/${year}`;
    case 'month_name_year': {
      if (month === null) return String(year);
      const name = MONTH_NAMES[month - 1];
      return name === undefined ? String(year) : `${name} ${year}`;
    }
    case 'year_only':
      return String(year);
  }
}

/**
 * The value this control should receive, or the reason it cannot be produced.
 *
 * The refusal codes are distinct on purpose, because they call for three
 * different things from three different people:
 *
 *  - `DATE_USER_INPUT_REQUIRED` — nothing is saved, or the role is current and
 *    the form has no way to say so. The applicant answers it.
 *  - `DATE_PRECISION_INSUFFICIENT` — a date *is* saved, and the control wants a
 *    part of it the applicant never stated. The applicant supplies that part,
 *    or stores a convention once and stops being asked.
 *  - `DATE_FORMAT_UNSUPPORTED` — the control asked for a shape this build
 *    cannot render. A code change, not a user action.
 *
 * Collapsing them into "Autofill failed" is what made the live run undiagnosable.
 */
export function formatNormalizedDate(
  date: NormalizedDate,
  shape: DateShape,
  convention: DayConvention = 'ask',
): NormalizedDateFormat {
  if (!dateShapeSchema.safeParse(shape).success) {
    return {
      kind: 'refused',
      code: 'DATE_FORMAT_UNSUPPORTED',
      reason: 'This control asks for a date format this build does not know how to write.',
    };
  }
  if (date.precision === 'present') {
    return {
      kind: 'refused',
      code: 'DATE_USER_INPUT_REQUIRED',
      reason:
        'This role is saved as current, so it has no end date. ' +
        'Today’s date is never written in place of one.',
    };
  }
  if (date.precision === 'unknown' || date.year === null) {
    return {
      kind: 'refused',
      code: 'DATE_USER_INPUT_REQUIRED',
      reason: 'No date is saved for this question, and one is never invented.',
    };
  }

  const needsDay = shapeNeedsDay(shape);
  const needsMonth = shape !== 'year_only';

  if (needsMonth && date.month === null) {
    return {
      kind: 'refused',
      code: 'DATE_PRECISION_INSUFFICIENT',
      reason:
        'This control requires a month, and only a year is saved. ' +
        'A month is never chosen for you.',
    };
  }

  let resolved = date;
  if (needsDay && resolved.day === null) {
    resolved = applyDayConvention(resolved, convention);
    if (resolved.day === null) {
      return {
        kind: 'refused',
        code: 'DATE_PRECISION_INSUFFICIENT',
        reason:
          'This control requires an exact day, and only a month and year are saved. ' +
          'A day is never chosen for you without an approved convention.',
      };
    }
  }

  const value = render(resolved, shape);
  if (value === null) {
    return {
      kind: 'refused',
      code: 'DATE_PRECISION_INSUFFICIENT',
      reason: 'The saved date does not hold every part this control asks for.',
    };
  }
  return {
    kind: 'value',
    value,
    shape,
    ...(resolved.dayFromConvention ? { usedConvention: resolved.dayFromConvention } : {}),
  };
}

/**
 * How this date orders against that one, comparing only the parts both hold.
 *
 * Returns `null` when they cannot be ordered — either is unknown, or one is
 * `present`. That is not a failure to compare; it is the honest answer, and it
 * is what stops a chronology check from firing on a current role whose end date
 * is correctly absent.
 *
 * Missing parts are *not* filled in with zeroes or with ones. July 2021 and 14
 * July 2021 compare equal at month precision, because at the precision they
 * share that is what they are, and inventing a day here to break the tie would
 * be the same fabrication this module exists to prevent.
 */
export function compareNormalizedDates(left: NormalizedDate, right: NormalizedDate): number | null {
  if (left.year === null || right.year === null) return null;
  if (left.precision === 'present' || right.precision === 'present') return null;
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.month === null || right.month === null) return 0;
  if (left.month !== right.month) return left.month < right.month ? -1 : 1;
  if (left.day === null || right.day === null) return 0;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}

/** True when an end date genuinely precedes the start date beside it. */
export function isChronologyInvalid(start: NormalizedDate, end: NormalizedDate): boolean {
  const order = compareNormalizedDates(start, end);
  return order !== null && order > 0;
}

/**
 * What the applicant's record holds for this date, in words.
 *
 * Used in the question the agent asks, so the applicant is told what is already
 * known rather than being asked from nothing. Deliberately says the month and
 * the year — those are the facts they gave — and never guesses at what is
 * missing.
 */
export function describePrecision(date: NormalizedDate): string {
  switch (date.precision) {
    case 'day':
      return 'an exact day, month and year';
    case 'month':
      return date.month !== null && date.year !== null
        ? `${MONTH_NAMES[date.month - 1] ?? ''} ${date.year}`.trim()
        : 'a month and a year';
    case 'year':
      return date.year === null ? 'a year' : String(date.year);
    case 'present':
      return 'that the role is current';
    case 'unknown':
      return 'nothing';
  }
}

/** The employer's format, described the way the employer described it. */
export function describeShape(shape: DateShape): string {
  switch (shape) {
    case 'iso_full':
      return 'YYYY-MM-DD';
    case 'iso_month':
      return 'YYYY-MM';
    case 'us_full':
      return 'MM/DD/YYYY';
    case 'us_month':
      return 'MM/YYYY';
    case 'month_name_year':
      return 'Month YYYY';
    case 'year_only':
      return 'YYYY';
  }
}

/**
 * The question put to the applicant when a control wants more than is saved.
 *
 * Names the record, the date, what is known, and what the employer asked for —
 * the four things somebody needs in order to answer without going and looking
 * at the page. It quotes the employer's own label and the applicant's own
 * month, and nothing else about them.
 */
export function dateQuestionFor(input: {
  label: string;
  section: string;
  date: NormalizedDate;
  shape: DateShape;
}): string {
  const where = input.section.trim().length > 0 ? ` in ${input.section}` : '';
  return (
    `"${input.label}"${where} asks for a date as ${describeShape(input.shape)}, ` +
    `and your profile records ${describePrecision(input.date)}. ` +
    'What exact date should be used?'
  ).slice(0, 500);
}
