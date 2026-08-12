import {
  dropdownDirectiveSchema,
  OPTION_INTERACTION_TYPES,
  toolExecutionResultSchema,
  type AgentToolCall,
  type DetectedField,
  type ToolExecutionResult,
} from '@internship-agent/shared';
import {
  closeControl,
  isVisible,
  readSelectedText,
  resolveTrigger,
  waitFor,
} from '../scanner/optionDiscovery.js';
import { collectCustomOptions, collectNativeOptions } from '../dropdown/dropdownOptionCollector.js';
import { runOneDropdown } from '../dropdown/dropdownEngine.js';
import { scanDropdowns, resetDropdownRegistry } from '../dropdown/dropdownScanner.js';
import { setNativeValue, dispatchValueEvents } from '../executor/domExecutor.js';
import { findControl } from '../dependencies/dependencyDetector.js';
import { countBlocks, findSection } from '../repeaters/repeaterScanner.js';
import { createBlock } from '../repeaters/repeaterCreator.js';
import {
  commitmentOf,
  elementForHandle,
  optionsOf,
  interactionTypeOf,
  SEARCH_HANDLE_SUFFIX,
  fieldForHandle,
  optionHandle,
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

/**
 * Questions where the form's own "Other" entry is the *true* answer when the
 * saved value is not listed, rather than a way to get something selected.
 *
 * Deliberately short. On Country, "Other" is a lie; on Area of Study it is what
 * an applicant would honestly pick for a subject the form does not enumerate,
 * and the free-text box beside it carries the real answer.
 */
const OTHER_IS_AN_HONEST_ANSWER = new Set([
  'field_of_study',
  'area_of_study',
  'major',
  'school',
  'institution',
  'how_did_you_hear',
]);

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

/**
 * Registers one control with the dropdown engine and drives it to an answer.
 *
 * The engine addresses controls through its own frame-local registry, so the
 * element is registered immediately before it is driven rather than carried
 * over from an earlier pass — the same reason the observation is rebuilt each
 * cycle, applied to the engine's own handles.
 */
async function driveDropdown(
  field: DetectedField,
  intendedAnswer: string,
): Promise<ReturnType<typeof runOneDropdown>> {
  resetDropdownRegistry();
  const scanned = scanDropdowns(document, [
    {
      fieldId: field.id,
      selector: field.selector,
      label: field.label,
      sectionContext: field.section ?? '',
      ...(field.canonicalKey ? { canonicalQuestion: field.canonicalKey } : {}),
      required: field.required,
      knownOptions: [],
    },
  ]);
  const target = scanned.find((entry) => entry.descriptor.scanFieldId === field.id) ?? scanned[0];
  if (!target) throw new Error('CONTROL_NOT_FOUND');
  return runOneDropdown(
    dropdownDirectiveSchema.parse({
      dropdownId: target.descriptor.dropdownId,
      canonicalQuestion: field.canonicalKey ?? 'other_custom',
      intendedAnswer,
      intendedAnswerSource: 'profile_fact',
      alternativeValues: [],
      // The form's own "Other" entry is the honest answer for a subject or a
      // school the list does not enumerate — and a lie on Country. The same
      // closed list the old executor used, for the same reason.
      allowOtherFallback: OTHER_IS_AN_HONEST_ANSWER.has(field.canonicalKey ?? ''),
      requiresUserConfirmation: false,
      sensitive: false,
    }),
  );
}

/**
 * The choices the control is offering at this instant, in the handle space the
 * call's handle was minted in.
 *
 * The subtlety that matters, and it is not cosmetic. Two things enumerate a
 * dropdown in this extension: the observer, which numbers every row including
 * the placeholder, and the engine's collector, which drops rows nobody may
 * choose. Their indices therefore disagree — `::option::2` is the third row to
 * one and the fourth to the other — and a handle resolved in the wrong space
 * selects the wrong answer while every log says it worked.
 *
 * Decisions are made against the *observation*, so the observation's reading is
 * the authority. The control is opened here with the collector — that is what
 * physically opens a menu — and then read back through `optionsOf`, the very
 * function that minted the handle being resolved.
 */
async function liveChoices(
  element: HTMLElement,
  field: DetectedField,
  handle: string,
): Promise<{ labels: string[] }> {
  // A `<select>` carries its list already; anything else has to be open before
  // there is a list to read, and this is the "options actually enumerated"
  // step of the contract.
  if (!(element instanceof HTMLSelectElement)) await collectCustomOptions(element);
  return { labels: optionsOf(field, handle).options.map((option) => option.label) };
}

/**
 * Which of those choices this call named.
 *
 * The handle is authoritative and is checked first: `e12::option::3` is the
 * fourth row, and if that row's text no longer agrees with the value the
 * decision carried, the list has moved and the handle is refused rather than
 * guessed around. A call carrying only a value is allowed, but only when the
 * live list actually contains it — the point being that in every path, the
 * string driven into the control is one the menu is offering right now.
 */
function resolveChoice(
  call: AgentToolCall,
  labels: readonly string[],
): { label: string; errorCode?: 'OPTION_HANDLE_UNKNOWN' | 'ANSWER_UNKNOWN'; reason: string } {
  const same = (left: string, right: string): boolean =>
    left
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() ===
    right
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  if (labels.length === 0) {
    return {
      label: '',
      errorCode: 'OPTION_HANDLE_UNKNOWN',
      reason: 'The control was opened and offered nothing to choose.',
    };
  }

  const named = (call.value ?? '').trim();
  const parsed = call.optionId ? parseOptionHandle(call.optionId) : null;
  if (parsed) {
    const atIndex = labels[parsed.index];
    if (atIndex === undefined) {
      return {
        label: '',
        errorCode: 'OPTION_HANDLE_UNKNOWN',
        reason: `The list now offers ${labels.length} choice(s) and that handle names row ${parsed.index}.`,
      };
    }
    // The row is still the row the decision meant. Its *current* text is what
    // gets driven, so a relabelled row is followed rather than fought.
    if (!named || same(atIndex, named)) return { label: atIndex, reason: '' };
    // The handle and the value disagree, which means the list changed under
    // the observation. Fall back to the value only if the live list still
    // offers it; otherwise refuse, because clicking row 3 regardless is how a
    // run selects something nobody chose.
    const byText = labels.find((label) => same(label, named));
    if (byText !== undefined) return { label: byText, reason: '' };
    return {
      label: '',
      errorCode: 'OPTION_HANDLE_UNKNOWN',
      reason:
        'The list changed since it was read, and neither the handle nor the value names a choice it is offering now.',
    };
  }

  if (!named) {
    return { label: '', errorCode: 'ANSWER_UNKNOWN', reason: 'No option was named.' };
  }
  const byText = labels.find((label) => same(label, named));
  if (byText !== undefined) return { label: byText, reason: '' };
  // Not an exact row, but the engine's own matching is cleverer than this
  // comparison — "NJ" for "New Jersey", a code beside a label — so the value is
  // passed through for it to resolve against the same live list.
  return { label: named, reason: '' };
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
        const collected =
          element instanceof HTMLSelectElement
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
              label: option.displayedText,
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
        dispatchValueEvents(element);
        // Verified against the control's own state, here and not later: a
        // framework that rejects or reformats a value leaves the box holding
        // something else, and that is a failure rather than a success.
        const observed = element.value;
        return result(
          call,
          {
            executed: true,
            observedValue: observed.slice(0, 600),
            pageChanged: observed === value,
            ...(observed === value ? {} : { errorCode: 'VALUE_NOT_VERIFIED' as const }),
            reason:
              observed === value
                ? 'The control holds what was written.'
                : 'The control holds something else.',
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
        const live = await liveChoices(element, field, call.elementId ?? '');
        const resolved = resolveChoice(call, live.labels);
        if (resolved.errorCode) {
          return result(
            call,
            {
              options: live.labels.map((label, index) => ({
                optionId: optionHandle(call.elementId ?? '', index),
                label,
                disabled: false,
                selected: false,
              })),
              optionsSeen: live.labels.length,
              errorCode: resolved.errorCode,
              reason: resolved.reason,
            },
            begun,
          );
        }
        const wanted = resolved.label;

        const outcome = await driveDropdown(field, wanted);

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
        const held = outcome.verified && commitment.committed && !commitment.saysUnanswered;
        const failureCode = outcome.errorCode
          ? ('OPTION_NOT_FOUND' as const)
          : outcome.verified && !held
            ? ('SELECTION_NOT_COMMITTED' as const)
            : undefined;
        return result(
          call,
          {
            executed: (outcome.selected || outcome.finalStatus === 'SKIPPED_ALREADY_VALID') && held,
            observedValue: readSelectedText(element).slice(0, 600),
            // The count the engine actually read while choosing. The list
            // itself is dropped on success; this is what proves the selection
            // came from options that were there.
            optionsSeen: Math.max(outcome.optionsFound, live.labels.length),
            options: outcome.availableOptions.map((option, index) => ({
              optionId: optionHandle(call.elementId ?? '', index),
              label: option.displayedText,
              disabled: option.disabled,
              selected: option.selected,
            })),
            pageChanged: held,
            ...(failureCode ? { errorCode: failureCode } : {}),
            reason: held
              ? outcome.reason
              : failureCode === 'SELECTION_NOT_COMMITTED'
                ? `The control shows the choice and the form has not kept it${
                    commitment.validationError ? `: "${commitment.validationError}"` : '.'
                  }`
                : outcome.reason,
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
