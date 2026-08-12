import {
  dateRequirementSchema,
  dateValidationStateSchema,
  MONTH_NAMES,
  type DateRequirement,
  type DateShape,
  type DateValidationState,
  type DetectedField,
} from '@internship-agent/shared';
import { elementById, isVisible, scopeOf } from '../scanner/optionDiscovery.js';

/**
 * Reading a date control: what it is, what format it wants, and whether it
 * accepted what it was given.
 *
 * ## Why this reads the element and not the scan
 *
 * The same lesson as the dropdown repair, applied to dates. The scanner types a
 * Lincoln Electric From Date box as ordinary text, because that is literally
 * what it is — `<input type="text">` — and an agent told "this is a text box"
 * will type a text answer into it. It typed `2021-07`, the profile's own
 * storage format, and the employer answered "Invalid date."
 *
 * What the scanner could not see, and what this reads, is that the control has
 * `placeholder="MM/DD/YYYY"` written on it. That placeholder is the employer
 * stating its own contract, and it is the difference between a box that takes
 * any string and a box that takes exactly one shape of string.
 *
 * ## Evidence order
 *
 * Strongest first, and the order is not arbitrary:
 *
 *  1. `type=date` / `type=month` — a contract the *browser* enforces. Its
 *     underlying value is ISO no matter what the picker renders, so this
 *     outranks anything written on the control.
 *  2. The value already in the box — the page demonstrating its own format.
 *  3. `pattern` — the page stating its rule as a regular expression.
 *  4. The placeholder and the label — the page giving an example.
 *  5. `min` / `max` — written in the format the control accepts.
 *
 * Anything below the first is a *claim* rather than a guarantee, which is why
 * the requirement records which reading decided it: a date the employer refuses
 * is worth being able to trace back to the thing that claimed the format.
 */

/** `MM/DD/YYYY`, `DD-MM-YYYY`, `YYYY-MM` and their kin, as written by humans. */
const MASK_SHAPES: readonly { pattern: RegExp; shape: DateShape }[] = [
  { pattern: /m{1,2}\s*\/\s*d{1,2}\s*\/\s*y{2,4}/i, shape: 'us_full' },
  { pattern: /m{1,2}\s*-\s*d{1,2}\s*-\s*y{2,4}/i, shape: 'us_full' },
  { pattern: /y{4}\s*-\s*m{1,2}\s*-\s*d{1,2}/i, shape: 'iso_full' },
  { pattern: /y{4}\s*\/\s*m{1,2}\s*\/\s*d{1,2}/i, shape: 'iso_full' },
  { pattern: /m{1,2}\s*\/\s*y{2,4}/i, shape: 'us_month' },
  { pattern: /y{4}\s*-\s*m{1,2}(?!\s*-)/i, shape: 'iso_month' },
  { pattern: /\bmonth\s*\/?\s*y{4}\b/i, shape: 'month_name_year' },
  { pattern: /\bm{3,4}\s+y{4}\b/i, shape: 'month_name_year' },
];

/** A literal date the page has written somewhere, demonstrating its format. */
const LITERAL_SHAPES: readonly { pattern: RegExp; shape: DateShape }[] = [
  { pattern: /^\d{4}-\d{2}-\d{2}$/, shape: 'iso_full' },
  { pattern: /^\d{4}-\d{2}$/, shape: 'iso_month' },
  { pattern: /^\d{2}\/\d{2}\/\d{4}$/, shape: 'us_full' },
  { pattern: /^\d{2}\/\d{4}$/, shape: 'us_month' },
  { pattern: /^\d{4}$/, shape: 'year_only' },
];

/**
 * Whether this element is a date control at all.
 *
 * Deliberately *not* "does its label contain the word date". A label is about
 * the question; this is about the control, and a `<select>` of month names
 * under a label reading "Graduation Date" is a dropdown that must be opened and
 * chosen from, not something `set_date` may write into. So a list control is
 * never a date control here, whatever it is called.
 */
export function isDateControl(element: HTMLElement | null): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  const type = element.type.toLowerCase();
  if (type === 'date' || type === 'month' || type === 'week' || type === 'datetime-local') {
    return true;
  }
  if (type !== 'text' && type !== 'tel' && type !== '') return false;
  return writtenShapeOf(element) !== null;
}

