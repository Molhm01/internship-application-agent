import type { DetectedField } from '../schemas/fields.js';
import type { DateShape } from '../schemas/dates.js';

/**
 * The one place a stored date becomes a value on a form.
 *
 * This module has no clock. There is deliberately no `Date.now()`, no
 * `new Date()`, and no parameter through which a caller could pass one in —
 * because the failure it exists to end was a *missing* graduation date arriving
 * on an employer's application as the current date. A date the profile does not
 * state has no formatting; it has an outcome, and that outcome is
 * `confirmation_required`.
 *
 * The second rule is that a day is never invented. A graduation is stored the
 * way it is known — "May 2027" — and writing `2027-05-01` into a control that
 * demands a full date states a day the applicant never gave. That is a
 * misstatement of record, so it is refused and handed back to the user.
 */

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A stored date, in exactly the precision it was stored at. */
export interface DateParts {
  year: string;
  /** Two digits. Absent when the profile stated only a year. */
  month?: string;
  /** Two digits. Absent when the profile stated only a month and a year. */
  day?: string;
}

/**
 * Reads a stored date.
 *
 * Accepts only the three shapes the profile schema can hold — `YYYY`,
 * `YYYY-MM`, `YYYY-MM-DD` — and returns `null` for everything else, including
 * strings `Date.parse` would happily accept. Being liberal here is how "n/a" or
 * "Spring 2027" turns into a real date somewhere downstream, and a value nobody
 * wrote is exactly what this module refuses to produce.
 */
export function parseStoredDate(raw: string | undefined): DateParts | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (!year) return null;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return null;
  if (day !== undefined && (Number(day) < 1 || Number(day) > 31)) return null;
  return {
    year,
    ...(month !== undefined ? { month } : {}),
    ...(day !== undefined ? { day } : {}),
  };
}

/**
 * The shapes a control can ask a date to take.
 *
 * Declared once, in `schemas/dates.ts`, and re-exported here so the two date
 * modules cannot drift apart. Agent Mode's `set_date` and this module's
 * `formatDateForField` both render against this vocabulary, which is what stops
 * "MM/DD/YYYY" meaning one thing on the legacy path and another on the agent's.
 */
export type { DateShape };

/** Whether a shape needs a day the profile may not hold. */
export function shapeNeedsDay(shape: DateShape): boolean {
  return shape === 'iso_full' || shape === 'us_full';
}

function shapeNeedsMonth(shape: DateShape): boolean {
  return shape !== 'year_only';
}

/**
 * The shape a control is asking for, read from the control itself.
 *
 * Evidence order matters: the input's own type is a contract the browser
 * enforces, a `pattern` is the page's stated rule, a placeholder is the page's
 * example, and the value already sitting in the box is the page's own
 * demonstration. Only when the control says nothing at all does the question
 * being asked decide, and a graduation — always stored as a month and a year —
 * defaults to the shape it is actually known at.
 */
