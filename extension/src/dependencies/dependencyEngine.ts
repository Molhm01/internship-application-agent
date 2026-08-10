import {
  dependencyTraceSchema,
  fingerprintChanged,
  type ControlFingerprint,
  type DependencyDirective,
  type DependencyTrace,
  normalizeOptionText,
  type ErrorCode,
} from '@internship-agent/shared';
import { fingerprintControl, findControl } from './dependencyDetector.js';
import { clearIfAgentWrote, driveDependent } from './dependencyExecutor.js';
import { applicabilityOf, parentIsAnswered, readHeldValues } from './dependencyResolver.js';
import { awaitControlChangeWithRetry } from './dependencyWatcher.js';

/**
 * The Dependency Engine, inside one frame.
 *
 * One operation, and one sequence per edge:
 *
 *     parent settled? → fingerprint the child → wait for the page to react →
 *     rescan the child → drive it → verify it
 *
 * Every step is an observation. Nothing here assumes that answering Country
 * produced State's options; it records what State looked like before, watches
 * for that to change, and reads the list the page actually built. That is the
 * whole difference from what this replaces, which planned State's answer from
 * the option list State had *before* Country was touched — a list consisting of
 * the single prompt "Select a country first" — and then reported
 * `No option on the page matched "New Jersey"`.
 *
 * ## What it does not do
 *
 * It does not open menus, match options, or type text. Those belong to the
 * Dropdown Engine and the text executor, which it calls. It does not create
 * repeater blocks. It does not decide answers — the worker does, from the
 * profile, before any of this runs.
 *
 * ## Ordering
 *
 * The directives arrive already ordered, parent before child, from the worker's
 * topological sort. This loop must therefore stay sequential: driving two edges
 * of one chain concurrently is precisely the race the ordering exists to
 * remove.
 */

export interface DependencyEngineContext {
  document: Document;
  /** Ordered parent-before-child by the worker. Never reordered here. */
  directives: readonly DependencyDirective[];
  now?: () => number;
}

/**
 * Runs every directive against this frame, in the order given.
 *
 * Always returns one trace per directive. An edge whose control has left the
 * page is reported as such rather than omitted — an absent record and a record
 * saying "this was never on the form" read identically, and only one of them is
 * true.
 */
export async function runDependencyResolution(
  context: DependencyEngineContext,
): Promise<DependencyTrace[]> {
  const clock = context.now ?? (() => Date.now());
  const traces: DependencyTrace[] = [];
  /** Selectors this run has already settled, so a chain can check its parent. */
  const settled = new Set<string>();

  for (const directive of context.directives) {
    const trace = await runOne(context.document, directive, clock, settled);
    traces.push(trace);
    if (trace.dependentVerified) settled.add(directive.dependentSelector);
  }
  return traces;
}

/**
 * True when this control already holds the answer the run intends for it.
 *
 * Compared on the page's own words as well as its stored value, because a
 * select storing `NJ` and displaying `New Jersey` is holding the same answer as
 * a saved "New Jersey", and treating those as different is what makes a run
 * rewrite a field it had already got right.
 */
function holdsAnswer(element: HTMLElement, intended: string): boolean {
  const wanted = normalizeOptionText(intended);
  if (!wanted) return false;
  return readHeldValues(element)
    .map((value) => normalizeOptionText(value))
    .some((value) => value === wanted);
}

function traceOf(
  directive: DependencyDirective,
  patch: Partial<DependencyTrace> & Pick<DependencyTrace, 'finalStatus'>,
): DependencyTrace {
  return dependencyTraceSchema.parse({
    parent: directive.parent,
    dependent: directive.dependent,
    dependencyType: directive.dependencyType,
    ...(directive.parentRequiredState === undefined
      ? {}
      : { parentRequiredState: directive.parentRequiredState }),
    ...patch,
  });
}

