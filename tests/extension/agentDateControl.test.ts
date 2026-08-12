import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  applyDayConvention,
  compareNormalizedDates,
  dateQuestionFor,
  formatNormalizedDate,
  isChronologyInvalid,
  lastDayOfMonth,
  normalizeStoredDate,
  dateRequirementSchema,
  normalizedDateSchema,
  observedElementSchema,
  pageObservationSchema,
  profileSchema,
  type DateRequirement,
  type DayConvention,
  type NormalizedDate,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import { checkDecision } from '../../extension/src/agent/agentSafety.js';
import { decideDeterministically } from '../../extension/src/agent/agentDecision.js';
import { AgentHistory } from '../../extension/src/agent/agentHistory.js';
import { interactionTypeOf, observePage } from '../../extension/src/agent/pageObserver.js';
import {
  dateAccepted,
  dateRequirementOf,
  isDateControl,
  readDateValidation,
} from '../../extension/src/agent/dateControl.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { trustedValuesFor } from '../../extension/src/background/agentController.js';

/**
 * A date is converted to the shape the control asked for, or it is not written.
 *
 * ## The live failure this file is about
 *
 * On a real Lincoln Electric application the Work Experience "From Date" box
 * displayed `MM/DD/YYYY`. The profile held the start date as `2021-07`. The
 * agent typed `2021-07` into the box and the employer answered "Invalid date."
 *
 * Two separate defects, and only one of them is a formatting bug:
 *
 *  1. **No conversion existed.** The saved value went to the DOM verbatim,
 *     because `type` carries a string chosen before anything looked at the
 *     control. Fixed by `set_date`, which carries the date as *parts* and
 *     renders it against the control at the moment of writing.
 *
 *  2. **Even converted, the answer would have been invented.** `MM/DD/YYYY`
 *     wants a day and July 2021 does not contain one. `07/01/2021` is not a
 *     better rendering of the saved fact; it is a different fact, and one the
 *     applicant never stated. So it is refused, and the applicant is asked.
 *
 * The tests are grouped by the guarantee each one holds, and the two that carry
 * the most weight are "the previous live failure is now impossible" and "a day
 * is never invented" — because those are the ones that can regress silently.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 200,
    height: 32,
    top: 0,
    left: 0,
    right: 200,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

let handle = 0;
function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  handle += 1;
  return observedElementSchema.parse({
    elementId: `e${handle}`,
    label: `Field ${handle}`,
    kind: 'date',
    interactionType: 'DATE_INPUT',
    policy: 'KNOWN_FACT',
    ...patch,
  });
}

function observation(elements: ObservedElement[]): PageObservation {
  return pageObservationSchema.parse({
    observationId: 'obs-date',
    elements,
    requiredOutstanding: elements.filter((entry) => entry.required).length,
  });
}

function date(parts: Partial<NormalizedDate>): NormalizedDate {
  return normalizedDateSchema.parse({ precision: 'day', ...parts });
}

/** A control's stated format, filled out through the schema's own defaults. */
function requirement(patch: Partial<DateRequirement>): DateRequirement {
  return dateRequirementSchema.parse({ shape: 'us_full', ...patch });
}

/** One control, mounted, so every reading comes from a real element. */
function mount(html: string, id = 'control'): HTMLInputElement {
  document.body.innerHTML = html;
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error('fixture is not an input');
  return found;
}

/**
 * Mounts a page, observes it, and hands back the handle for one control.
 *
 * The executor resolves handles through the registry the *observation* minted,
 * so a test that guessed at `e0` would be testing its own guess. Going through
 * `observePage` is also what makes these tests exercise the real path: the
 * classification, the requirement reading, and the handle registry all have to
 * agree for the executor call below to find anything.
 */
async function observeAndFind(html: string, label: string): Promise<string> {
  document.body.innerHTML = html;
  const observed = await observePage();
  const found = observed.elements.find((entry) => entry.label.includes(label));
  if (!found) throw new Error(`no observed element labelled ${label}`);
  return found.elementId;
}

