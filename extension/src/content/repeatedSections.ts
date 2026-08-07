import {
  markBlockCreationFailed,
  planRepeatedSection,
  type RepeatPlan,
  type RepeatedSectionKind,
} from '@internship-agent/shared';
import { pressPointer } from '../scanner/optionDiscovery.js';

/**
 * Making the page hold as many blocks as the applicant has records.
 *
 * An application offers one Work Experience block and an "Add" button. Nothing
 * ever pressed it, so an applicant with three jobs submitted one — and the two
 * that were missing did not appear anywhere in the report either, because a
 * block that does not exist has no field to be unanswered.
 *
 * Everything here is observation and interaction. It presses a control the page
 * already has, waits for the page's own answer, and counts what came back. It
 * never fabricates a block, never presses more times than there are records to
 * place, and never presses at all when the page is already offering enough.
 */

/** How long one Add press is given to produce a block. */
const ADD_WAIT_MS = 2000;
const POLL_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Words an Add control uses, and the section each one belongs to.
 *
 * Matched against the control's own accessible text. Deliberately requires the
 * *section* to be named as well as the action: a bare "Add" on a page with three
 * repeating sections is ambiguous, and pressing the wrong one adds a row the
 * applicant then has to delete.
 */
const SECTION_WORDS: Record<RepeatedSectionKind, RegExp> = {
  experience: /\b(experience|employment|employer|work history|position|job)\b/i,
  education: /\b(education|school|degree|academic|university|college)\b/i,
  projects: /\b(project|portfolio)\b/i,
};

const ADD_WORDS = /\b(add|another|\+)\b/i;

/** The accessible text of a control, as a person would read it. */
function controlText(element: HTMLElement): string {
  const aria = element.getAttribute('aria-label') ?? '';
  const title = element.getAttribute('title') ?? '';
  return `${element.textContent ?? ''} ${aria} ${title}`.replace(/\s+/g, ' ').trim();
}

function isUsable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The Add control for one section, or null when the page has none.
 *
 * Never the Submit button, and never a control that only says "Add" — the
 * section has to be named. A page that offers no unambiguous Add simply does
 * not grow, and the records that had nowhere to go are reported rather than
 * forced somewhere.
 */
export function findAddControl(document: Document, kind: RepeatedSectionKind): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,[role="button"],a[href="#"],input[type="button"]',
    ),
  ).filter(isUsable);

  const named = candidates.filter((element) => {
    const text = controlText(element);
    if (!ADD_WORDS.test(text)) return false;
    // A submit control is never an Add control, whatever it is called.
    if (/\bsubmit\b/i.test(text)) return false;
    if (element instanceof HTMLButtonElement && element.type === 'submit') return false;
    return SECTION_WORDS[kind].test(text);
  });

  // Exactly one, or none. Two equally plausible Add buttons is ambiguous
  // evidence, and pressing one of them is a guess about the applicant's form.
  return named.length === 1 ? (named[0] ?? null) : null;
}

export interface BlockCounter {
  /**
   * How many blocks of this kind the page is showing right now.
   *
   * Supplied by the caller because block discovery belongs to the scanner: a
   * block is "a group of controls carrying this section's questions", and the
   * scanner is the one place that decides what a control's question is.
   */
  (kind: RepeatedSectionKind): number;
}

export interface GrowSectionInput {
  document: Document;
  kind: RepeatedSectionKind;
  /** How many saved records the profile holds. Counts only. */
  recordCount: number;
  countBlocks: BlockCounter;
  /** Called after each new block appears, so it can be scanned on its own. */
  onBlockAdded?: (blockIndex: number) => Promise<void> | void;
}

export interface GrowSectionOutcome {
  plan: RepeatPlan;
  blocksBefore: number;
  blocksAfter: number;
  addPressesPerformed: number;
}

/**
 * Presses Add until the page holds one block per saved record.
 *
 * One press at a time, each one waited for and *counted* before the next — not
 * a burst of clicks and a hope. A page that answers a press with two blocks, or
 * with none, is observed rather than assumed, and the loop stops the moment the
 * count reaches the target or a press produces nothing.
 */
export async function growRepeatedSection(input: GrowSectionInput): Promise<GrowSectionOutcome> {
  const blocksBefore = input.countBlocks(input.kind);
  const addControl = findAddControl(input.document, input.kind);
  let plan = planRepeatedSection({
    kind: input.kind,
    recordCount: input.recordCount,
    blockCount: blocksBefore,
    hasAddControl: addControl !== null,
  });

  if (plan.addPresses === 0 || !addControl) {
    return { plan, blocksBefore, blocksAfter: blocksBefore, addPressesPerformed: 0 };
  }

  let current = blocksBefore;
  let presses = 0;
  for (let press = 0; press < plan.addPresses; press += 1) {
    const before = current;
    // The page's own control, pressed the way a person presses it.
    const live = findAddControl(input.document, input.kind) ?? addControl;
    if (!live.isConnected) break;
    pressPointer(live);

    const deadline = Date.now() + ADD_WAIT_MS;
    let grown = before;
    for (;;) {
      grown = input.countBlocks(input.kind);
      if (grown > before) break;
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }

    if (grown <= before) {
      // The press did nothing. Recorded as such and the loop stops: pressing
      // again would either do nothing again or add two blocks at once, and
      // neither is a repair.
      plan = markBlockCreationFailed(plan, before);
      break;
    }
    presses += 1;
    current = grown;
    // The caller scans and fills *this* block only. A whole-page rescan after
    // every Add is what makes a three-record section take as long as three
    // applications.
    await input.onBlockAdded?.(before);
  }

  return {
    plan,
    blocksBefore,
    blocksAfter: input.countBlocks(input.kind),
    addPressesPerformed: presses,
  };
}
