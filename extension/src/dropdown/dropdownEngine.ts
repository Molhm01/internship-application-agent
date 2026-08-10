import {
  dropdownRunResultSchema,
  type CollectedOption,
  type DropdownDirective,
  type DropdownFailureCode,
  type DropdownFinalStatus,
  type DropdownRunResult,
  type MenuDetectionStrategy,
  type OptionCandidateStrategy,
} from '@internship-agent/shared';
import { resolveTrigger } from '../scanner/optionDiscovery.js';
import { descriptorById, dropdownById } from './dropdownScanner.js';
import {
  collectCustomOptions,
  collectNativeOptions,
  releaseControl,
  type CollectedOptions,
} from './dropdownOptionCollector.js';
import { matchIntendedAnswer } from './dropdownMatcher.js';
import { executeCustom, executeNative } from './dropdownExecutor.js';
import { alreadyDisplays } from './dropdownVerifier.js';

/**
 * One dropdown, from a directive to a verified answer — or to an honest account
 * of where it stopped.
 *
 * The sequence is fixed and every step is *observed* rather than assumed: open,
 * enumerate what is actually offered, match the intended answer against that,
 * select, verify against the control's own state, close. No step reports success
 * because the previous one did not throw.
 *
 * ## The two things this will not do
 *
 * It will not answer a question the directive did not answer. A directive
 * carrying `requiresUserConfirmation` still gets its control opened and its
 * choices read — those choices are worth having, so the applicant can answer
 * from the popup instead of hunting for the control — and then nothing is
 * selected. That is `USER_CONFIRMATION_REQUIRED`, a complete outcome, not a
 * failure.
 *
 * It will not let one control's trouble reach another. Every dropdown is driven
 * inside its own try, and a widget that throws mid-interaction is left closed so
 * the next one is not driven through a menu still hanging over the page.
 */

/** No single control may hold the pass up longer than this. */
export const PER_DROPDOWN_BUDGET_MS = 5_000;

async function withBudget<T>(work: Promise<T>, fallback: T, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), budgetMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Attempt {
  opened: boolean;
  scrolled: boolean;
  optionsFound: number;
  selected: boolean;
  verified: boolean;
  matchedOption?: string;
  failureCode?: DropdownFailureCode;
  reason: string;
  status: DropdownFinalStatus;
  availableOptions: readonly CollectedOption[];
  /**
   * The stage-by-stage record, observed rather than inferred.
   *
   * Every one of these is a *separate* fact, because "the dropdown failed" was
   * one word covering a control whose trigger was never resolved, one whose
   * press did nothing, one whose menu could not be recognised, one whose list
   * held no match, and one that took a click and did not change. Those are five
   * repairs, and a live employer page cannot be diagnosed remotely without
   * knowing which happened.
   */
  trace: AttemptTrace;
}

interface AttemptTrace {
  triggerResolved: boolean;
  openAttempted: boolean;
  menuDetection: MenuDetectionStrategy;
  optionCandidates: OptionCandidateStrategy;
  scrollIterations: number;
  targetFound: boolean;
  clickAttempted: boolean;
  verificationObserved: boolean;
  ariaExpandedAfter: string;
}

const UNTOUCHED: AttemptTrace = {
  triggerResolved: false,
  openAttempted: false,
  menuDetection: 'none',
  optionCandidates: 'none',
  scrollIterations: 0,
  targetFound: false,
  clickAttempted: false,
  verificationObserved: false,
  ariaExpandedAfter: '',
};

/** What the collector observed while opening, in the shape the result records. */
function fromCollected(collected: CollectedOptions, triggerResolved: boolean): AttemptTrace {
  return {
    ...UNTOUCHED,
    triggerResolved,
    openAttempted: collected.openAttempted,
    menuDetection: collected.menuDetection,
    optionCandidates: collected.optionCandidates,
    scrollIterations: collected.scrollIterations,
    ariaExpandedAfter: collected.ariaExpandedAfter,
  };
}

/**
 * A control the applicant has to answer, with its choices recorded.
 *
 * The options survive into the result *only* on this path. A verified control's
 * option list is not worth carrying around, and a pass over a long form would
 * otherwise ship several thousand strings to the worker for no purpose.
 */