async function runOne(
  document: Document,
  directive: DependencyDirective,
  clock: () => number,
  settled: ReadonlySet<string>,
): Promise<DependencyTrace> {
  const startedAt = clock();
  const elapsed = (): number => Math.max(0, clock() - startedAt);

  const parentPresent = findControl(document, directive.parentSelector) !== null;
  if (!parentPresent) {
    return traceOf(directive, {
      finalStatus: 'FAILED',
      errorCode: 'DEPENDENCY_CONTROL_NOT_FOUND',
      durationMs: elapsed(),
    });
  }

  // ── A conditional child: is this question being asked at all? ──────────────
  //
  // Decided from what the parent is holding in the live document, never from
  // what a plan intends it to hold. A plan that intends to choose "Other" has
  // not chosen it, and a child filled on that intention is filled against a
  // form state that does not exist.
  if (directive.dependencyType === 'CONDITIONAL_REQUIRED') {
    const applicability = applicabilityOf(
      document,
      directive.parentSelector,
      directive.parentRequiredState ?? '',
    );

    if (applicability === 'PARENT_UNANSWERED') {
      // Untouched, and deliberately so. This is the relatives case: nobody has
      // said whether the applicant has a relative at this company, so nothing
      // may be written into the box that describes one.
      return traceOf(directive, {
        parentResolved: false,
        finalStatus: 'WAITING_FOR_DEPENDENCY',
        errorCode: 'DEPENDENCY_PARENT_UNRESOLVED',
        durationMs: elapsed(),
      });
    }

    if (applicability === 'NOT_APPLICABLE') {
      // Emptied, but only if what it holds is what *this run* would have put
      // there. A not-applicable box holding the applicant's own words is their
      // business, and clearing it to satisfy a status destroys their work.
      //
      // Worth doing at all because an earlier stage can legitimately have
      // filled it before the parent settled: this stage runs after the
      // deterministic pass, and "the form is not asking this" is a fact that
      // only becomes knowable once the parent has an answer.
      const control = findControl(document, directive.dependentSelector);
      if (control) clearIfAgentWrote(control, directive.intendedAnswer);
      return traceOf(directive, {
        parentResolved: true,
        parentVerified: true,
        finalStatus: 'NOT_APPLICABLE',
        durationMs: elapsed(),
      });
    }

    // It applies. An answer nobody saved is the applicant's to give — never
    // filled from an unrelated profile fact because the label happens to
    // contain the word "name".
    if (directive.intendedAnswer.trim().length === 0) {
      return traceOf(directive, {
        parentResolved: true,
        parentVerified: true,
        finalStatus: 'USER_CONFIRMATION_REQUIRED',
        durationMs: elapsed(),
      });
    }

    const drive = await driveDependent({
      document,
      selector: directive.dependentSelector,
      canonicalQuestion: directive.dependent.intent || 'unknown',
      intendedAnswer: directive.intendedAnswer,
      intendedAnswerSource: directive.intendedAnswerSource,
      alternativeValues: directive.alternativeValues,
      ...(directive.searchText ? { searchText: directive.searchText } : {}),
      allowOtherFallback: directive.allowOtherFallback,
      requiresUserConfirmation: directive.requiresUserConfirmation,
      sensitive: directive.sensitive,
    });

    return traceOf(directive, {
      parentResolved: true,
      parentVerified: true,
      dependentExecuted: drive.executed,
      dependentVerified: drive.verified,
      finalStatus: drive.verified ? 'RESOLVED' : 'FAILED',
      ...(drive.verified
        ? {}
        : {
            errorCode: drive.executed
              ? ('DEPENDENCY_VERIFICATION_FAILED' as const)
              : ('DEPENDENCY_EXECUTION_FAILED' as const),
          }),
      durationMs: elapsed(),
    });
  }

  // ── An option-refresh, enable, or appear edge ──────────────────────────────
  const parentAnswered =
    parentIsAnswered(document, directive.parentSelector) || settled.has(directive.parentSelector);
  if (!parentAnswered) {
    // The child is next in the queue, not broken. `WAITING_FOR_DEPENDENCY`
    // rather than a failure is the point: a State control whose Country is
    // still open used to wear a red "Autofill failed" for the page's ordering.
    return traceOf(directive, {
      parentResolved: false,
      finalStatus: 'WAITING_FOR_DEPENDENCY',
      errorCode: 'DEPENDENCY_PARENT_UNRESOLVED',
      durationMs: elapsed(),
    });
  }

  // Already correct, so nothing is touched.
  //
  // Re-selecting a value a control already holds fires `change` at a framework
  // that rebuilds everything downstream of it — which on a four-deep chain
  // means answering School again wipes and refetches nothing, but answering
  // Country again wipes State and School. A pass that "helpfully" reasserts
  // settled answers is a pass that undoes its own earlier work.
  if (directive.intendedAnswer.trim().length > 0) {
    const current = findControl(document, directive.dependentSelector);
    if (current && holdsAnswer(current, directive.intendedAnswer)) {
      return traceOf(directive, {
        parentResolved: true,
        parentVerified: true,
        dependentVerified: true,
        finalStatus: 'RESOLVED',
        durationMs: elapsed(),
      });
    }
  }

  const before: ControlFingerprint = fingerprintControl(document, directive.dependentSelector);

  // Nothing to wait for when the list is already there.
  //
  // The wait exists for a control the page has yet to build. A control that is
  // present, enabled, and already offering real choices has been built —
  // typically on an earlier pass of the same run — and waiting on it anyway
  // costs the full bound *and finds nothing*, because the change being watched
  // for already happened. With eight edges on a page and five passes, that is
  // twenty-eight seconds per pass spent watching controls that were ready
  // before the watcher started, and it is what pushed a run past its budget
  // without a single dependency having failed.
  const alreadyUsable =
    before.present &&
    !before.disabled &&
    (before.optionCount === 0 || before.usableOptionCount > 0);

  const watched = alreadyUsable
    ? { mutationObserved: false, fingerprint: before, waitedMs: 0 }
    : await awaitControlChangeWithRetry(document, directive.dependentSelector, before);

  const after = fingerprintControl(document, directive.dependentSelector);
  const changed = alreadyUsable || watched.mutationObserved || fingerprintChanged(before, after);

  if (!after.present) {
    // A CONTROL_APPEAR child that never appeared is a different fact from an
    // option list that never rebuilt, and the two need different responses.
    const code: ErrorCode =
      directive.dependencyType === 'CONTROL_APPEAR'
        ? 'DEPENDENCY_CHILD_NOT_CREATED'
        : 'DEPENDENCY_CONTROL_NOT_FOUND';
    return traceOf(directive, {
      parentResolved: true,
      parentVerified: true,
      initialDependentFingerprint: before,
      mutationObserved: watched.mutationObserved,
      newFingerprint: after,
      finalStatus: 'FAILED',
      errorCode: code,
      durationMs: elapsed(),
    });
  }

  // Changed but still offering nothing to pick is the page having cleared the
  // list and never refilled it — a different fact from a list that was never
  // touched, and both are DEPENDENCY_OPTIONS_NOT_UPDATED to the user.
  if (after.optionCount > 0 && after.usableOptionCount === 0) {
    return traceOf(directive, {
      parentResolved: true,
      parentVerified: true,
      initialDependentFingerprint: before,
      mutationObserved: false,
      newFingerprint: after,
      finalStatus: 'FAILED',
      errorCode: 'DEPENDENCY_OPTIONS_NOT_UPDATED',
      durationMs: elapsed(),
    });
  }

  if (directive.intendedAnswer.trim().length === 0) {
    return traceOf(directive, {
      parentResolved: true,
      parentVerified: true,
      initialDependentFingerprint: before,
      mutationObserved: changed,
      newFingerprint: after,
      finalStatus: 'USER_CONFIRMATION_REQUIRED',
      durationMs: elapsed(),
    });
  }

  if (after.disabled) {
    return traceOf(directive, {
      parentResolved: true,
      parentVerified: true,
      initialDependentFingerprint: before,
      mutationObserved: changed,
      newFingerprint: after,
      finalStatus: 'FAILED',
      errorCode: 'DEPENDENCY_NOT_READY',
      durationMs: elapsed(),
    });
  }

  // Rescanned, then driven. The rescan is what discards the pre-parent option
  // set: the choices matched against below are the ones the page built after
  // the parent verified, never the prompt they replaced.
  const drive = await driveDependent({
    document,
    selector: directive.dependentSelector,
    canonicalQuestion: directive.dependent.intent || 'unknown',
    intendedAnswer: directive.intendedAnswer,
    intendedAnswerSource: directive.intendedAnswerSource,
    alternativeValues: directive.alternativeValues,
    ...(directive.searchText ? { searchText: directive.searchText } : {}),
    allowOtherFallback: directive.allowOtherFallback,
    requiresUserConfirmation: directive.requiresUserConfirmation,
    sensitive: directive.sensitive,
  });

  return traceOf(directive, {
    parentResolved: true,
    parentVerified: true,
    initialDependentFingerprint: before,
    mutationObserved: changed,
    dependentRescanned: true,
    newFingerprint: fingerprintControl(document, directive.dependentSelector),
    dependentExecuted: drive.executed,
    dependentVerified: drive.verified,
    // Taken from the drive rather than from the fingerprint above. A button-menu
    // widget has its menu closed again by this point, so fingerprinting it now
    // counts nothing — which is how a control the engine had just chosen from
    // eleven options was recorded as having offered none.
    dependentOptionCount: drive.result?.optionsFound ?? 0,
    finalStatus: drive.verified ? 'RESOLVED' : 'FAILED',
    ...(drive.verified
      ? {}
      : {
          errorCode: drive.executed
            ? ('DEPENDENCY_VERIFICATION_FAILED' as const)
            : ('DEPENDENCY_EXECUTION_FAILED' as const),
        }),
    durationMs: elapsed(),
  });
}
