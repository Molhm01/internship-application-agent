import { z } from 'zod';

/**
 * A date, in exactly the precision the applicant stated it at — and a control's
 * own account of the date it will accept.
 *
 * ## Why this is a schema and not a string
 *
 * On a live Lincoln Electric application the profile held `2021-07`, the
 * employer's From Date box displayed `MM/DD/YYYY`, and the agent typed
 * `2021-07` into it. The form answered "Invalid date." Nothing in the system
 * was wrong about the *fact* — July 2021 is when the job started — and
 * everything was wrong about the *representation*: a stored value was posted
 * verbatim into a control that had stated, in its placeholder, a completely
 * different shape.
 *
 * A string cannot carry the one fact that decides whether that conversion is
 * even possible: whether a day is known. `2021-07` and `2021-07-01` are both
 * strings; only one of them is something the applicant said. So a date travels
 * through Agent Mode as parts plus a `precision`, and a control that wants
 * `MM/DD/YYYY` from a `month`-precision date is a question for the applicant
 * rather than an arithmetic problem.
 *
 * ## The rule this exists to enforce
 *
 * A day is never invented. Not the first of the month, not the fifteenth, not
 * the last — unless the applicant has explicitly stored a convention saying
 * which. `07/01/2021` on an employment record is a claim about a start date,
 * and it is the applicant's claim to make.
 *
 * There is deliberately no clock anywhere in this module or the logic beside
 * it. `precision: 'present'` says a role is current; it does not say the end
 * date is today, and there is no member here in which today could be put.
 */

/**
 * How precisely a stored date is known.
 *
 * `present` is a precision rather than a flag because it is genuinely a
 * different kind of answer: a role that has not ended has no end date to
 * format, and the correct action on an End Date control is to find the form's
 * own "I currently work here" mechanism rather than to write anything.
 */
export const datePrecisionSchema = z.enum(['day', 'month', 'year', 'present', 'unknown']);
export type DatePrecision = z.infer<typeof datePrecisionSchema>;

/**
 * One date, normalized, carrying its own precision.
 *
 * `.strict()`, and every component is a number rather than a pre-rendered
 * string — there is nowhere here to put `"2021-07"`, which is exactly the value
 * that reached the employer's DOM. Rendering happens once, at the moment of
 * execution, against the control that is going to receive it.
 */
export const normalizedDateSchema = z
  .object({
    /** Absent only for `present` and `unknown`. */
    year: z.number().int().min(1900).max(2100).nullable().default(null),
    /** 1–12. Null when the profile stated only a year. */
    month: z.number().int().min(1).max(12).nullable().default(null),
    /** 1–31. Null when the profile stated only a month and a year. */
    day: z.number().int().min(1).max(31).nullable().default(null),
    precision: datePrecisionSchema,
    /**
     * Which stored convention supplied the day, when one did.
     *
     * Present *only* when a day was added that the profile did not state, so a
     * value carrying a day the applicant never gave says so about itself and
     * the safety layer can check that the applicant actually approved it.
     */
    dayFromConvention: z.enum(['first_day', 'last_day']).optional(),
  })
  .strict();

export type NormalizedDate = z.infer<typeof normalizedDateSchema>;

/**
 * What the applicant has approved doing when a control demands a day their
 * profile does not hold.
 *
 * `ask` is the default and is the only value that can arise without the
 * applicant having chosen it. The other two are consent, recorded once, to a
 * specific substitution — which is what makes writing `07/01/2021` a thing the
 * applicant decided rather than a thing the agent guessed.
 */
export const dayConventionSchema = z.enum(['ask', 'first_day', 'last_day']);
export type DayConvention = z.infer<typeof dayConventionSchema>;

/**
 * The shapes a control can ask a date to take.
 *
 * The single vocabulary for this across the repo: `shared/logic/dateValues.ts`
 * takes its `DateShape` from here rather than declaring a second one, so the
 * legacy deterministic matcher and Agent Mode can never disagree about what
 * `us_full` means.
 *
 * Note what is *not* here: a shape for "whatever the picker displays". An
 * `<input type="date">` rendering `07/12/2021` to a US user holds
 * `2021-07-12`, and that underlying value is `iso_full` — writing the displayed
 * form into it silently sets the control to nothing. The distinction that
 * matters is therefore not a separate shape but a separate *evidence* source: a
 * shape read from the input's own `type` is a contract the browser enforces,
 * and one read from a placeholder is only the page's example.
 */
export const dateShapeSchema = z.enum([
  'iso_full', // 2021-07-12 — also the value an <input type="date"> holds
  'iso_month', // 2021-07 — also the value an <input type="month"> holds
  'us_full', // 07/12/2021
  'us_month', // 07/2021
  'month_name_year', // July 2021
  'year_only', // 2021
]);

export type DateShape = z.infer<typeof dateShapeSchema>;

/**
 * What one date control said about itself, read from the live element.
 *
 * Every member is the *page's* own text or the browser's own state — never
 * anything about the applicant — so this is safe to carry into an observation
 * and into an exported trace. `evidence` names which of the readings decided
 * the shape, because "the placeholder said so" and "the input type said so" are
 * different levels of certainty and a wrong format is worth being able to trace
 * back to the thing that claimed it.
 */
export const dateRequirementSchema = z
  .object({
    shape: dateShapeSchema,
    /** Which reading settled the shape. */
    evidence: z
      .enum([
        'input_type',
        'existing_value',
        'pattern',
        'placeholder',
        'help_text',
        'bounds',
        'default',
      ])
      .default('default'),
    /** The control's own `type`, when it is an input. */
    inputType: z.string().max(40).default(''),
    /** The employer's own example text. Page content, not applicant content. */
    placeholder: z.string().max(120).default(''),
    pattern: z.string().max(200).default(''),
    min: z.string().max(40).default(''),
    max: z.string().max(40).default(''),
    /** True when a written value must carry a day. */
    needsDay: z.boolean().default(false),
    /** True when a written value must carry a month. */
    needsMonth: z.boolean().default(true),
  })
  .strict();

export type DateRequirement = z.infer<typeof dateRequirementSchema>;

/**
 * How the page judged a date after it was written.
 *
 * Three independent readings, because none of them is sufficient alone. A
 * custom ATS validator can reject a value the browser considers perfectly
 * valid — which is precisely what "Invalid date." was — and a native control
 * can be invalid while the page shows no message at all.
 */
export const dateValidationStateSchema = z
  .object({
    /** `input.validity.valid`, or true where there is no constraint API. */
    nativeValid: z.boolean().default(true),
    /** `aria-invalid="true"` on the control. */
    ariaInvalid: z.boolean().default(false),
    /** The employer's own complaint. Page text, never applicant text. */
    message: z.string().max(300).default(''),
  })
  .strict();

export type DateValidationState = z.infer<typeof dateValidationStateSchema>;
