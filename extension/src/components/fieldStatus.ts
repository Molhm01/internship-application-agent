import type { FieldRunStatus } from '@internship-agent/shared';
import type { IconName } from './Icon.js';

/**
 * How the agent's field states are shown, in one place.
 *
 * The presentation vocabulary is deliberately *wider* than the storage
 * vocabulary. `shared/logic/finalFieldStatus.ts` owns seven outcomes and five
 * running stages, and that closed set is what a run records. But "the agent is
 * doing something to this control" covers reading a menu's choices, typing into
 * its search box and clicking an option — three visibly different things that
 * all live under one stored stage, and a user watching a long dropdown pass
 * needs to see which one is happening or the interface looks stuck.
 *
 * So these are display states derived from stored ones plus the live activity
 * sentence. Nothing here is persisted, and nothing here can be mistaken for a
 * stored status: the mapping goes one way, from storage to screen.
 *
 * The three rules this table enforces:
 *
 * 1. **Attempted is not verified.** `SELECTING` and `VERIFIED` are different
 *    tones, different glyphs and different words. "Selecting New Jersey…" must
 *    never be able to look like success.
 * 2. **An unanswered question is not an error.** `NEEDS_INPUT` is the pending
 *    tone, not the danger tone. The agent asking is the product working.
 * 3. **Colour is never the carrier.** Every entry has a glyph and a word.
 */

export type FieldDisplayStatus =
  /** Written and confirmed against the page afterwards. The end state. */
  | 'VERIFIED'
  /** The page already held the right answer. Nothing was written. */
  | 'ALREADY_VALID'
  /** Something is happening to this control, kind unspecified. */
  | 'PROCESSING'
  /** A menu is open and its choices are being enumerated. */
  | 'READING_OPTIONS'
  /** Typing into a combobox's search box to narrow the list. */
  | 'SEARCHING'
  /** An option has been clicked; the framework has not confirmed it yet. */
  | 'SELECTING'
  /** Correctly untouched: the question that produces its choices is not settled. */
  | 'WAITING_DEPENDENCY'
  /** A fact nobody holds. The agent stopped and asked. Not a failure. */
  | 'NEEDS_INPUT'
  /** Filled, but worth a person's eye before submitting. */
  | 'NEEDS_REVIEW'
  /** A CAPTCHA, a verification step, or page protection stood in the way. */
  | 'BLOCKED'
  /** Optional and deliberately empty. */
  | 'OPTIONAL_SKIPPED'
  /** The form itself has switched this question off. */
  | 'NOT_APPLICABLE'
  /** A legal or demographic decision that is the applicant's alone. */
  | 'SENSITIVE'
  /** The write was attempted and the page refused it. */
  | 'FAILED';

/** The tone names, matching the token families in `tokens.css`. */
export type StatusTone =
  'verified' | 'success' | 'running' | 'pending' | 'warning' | 'danger' | 'sensitive' | 'idle';

export interface FieldStatusPresentation {
  /** The word shown to the applicant. Sentence case, never a status constant. */
  label: string;
  icon: IconName;
  tone: StatusTone;
  /**
   * What a screen reader is told, when the visible label alone would be
   * ambiguous out of context. "Blocked" on its own does not say by what.
   */
  announcement: string;
  /** True while the agent is actively working on this control. */
  active: boolean;
}