/** The text a control writes about itself: placeholder, title, aria-label, mask. */
function selfDescription(element: HTMLInputElement): string {
  return [
    element.placeholder,
    element.getAttribute('title') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('data-format') ?? '',
    element.getAttribute('data-date-format') ?? '',
  ].join(' ');
}

/**
 * The shape a *text-backed* control has written on itself, or null.
 *
 * Null is the honest answer for a text box that says nothing about dates, and
 * it is what keeps Address and City out of `DATE_INPUT`: a box with no mask, no
 * date pattern and no date-shaped value is a text box, and this returns nothing
 * for it.
 */
function writtenShapeOf(element: HTMLInputElement): DateShape | null {
  const description = selfDescription(element);
  for (const candidate of MASK_SHAPES) {
    if (candidate.pattern.test(description)) return candidate.shape;
  }
  // A `pattern` is regular-expression *source*, so its digit classes are the
  // two characters `\d` rather than a digit. Reducing them first is what let a
  // control that had stated its format exactly stop being read as silent.
  const source = (element.getAttribute('pattern') ?? '')
    .replace(/\\d|\[0-9\]/g, '9')
    .replace(/[$^]/g, '')
    .trim();
  if (/^9\{2\}\/9\{2\}\/9\{4\}$/.test(source)) return 'us_full';
  if (/^9\{2\}\/9\{4\}$/.test(source)) return 'us_month';
  if (/^9\{4\}-9\{2\}-9\{2\}$/.test(source)) return 'iso_full';
  if (/^9\{4\}-9\{2\}$/.test(source)) return 'iso_month';
  for (const candidate of LITERAL_SHAPES) {
    if (candidate.pattern.test(element.value.trim())) return candidate.shape;
  }
  for (const bound of [element.getAttribute('min') ?? '', element.getAttribute('max') ?? '']) {
    for (const candidate of LITERAL_SHAPES) {
      if (candidate.pattern.test(bound.trim())) return candidate.shape;
    }
  }
  return null;
}

function needsDay(shape: DateShape): boolean {
  return shape === 'iso_full' || shape === 'us_full';
}

/**
 * Everything this control said about the date it wants.
 *
 * `field` is consulted only for the help text beside the control — the "Enter
 * as MM/DD/YYYY" line a page puts under the box, which the element itself never
 * carries. Every other reading comes from the live element, because the element
 * is the thing that is going to reject the value.
 */