// ---------------------------------------------------------------------------
describe('a date control is recognised as one, whatever tag it uses', () => {
  it('classifies the native pickers as DATE_INPUT', () => {
    for (const type of ['date', 'month', 'week', 'datetime-local']) {
      expect(interactionTypeOf(mount(`<input id="control" type="${type}" />`))).toBe('DATE_INPUT');
    }
  });

  it('classifies the Lincoln text-backed From Date box as DATE_INPUT', () => {
    // The live control. `<input type="text">` with a format mask written on it
    // and nothing else — which the scanner reads as a text box, which is how a
    // text answer came to be typed into it.
    const control = mount('<input id="control" type="text" placeholder="MM/DD/YYYY" />');
    expect(isDateControl(control)).toBe(true);
    expect(interactionTypeOf(control)).toBe('DATE_INPUT');
  });

  it('reads a format stated as a pattern, an aria-label, or an existing value', () => {
    expect(interactionTypeOf(mount(String.raw`<input id="control" pattern="\d{2}/\d{4}" />`))).toBe(
      'DATE_INPUT',
    );
    expect(
      interactionTypeOf(mount('<input id="control" aria-label="Start date (YYYY-MM-DD)" />')),
    ).toBe('DATE_INPUT');
    expect(interactionTypeOf(mount('<input id="control" value="2021-07-12" />'))).toBe(
      'DATE_INPUT',
    );
  });

  it('leaves an ordinary text box alone', () => {
    // The regression guard on classification itself. Address, City, Postal Code
    // and Phone must not become date controls because the word "date" appears
    // somewhere near them, so classification rests on the control's own format
    // evidence and never on its label.
    for (const html of [
      '<input id="control" type="text" />',
      '<input id="control" type="text" placeholder="Street address" />',
      '<input id="control" type="text" aria-label="Start Date" />',
      '<input id="control" type="tel" placeholder="(201) 555-0134" />',
      '<input id="control" type="text" value="Clifton" />',
    ]) {
      expect(isDateControl(mount(html))).toBe(false);
      expect(interactionTypeOf(mount(html))).not.toBe('DATE_INPUT');
    }
  });

  it('never turns a list control into a date control', () => {
    // A `<select>` of months under a label reading "Graduation Date" is a
    // dropdown. `set_date` must never be pointed at one, so the list readings
    // run first and win.
    document.body.innerHTML =
      '<select id="control"><option value="">No Selection</option><option>July</option></select>';
    const control = document.getElementById('control');
    expect(interactionTypeOf(control as HTMLElement)).toBe('NATIVE_SELECT');
    expect(isDateControl(control as HTMLElement)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the control states the format it wants, and it is read from the control', () => {
  it('reads MM/DD/YYYY off the Lincoln placeholder', () => {
    const requirement = dateRequirementOf(
      mount('<input id="control" type="text" placeholder="MM/DD/YYYY" />'),
    );
    expect(requirement?.shape).toBe('us_full');
    expect(requirement?.needsDay).toBe(true);
    expect(requirement?.evidence).toBe('placeholder');
    expect(requirement?.placeholder).toBe('MM/DD/YYYY');
  });

  it('reads MM/YYYY as a month-precision control', () => {
    const requirement = dateRequirementOf(
      mount('<input id="control" type="text" placeholder="MM/YYYY" />'),
    );
    expect(requirement?.shape).toBe('us_month');
    expect(requirement?.needsDay).toBe(false);
  });

  it('trusts the input type over anything written on the control', () => {
    // A native date picker holds `2021-07-12` however it renders that, so its
    // own type outranks a placeholder claiming otherwise. Writing the displayed
    // form into it sets the control to nothing.
    const requirement = dateRequirementOf(
      mount('<input id="control" type="date" placeholder="MM/DD/YYYY" />'),
    );
    expect(requirement?.shape).toBe('iso_full');
    expect(requirement?.evidence).toBe('input_type');
    expect(dateRequirementOf(mount('<input id="control" type="month" />'))?.shape).toBe(
      'iso_month',
    );
  });

  it('does not assume every employer wants the same format', () => {
    const shapes = [
      ['MM/DD/YYYY', 'us_full'],
      ['MM/YYYY', 'us_month'],
      ['YYYY-MM-DD', 'iso_full'],
      ['YYYY-MM', 'iso_month'],
      ['Month YYYY', 'month_name_year'],
    ] as const;
    for (const [placeholder, shape] of shapes) {
      expect(
        dateRequirementOf(mount(`<input id="control" type="text" placeholder="${placeholder}" />`))
          ?.shape,
      ).toBe(shape);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a stored date is normalized at the precision it was stored at', () => {
  it('keeps month-only data month-only', () => {
    expect(normalizeStoredDate('2021-07')).toMatchObject({
      year: 2021,
      month: 7,
      day: null,
      precision: 'month',
    });
  });

  it('reads a full date, a year, and nothing at all', () => {
    expect(normalizeStoredDate('2021-07-12')).toMatchObject({ day: 12, precision: 'day' });
    expect(normalizeStoredDate('2021')).toMatchObject({ month: null, precision: 'year' });
    expect(normalizeStoredDate(undefined).precision).toBe('unknown');
    expect(normalizeStoredDate('Spring 2027').precision).toBe('unknown');
  });

  it('reads a current role as present, and never as a date', () => {
    const current = normalizeStoredDate('2021-07', { current: true });
    expect(current.precision).toBe('present');
    expect(current.year).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('an exact date is formatted for whatever the control asked for', () => {
  const exact = date({ year: 2021, month: 7, day: 12 });

  it('renders 12 July 2021 in each shape', () => {
    expect(formatNormalizedDate(exact, 'us_full')).toMatchObject({ value: '07/12/2021' });
    expect(formatNormalizedDate(exact, 'iso_full')).toMatchObject({ value: '2021-07-12' });
    expect(formatNormalizedDate(exact, 'us_month')).toMatchObject({ value: '07/2021' });
    expect(formatNormalizedDate(exact, 'iso_month')).toMatchObject({ value: '2021-07' });
    expect(formatNormalizedDate(exact, 'month_name_year')).toMatchObject({ value: 'July 2021' });
    expect(formatNormalizedDate(exact, 'year_only')).toMatchObject({ value: '2021' });
  });

  it('never sends the profile’s own storage format to a control that wants another', () => {
    // The bug, stated as a property. `2021-07` is what the profile holds and it
    // is never what an `MM/DD/YYYY` control receives.
    const outcome = formatNormalizedDate(exact, 'us_full');
    expect(outcome.kind).toBe('value');
    if (outcome.kind === 'value') expect(outcome.value).not.toBe('2021-07');
  });
});

// ---------------------------------------------------------------------------
describe('a day is never invented', () => {
  const monthOnly = date({ year: 2021, month: 7, day: null, precision: 'month' });

  it('refuses MM/DD/YYYY from a month-precision record', () => {
    const outcome = formatNormalizedDate(monthOnly, 'us_full');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'DATE_PRECISION_INSUFFICIENT' });
  });

  it('produces none of the plausible fabrications', () => {
    // Named individually rather than asserted as "not a value", because these
    // three strings are exactly what a helpful implementation reaches for.
    const outcome = formatNormalizedDate(monthOnly, 'us_full');
    const forbidden = ['07/01/2021', '07/15/2021', '07/31/2021'];
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'value') expect(forbidden).not.toContain(outcome.value);
  });

  it('still fills a control that only wants a month and a year', () => {
    // The other half of the same rule: refusing a day does not mean refusing
    // the field. A month-precision record answers a month-precision control
    // completely.
    expect(formatNormalizedDate(monthOnly, 'us_month')).toMatchObject({ value: '07/2021' });
    expect(formatNormalizedDate(monthOnly, 'iso_month')).toMatchObject({ value: '2021-07' });
  });

  it('refuses a month it does not have', () => {
    const yearOnly = date({ year: 2021, month: null, day: null, precision: 'year' });
    expect(formatNormalizedDate(yearOnly, 'us_month')).toMatchObject({
      code: 'DATE_PRECISION_INSUFFICIENT',
    });
    expect(formatNormalizedDate(yearOnly, 'year_only')).toMatchObject({ value: '2021' });
  });
});

// ---------------------------------------------------------------------------
describe('an explicitly approved day convention, and only an explicit one', () => {
  const monthOnly = date({ year: 2021, month: 7, day: null, precision: 'month' });

  it('defaults to asking', () => {
    // Not merely the documented default — the value a caller gets by omission,
    // which is the case that matters when somebody adds a new call site.
    expect(
      profileSchema.parse({ updatedAt: '2026-08-11T00:00:00.000Z' }).preferences
        .monthYearDayConvention,
    ).toBe('ask');
    expect(formatNormalizedDate(monthOnly, 'us_full').kind).toBe('refused');
  });

  it('uses the first of the month when that is what was approved', () => {
    const outcome = formatNormalizedDate(monthOnly, 'us_full', 'first_day');
    expect(outcome).toMatchObject({
      kind: 'value',
      value: '07/01/2021',
      usedConvention: 'first_day',
    });
  });

  it('uses the last of the month when that is what was approved', () => {
    expect(formatNormalizedDate(monthOnly, 'us_full', 'last_day')).toMatchObject({
      value: '07/31/2021',
    });
    // February, and February in a leap year, because a month-length table is
    // exactly the kind of thing that is wrong for two days a year.
    const feb2021 = date({ year: 2021, month: 2, day: null, precision: 'month' });
    const feb2024 = date({ year: 2024, month: 2, day: null, precision: 'month' });
    expect(formatNormalizedDate(feb2021, 'us_full', 'last_day')).toMatchObject({
      value: '02/28/2021',
    });
    expect(formatNormalizedDate(feb2024, 'us_full', 'last_day')).toMatchObject({
      value: '02/29/2024',
    });
    expect(lastDayOfMonth(2000, 2)).toBe(29);
    expect(lastDayOfMonth(1900, 2)).toBe(28);
  });

  it('marks a date whose day came from a convention', () => {
    // The marker is what lets the safety layer tell a recorded day from a
    // supplied one three layers later, when the record itself is out of reach.
    const applied = applyDayConvention(monthOnly, 'first_day');
    expect(applied.dayFromConvention).toBe('first_day');
    expect(applyDayConvention(monthOnly, 'ask').dayFromConvention).toBeUndefined();
    // A date that already has a day is not re-decided by a convention.
    const exact = date({ year: 2021, month: 7, day: 12 });
    expect(applyDayConvention(exact, 'last_day').day).toBe(12);
  });
});

// ---------------------------------------------------------------------------
describe('the tool contract, enforced in code', () => {
  const decisionFor = (
    tool: 'type' | 'set_date',
    target: ObservedElement,
    extra: Record<string, unknown> = {},
  ) =>
    agentDecisionSchema.parse({
      kind: 'ACTION',
      reason: 'x',
      action: { tool, elementId: target.elementId, ...extra },
    });

  it('THE REGRESSION: `2021-07` cannot be typed into an MM/DD/YYYY control', () => {
    // The exact previous live failure, asserted as impossible. The decision is
    // the one the agent actually made on Lincoln Electric: type the profile's
    // stored value into the From Date box.
    const target = element({
      label: 'From Date',
      section: 'Work Experience',
      proposedValue: '2021-07',
      dateRequirement: requirement({ shape: 'us_full', needsDay: true, placeholder: 'MM/DD/YYYY' }),
    });
    const verdict = checkDecision(
      decisionFor('type', target, { value: '2021-07' }),
      observation([target]),
      new Map([[target.elementId, '2021-07']]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect(verdict.suggestedTool).toBe('set_date');
    expect(verdict.reason).toContain('MM/DD/YYYY');
  });

  it('refuses type() on a date control even when the string would be correct', () => {
    // The rule is about the tool, not the value. A guard that only rejected
    // wrong-looking strings would be a guard that lets the next one through.
    const target = element({
      proposedValue: '2021-07-12',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const verdict = checkDecision(
      decisionFor('type', target, { value: '07/12/2021' }),
      observation([target]),
      new Map([[target.elementId, '2021-07-12']]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
  });

  it('permits set_date carrying the date the profile records', () => {
    const target = element({
      proposedValue: '2021-07-12',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const verdict = checkDecision(
      decisionFor('set_date', target, {
        normalizedDate: date({ year: 2021, month: 7, day: 12 }),
      }),
      observation([target]),
      new Map([[target.elementId, '2021-07-12']]),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('refuses set_date on anything that is not a date control', () => {
    const target = element({ interactionType: 'CUSTOM_SELECT', kind: 'dropdown' });
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: date({ year: 2021, month: 7, day: 12 }) }),
      observation([target]),
      new Map(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect(verdict.suggestedTool).toBe('open_dropdown');
  });

  it('refuses a set_date whose day the profile never recorded', () => {
    // The guarantee that survives a decider being wrong. Even if something
    // upstream composed `07/01/2021` from a month-precision record, it does not
    // reach the page.
    const target = element({
      proposedValue: '2021-07',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: date({ year: 2021, month: 7, day: 1 }) }),
      observation([target]),
      new Map([[target.elementId, '2021-07']]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('DATE_PRECISION_INSUFFICIENT');
    expect(verdict.replacement?.kind).toBe('ASK_USER');
  });

  it('refuses a day that claims a convention the applicant did not store', () => {
    const target = element({
      proposedValue: '2021-07',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const claim = normalizedDateSchema.parse({
      year: 2021,
      month: 7,
      day: 1,
      precision: 'day',
      dayFromConvention: 'first_day',
    });
    // Stored preference is `ask`, so a call claiming first_day is a call
    // claiming consent that was never given.
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: claim }),
      observation([target]),
      new Map([[target.elementId, '2021-07']]),
      'ask',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('DATE_PRECISION_INSUFFICIENT');
  });

  it('refuses a day the stored convention does not actually produce', () => {
    const target = element({
      proposedValue: '2021-07',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const claim = normalizedDateSchema.parse({
      year: 2021,
      month: 7,
      day: 15,
      precision: 'day',
      dayFromConvention: 'first_day',
    });
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: claim }),
      observation([target]),
      new Map([[target.elementId, '2021-07']]),
      'first_day',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('DATE_PRECISION_INSUFFICIENT');
  });

  it('permits the day the stored convention does produce', () => {
    const target = element({
      proposedValue: '2021-07',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const claim = normalizedDateSchema.parse({
      year: 2021,
      month: 7,
      day: 1,
      precision: 'day',
      dayFromConvention: 'first_day',
    });
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: claim }),
      observation([target]),
      new Map([[target.elementId, '2021-07']]),
      'first_day',
    );
    expect(verdict.allowed).toBe(true);
  });

  it('refuses a set_date carrying a date the profile does not contain', () => {
    const target = element({
      proposedValue: '2021-07-12',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const verdict = checkDecision(
      decisionFor('set_date', target, { normalizedDate: date({ year: 2019, month: 3, day: 4 }) }),
      observation([target]),
      new Map([[target.elementId, '2021-07-12']]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('DATE_USER_INPUT_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
describe('chronology is validated, and never silently repaired', () => {
  it('orders dates at the precision they share', () => {
    const july = date({ year: 2021, month: 7, day: null, precision: 'month' });
    const julyFourteenth = date({ year: 2021, month: 7, day: 14 });
    // Equal at the precision they share. Inventing a day to break the tie is
    // the same fabrication the rest of this file forbids.
    expect(compareNormalizedDates(july, julyFourteenth)).toBe(0);
    expect(
      compareNormalizedDates(july, date({ year: 2022, month: 1, day: null, precision: 'month' })),
    ).toBe(-1);
    // A current role cannot be ordered against anything, which is what stops a
    // chronology check firing on an end date that is correctly absent.
    expect(
      compareNormalizedDates(july, normalizeStoredDate('2021-07', { current: true })),
    ).toBeNull();
  });

  it('detects an end date earlier than its start date', () => {
    expect(
      isChronologyInvalid(normalizeStoredDate('2021-07'), normalizeStoredDate('2020-01')),
    ).toBe(true);
    expect(
      isChronologyInvalid(normalizeStoredDate('2020-01'), normalizeStoredDate('2021-07')),
    ).toBe(false);
  });

  it('refuses to fill an end date that precedes the start beside it', () => {
    const start = element({
      label: 'From Date',
      section: 'Work Experience',
      blockIndex: 0,
      intent: 'employment_start_date',
      proposedValue: '2021-07-12',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const end = element({
      label: 'End Date',
      section: 'Work Experience',
      blockIndex: 0,
      intent: 'employment_end_date',
      proposedValue: '2019-03-04',
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const verdict = checkDecision(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: {
          tool: 'set_date',
          elementId: end.elementId,
          normalizedDate: date({ year: 2019, month: 3, day: 4 }),
        },
      }),
      observation([start, end]),
      new Map([
        [start.elementId, '2021-07-12'],
        [end.elementId, '2019-03-04'],
      ]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('DATE_CHRONOLOGY_INVALID');
    // Asked about, never swapped. Choosing which of the applicant's two
    // statements was the mistake is not the agent's call.
    expect(verdict.replacement?.kind).toBe('ASK_USER');
  });
});

// ---------------------------------------------------------------------------
describe('the decider chooses set_date, and asks when it cannot', () => {
  const decide = (elements: ObservedElement[], dayConvention: DayConvention = 'ask') =>
    decideDeterministically({
      observation: observation(elements),
      history: new AgentHistory(),
      trustedValues: new Map(elements.map((entry) => [entry.elementId, entry.proposedValue ?? ''])),
      dayConvention,
    });

  it('SCENARIO A: an exact date becomes set_date carrying the parts', () => {
    const target = element({
      label: 'From Date',
      proposedValue: '2021-07-12',
      required: true,
      dateRequirement: requirement({ shape: 'us_full', needsDay: true, placeholder: 'MM/DD/YYYY' }),
    });
    const decision = decide([target]);
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('set_date');
    // Parts, never a rendered string: there is nowhere in the call to put one.
    expect(decision.action?.normalizedDate).toMatchObject({ year: 2021, month: 7, day: 12 });
    expect(decision.action?.value).toBeUndefined();
  });

  it('SCENARIO B: a month-only record asks rather than inventing a day', () => {
    const target = element({
      label: 'From Date',
      section: 'Work Experience',
      proposedValue: '2021-07',
      required: true,
      dateRequirement: requirement({ shape: 'us_full', needsDay: true, placeholder: 'MM/DD/YYYY' }),
    });
    const decision = decide([target]);
    expect(decision.kind).toBe('ASK_USER');
    expect(decision.errorCode).toBe('DATE_PRECISION_INSUFFICIENT');
    // The question names the record, the date, what is known, and what the
    // employer wants — the four things needed to answer it without going and
    // reading the page.
    expect(decision.question).toContain('From Date');
    expect(decision.question).toContain('Work Experience');
    expect(decision.question).toContain('MM/DD/YYYY');
    expect(decision.question).toContain('July 2021');
  });

  it('SCENARIO C: an approved first-day convention fills it', () => {
    const target = element({
      label: 'From Date',
      proposedValue: '2021-07',
      required: true,
      dateRequirement: requirement({ shape: 'us_full', needsDay: true, placeholder: 'MM/DD/YYYY' }),
    });
    const decision = decide([target], 'first_day');
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('set_date');
    expect(decision.action?.normalizedDate).toMatchObject({
      day: 1,
      dayFromConvention: 'first_day',
    });
  });

  it('fills a month-precision control from a month-precision record without asking', () => {
    const target = element({
      label: 'From Date',
      proposedValue: '2021-07',
      required: true,
      dateRequirement: requirement({ shape: 'us_month', needsDay: false, placeholder: 'MM/YYYY' }),
    });
    const decision = decide([target]);
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('set_date');
  });

  it('never chooses type for a date control', () => {
    // The decider and the validator are independent protections, and this is
    // the decider's half: it does not produce the refused decision in the first
    // place, so a correct run never spends steps being corrected.
    const target = element({
      label: 'From Date',
      proposedValue: '2021-07-12',
      required: true,
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    expect(decide([target]).action?.tool).not.toBe('type');
  });

  it('leaves ordinary text fields on the type path', () => {
    // The other regression that matters: Address, City, Postal Code, Phone,
    // Company Name and Position Title all fill by typing, and must go on doing
    // so.
    for (const label of [
      'Address',
      'City',
      'Postal Code',
      'Phone',
      'Company Name',
      'Position Title',
    ]) {
      const target = element({
        label,
        kind: 'text',
        interactionType: 'TEXT_INPUT',
        proposedValue: 'Clifton',
        required: true,
      });
      const decision = decide([target]);
      expect(decision.kind).toBe('ACTION');
      expect(decision.action?.tool).toBe('type');
      expect(decision.action?.value).toBe('Clifton');
    }
  });
});

// ---------------------------------------------------------------------------
describe('a current role does not get today’s date', () => {
  it('offers no end date for a role the record marks current', () => {
    const profile = profileSchema.parse({
      updatedAt: '2026-08-11T00:00:00.000Z',
      experience: [
        {
          id: 'experience-1',
          employer: 'Northline Robotics',
          startDate: '2021-07-12',
          endDate: '2023-01-01',
          current: true,
        },
      ],
    });
    const end = element({
      label: 'End Date',
      intent: 'employment_end_date',
      blockIndex: 0,
      dateRequirement: requirement({ shape: 'us_full' }),
    });
    const current = element({
      label: 'I currently work here',
      kind: 'checkbox',
      interactionType: 'CHECKBOX',
      intent: 'currently_employed',
      blockIndex: 0,
    });
    const trusted = trustedValuesFor(observation([end, current]), profile);
    // Not today, and not the stale end date sitting in the record either.
    expect(trusted.get(end.elementId)).toBeUndefined();
    expect(trusted.get(current.elementId)).toBe('Yes');
  });

  it('ticks the form’s own current-employment control instead', () => {
    const current = element({
      label: 'I currently work here',
      kind: 'checkbox',
      interactionType: 'CHECKBOX',
      policy: 'KNOWN_FACT',
      proposedValue: 'Yes',
    });
    const decision = decideDeterministically({
      observation: observation([current]),
      history: new AgentHistory(),
      trustedValues: new Map([[current.elementId, 'Yes']]),
    });
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('click');
    expect(decision.action?.elementId).toBe(current.elementId);
  });

  it('refuses to write a date for a present-precision record', () => {
    const outcome = formatNormalizedDate(
      normalizeStoredDate('2021-07', { current: true }),
      'us_full',
    );
    expect(outcome).toMatchObject({ kind: 'refused', code: 'DATE_USER_INPUT_REQUIRED' });
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('current');
  });
});

// ---------------------------------------------------------------------------
describe('the executor writes the shape the control asked for', () => {
  const LINCOLN_FROM_DATE = `
    <label for="from0">From Date</label>
    <input id="from0" name="from0" type="text" placeholder="MM/DD/YYYY" />`;

  it('writes MM/DD/YYYY into the Lincoln text-backed box', async () => {
    const elementId = await observeAndFind(LINCOLN_FROM_DATE, 'From Date');
    const outcome = await executeAgentTool({
      tool: 'set_date',
      elementId,
      normalizedDate: date({ year: 2021, month: 7, day: 12 }),
    });
    const control = document.getElementById('from0') as HTMLInputElement;
    expect(outcome.executed).toBe(true);
    expect(control.value).toBe('07/12/2021');
    expect(outcome.dateShapeWritten).toBe('us_full');
    // And never the profile's own storage format.
    expect(control.value).not.toBe('2021-07');
  });

  it('writes the ISO value a native picker actually holds', async () => {
    // The distinction that a "just format it like the placeholder" fix gets
    // wrong: an <input type="date"> submits `2021-07-12` however it renders.
    const elementId = await observeAndFind(
      `<label for="d">Start Date</label>
       <input id="d" name="d" type="date" placeholder="MM/DD/YYYY" />`,
      'Start Date',
    );
    const outcome = await executeAgentTool({
      tool: 'set_date',
      elementId,
      normalizedDate: date({ year: 2021, month: 7, day: 12 }),
    });
    expect(outcome.executed).toBe(true);
    expect((document.getElementById('d') as HTMLInputElement).value).toBe('2021-07-12');
  });

  it('writes nothing at all when the day is missing', async () => {
    const elementId = await observeAndFind(LINCOLN_FROM_DATE, 'From Date');
    const outcome = await executeAgentTool({
      tool: 'set_date',
      elementId,
      normalizedDate: date({ year: 2021, month: 7, day: null, precision: 'month' }),
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('DATE_PRECISION_INSUFFICIENT');
    // A half-right date in an employer's form is worse than an empty box: the
    // applicant can see an empty box.
    expect((document.getElementById('from0') as HTMLInputElement).value).toBe('');
  });

  it('refuses type() against the live element as a second lock', async () => {
    const elementId = await observeAndFind(LINCOLN_FROM_DATE, 'From Date');
    const outcome = await executeAgentTool({ tool: 'type', elementId, value: '2021-07' });
    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    // Nothing reached the DOM. This is the live failure, at the last layer that
    // could have stopped it.
    expect((document.getElementById('from0') as HTMLInputElement).value).toBe('');
  });

  it('still types into an ordinary text box', async () => {
    const elementId = await observeAndFind(
      `<label for="city">City</label>
       <input id="city" name="city" type="text" />`,
      'City',
    );
    const outcome = await executeAgentTool({ tool: 'type', elementId, value: 'Clifton' });
    expect(outcome.executed).toBe(true);
    expect((document.getElementById('city') as HTMLInputElement).value).toBe('Clifton');
  });

  it('reports the employer’s rejection rather than reporting success', async () => {
    // The acceptance check, end to end. The page's own script rewrites the box
    // to its stored format and flags it — exactly what a masked ATS date field
    // does on blur — and the tool reports a rejection instead of "written".
    const elementId = await observeAndFind(
      `<div>
         <label for="from0">From Date</label>
         <input id="from0" name="from0" type="text" placeholder="MM/DD/YYYY"
                aria-errormessage="err" />
         <span id="err" class="error" hidden>Invalid date.</span>
       </div>`,
      'From Date',
    );
    const control = document.getElementById('from0') as HTMLInputElement;
    const complaint = document.getElementById('err') as HTMLElement;
    control.addEventListener('focusout', () => {
      control.setAttribute('aria-invalid', 'true');
      complaint.hidden = false;
    });
    const outcome = await executeAgentTool({
      tool: 'set_date',
      elementId,
      normalizedDate: date({ year: 2021, month: 7, day: 12 }),
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('DATE_VALIDATION_FAILED');
    expect(outcome.dateValidationAfter?.message).toBe('Invalid date.');
    // The box holds the date and the form refused it. Those are different
    // facts, and only the second one decides whether the field is answered.
    expect(control.value).toBe('07/12/2021');
  });
});

// ---------------------------------------------------------------------------
describe('employer acceptance is checked, not assumed', () => {
  it('treats a control the employer is complaining about as not accepted', () => {
    // The live shape: the box displays the right thing and the form says
    // "Invalid date." The form is the authority.
    document.body.innerHTML = `
      <div>
        <input id="control" type="text" placeholder="MM/DD/YYYY" value="07/12/2021"
               aria-invalid="true" aria-errormessage="err" />
        <span id="err" class="error">Invalid date.</span>
      </div>`;
    const control = document.getElementById('control') as HTMLInputElement;
    const validation = readDateValidation(control);
    expect(validation.ariaInvalid).toBe(true);
    expect(validation.message).toBe('Invalid date.');
    expect(dateAccepted(control, '07/12/2021').accepted).toBe(false);
  });

  it('does not depend on native validity alone', () => {
    // `2021-07` in a plain text box is valid HTML. Native validity would have
    // called the live failure a success, which is why it is one reading of
    // three rather than the reading.
    document.body.innerHTML =
      '<input id="control" type="text" placeholder="MM/DD/YYYY" value="2021-07" />';
    const control = document.getElementById('control') as HTMLInputElement;
    expect(readDateValidation(control).nativeValid).toBe(true);
    // It holds `2021-07` and `07/12/2021` was written, so it did not keep it.
    expect(dateAccepted(control, '07/12/2021').accepted).toBe(false);
  });

  it('accepts a control that holds the value with no complaint', () => {
    document.body.innerHTML =
      '<input id="control" type="text" placeholder="MM/DD/YYYY" value="07/12/2021" />';
    const control = document.getElementById('control') as HTMLInputElement;
    expect(dateAccepted(control, '07/12/2021').accepted).toBe(true);
  });

  it('surfaces the employer complaint through the observation', async () => {
    // What makes the loop's verifier able to fail: `validationError` on the
    // observed element, read from the date control's own reading.
    document.body.innerHTML = `
      <div>
        <label for="from0">From Date</label>
        <input id="from0" name="from0" type="text" placeholder="MM/DD/YYYY" value="07/12/2021"
               aria-invalid="true" aria-errormessage="err" />
        <span id="err" class="error">Invalid date.</span>
      </div>`;
    const observed = await observePage();
    const from = observed.elements.find((entry) => entry.label.includes('From Date'));
    expect(from?.interactionType).toBe('DATE_INPUT');
    expect(from?.validationError).toBe('Invalid date.');
  });

  it('reports the control’s stated format in the observation', async () => {
    document.body.innerHTML = `
      <label for="from0">From Date</label>
      <input id="from0" name="from0" type="text" placeholder="MM/DD/YYYY" />`;
    const observed = await observePage();
    const from = observed.elements.find((entry) => entry.label.includes('From Date'));
    expect(from?.dateRequirement?.shape).toBe('us_full');
    expect(from?.dateRequirement?.needsDay).toBe(true);
    expect(from?.kind).toBe('date');
  });
});

// ---------------------------------------------------------------------------
describe('the question put to the applicant', () => {
  it('names the record, the date, the precision known, and the format wanted', () => {
    const question = dateQuestionFor({
      label: 'From Date',
      section: 'Work Experience',
      date: normalizeStoredDate('2021-07'),
      shape: 'us_full',
    });
    expect(question).toContain('From Date');
    expect(question).toContain('Work Experience');
    expect(question).toContain('July 2021');
    expect(question).toContain('MM/DD/YYYY');
    expect(question.length).toBeLessThanOrEqual(500);
  });
});