function awaitingUser(collected: CollectedOptions, reason: string): Attempt {
  return {
    opened: collected.opened,
    scrolled: collected.scrolled,
    optionsFound: collected.choices.length,
    selected: false,
    verified: false,
    reason,
    status: 'USER_CONFIRMATION_REQUIRED',
    availableOptions: collected.choices,
    trace: fromCollected(collected, true),
  };
}

async function attempt(root: HTMLElement, directive: DropdownDirective): Promise<Attempt> {
  const trigger = resolveTrigger(root);
  const native =
    root instanceof HTMLSelectElement
      ? root
      : trigger instanceof HTMLSelectElement
        ? trigger
        : null;
  // A trigger is "resolved" when there is a live element to send the press to.
  //
  // Deliberately *not* "it is an input, a button, or a role=combobox". The
  // widgets this engine exists for are none of those — a vendor picker is a bare
  // `div` that is its own trigger — and requiring a recognisable tag reported
  // `triggerResolved: false` over eight controls it had just opened, read,
  // selected and verified. A diagnostic that says a working control failed is
  // worse than no diagnostic. The honest false case is the one below: an element
  // that has left the page.
  const triggerResolved = trigger.isConnected;

  // ---- Already answered, before anything is opened. ------------------------
  //
  // Not merely an optimisation. Re-selecting a value a control already holds
  // fires `change`, and a page that rebuilds a dependent list on that event
  // discards the answer chosen moments earlier.
  if (
    !directive.requiresUserConfirmation &&
    directive.intendedAnswer &&
    alreadyDisplays(root, directive.intendedAnswer)
  ) {
    return {
      opened: false,
      scrolled: false,
      optionsFound: 0,
      selected: false,
      verified: true,
      matchedOption: directive.intendedAnswer,
      reason: 'The control already showed the saved answer, so nothing was changed.',
      status: 'SKIPPED_ALREADY_VALID',
      availableOptions: [],
      // Nothing was opened, and the record says so. This is the outcome the
      // "No Selection" defect produced over an unanswered control, and a run
      // that reaches it now has to have passed `displaysSelection` first.
      trace: { ...UNTOUCHED, triggerResolved, verificationObserved: true },
    };
  }

  // ---- Controls that cannot be driven at all. ------------------------------
  const disabled =
    native?.disabled === true ||
    root.getAttribute('aria-disabled') === 'true' ||
    resolveTrigger(root).matches(':disabled');
  if (disabled) {
    return {
      opened: false,
      scrolled: false,
      optionsFound: 0,
      selected: false,
      verified: false,
      failureCode: 'CONTROL_DISABLED',
      reason: 'The control is switched off, so the field it depends on has not been answered yet.',
      status: 'BLOCKED',
      availableOptions: [],
      trace: { ...UNTOUCHED, triggerResolved },
    };
  }

  // ---- Open and read the whole list. --------------------------------------
  //
  // A control awaiting the applicant is opened too. Its choices are the point:
  // an unanswerable question with its options in hand is something the popup can
  // ask, and one without them sends the user back to the page to look.
  const collected = native
    ? collectNativeOptions(native)
    : await collectCustomOptions(
        root,
        // A searchable control is filtered by what is typed into it, so a
        // control nobody has an answer for is opened without a query rather
        // than probed with a guess.
        directive.requiresUserConfirmation ? undefined : directive.searchText,
      );

  try {
    if (!collected.opened) {
      return {
        opened: false,
        scrolled: false,
        optionsFound: 0,
        selected: false,
        verified: false,
        failureCode: 'OPEN_FAILED',
        reason: 'The control did not open for a click, a keypress, or typing.',
        status: 'FAILED_EXECUTION',
        availableOptions: [],
        // `menuDetection: 'none'` here is the diagnosis: the press happened and
        // nothing that could be a menu appeared — as distinct from a menu that
        // appeared and could not be read, which reports a strategy and no
        // options.
        trace: fromCollected(collected, triggerResolved),
      };
    }

    if (collected.choices.length === 0) {
      // An empty list means two different things, and reporting both the same
      // way is how a working dependency looked like a breakage.
      const dependent = root.hasAttribute('data-depends-on');
      return {
        opened: true,
        scrolled: collected.scrolled,
        optionsFound: 0,
        selected: false,
        verified: false,
        failureCode: dependent ? 'DEPENDENT_CONTROL_NOT_REFRESHED' : 'NO_OPTIONS_FOUND',
        reason: dependent
          ? 'The list opened empty, so the control it depends on has not populated it yet.'
          : 'The list opened and contained no choices.',
        status: dependent ? 'BLOCKED' : 'FAILED_EXECUTION',
        availableOptions: [],
        trace: fromCollected(collected, triggerResolved),
      };
    }

    if (directive.requiresUserConfirmation) {
      return awaitingUser(
        collected,
        directive.confirmationPrompt ??
          'Only you can answer this question, so the agent left it for you.',
      );
    }

    // ---- Match the answer against what is on offer. -------------------------
    const match = matchIntendedAnswer(directive, collected.choices);
    if (!match.option) {
      return {
        opened: true,
        scrolled: collected.scrolled,
        optionsFound: collected.choices.length,
        selected: false,
        verified: false,
        failureCode: match.ambiguous
          ? 'AMBIGUOUS_OPTION_MATCH'
          : match.method === 'semantic'
            ? 'NO_SEMANTIC_OPTION_MATCH'
            : 'OPTION_NOT_FOUND',
        reason: match.reason,
        // The applicant's to settle: the answer is known and this form does not
        // offer it, or offers it twice. Either way the choices are what they
        // need in order to decide, so they travel with the result.
        status: 'USER_CONFIRMATION_REQUIRED',
        availableOptions: collected.choices,
        // The list was read and nothing on it is the saved answer: every stage
        // up to the match succeeded, and `targetFound: false` is the one that
        // did not. Distinct from a list that never appeared.
        trace: fromCollected(collected, triggerResolved),
      };
    }

    // ---- Select, and prove it. ---------------------------------------------
    const execution = native
      ? executeNative(native, match.option)
      : await executeCustom(
          root,
          collected.container ?? root,
          match.option,
          collected.choices.length,
        );

    return {
      opened: true,
      scrolled: collected.scrolled,
      optionsFound: collected.choices.length,
      selected: execution.selected,
      verified: execution.verification.verified,
      matchedOption: match.option.displayedText,
      ...(execution.failureCode ? { failureCode: execution.failureCode } : {}),
      reason: execution.reason,
      status: execution.verification.verified ? 'FILLED_VERIFIED' : 'FAILED_EXECUTION',
      availableOptions: [],
      trace: {
        ...fromCollected(collected, triggerResolved),
        targetFound: true,
        clickAttempted: true,
        // Whether the control was *read back* at all, which is not the same as
        // whether it agreed. A control that left the page mid-attempt observes
        // nothing, and that is a different failure from one that observed the
        // wrong thing.
        verificationObserved: execution.verification.observed.trim().length > 0,
      },
    };
  } finally {
    if (!native) releaseControl(root);
  }
}

