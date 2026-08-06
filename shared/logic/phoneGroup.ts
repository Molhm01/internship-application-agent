import { isOptionFieldType, type FieldType } from '../schemas/fields.js';
import { isSettledStatus, type FinalFieldStatus } from './finalFieldStatus.js';
import { carriesDialCode } from './phoneNumber.js';

/**
 * Reconciling a phone block against what the page actually ended up holding.
 *
 * A phone question is routinely three controls — type, country code, number —
 * and a portal is free to build the country code *into* the number's own
 * control: a combobox whose menu only exists once it is opened, rendered inside
 * the number box, reading "US +1". A scan finds it, so it becomes a field with
 * no choices on it and no separate answer to give; the planner correctly refuses
 * to invent one; and it ends the run `USER_CONFIRMATION_REQUIRED` — wearing an
 * orange "Information needed" badge drawn on top of a phone number that filled
 * and verified with its +1 intact.
 *
 * That is the reported failure, and the honest repair is not to turn the badge
 * off. It is to notice that the answer the control was asking for is already on
 * the page, in the combined control beside it, confirmed by the same DOM
 * verification every other status is decided from.
 *
 * This module decides that and nothing else. It invents no status — every
 * outcome it returns is a member of `FINAL_FIELD_STATUSES` — and it never
 * upgrades a control that could have been filled separately and was not.
 */

/** The canonical keys that make up one phone block. */
const PHONE_NUMBER_KEY = 'phone';
const PHONE_COUNTRY_CODE_KEY = 'phone_country_code';
const PHONE_TYPE_KEY = 'phone_type';

/** What the run observed about one control in a phone block. */
export interface PhoneControlObservation {
  fieldId: string;
  /** From `CANONICAL_QUESTIONS`; anything else is not part of a phone block. */
  canonicalKey?: string | undefined;
  fieldType: FieldType;
  /** How the mark and the executor find this control again. */
  selector: string;
  /** 0 is the top document. A block never spans two frames. */
  frameId: number;
  disabled: boolean;
  /** How many choices the scan found on it. Zero means nothing to select. */
  optionCount: number;
  status: FinalFieldStatus;
  /**
   * What the page was observed to hold afterwards — the executor's confirmed
   * read where there is one, the scanned value otherwise. Never a planned value:
   * the whole point is to decide from what the page kept.
   */
  observedValue: string;
}

export interface PhoneGroupReconciliation {
  /** Only the fields whose status this changed. Empty when nothing did. */
  statuses: ReadonlyMap<string, FinalFieldStatus>;
  /** Country-code controls answered by the number control beside them. */
  satisfiedByCombinedControl: readonly string[];
  /**
   * True when the block as a whole is answered: a phone number that settled, and
   * no member of the block left outstanding.
   */
  groupComplete: boolean;
}

function isPhoneMember(observation: PhoneControlObservation): boolean {
  return (
    observation.canonicalKey === PHONE_NUMBER_KEY ||
    observation.canonicalKey === PHONE_COUNTRY_CODE_KEY ||
    observation.canonicalKey === PHONE_TYPE_KEY
  );
}

/**
 * True when this country-code control offers the user no separate way to answer
 * it — the evidence that it is part of the number's own widget rather than a
 * control of its own.
 *
 * Each clause is something observed rather than assumed:
 *
 *  - the same selector as the number control is literally one element;
 *  - a disabled control cannot be answered by anyone, agent or applicant;
 *  - a chooser with no choices on it has nothing that could ever be selected.
 *
 * A country-code `<select>` carrying two hundred dialling codes matches none of
 * these, so a form that really does split the two keeps asking for both.
 */
function hasNoSeparateControl(
  code: PhoneControlObservation,
  number: PhoneControlObservation,
): boolean {
  if (code.selector === number.selector) return true;
  if (code.disabled) return true;
  return isOptionFieldType(code.fieldType) && code.optionCount === 0;
}

/**
 * Settles a phone block against observed DOM state.
 *
 * The only statuses this ever writes are the settled verdict of the number
 * control beside it, and only onto a country-code control that is
 * `USER_CONFIRMATION_REQUIRED`. A code control that
 * failed execution stays failed, a blocked one stays blocked, and a form with
 * two real controls is left to verify both — the run has to keep being able to
 * say a phone block is unfinished, or saying it is finished would mean nothing.
 */
export function reconcilePhoneGroup(
  observations: readonly PhoneControlObservation[],
): PhoneGroupReconciliation {
  const statuses = new Map<string, FinalFieldStatus>();
  const satisfied: string[] = [];

  const members = observations.filter(isPhoneMember);
  const numbers = members.filter((entry) => entry.canonicalKey === PHONE_NUMBER_KEY);
  // Settled *and* stating a code. A verified number that carries no code has
  // answered its own question and nobody else's.
  const combined = numbers.filter(
    (entry) => isSettledStatus(entry.status) && carriesDialCode(entry.observedValue),
  );

  for (const code of members) {
    if (code.canonicalKey !== PHONE_COUNTRY_CODE_KEY) continue;
    if (code.status !== 'USER_CONFIRMATION_REQUIRED') continue;
    const host = combined.find(
      (entry) => entry.frameId === code.frameId && hasNoSeparateControl(code, entry),
    );
    if (!host) continue;
    // The number control's own verdict, not a fixed one. When the agent wrote
    // the number the code came with it and both are `FILLED_VERIFIED`; when the
    // page already held the number — a second run over a form that is already
    // filled — both are `SKIPPED_ALREADY_VALID`, and neither claims credit for
    // an answer the user typed themselves.
    statuses.set(code.fieldId, host.status);
    satisfied.push(code.fieldId);
  }

  const effective = (entry: PhoneControlObservation): FinalFieldStatus =>
    statuses.get(entry.fieldId) ?? entry.status;
  const groupComplete =
    numbers.length > 0 &&
    numbers.every((entry) => isSettledStatus(effective(entry))) &&
    members.every((entry) => isSettledStatus(effective(entry)));

  return { statuses, satisfiedByCombinedControl: satisfied, groupComplete };
}
