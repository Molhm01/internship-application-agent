import {
  dropdownDirectiveSchema,
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
import { elementForHandle, fieldForHandle, repeaterKindForHandle } from './pageObserver.js';

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
            options: collected.choices.map((option) => ({
              label: option.displayedText,
              disabled: option.disabled,
              selected: option.selected,
            })),
            observedValue: readSelectedText(element).slice(0, 600),
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
        const wanted = call.value ?? '';
        if (!wanted.trim()) {
          return result(
            call,
            { errorCode: 'ANSWER_UNKNOWN', reason: 'No option was named.' },
            begun,
          );
        }
        const outcome = await driveDropdown(field, wanted);
        return result(
          call,
          {
            executed: outcome.selected || outcome.finalStatus === 'SKIPPED_ALREADY_VALID',
            observedValue: readSelectedText(element).slice(0, 600),
            options: outcome.availableOptions.map((option) => ({
              label: option.displayedText,
              disabled: option.disabled,
              selected: option.selected,
            })),
            pageChanged: outcome.verified,
            ...(outcome.errorCode ? { errorCode: 'OPTION_NOT_FOUND' as const } : {}),
            reason: outcome.reason,
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