/**
 * Drives one dropdown and always returns a record of what happened.
 *
 * "Always" is the contract. A throw, a timeout, or a control that left the page
 * mid-attempt each produce a named outcome, because a dropdown missing from the
 * results is indistinguishable from a dropdown that was never on the form — and
 * that is how a half-filled page comes back looking complete.
 */
export async function runOneDropdown(directive: DropdownDirective): Promise<DropdownRunResult> {
  const started = performance.now();
  const root = dropdownById(directive.dropdownId);
  const descriptor = descriptorById(directive.dropdownId);

  const finish = (patch: Partial<DropdownRunResult>): DropdownRunResult =>
    dropdownRunResultSchema.parse({
      dropdownId: directive.dropdownId,
      // Replaced by the worker, which is the only side that knows frame ids.
      frameId: 0,
      question: descriptor?.label ?? '',
      selector: descriptor?.selector ?? '',
      canonicalQuestion: directive.canonicalQuestion,
      controlStrategy: descriptor?.controlStrategy ?? 'unknown',
      // Carried from the descriptor, which recorded both when the control was
      // offered. Neither is a property of the attempt.
      discoverySource: descriptor?.discoverySource ?? 'dropdown_scan',
      ...(descriptor?.scanFieldId ? { scanFieldId: descriptor.scanFieldId } : {}),
      ...(descriptor?.structure ? { structure: descriptor.structure } : {}),
      intendedAnswerSource: directive.intendedAnswerSource,
      intendedAnswerResolved: directive.intendedAnswer.trim().length > 0,
      optionsFound: 0,
      opened: false,
      scrolled: false,
      selected: false,
      verified: false,
      finalStatus: 'FAILED_EXECUTION',
      reason: 'The attempt produced no outcome.',
      durationMs: Math.round(performance.now() - started),
      // Every path through this function ran here, in the frame that owns the
      // control. The worker's own placeholder for a frame that never answered
      // leaves this false, which is what tells the two apart.
      executorInvoked: true,
      ...patch,
    });

  if (!root) {
    return finish({
      errorCode: 'CONTROL_NOT_FOUND',
      finalStatus: 'BLOCKED',
      reason: 'The control is no longer on the page.',
    });
  }

  let outcome: Attempt;
  try {
    outcome = await withBudget(
      attempt(root, directive),
      {
        opened: false,
        scrolled: false,
        optionsFound: 0,
        selected: false,
        verified: false,
        failureCode: 'OPEN_FAILED' as const,
        reason: `The control did not reach an outcome within ${PER_DROPDOWN_BUDGET_MS}ms.`,
        status: 'FAILED_EXECUTION' as const,
        availableOptions: [],
        trace: { ...UNTOUCHED, openAttempted: true },
      },
      PER_DROPDOWN_BUDGET_MS,
    );
  } catch (cause) {
    try {
      releaseControl(root);
    } catch {
      // Closing is best-effort; the reported failure is the one that matters.
    }
    return finish({
      errorCode: 'OPTION_CLICK_FAILED',
      finalStatus: 'FAILED_EXECUTION',
      reason: `The control threw while being driven: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }

  return finish({
    optionsFound: outcome.optionsFound,
    opened: outcome.opened,
    scrolled: outcome.scrolled,
    selected: outcome.selected,
    verified: outcome.verified,
    finalStatus: outcome.status,
    reason: outcome.reason,
    ...(outcome.matchedOption ? { matchedOption: outcome.matchedOption } : {}),
    ...(outcome.failureCode ? { errorCode: outcome.failureCode } : {}),
    availableOptions: [...outcome.availableOptions],
    // A control that was just answered may have populated another. Reported so
    // the worker can re-scan the ones that changed rather than the whole page.
    mayHaveEnabledDependents: outcome.verified,
    triggerResolved: outcome.trace.triggerResolved,
    openAttempted: outcome.trace.openAttempted,
    menuDetection: outcome.trace.menuDetection,
    optionCandidates: outcome.trace.optionCandidates,
    scrollIterations: outcome.trace.scrollIterations,
    targetFound: outcome.trace.targetFound,
    clickAttempted: outcome.trace.clickAttempted,
    verificationObserved: outcome.trace.verificationObserved,
    // The `aria-expanded` the trigger reported *after* the press, folded into
    // the structure record the descriptor supplied. Structure only.
    ...(descriptor?.structure
      ? {
          structure: {
            ...descriptor.structure,
            ariaExpandedAfter: outcome.trace.ariaExpandedAfter,
          },
        }
      : {}),
  });
}

/**
 * Every directive this frame was given, one after another.
 *
 * Sequential on purpose. Two menus open at once is a page in a state no user
 * ever puts it in, and a widget that closes its neighbour on focus would make
 * the second attempt fail for a reason that has nothing to do with the second
 * control. The order is the worker's — parents before the controls that depend
 * on them — and this preserves it.
 *
 * One directive's failure never reaches the next: `runOneDropdown` always
 * returns a record, so the loop cannot be broken by a control that throws.
 */
export async function runDropdownDirectives(
  directives: readonly DropdownDirective[],
): Promise<DropdownRunResult[]> {
  const results: DropdownRunResult[] = [];
  for (const directive of directives) {
    results.push(await runOneDropdown(directive));
  }
  return results;
}