export function requiredDateShape(field: DetectedField): DateShape {
  if (field.fieldType === 'date') return 'iso_full';
  if (field.fieldType === 'month') return 'iso_month';

  const pattern = field.pattern ?? '';
  const placeholder = field.placeholder ?? '';
  const help = field.helpText ?? '';
  const existing = typeof field.currentValue === 'string' ? field.currentValue : '';
  const hints = `${pattern} ${placeholder} ${help}`;

  // The page demonstrating its own format beats every hint about it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(existing.trim())) return 'iso_full';
  if (/^\d{4}-\d{2}$/.test(existing.trim())) return 'iso_month';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(existing.trim())) return 'us_full';
  if (/^\d{2}\/\d{4}$/.test(existing.trim())) return 'us_month';

  // A `pattern` is regular-expression *source text*, so its digit classes are
  // the two characters `\d` — not a digit. Testing it with a regex that
  // expected a digit there matched nothing, and a control that had stated its
  // format exactly was treated as if it had said nothing.
  const shapeOfPattern = pattern
    .replace(/\\d|\[0-9\]/g, '9')
    .replace(/[$^]/g, '')
    .trim();
  if (/mm\s*\/\s*dd\s*\/\s*yyyy/i.test(hints) || /^9\{2\}\/9\{2\}\/9\{4\}$/.test(shapeOfPattern)) {
    return 'us_full';
  }
  if (/mm\s*\/\s*yyyy/i.test(hints) || /^9\{2\}\/9\{4\}$/.test(shapeOfPattern)) return 'us_month';
  if (/^9\{4\}-9\{2\}-9\{2\}$/.test(shapeOfPattern)) return 'iso_full';
  if (/^9\{4\}-9\{2\}$/.test(shapeOfPattern)) return 'iso_month';
  if (/yyyy\s*-\s*mm\s*-\s*dd/i.test(hints)) return 'iso_full';
  if (/yyyy\s*-\s*mm(?!\s*-)/i.test(hints)) return 'iso_month';
  // "Month YYYY", "e.g. May 2027", "MMM YYYY".
  if (/\b(month\s+yyyy|mmm+\s+yyyy)\b/i.test(hints)) return 'month_name_year';
  if (new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+\\d{4}\\b`, 'i').test(hints)) {
    return 'month_name_year';
  }
  if (/^\s*yyyy\s*$/i.test(placeholder) || /^\s*\d{4}\s*$/.test(placeholder)) return 'year_only';

  // `min`/`max` on a bare text control are written in the format the control
  // accepts, so they are the page stating its own rule.
  for (const bound of [field.min, field.max]) {
    if (typeof bound !== 'string') continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(bound)) return 'iso_full';
    if (/^\d{4}-\d{2}$/.test(bound)) return 'iso_month';
  }

  if (field.canonicalKey === 'graduation_year') return 'year_only';
  // A graduation, an enrolment, or an availability date asked for as free text
  // is written the way people write it, and the way the profile holds it.
  return 'month_name_year';
}

/** What formatting a stored date for a control produced. */
export type DateFormatOutcome =
  | { kind: 'value'; value: string; shape: DateShape }
  | { kind: 'confirmation_required'; reason: string };

function render(parts: DateParts, shape: DateShape): string {
  const monthName = parts.month ? MONTH_NAMES[Number(parts.month) - 1] : undefined;
  switch (shape) {
    case 'iso_full':
      return `${parts.year}-${parts.month}-${parts.day}`;
    case 'iso_month':
      return `${parts.year}-${parts.month}`;
    case 'us_full':
      return `${parts.month}/${parts.day}/${parts.year}`;
    case 'us_month':
      return `${parts.month}/${parts.year}`;
    case 'month_name_year':
      return monthName ? `${monthName} ${parts.year}` : parts.year;
    case 'year_only':
      return parts.year;
  }
}

/**
 * Formats a stored date for one control, or explains why it cannot be.
 *
 * The reason returned is safe to show: it names the precision the profile holds
 * and the precision the control demands, and never quotes anything else about
 * the applicant.
 */
export function formatDateForField(
  field: DetectedField,
  raw: string | undefined,
): DateFormatOutcome {
  if (raw === undefined || raw.trim() === '') {
    return {
      kind: 'confirmation_required',
      reason: 'No date is saved for this question, and one is never invented.',
    };
  }
  const parts = parseStoredDate(raw);
  if (!parts) {
    return {
      kind: 'confirmation_required',
      reason:
        'The saved value for this question is not a date this build can read ' +
        '(expected YYYY, YYYY-MM, or YYYY-MM-DD).',
    };
  }
  const shape = requiredDateShape(field);
  if (shapeNeedsDay(shape) && parts.day === undefined) {
    return {
      kind: 'confirmation_required',
      reason:
        'This control requires a full day, month and year, and only a month and year are saved. ' +
        'A day is never chosen for you.',
    };
  }
  if (shapeNeedsMonth(shape) && parts.month === undefined) {
    return {
      kind: 'confirmation_required',
      reason:
        'This control requires a month, and only a year is saved. A month is never chosen for you.',
    };
  }
  return { kind: 'value', value: render(parts, shape), shape };
}

/**
 * The value for a control that takes the month of a date on its own.
 *
 * A month select is labelled either by name ("May") or by number ("05"), and
 * the page's own list decides which. Offering "05" to a list of names is how a
 * split graduation control ended up half-filled — the year landed and the month
 * did not.
 *
 * A control with no list at all gets the two-digit number: that is how the
 * profile stores it, it is what an `MM` box asks for, and the month name is
 * only ever chosen on the evidence of a list that spells one.
 */
export function monthValueForField(field: DetectedField, raw: string | undefined): string | null {
  const parts = parseStoredDate(raw);
  if (!parts?.month) return null;
  const name = MONTH_NAMES[Number(parts.month) - 1];
  if (name === undefined) return parts.month;
  const spelled = (field.options ?? []).some((option) =>
    [option.label, option.value].some((text) => text.trim().toLowerCase() === name.toLowerCase()),
  );
  if (spelled) return name;
  // A free-text month box that shows its own example follows it.
  if (new RegExp(`\\b(${MONTH_NAMES.join('|')})\\b`, 'i').test(field.placeholder ?? '')) {
    return name;
  }
  return parts.month;
}

/** The four-digit year of a stored date, or null when none is stored. */
export function yearValue(raw: string | undefined): string | null {
  return parseStoredDate(raw)?.year ?? null;
}

/** Canonical questions whose answer is a date taken from the applicant's record. */
export const FACTUAL_DATE_QUESTIONS = [
  'graduation_date',
  'graduation_month',
  'graduation_year',
  'education_start_date',
  'employment_start_date',
  'employment_end_date',
  'earliest_start_date',
] as const;

export function isFactualDateQuestion(canonical: string | undefined): boolean {
  return (
    canonical !== undefined && (FACTUAL_DATE_QUESTIONS as readonly string[]).includes(canonical)
  );
}
