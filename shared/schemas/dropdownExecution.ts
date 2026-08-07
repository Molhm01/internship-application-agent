import { z } from 'zod';
import { idSchema } from './common.js';

/**
 * What one dropdown attempt did, and where it stopped.
 *
 * This exists because "Autofill failed" was the only thing a dropdown could say.
 * A control whose list never opened, a control whose list opened and offered
 * nothing the profile could answer, a control that was clicked and reverted, and
 * a question nobody has an answer to were the same red badge — four different
 * repairs behind one word. Each stage now has a name, and the name is the
 * failure code.
 *
 * Nothing here carries a value the applicant typed. `desiredSemanticValue` and
 * `matchedOptionText` are the *page's* vocabulary and the answer chosen from it,
 * and the trace strips both before anything is exported (see `runTrace.ts`).
 */

/**
 * The widget shape, decided from what the element actually is rather than from
 * what it calls itself.
 *
 * A `role="combobox"` on a `<div>` and a `role="combobox"` on an `<input>` are
 * driven completely differently — the first is clicked, the second is typed into
 * — and treating them alike is why searchable controls sat with a query in the
 * box and no selection made.
 */
export const dropdownKindSchema = z.enum([
  /** `<select>` with its options in the DOM already. */
  'native_select',
  /** `<select multiple>`. */
  'native_multi_select',
  /** A group of `input[type=radio]`. */
  'radio_group',
  /** A group of `input[type=checkbox]`. */
  'checkbox_group',
  /** `role="combobox"` on a non-input element, or a `button[aria-haspopup]`. */
  'aria_combobox',
  /** `input[role=combobox][aria-autocomplete=list|both]` — filtered by typing. */
  'searchable_combobox',
  /** A button or div that opens a `role="menu"` of `role="menuitem"` entries. */
  'button_menu',
  /** A permanently rendered `role="listbox"`. */
  'listbox',
  /** Nothing above matched. Never driven; reported. */
  'unknown',
]);

export type DropdownKind = z.infer<typeof dropdownKindSchema>;

/** Kinds whose choices do not exist in the DOM until the control is opened. */
export const OPENS_TO_REVEAL: readonly DropdownKind[] = [
  'aria_combobox',
  'searchable_combobox',
  'button_menu',
];

/**
 * Where an attempt stopped. One member per stage of the engine, so the report
 * can name the stage rather than the outcome.
 */
export const dropdownFailureCodeSchema = z.enum([
  /** The scanned control was not on the page when the attempt ran. */
  'CONTROL_NOT_FOUND',
  /** The control is present and refuses interaction. */
  'CONTROL_DISABLED',
  /** Click, keyboard, and typing all failed to open it. */
  'OPEN_FAILED',
  /** It opened and no listbox/menu could be tied to *this* control. */
  'OPTION_CONTAINER_NOT_FOUND',
  /** The container exists and holds nothing selectable. */
  'NO_OPTIONS_FOUND',
  /** Options were read and none is the requested answer. */
  'OPTION_NOT_FOUND',
  /** Several options matched equally. Never resolved by picking one. */
  'AMBIGUOUS_OPTION_MATCH',
  /** No offered option is defensibly equivalent to the answer. */
  'NO_SEMANTIC_OPTION_MATCH',
  /** The right option exists and the page will not let it be chosen. */
  'OPTION_DISABLED',
  /** The option element vanished between matching and clicking. */
  'OPTION_CLICK_FAILED',
  /** The click landed and the control's own state never changed. */
  'SELECTION_NOT_ACCEPTED',
  /** The control changed and does not display the option that was chosen. */
  'VERIFICATION_FAILED',
  /** A dependent control never received the choices its parent produces. */
  'DEPENDENT_CONTROL_NOT_REFRESHED',
  /**
   * Nothing saved answers this question. Not a dropdown failure at all — the
   * engine is never invoked for one, and this member exists so a caller can say
   * so in the same vocabulary instead of borrowing a physical failure.
   */
  'ANSWER_UNKNOWN',
]);

export type DropdownFailureCode = z.infer<typeof dropdownFailureCodeSchema>;

/** How the chosen option was tied to the requested answer. */
export const dropdownMatchMethodSchema = z.enum([
  'literal',
  'alias',
  'region_suffix',
  'semantic',
  'other_fallback',
  'none',
]);

export type DropdownMatchMethod = z.infer<typeof dropdownMatchMethodSchema>;

export const dropdownExecutionResultSchema = z
  .object({
    fieldId: idSchema,
    dropdownKind: dropdownKindSchema,
    /** The answer the resolver settled on. Never a selector, never an index. */
    desiredSemanticValue: z.string().max(1000),
    /** How many choices the control offered *at the moment of the attempt*. */
    optionCount: z.number().int().nonnegative(),
    matchMethod: dropdownMatchMethodSchema.default('none'),
    matchedOptionText: z.string().max(1000).optional(),
    /** True once the engine physically interacted with an option. */
    executionAttempted: z.boolean(),
    /** True only when observed control state confirms the choice. */
    verified: z.boolean(),
    /** What the control displayed afterwards, for the report to quote. */
    observedValue: z.string().max(2000).optional(),
    failureCode: dropdownFailureCodeSchema.optional(),
    /** A sentence naming the actual cause. Never a bare failure. */
    reason: z.string().max(1000),
    durationMs: z.number().nonnegative().max(600_000),
  })
  .strict();

export type DropdownExecutionResult = z.infer<typeof dropdownExecutionResultSchema>;

/**
 * What a dropdown attempt is allowed to say about itself in a diagnostic.
 *
 * A strict subset of the result above, and the omissions are the point: no
 * `desiredSemanticValue`, no `matchedOptionText`, no `observedValue`. Those name
 * the applicant's own answer, and a trace is a document people paste into bug
 * reports. What survives is the shape of the control, how many choices it
 * offered, and how a match was reached — which is everything needed to tell
 * "the list never opened" from "the list opened and had nothing in it" from
 * "the answer is not on this form".
 */
export const dropdownTraceSchema = z
  .object({
    kind: dropdownKindSchema,
    optionCount: z.number().int().nonnegative(),
    matchMethod: dropdownMatchMethodSchema,
    failureCode: dropdownFailureCodeSchema.optional(),
  })
  .strict();

export type DropdownTrace = z.infer<typeof dropdownTraceSchema>;

/** The diagnostic view of one attempt, with every value stripped. */
export function toDropdownTrace(result: DropdownExecutionResult): DropdownTrace {
  return dropdownTraceSchema.parse({
    kind: result.dropdownKind,
    optionCount: result.optionCount,
    matchMethod: result.matchMethod,
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  });
}
