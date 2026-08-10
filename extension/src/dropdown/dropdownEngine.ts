import {
  dropdownRunResultSchema,
  type CollectedOption,
  type DropdownDirective,
  type DropdownFailureCode,
  type DropdownFinalStatus,
  type DropdownRunResult,
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
  };
}

async function attempt(root: HTMLElement, directive: DropdownDirective): Promise<Attempt> {
  const native =
    root instanceof HTMLSelectElement
      ? root
      : resolveTrigger(root) instanceof HTMLSelectElement
        ? (resolveTrigger(root) as HTMLSelectElement)
        : null;

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