export function dateRequirementOf(
  element: HTMLElement | null,
  field?: DetectedField | null,
): DateRequirement | null {
  if (!(element instanceof HTMLInputElement)) return null;
  const type = element.type.toLowerCase();
  const base = {
    inputType: type.slice(0, 40),
    placeholder: element.placeholder.slice(0, 120),
    pattern: (element.getAttribute('pattern') ?? '').slice(0, 200),
    min: (element.getAttribute('min') ?? '').slice(0, 40),
    max: (element.getAttribute('max') ?? '').slice(0, 40),
  };

  // 1. The browser's own contract. An <input type="date"> holds `2021-07-12`
  //    however its picker chooses to render that, so this outranks every hint
  //    written on the control — including a placeholder that disagrees.
  if (type === 'date' || type === 'datetime-local') {
    return dateRequirementSchema.parse({
      ...base,
      shape: 'iso_full',
      evidence: 'input_type',
      needsDay: true,
      needsMonth: true,
    });
  }
  if (type === 'month') {
    return dateRequirementSchema.parse({
      ...base,
      shape: 'iso_month',
      evidence: 'input_type',
      needsDay: false,
      needsMonth: true,
    });
  }

  // 2-5. A text-backed control, read from what it says about itself. The
  //      Lincoln case, and the one the scanner alone could never see.
  const written = writtenShapeOf(element);
  if (written !== null) {
    return dateRequirementSchema.parse({
      ...base,
      shape: written,
      evidence: element.placeholder.trim().length > 0 ? 'placeholder' : 'pattern',
      needsDay: needsDay(written),
      needsMonth: written !== 'year_only',
    });
  }

  // The help text under the box — page content the element itself never holds.
  const help = `${field?.helpText ?? ''} ${field?.validationText ?? ''}`;
  for (const candidate of MASK_SHAPES) {
    if (!candidate.pattern.test(help)) continue;
    return dateRequirementSchema.parse({
      ...base,
      shape: candidate.shape,
      evidence: 'help_text',
      needsDay: needsDay(candidate.shape),
      needsMonth: candidate.shape !== 'year_only',
    });
  }
  if (new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+\\d{4}\\b`, 'i').test(help)) {
    return dateRequirementSchema.parse({
      ...base,
      shape: 'month_name_year',
      evidence: 'help_text',
      needsDay: false,
      needsMonth: true,
    });
  }
  return null;
}

/** Wording by which an employer's form says a date is wrong. */
const DATE_COMPLAINT =
  /\binvalid\b|\bnot\s+a\s+valid\b|\bmust\s+be\b|\bformat\b|\brequired\b|\benter\s+a\s+(valid\s+)?date\b|\bdate\s+is\b/i;

/** Anything a form puts an error into, near the control it is about. */
const ERROR_TEXT_SELECTOR =
  '[role="alert"],[aria-live="assertive"],[aria-live="polite"],[class*="error" i],[class*="invalid" i]';

function textOf(node: Element | null): string {
  if (!(node instanceof HTMLElement) || !isVisible(node)) return '';
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 && text.length <= 300 ? text : '';
}

/**
 * How the page currently judges this control.
 *
 * Three readings, and none of them is trusted alone — which is the whole point.
 * Native validity is meaningful and insufficient: a Lincoln text box holding
 * `2021-07` is perfectly valid HTML, and the employer's own script is what
 * decided it was not a date. `aria-invalid` is the page flagging the control,
 * and the message is the page saying why.
 *
 * The container walk stops after three ancestors so a banner about a different
 * field is never attributed to this one, and it only runs for a control the
 * page has actually flagged.
 */
export function readDateValidation(element: HTMLElement | null): DateValidationState {
  if (!(element instanceof HTMLInputElement)) {
    return dateValidationStateSchema.parse({});
  }
  const nativeValid = element.willValidate ? element.validity.valid : true;
  const ariaInvalid = element.getAttribute('aria-invalid') === 'true';

  let message = '';
  if (element.willValidate && !element.validity.valid && element.validationMessage) {
    message = element.validationMessage.slice(0, 300);
  }

  if (!message) {
    const named = [
      ...(element.getAttribute('aria-errormessage') ?? '').split(/\s+/),
      ...(element.getAttribute('aria-describedby') ?? '').split(/\s+/),
    ].filter(Boolean);
    // `elementById`/`scopeOf` rather than a `#id` query: the repo already owns
    // one shadow-root-aware lookup, and an id on a real employer page is
    // routinely not a valid CSS identifier.
    for (const id of named) {
      const text = textOf(elementById(scopeOf(element), id));
      // A described-by node is often help text — "Enter as MM/DD/YYYY" — rather
      // than a complaint, so only wording that actually complains counts.
      if (text && DATE_COMPLAINT.test(text)) {
        message = text;
        break;
      }
    }
  }

  if (!message && ariaInvalid) {
    let container: HTMLElement | null = element.parentElement;
    for (let depth = 0; depth < 3 && container && !message; depth += 1) {
      for (const node of Array.from(container.querySelectorAll(ERROR_TEXT_SELECTOR))) {
        const text = textOf(node);
        if (text) {
          message = text;
          break;
        }
      }
      container = container.parentElement;
    }
  }

  return dateValidationStateSchema.parse({ nativeValid, ariaInvalid, message });
}

/**
 * Whether the page accepted this date, as distinct from merely holding it.
 *
 * The rule the acceptance gate turns on: a control displaying `07/12/2021`
 * beside an employer message reading "Invalid date." has *not* been answered,
 * and reporting that as success is the failure this whole repair exists for. So
 * the value matching is necessary and never sufficient — the page's own verdict
 * is checked as well, and it outranks the text in the box.
 */
export function dateAccepted(
  element: HTMLElement | null,
  written: string,
): { accepted: boolean; validation: DateValidationState; held: string } {
  const validation = readDateValidation(element);
  const held = element instanceof HTMLInputElement ? element.value : '';
  const holdsIt = held.trim() === written.trim();
  return {
    accepted:
      holdsIt && validation.nativeValid && !validation.ariaInvalid && validation.message === '',
    validation,
    held,
  };
}
