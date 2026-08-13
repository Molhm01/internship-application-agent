import {
  DATE_INTERACTION_TYPES,
  DROPDOWN_INTERACTION_TYPES,
  formatNormalizedDate,
  holdsWrittenValue,
  OPTION_INTERACTION_TYPES,
  toolExecutionResultSchema,
  type AgentToolCall,
  type DetectedField,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import { dateAccepted, dateRequirementOf, readDateValidation } from './dateControl.js';
import {
  closeControl,
  isVisible,
  pressPointer,
  readSelectedText,
  resolveTrigger,
  waitFor,
} from '../scanner/optionDiscovery.js';
import { collectCustomOptions, collectNativeOptions } from '../dropdown/dropdownOptionCollector.js';
import { setNativeValue, dispatchValueEvents } from '../executor/domExecutor.js';
import { findControl } from '../dependencies/dependencyDetector.js';
import { countBlocks, findSection } from '../repeaters/repeaterScanner.js';
import { createBlock } from '../repeaters/repeaterCreator.js';
import {
  commitmentOf,
  currentObservationId,
  elementForHandle,
  optionsOf,
  interactionTypeOf,
  SEARCH_HANDLE_SUFFIX,
  fieldForHandle,
  optionHandle,
  optionReferenceForHandle,
  parseOptionHandle,
  repeaterKindForHandle,
} from './pageObserver.js';

/**
 * One tool, executed against the live page.
 *
 * Every implementation here is an *adapter* over machinery that already worked.
 * `type` is the existing native-setter write; `open_dropdown` and
 * `select_option` are the authoritative dropdown engine; `click_add` is the
 * repeater creator. None of that is reimplemented, because none of it was the
 * problem — the problem was that those engines each tried to solve the whole
 * page from a stale plan. Here they are hands, and the loop is the brain.
 *
 * ## One action, and then nothing
 *
 * Each call does exactly one thing and returns. It does not go on to the next
 * field, it does not retry a different strategy, and it does not look for
 * anything else to fix. The caller observes the page again and decides again,
 * which is what makes a dependency work without a graph: `select_option` on
 * Country returns, the next observation shows State enabled, and State becomes
 * the next decision because that is what the page now offers.
 *
 * ## Handles, not selectors
 *
 * A tool call names an element by a handle the observation minted. Resolution
 * goes through the live DOM by the scanned selector rather than through a
 * stored node, so a control the page *replaced* since the observation is found
 * again — and one that has genuinely gone reports `CONTROL_NOT_FOUND` instead
 * of writing into a detached element.
 */

/** How long a tool waits for the page to react before reporting what it saw. */
const CHANGE_WAIT_MS = 1200;

const started = (): number => performance.now();

function result(
  call: AgentToolCall,
  patch: Partial<ToolExecutionResult>,
  begun: number,
): ToolExecutionResult {
  return toolExecutionResultSchema.parse({
    tool: call.tool,
    executed: false,
    durationMs: Math.round(performance.now() - begun),
    ...patch,
  });
}

/** The control a handle names, resolved against the page as it stands now. */
function resolve(call: AgentToolCall): {
  element: HTMLElement | null;
  field: DetectedField | null;
} {
  if (!call.elementId) return { element: null, field: null };
  return {
    element: elementForHandle(call.elementId),
    field: fieldForHandle(call.elementId),
  };
}

function staleOption(call: AgentToolCall): boolean {
  const parsed = call.optionId ? parseOptionHandle(call.optionId) : null;
  return parsed?.observationId !== undefined && parsed.observationId !== currentObservationId();
}

function currentOption(call: AgentToolCall) {
  if (!call.optionId || staleOption(call)) return null;
  const reference = optionReferenceForHandle(call.optionId);
  if (!reference || reference.elementId !== call.elementId) return null;
  if (!reference.node.isConnected || !reference.owner.isConnected) return null;
  if (
    reference.node instanceof HTMLOptionElement &&
    reference.node.index !== reference.index
  ) {
    return null;
  }
  const currentLabel =
    reference.node instanceof HTMLInputElement
      ? (reference.node.labels?.[0]?.textContent ??
          reference.node.getAttribute('aria-label') ??
          reference.node.value)
      : (reference.node.textContent ?? '');
  if (currentLabel.replace(/\s+/g, ' ').trim() !== reference.label) return null;
  return reference;
}

function clickActualOption(node: HTMLElement): void {
  node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (!(node instanceof HTMLOptionElement)) node.focus?.();
  pressPointer(node);
}

/**
 * Runs one tool and reports what was observed, never what was intended.
 *
 * Total by construction: every path returns a result. A tool that throws is a
 * named failure rather than a run that stops, because the loop's next decision
 * needs to know this element failed in order to try something else.
 */
export async function executeAgentTool(call: AgentToolCall): Promise<ToolExecutionResult> {
  const begun = started();
  try {
    switch (call.tool) {
      // ---- Reading -------------------------------------------------------
      case 'observe_page':
      case 'wait_for_change': {
        // The loop observes after every action anyway; as an explicit tool this
        // is simply a no-op that costs the agent one step, which is what stops
        // "observe again" from being a way to spin forever.
        return result(call, { executed: true, pageChanged: false, reason: 'Looked again.' }, begun);
      }

      case 'get_options':
      case 'open_dropdown': {
        const { element, field } = resolve(call);
        if (!element || !field) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That control is no longer on the page.' },
            begun,
          );
        }
        const behaviour = interactionTypeOf(element);
        if (
          call.tool === 'open_dropdown' &&
          !(DROPDOWN_INTERACTION_TYPES as readonly string[]).includes(behaviour)
        ) {
          return result(
            call,
            { errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE', reason: 'That choice control does not open a popup.' },
            begun,
          );
        }
        if (
          call.tool === 'get_options' &&
          !(OPTION_INTERACTION_TYPES as readonly string[]).includes(behaviour)
        ) {
          return result(
            call,
            { errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE', reason: 'That control does not expose choices.' },
            begun,
          );
        }
        const observedGroup =
          behaviour === 'RADIO_GROUP' || behaviour === 'CHECKBOX_GROUP'
            ? optionsOf(field, call.elementId ?? '').options
            : null;
        const collected = observedGroup
          ? {
              opened: true,
              choices: observedGroup.map((option) => ({
                displayedText: option.label,
                value: option.value,
                disabled: option.disabled,
                selected: option.selected,
              })),
            }
          : element instanceof HTMLSelectElement
            ? collectNativeOptions(element)
            : await collectCustomOptions(element);
        // Left open on purpose for `open_dropdown`: the next decision is
        // normally `select_option`, and closing it here would mean opening it
        // twice — during which a framework may rebuild the list.
        if (call.tool === 'get_options' && !(element instanceof HTMLSelectElement)) {
          closeControl(resolveTrigger(element));
        }
        return result(
          call,
          {
            executed: collected.opened,
            options: collected.choices.map((option, index) => ({
              // Named by the handle of the control that offered them, so the
              // next decision selects a choice this read actually saw.
              optionId: optionHandle(call.elementId ?? '', index),
              index,
              label: option.displayedText,
              value: option.value,
              disabled: option.disabled,
              selected: option.selected,
            })),
            observedValue: readSelectedText(element).slice(0, 600),
            optionsSeen: collected.choices.length,
            pageChanged: collected.opened,
            ...(collected.opened ? {} : { errorCode: 'DROPDOWN_OPEN_FAILED' as const }),
            reason: collected.opened
              ? `The control offered ${collected.choices.length} choice(s).`
              : 'The control did not open.',
          },
          begun,
        );
      }

      // ---- Writing -------------------------------------------------------
      case 'type': {
        const { element } = resolve(call);
        if (!element) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That control is no longer on the page.' },
            begun,
          );
        }
        // ---- The second lock on the door. ----------------------------------
        //
        // `checkDecision` already refuses this, and it is refused again here
        // because the two guards fail differently: the validator reasons from
        // the *observation*, and this reasons from the element in front of it.
        // A control the page turned into a dropdown after it was observed gets
        // past the first and not past the second.
        //
        // Being an `<input>` proves nothing — a React-select trigger and a
        // readonly Workday combobox are both inputs. What is asked is what the
        // control *does*, and a control that answers from a list is never typed
        // into. The single exception is the search box inside an opened menu,
        // which the observer emits under its own handle; that box narrows a
        // list and still leaves the choosing to `select_option`.
        const searchBox = call.elementId?.endsWith(SEARCH_HANDLE_SUFFIX) ?? false;
        const behaviour = interactionTypeOf(element);
        if (!searchBox && (OPTION_INTERACTION_TYPES as readonly string[]).includes(behaviour)) {
          return result(
            call,
            {
              errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE',
              reason: 'That control answers from a list, so it is opened and chosen from.',
            },
            begun,
          );
        }
        // The same second lock, for dates. `checkDecision` refused this against
        // the observation; this refuses it against the element in front of us,
        // and the two can genuinely disagree — a control the page re-rendered
        // into a masked date box after it was observed gets past the first and
        // not past this.
        //
        // Nothing is written before the refusal. That is the point of putting
        // it here rather than checking the value afterwards: the live failure
        // is `2021-07` reaching the employer's DOM at all, and a check that
        // fires after `setNativeValue` would only be able to report it.
        if (!searchBox && (DATE_INTERACTION_TYPES as readonly string[]).includes(behaviour)) {
          return result(
            call,
            {
              errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE',
              reason:
                'That control is a date control, so a saved date is never typed into it verbatim. It is written with set_date, in the format the control asks for.',
            },
            begun,
          );
        }
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
          return result(
            call,
            { errorCode: 'UNSUPPORTED_CONTROL', reason: 'That control is not typed into.' },
            begun,
          );
        }
        const value = call.value ?? '';
        element.focus();
        setNativeValue(element, value);
        if (searchBox) {
          element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        } else {
          dispatchValueEvents(element);
        }
        // Read back from the control's own state, here and not later.
        //
        // `holdsWrittenValue` rather than `===`, because a control that
        // *reformats* what it keeps has still kept it. A phone box handed
        // `+1 201 555 0134` and storing `(201) 555-0134` has the applicant's
        // number in it; reporting that as `VALUE_NOT_VERIFIED` made a
        // correctly filled field look like a failed write at every layer above
        // this one, and contributed to a live run counting zero of its own
        // successful writes.
        //
        // A box that kept something genuinely different, or nothing, is still a
        // failure — and the loop's verifier takes the same reading again
        // against fresh page state, because this one is the executor's opinion
        // and the executor's opinion is not evidence.
        const observed = element.value;
        const kept = holdsWrittenValue(observed, value);
        return result(
          call,
          {
            executed: true,
            observedValue: observed.slice(0, 600),
            pageChanged: kept,
            ...(kept ? {} : { errorCode: 'TEXT_VALUE_NOT_COMMITTED' as const }),
            reason: kept
              ? 'The control holds what was written.'
              : 'The control holds something else.',
          },
          begun,
        );
      }

      // ---- One date, in the shape this control asked for. ------------------
      //
      // The whole repair, in one tool. The date arrives as parts — year, month,
      // day, precision — and the *string* is composed here, against the control
      // that is about to receive it. That ordering is what makes the same saved
      // fact land as `07/12/2021` on Lincoln Electric and `2021-07-12` in a
      // native picker, instead of arriving as `2021-07` on both because that is
      // how the profile happens to store it.
      //
      // Nothing is written unless a value could be produced. A month-precision
      // date against a control demanding a day leaves the box exactly as it
      // was and reports `DATE_PRECISION_INSUFFICIENT`, because a half-right
      // date in an employer's form is worse than an empty one: the applicant
      // can see an empty box.
      case 'set_date': {
        const { element, field } = resolve(call);
        if (!element) {
          return result(
            call,
            {
              errorCode: 'DATE_CONTROL_NOT_FOUND',
              reason: 'That date control is no longer on the page.',
            },
            begun,
          );
        }
        // Read from the element, not from the observation that produced the
        // decision. A page that re-rendered the control since then may have
        // changed what it asks for, and the element in front of us is the thing
        // that will accept or reject the value.
        const behaviour = interactionTypeOf(element);
        if (!(DATE_INTERACTION_TYPES as readonly string[]).includes(behaviour)) {
          return result(
            call,
            {
              errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE',
              reason: 'That control is not a date control, so set_date does not apply to it.',
            },
            begun,
          );
        }
        const requirement = dateRequirementOf(element, field);
        if (!requirement) {
          return result(
            call,
            {
              errorCode: 'DATE_FORMAT_UNSUPPORTED',
              reason: 'That control did not state a date format this build can write.',
            },
            begun,
          );
        }
        const date = call.normalizedDate;
        if (!date) {
          return result(
            call,
            { errorCode: 'DATE_USER_INPUT_REQUIRED', reason: 'No date was supplied to write.' },
            begun,
          );
        }
        // `ask` deliberately, and not the applicant's stored convention: by the
        // time a call reaches here, any approved convention has *already* been
        // applied by the decider and checked by the safety layer, and the date
        // carries `dayFromConvention` to say so. Re-applying it here would be a
        // second, unchecked place a day could be invented.
        const formatted = formatNormalizedDate(date, requirement.shape, 'ask');
        if (formatted.kind === 'refused') {
          return result(call, { errorCode: formatted.code, reason: formatted.reason }, begun);
        }

        const before = readDateValidation(element);
        if (!(element instanceof HTMLInputElement)) {
          return result(
            call,
            { errorCode: 'DATE_EXECUTION_FAILED', reason: 'That date control is not writable.' },
            begun,
          );
        }
        element.focus();
        setNativeValue(element, formatted.value);
        dispatchValueEvents(element);
        // Blurred on purpose, and it is not cosmetic: an ATS that validates a
        // masked date box overwhelmingly does it on blur, so a run that never
        // blurs never learns that its value was rejected. This is what turns
        // "the box contains the date" into "the employer accepted the date".
        element.blur();
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        // Give the page a moment to paint its complaint before reading it.
        await waitFor(() => (readDateValidation(element).message ? true : null), 300);

        const outcome = dateAccepted(element, formatted.value);
        return result(
          call,
          {
            executed: outcome.accepted,
            observedValue: outcome.held.slice(0, 600),
            pageChanged: outcome.held.trim().length > 0,
            ...(outcome.accepted
              ? {}
              : outcome.held.trim() === formatted.value.trim()
                ? { errorCode: 'DATE_VALIDATION_FAILED' as const }
                : { errorCode: 'DATE_EXECUTION_FAILED' as const }),
            reason: outcome.accepted
              ? `The control holds the date in ${requirement.shape} form and the form raised nothing.`
              : outcome.held.trim() === formatted.value.trim()
                ? `The control holds the date and the form rejected it${
                    outcome.validation.message ? `: "${outcome.validation.message}"` : '.'
                  }`
                : 'The control did not keep the date that was written.',
            // Carried home so the trace can show the page's verdict on either
            // side of the write. Without the "before" reading a control that
            // was *already* complaining is indistinguishable from one this
            // action broke, and those call for opposite responses.
            dateShapeWritten: formatted.shape,
            dateValidationBefore: before,
            dateValidationAfter: outcome.validation,
          },
          begun,
        );
      }

      case 'clear': {
        const { element } = resolve(call);
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'Nothing to clear.' },
            begun,
          );
        }
        element.focus();
        setNativeValue(element, '');
        dispatchValueEvents(element);
        return result(
          call,
          { executed: true, observedValue: element.value, pageChanged: true, reason: 'Cleared.' },
          begun,
        );
      }

      case 'focus': {
        const { element } = resolve(call);
        if (!element)
          return result(call, { errorCode: 'CONTROL_NOT_FOUND', reason: 'Gone.' }, begun);
        resolveTrigger(element).focus();
        return result(call, { executed: true, reason: 'Focused.' }, begun);
      }

      case 'select_option': {
        const { element, field } = resolve(call);
        if (!element || !field) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That control is no longer on the page.' },
            begun,
          );
        }

        // ---- The choice is resolved against the menu as it stands now. -----
        //
        // A handle names a row in a list some earlier observation read, and a
        // list is not a stable thing: answering Country rebuilds State, a
        // framework re-renders between the read and the click, and a search box
        // filters the rows out from under the index. So the menu is opened and
        // enumerated again *here*, and the handle is resolved against that
        // reading. What is driven is a string this run has just watched the
        // control offer — never one carried over from a previous cycle, and
        // never one composed from the profile.
        if (!call.optionId) {
          return result(
            call,
            {
              errorCode: 'INVALID_OPTION_ID',
              reason: 'select_option requires an optionId from the current observation.',
            },
            begun,
          );
        }
        if (staleOption(call)) {
          return result(
            call,
            {
              errorCode: 'STALE_OPTION_REFERENCE',
              reason: 'That optionId belongs to an earlier menu observation.',
            },
            begun,
          );
        }
        const registered = optionReferenceForHandle(call.optionId);
        if (!registered) {
          return result(
            call,
            {
              errorCode: 'INVALID_OPTION_ID',
              reason: 'That optionId was not minted by the current option observation.',
            },
            begun,
          );
        }
        const reference = currentOption(call);
        if (!reference) {
          return result(
            call,
            {
              errorCode: 'STALE_OPTION_REFERENCE',
              reason: 'The exact option node changed or disappeared after it was observed.',
            },
            begun,
          );
        }
        const behaviour = interactionTypeOf(element);
        if (
          ![
            'NATIVE_SELECT',
            'CUSTOM_SELECT',
            'SEARCHABLE_COMBOBOX',
            'RADIO_GROUP',
          ].includes(behaviour)
        ) {
          return result(
            call,
            {
              errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE',
              reason: 'select_option is not legal for that control type.',
            },
            begun,
          );
        }

        if (element instanceof HTMLSelectElement && reference.node instanceof HTMLOptionElement) {
          element.scrollIntoView?.({ block: 'center' });
          element.focus();
          element.selectedIndex = reference.node.index;
          dispatchValueEvents(element);
          element.blur();
        } else {
          clickActualOption(reference.node);
        }
        await waitFor(
          () => {
            if (reference.node instanceof HTMLInputElement) return reference.node.checked || null;
            const committed = commitmentOf(field, true);
            return committed.committed && !committed.saysUnanswered ? true : null;
          },
          CHANGE_WAIT_MS,
        );

        // ---- And then checked against what the form kept. ------------------
        //
        // The engine verifies that the control *displays* the choice, which is
        // necessary and is not sufficient: on Lincoln Electric the Education
        // Type trigger read "BS" over an empty value while the page went on
        // showing "Education Type is required". So the backing store and the
        // form's own complaint are read here, and a control that displays an
        // answer it did not keep is a failure at the moment it happens rather
        // than a success the next observation has to catch.
        const commitment = commitmentOf(field, true);
        const selected =
          reference.node instanceof HTMLOptionElement
            ? reference.node.selected
            : reference.node instanceof HTMLInputElement
              ? reference.node.checked
              : reference.node.getAttribute('aria-selected') === 'true' ||
                reference.node.getAttribute('aria-checked') === 'true' ||
                commitment.committed;
        const held = selected && commitment.committed && !commitment.saysUnanswered;
        const failureCode = held ? undefined : ('SELECTION_NOT_COMMITTED' as const);
        return result(
          call,
          {
            executed: held,
            observedValue: readSelectedText(element).slice(0, 600),
            optionsSeen: 1,
            pageChanged: held,
            ...(failureCode ? { errorCode: failureCode } : {}),
            reason: held
              ? 'The exact observed DOM option was clicked and the control committed it.'
              : `The exact option was clicked but the form has not kept it${
                  commitment.validationError ? `: "${commitment.validationError}"` : '.'
                }`,
          },
          begun,
        );
      }

      case 'select_options': {
        const { element, field } = resolve(call);
        if (!element || !field || interactionTypeOf(element) !== 'CHECKBOX_GROUP') {
          return result(
            call,
            { errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE', reason: 'select_options requires a checkbox group.' },
            begun,
          );
        }
        const optionIds = call.optionIds ?? [];
        if (optionIds.length === 0) {
          return result(call, { errorCode: 'INVALID_OPTION_ID', reason: 'No choices were provided.' }, begun);
        }
        const references = optionIds.map((optionId) => currentOption({ ...call, optionId }));
        if (references.some((reference) => reference === null)) {
          const hasUnregistered = optionIds.some(
            (optionId) => !optionReferenceForHandle(optionId),
          );
          return result(
            call,
            {
              errorCode: hasUnregistered
                ? 'INVALID_OPTION_ID'
                : 'STALE_OPTION_REFERENCE',
              reason: 'At least one checkbox choice is not part of the current option observation.',
            },
            begun,
          );
        }
        for (const reference of references) {
          if (!(reference!.node instanceof HTMLInputElement) || reference!.node.type !== 'checkbox') {
            return result(call, { errorCode: 'INVALID_OPTION_ID', reason: 'A named choice is not a checkbox.' }, begun);
          }
        }
        for (const reference of references) {
          const checkbox = reference!.node as HTMLInputElement;
          if (!checkbox.checked) clickActualOption(checkbox);
        }
        const held = references.every(
          (reference) => reference!.node instanceof HTMLInputElement && reference!.node.checked,
        );
        return result(
          call,
          {
            executed: held,
            optionsSeen: references.length,
            pageChanged: held,
            ...(held ? {} : { errorCode: 'SELECTION_NOT_COMMITTED' as const }),
            reason: held
              ? 'Every exact observed checkbox choice is checked.'
              : 'At least one checkbox choice did not remain checked.',
          },
          begun,
        );
      }

      case 'set_checked': {
        const { element } = resolve(call);
        if (!(element instanceof HTMLInputElement) || interactionTypeOf(element) !== 'SINGLE_CHECKBOX') {
          return result(
            call,
            { errorCode: 'WRONG_TOOL_FOR_CONTROL_TYPE', reason: 'set_checked requires one checkbox.' },
            begun,
          );
        }
        const wanted = call.checked;
        if (wanted === undefined) {
          return result(call, { errorCode: 'ANSWER_UNKNOWN', reason: 'No checked state was provided.' }, begun);
        }
        if (element.checked !== wanted) clickActualOption(element);
        return result(
          call,
          {
            executed: element.checked === wanted,
            pageChanged: element.checked === wanted,
            observedValue: element.checked ? 'checked' : 'unchecked',
            ...(element.checked === wanted ? {} : { errorCode: 'SELECTION_NOT_COMMITTED' as const }),
            reason: element.checked === wanted ? 'The checkbox holds the requested state.' : 'The checkbox did not keep the requested state.',
          },
          begun,
        );
      }

      case 'click': {
        const { element } = resolve(call);
        if (!element)
          return result(call, { errorCode: 'CONTROL_NOT_FOUND', reason: 'Gone.' }, begun);
        const before = document.body.innerHTML.length;
        resolveTrigger(element).click();
        const changed = await waitFor(
          () => (document.body.innerHTML.length !== before ? true : null),
          CHANGE_WAIT_MS,
        );
        return result(
          call,
          { executed: true, pageChanged: changed === true, reason: 'Clicked.' },
          begun,
        );
      }

      // ---- Structure -----------------------------------------------------
      case 'click_add': {
        const kind = call.elementId ? repeaterKindForHandle(call.elementId) : null;
        if (!kind) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That Add control is not on this page.' },
            begun,
          );
        }
        const section = findSection(document, kind);
        if (!section) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That section is not on this page.' },
            begun,
          );
        }
        const before = countBlocks(section);
        const outcome = await createBlock(section);
        const after = countBlocks(findSection(document, kind) ?? section);
        return result(
          call,
          {
            executed: outcome.created > 0,
            pageChanged: after > before,
            observedValue: String(after),
            ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
            reason:
              after > before
                ? `The section now holds ${after} block(s).`
                : 'The Add control produced no new block.',
          },
          begun,
        );
      }

      case 'click_next': {
        const element = call.elementId ? elementForHandle(call.elementId) : null;
        if (!element) {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That control is gone.' },
            begun,
          );
        }
        const url = window.location.href;
        const before = document.body.innerHTML.length;
        element.click();
        const changed = await waitFor(
          () =>
            window.location.href !== url || document.body.innerHTML.length !== before ? true : null,
          CHANGE_WAIT_MS * 2,
        );
        return result(
          call,
          { executed: true, pageChanged: changed === true, reason: 'Moved to the next step.' },
          begun,
        );
      }

      case 'scroll_page': {
        window.scrollBy({ top: window.innerHeight * 0.8 });
        return result(call, { executed: true, reason: 'Scrolled the page.' }, begun);
      }

      case 'scroll_element': {
        const { element } = resolve(call);
        if (!element)
          return result(call, { errorCode: 'CONTROL_NOT_FOUND', reason: 'Gone.' }, begun);
        element.scrollIntoView?.({ block: 'center' });
        return result(call, { executed: true, reason: 'Scrolled to the control.' }, begun);
      }

      case 'upload_document': {
        const { element } = resolve(call);
        if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
          return result(
            call,
            { errorCode: 'CONTROL_NOT_FOUND', reason: 'That is not an upload control.' },
            begun,
          );
        }
        // The document bytes never travel through a decision. The worker
        // attaches them through the existing document path; this reports what
        // the control holds so the loop can verify rather than assume.
        return result(
          call,
          {
            executed: false,
            observedValue: element.files?.[0]?.name ?? '',
            errorCode: 'UPLOAD_FAILED',
            reason: 'Document attachment is handled by the worker, not by a page tool.',
          },
          begun,
        );
      }

      // ---- Terminal ------------------------------------------------------
      case 'ask_user':
      case 'finish_for_review': {
        return result(call, { executed: true, reason: 'No page action.' }, begun);
      }

      default: {
        return result(call, { errorCode: 'UNSUPPORTED_CONTROL', reason: 'Unknown tool.' }, begun);
      }
    }
  } catch (cause) {
    return result(
      call,
      {
        errorCode: 'AGENT_TOOL_FAILED',
        reason: `The tool threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      begun,
    );
  }
}

/** Whether a control is on screen, for the loop's own sanity checks. */
export function isElementVisible(handle: string): boolean {
  const element = elementForHandle(handle);
  return element ? isVisible(element) : false;
}

/** Whether a field currently holds anything, read from the live control. */
export function currentValueOfField(field: DetectedField): string {
  const element = findControl(document, field.selector);
  if (!element) return '';
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return readSelectedText(element);
}