export const FIELD_STATUS_PRESENTATION: Record<FieldDisplayStatus, FieldStatusPresentation> = {
  VERIFIED: {
    label: 'Verified',
    icon: 'check-double',
    tone: 'verified',
    announcement: 'Filled and verified against the page',
    active: false,
  },
  ALREADY_VALID: {
    label: 'Already correct',
    icon: 'check',
    tone: 'success',
    announcement: 'The page already held the correct answer',
    active: false,
  },
  PROCESSING: {
    label: 'Working',
    icon: 'spinner',
    tone: 'running',
    announcement: 'The agent is working on this field',
    active: true,
  },
  READING_OPTIONS: {
    label: 'Reading choices',
    icon: 'layers',
    tone: 'running',
    announcement: 'Reading the choices this control offers',
    active: true,
  },
  SEARCHING: {
    label: 'Searching',
    icon: 'search',
    tone: 'running',
    announcement: 'Searching this control for a matching choice',
    active: true,
  },
  SELECTING: {
    label: 'Selecting',
    icon: 'circle-dot',
    tone: 'running',
    // The wording matters: this is an attempt, and it is not yet a result.
    announcement: 'Selecting a choice. Not yet verified',
    active: true,
  },
  WAITING_DEPENDENCY: {
    label: 'Waiting on another answer',
    icon: 'clock',
    tone: 'idle',
    announcement: 'Waiting for the question that produces this one’s choices',
    active: true,
  },
  NEEDS_INPUT: {
    label: 'Needs your answer',
    icon: 'question',
    tone: 'pending',
    announcement: 'The agent cannot safely infer this and is asking you',
    active: false,
  },
  NEEDS_REVIEW: {
    label: 'Check this one',
    icon: 'eye',
    tone: 'warning',
    announcement: 'Filled, and worth checking before you submit',
    active: false,
  },
  BLOCKED: {
    label: 'Blocked',
    icon: 'shield',
    tone: 'danger',
    announcement: 'Something on the page stopped the agent here',
    active: false,
  },
  OPTIONAL_SKIPPED: {
    label: 'Optional, left blank',
    icon: 'minus',
    tone: 'idle',
    announcement: 'Optional and deliberately left blank',
    active: false,
  },
  NOT_APPLICABLE: {
    label: 'Not applicable',
    icon: 'slash',
    tone: 'idle',
    announcement: 'The form is not asking this question',
    active: false,
  },
  SENSITIVE: {
    label: 'Your decision',
    icon: 'lock',
    tone: 'sensitive',
    announcement: 'A sensitive question. The agent never infers these',
    active: false,
  },
  FAILED: {
    label: 'Could not fill',
    icon: 'alert',
    tone: 'danger',
    announcement: 'The agent wrote this and the page did not keep it',
    active: false,
  },
};

/**
 * The stored status a run records, mapped onto what the screen shows.
 *
 * The three running stages that share `PENDING_EXECUTION` collapse to
 * `PROCESSING` here; the caller refines that with the live activity sentence
 * via `refineActiveStatus` when it has one. Doing it in that order — coarse
 * from storage, fine from the activity line — is what keeps the display honest
 * when the activity line is absent.
 */
export function displayStatusFor(status: FieldRunStatus): FieldDisplayStatus {
  switch (status) {
    case 'FILLED_VERIFIED':
      return 'VERIFIED';
    case 'SKIPPED_ALREADY_VALID':
      return 'ALREADY_VALID';
    case 'OPTIONAL_LEFT_BLANK':
      return 'OPTIONAL_SKIPPED';
    case 'NOT_APPLICABLE':
      return 'NOT_APPLICABLE';
    case 'USER_CONFIRMATION_REQUIRED':
      return 'NEEDS_INPUT';
    case 'FAILED_EXECUTION':
      return 'FAILED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'WAITING_FOR_DEPENDENCY':
      return 'WAITING_DEPENDENCY';
    case 'PENDING_SCAN':
    case 'PENDING_RESOLUTION':
    case 'PENDING_EXECUTION':
      return 'PROCESSING';
    case 'PENDING_VERIFICATION':
      // Written, not yet confirmed. Deliberately not `VERIFIED`: this is the
      // exact moment the two must not be conflated.
      return 'SELECTING';
    default:
      return 'PROCESSING';
  }
}

/**
 * Sharpens a working state using the agent's own activity sentence.
 *
 * Reads the sentence the loop already emits rather than adding a new channel
 * for it. Only ever narrows within the working states — it cannot turn a
 * finished field back into a busy one, and it can never produce `VERIFIED`,
 * because verification is a fact the loop reports and never a phrase this
 * function infers.
 */
export function refineActiveStatus(
  status: FieldDisplayStatus,
  activity: string,
): FieldDisplayStatus {
  if (!FIELD_STATUS_PRESENTATION[status].active) return status;
  const text = activity.toLowerCase();
  if (text.includes('choice') || text.includes('option') || text.includes('reading')) {
    return 'READING_OPTIONS';
  }
  if (text.includes('search') || text.includes('typing')) return 'SEARCHING';
  if (text.includes('select') || text.includes('choos') || text.includes('click')) {
    return 'SELECTING';
  }
  if (text.includes('waiting') || text.includes('depend')) return 'WAITING_DEPENDENCY';
  return status;
}

/**
 * Whether a display status represents outstanding work for the *applicant*.
 *
 * Used to drive the "N need you" counts. `BLOCKED` and `FAILED` are included
 * because both end with a person having to do something, even though neither is
 * a question.
 */
export function needsPerson(status: FieldDisplayStatus): boolean {
  return (
    status === 'NEEDS_INPUT' ||
    status === 'NEEDS_REVIEW' ||
    status === 'BLOCKED' ||
    status === 'FAILED' ||
    status === 'SENSITIVE'
  );
}
