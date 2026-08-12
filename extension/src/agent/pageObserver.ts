import {
  answerPolicySchema,
  describesThirdPartyDetails,
  isNeverGuessedQuestion,
  isPlaceholderSelection,
  OPTION_INTERACTION_TYPES,
  observedControlKindSchema,
  observedElementSchema,
  pageObservationSchema,
  type AnswerPolicy,
  type DetectedField,
  type ObservedControlKind,
  type ObservedElement,
  type InteractionType,
  type RepeaterKind,
  type PageObservation,
} from '@internship-agent/shared';
import { scanDom } from '../scanner/domScanner.js';
import { detectAtsByHostname, isFinalSubmitControl } from '../scanner/adapters.js';
import {
  elementById,
  findListbox,
  findSearchInput,
  isVisible,
  readOptions,
  readSelectedText,
  resolveTrigger,
  scopeOf,
} from '../scanner/optionDiscovery.js';
import { answersFromList, isCustomCombobox, opensOptionList } from '../scanner/domScanner.js';
import { dateRequirementOf, isDateControl, readDateValidation } from './dateControl.js';
import { findControl } from '../dependencies/dependencyDetector.js';
import { countBlocks, findAddControl, findSection } from '../repeaters/repeaterScanner.js';

/**
 * What the page looks like *right now*, in the vocabulary the agent reasons in.
 *
 * This is the "observe" half of observe → decide → act → verify, and its most
 * important property is that it is thrown away and rebuilt after every action.
 * The old pipeline scanned once and planned everything from that snapshot; this
 * never holds an element reference across a cycle, because on a real portal a
 * control is routinely *replaced* rather than mutated — a State list rebuilt
 * after Country, a block re-rendered after Add — and a stale reference points
 * at an element the page has already discarded.
 *
 * ## What the model is given
 *
 * Not the DOM. A list of controls with their labels, kinds, current values,
 * required flags, and — critically — the options a control is offering *at this
 * instant*, which for a closed custom dropdown is none. Pretending a closed
 * dropdown has options is what let the old planner match an answer against a
 * list that had ceased to exist.
 *
 * ## The handles
 *
 * Every element gets an `elementId` minted here, valid only for this
 * observation, and a frame-local registry maps it back to the scanned field.
 * The model can name nothing else: no selector, no index, no XPath. A handle
 * from a previous observation resolves to nothing, which is the mechanism that
 * makes stale references impossible rather than merely discouraged.
 */

/** The handles this frame issued for the current observation. */
interface Registry {
  observationId: string;
  fields: Map<string, DetectedField>;
  /** Repeater and navigation handles, which are elements rather than fields. */
  elements: Map<string, HTMLElement>;
  /** Which section a repeater handle grows. */
  repeaterKinds: Map<string, RepeaterKind>;
}

let registry: Registry = {
  observationId: '',
  fields: new Map(),
  elements: new Map(),
  repeaterKinds: new Map(),
};

/** The field a handle names, or null once the observation has been replaced. */
export function fieldForHandle(handle: string): DetectedField | null {
  return registry.fields.get(handle) ?? null;
}

export function elementForHandle(handle: string): HTMLElement | null {
  const element = registry.elements.get(handle);
  if (element) return element.isConnected ? element : null;
  // A field handle resolves through the live DOM rather than a stored node, so
  // a control the page replaced between observation and action is found again
  // by its selector instead of returning a detached element.
  const field = registry.fields.get(handle);
  if (!field) return null;
  return findControl(document, field.selector);
}

export function repeaterKindForHandle(handle: string): RepeaterKind | null {
  return registry.repeaterKinds.get(handle) ?? null;
}

/** Coarsens the scanner's field type into what the agent decides about. */
function kindOf(field: DetectedField): ObservedControlKind {
  switch (field.fieldType) {
    case 'select':
    case 'combobox':
    case 'multi_select':
      return 'dropdown';
    case 'radio':
      return 'radio_group';
    case 'checkbox':
      return 'checkbox';
    case 'textarea':
      return 'textarea';
    case 'date':
    case 'month':
      return 'date';
    case 'file':
      return 'file_upload';
    case 'unknown':
      return 'unknown';
    default:
      return observedControlKindSchema.parse('text');
  }
}

/**
 * How this control must be *operated*, read from the live element.
 *
 * Deliberately not derived from the scanner's field type. That was the shape of
 * the live failure: a vendor control the scanner reads as a text box is one the
 * agent will try to type an answer into, and no amount of prompt wording stops
 * that — the decision looked correct given what it had been told the control
 * was.
 *
 * So the question asked here is what the element *does*, in this order:
 *
 *  1. Is it a `<select>`? Then its options are already in the DOM.
 *  2. Does it open a list — by role, by `aria-haspopup`, by naming a popup, or
 *     by being one of the React-select shapes? Then it is a menu, whatever tag
 *     it happens to use, and it is never typed into.
 *  3. Can a person put characters into it *and* it answers from no list? Only
 *     then is it a text box.
 *
 * A control that opens a list and also carries an editable input is a
 * `SEARCHABLE_COMBOBOX`: the search box takes characters, the control does not,
 * and typing a query is not the same as choosing an answer.
 */
export function interactionTypeOf(element: HTMLElement | null): InteractionType {
  if (!element) return 'UNKNOWN';
  if (element instanceof HTMLSelectElement) return 'NATIVE_SELECT';
  if (element instanceof HTMLTextAreaElement) return 'TEXTAREA';

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'checkbox') return 'CHECKBOX';
    if (type === 'radio') return 'RADIO';
    if (type === 'file') return 'FILE_UPLOAD';
    if (type === 'date' || type === 'month' || type === 'week' || type === 'datetime-local') {
      return 'DATE_INPUT';
    }
    if (type === 'button' || type === 'submit') return 'BUTTON';
    // An input that answers from a list is a dropdown that happens to be an
    // input. `readonly` is the other tell: a box a person cannot type into is
    // not a box the agent may type into either.
    if (answersFromList(element)) {
      return element.readOnly ? 'CUSTOM_SELECT' : 'SEARCHABLE_COMBOBOX';
    }
    if (element.readOnly && opensOptionList(element)) return 'CUSTOM_SELECT';
    // ---- The Lincoln From Date box. ---------------------------------------
    //
    // Checked *after* the list readings and *before* falling through to text.
    // After, because a control that opens a menu of months is a dropdown
    // however it is labelled, and `set_date` must never be pointed at one.
    // Before, because this is the exact control the agent typed `2021-07` into:
    // an ordinary `<input type="text">` whose only statement about itself is
    // `placeholder="MM/DD/YYYY"`.
    //
    // `isDateControl` returns true here only on that positive evidence — a
    // format mask, a date `pattern`, a date-shaped value or bound. A text box
    // that says nothing about dates stays `TEXT_INPUT`, which is what keeps
    // Address, City and Postal Code on the ordinary `type` path.
    if (isDateControl(element)) return 'DATE_INPUT';
    return 'TEXT_INPUT';
  }

  if (element instanceof HTMLAnchorElement) return 'LINK';
  if (element instanceof HTMLButtonElement) {
    return opensOptionList(element) ? 'CUSTOM_SELECT' : 'BUTTON';
  }
  if (element.isContentEditable) return 'TEXT_INPUT';

  const role = element.getAttribute('role');
  if (role === 'radiogroup') return 'RADIO';
  if (role === 'checkbox' || role === 'switch') return 'CHECKBOX';
  if (isCustomCombobox(element) || opensOptionList(element)) {
    // A menu whose trigger is an editable input is searchable; one whose
    // trigger is a div or a button is not.
    const trigger = resolveTrigger(element);
    const editable =
      trigger instanceof HTMLInputElement && !trigger.readOnly && trigger.type !== 'hidden';
    return editable ? 'SEARCHABLE_COMBOBOX' : 'CUSTOM_SELECT';
  }
  if (role === 'textbox') return 'TEXT_INPUT';
  return 'UNKNOWN';
}

/**
 * How this question may be answered.
 *
 * Decided here, in the extension, and handed to the model as a fact it cannot
 * argue with. The order is the priority: a protected characteristic is
 * `SENSITIVE` whatever else is true of it, and a question about somebody else is
 * never a fact about the applicant however much its wording resembles one.
 */
export function policyFor(field: DetectedField, proposed: string | undefined): AnswerPolicy {
  if (field.canonicalKey && isNeverGuessedQuestion(field.canonicalKey)) {
    return answerPolicySchema.parse('SENSITIVE');
  }
  // The relatives box. `full name` in the label is not a reason to write the
  // applicant's name into a question about their relative.
  if (describesThirdPartyDetails(field.label) || describesThirdPartyDetails(field.question)) {
    return answerPolicySchema.parse('UNKNOWN_FACT');
  }
  if (proposed && proposed.trim().length > 0) return answerPolicySchema.parse('KNOWN_FACT');
  if (field.fieldType === 'textarea') return answerPolicySchema.parse('SUBJECTIVE');
  return answerPolicySchema.parse('UNKNOWN_FACT');
}

/**
 * The choices a control is offering at this instant.
 *
 * A native `<select>` carries its list in the DOM, so it is read. A custom
 * control is *not opened here*: opening is an action the agent decides to take,
 * and an observer that opened nine menus to see what was in them would be
 * indistinguishable from the agent flailing. `optionsKnown` reports which case
 * this is, so the model can tell "no options" from "not looked yet".
 */
export function optionsOf(
  field: DetectedField,
  handle: string,
): { options: ObservedElement['options']; known: boolean; searchInput: HTMLElement | null } {
  const element = findControl(document, field.selector);
  if (element instanceof HTMLSelectElement) {
    return {
      searchInput: null,
      options: Array.from(element.options).map((option, index) => ({
        // Minted from the handle that read them, so a choice can only ever be
        // named by an observation that actually saw it offered.
        optionId: optionHandle(handle, index),
        label: (option.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        disabled: option.disabled,
        selected: option.selected,
      })),
      known: true,
    };
  }

  // A custom control that is *currently open*.
  //
  // Nothing is opened here — that is an action the agent decides to take. But
  // once it has, the next observation has to be able to see what the menu
  // contains, or the contract "open, look, choose" has no middle step and the
  // agent would be back to deciding an answer before seeing the choices.
  if (element) {
    const trigger = resolveTrigger(element);
    const menu = findListbox(trigger);
    if (menu) {
      const live = readOptions(menu);
      // The search box is reported whenever the menu is open — including when
      // the query has narrowed the list to nothing. That case is precisely when
      // the agent needs to know a search box exists, so it can clear or shorten
      // the query rather than conclude the control offers no choices.
      // The menu has to be *on screen* for its search box to count. An ARIA
      // combobox keeps an empty `<ul role="listbox">` in the document while it
      // is shut, and treating that as an open menu would report a closed
      // control as OPEN with nothing in it — which reads as "opened and offers
      // no choices" when the truth is "never opened".
      const searchInput = isVisible(menu) ? findSearchInput(trigger, menu) : null;
      if (live.length > 0 || searchInput) {
        return {
          searchInput,
          options: live.map((option, index) => ({
            optionId: optionHandle(handle, index),
            label: option.label.slice(0, 300),
            disabled: option.disabled,
            selected: option.selected,
          })),
          known: true,
        };
      }
    }
  }
  return { options: [], known: false, searchInput: null };
}

/** `e12::option::3` — one offered choice, named by the observation that read it. */
/**
 * The suffix that marks a handle as a menu's own search box.
 *
 * Shared rather than spelled twice: the observer mints these handles and the
 * executor decides, from the handle alone, whether a `type` is a query into an
 * open menu or an answer being written into a dropdown. Those two must agree.
 */
export const SEARCH_HANDLE_SUFFIX = '::search';

export function optionHandle(elementHandle: string, index: number): string {
  return `${elementHandle}::option::${index}`;
}

/** The element and index a choice handle refers to, or null if it is not one. */
export function parseOptionHandle(optionId: string): { elementId: string; index: number } | null {
  const match = /^(.+)::option::(\d+)$/.exec(optionId);
  if (!match?.[1] || match[2] === undefined) return null;
  return { elementId: match[1], index: Number(match[2]) };
}

/**
 * What the control displays now — and empty when that is a prompt.
 *
 * A control showing "No Selection" holds no answer, and reporting its
 * placeholder as a value is not a cosmetic slip: `currentValue` is what the
 * agent reads to decide whether a control still needs attention, so a dropdown
 * sitting on its prompt looked *answered* and every one of them was skipped.
 * The first live agent run filled eleven text fields and did not attempt a
 * single dropdown for exactly this reason.
 *
 * `isPlaceholderSelection` is the same judgement the dropdown engine's
 * verification uses, so "is this control answered" has one answer across the
 * extension rather than two that can disagree.
 */
function currentValueOf(field: DetectedField): string {
  const element = findControl(document, field.selector);
  if (!element) return '';
  if (element instanceof HTMLInputElement && element.type === 'file') {
    return element.files?.[0]?.name ?? '';
  }
  // A checkbox's `value` is the string it *submits when ticked* — "on" by
  // default — and it reads the same whether the box is ticked or not. Returning
  // it made every checkbox on every page look answered, so an "I currently work
  // here" box could never be reached: the agent saw a control already holding
  // "on" and moved past it. What a checkbox holds is whether it is checked.
  if (
    element instanceof HTMLInputElement &&
    (element.type === 'checkbox' || element.type === 'radio')
  ) {
    return element.checked ? 'Yes' : '';
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.slice(0, 300);
  }
  const displayed = readSelectedText(element);
  return isPlaceholderSelection(displayed) ? '' : displayed.slice(0, 300);
}

/**
 * What the form is holding, as distinct from what the control is showing.
 *
 * The distinction the live failure turned on. Education Type displayed "BS";
 * the value behind it was empty, and the employer form went on saying
 * "Education Type is required" while the run recorded the field as answered.
 * Reading the trigger's text is therefore not verification — it is reading the
 * one part of a widget that can change without anything having been selected.
 *
 * Two independent readings are taken, and either one is enough to say the
 * control is unanswered:
 *
 *  1. The backing store, when the widget has one that can be found.
 *  2. The form's own complaint, which outranks everything else on the page.
 */
export interface ControlCommitment {
  /** False only on positive evidence that the form kept nothing. */
  committed: boolean;
  /** The form's own validation text, when it is showing one. */
  validationError: string;
  /** True when that text is the form saying this question is still unanswered. */
  saysUnanswered: boolean;
}

/** Wording by which a form says a question has not been answered yet. */
const UNANSWERED_WORDING =
  /\b(is\s+)?required\b|please\s+(select|choose|pick|enter)|must\s+be\s+(selected|chosen|provided)|make\s+a\s+selection|cannot\s+be\s+(blank|empty)|mandatory/i;

/** Anything a form puts an error into, near the control it is about. */
const ERROR_TEXT_SELECTOR =
  '[role="alert"],[aria-live="assertive"],[class*="error" i],[class*="invalid" i]';

/** The text of an element, if it is on screen and short enough to be a message. */
function errorTextOf(node: Element | null): string {
  if (!(node instanceof HTMLElement) || !isVisible(node)) return '';
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 && text.length <= 300 ? text : '';
}

/**
 * The employer form's complaint about this control, when it has one.
 *
 * Looked for where forms actually put it, in descending order of how much the
 * source *means* it: the element's own constraint validation, the node it
 * names through `aria-errormessage`, and — only for a control the page has
 * flagged `aria-invalid` — a described-by node or an error node inside the
 * field's own container.
 *
 * That flag is load-bearing rather than cautious. `aria-describedby` is the
 * attribute for hints, and a required field on a real portal points at a
 * permanent "This field is required" marker through it. Reading such a marker
 * as a complaint made every filled text field on a live Lincoln Electric run
 * report `VERIFICATION_FAILED`, which is where "six actions, zero verified"
 * came from.
 *
 * The container walk stops after three ancestors, so a page-level banner about
 * something else is never attributed to this control.
 */
function validationErrorFor(element: HTMLElement): string {
  if (
    element instanceof HTMLSelectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    if (element.willValidate && !element.validity.valid && element.validationMessage) {
      return element.validationMessage.slice(0, 300);
    }
  }

  // `aria-errormessage` is *the* error attribute. A node named by it is the
  // form's complaint by definition, so it is read whatever the control's other
  // state says.
  const flagged = element.getAttribute('aria-invalid') === 'true';
  for (const id of (element.getAttribute('aria-errormessage') ?? '').split(/\s+/).filter(Boolean)) {
    const text = errorTextOf(elementById(scopeOf(element), id));
    if (text && UNANSWERED_WORDING.test(text)) return text;
  }

  // ---- `aria-describedby` is help text, and was being read as a complaint. --
  //
  // The bug that produced six actions and zero verified on a live Lincoln
  // Electric run. `aria-describedby` is the attribute for *hints*, and a
  // required field on a real portal routinely points at a permanent "This field
  // is required" marker through it. That marker does not go away when the field
  // is filled — it is a label, not a verdict.
  //
  // The old reading accepted any described-by node whose wording matched
  // "required", with no other evidence. So Street Address was filled correctly,
  // read back correctly, and reported `VERIFICATION_FAILED` — because a static
  // hint beside it said the word "required". Every text field on the page with
  // such a hint failed the same way, permanently, and the run counted none of
  // its own successful writes.
  //
  // So a described-by node now only counts as a complaint when the control is
  // *also* flagged invalid. That is the same evidence the container walk below
  // already required, and the asymmetry between the two was the whole defect.
  if (!flagged) return '';
  for (const id of (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
    const text = errorTextOf(elementById(scopeOf(element), id));
    if (text && UNANSWERED_WORDING.test(text)) return text;
  }

  // Only a control the page has flagged gets its container searched. Without
  // that guard an error elsewhere in the same fieldset would be read as this
  // control's, and a correctly answered dropdown would report as failed.
  if (element.getAttribute('aria-invalid') !== 'true') return '';
  let container: HTMLElement | null = element.parentElement;
  for (let depth = 0; depth < 3 && container; depth += 1) {
    for (const node of Array.from(container.querySelectorAll(ERROR_TEXT_SELECTOR))) {
      const text = errorTextOf(node);
      if (text) return text;
    }
    container = container.parentElement;
  }
  return '';
}

/**
 * Whether a list control's backing store holds anything.
 *
 * Returns true when no backing store can be found at all. That is deliberate:
 * this reading exists to catch a control caught *empty*, and a widget whose
 * storage this code cannot locate has not been caught at anything. The
 * validation reading above is the safety net for those.
 */
function holdsCommittedValue(element: HTMLElement): boolean {
  if (element instanceof HTMLSelectElement) {
    if (element.selectedIndex < 0 || element.value.trim().length === 0) return false;
    return !isPlaceholderSelection(readSelectedText(element));
  }
  const inner = element.querySelector('select');
  if (inner instanceof HTMLSelectElement) return holdsCommittedValue(inner);

  // React-select and its imitators submit through a hidden input. It is the
  // widget's real answer, and an empty one is the widget saying it has none.
  const hidden = element.querySelector<HTMLInputElement>('input[type="hidden"][name]');
  if (hidden) return hidden.value.trim().length > 0;

  // A listbox that marks its chosen row, or a trigger still pointing at one
  // after the menu shut. Either is the widget having recorded a choice.
  if (element.querySelector('[aria-selected="true"],[data-selected="true"]')) return true;
  const trigger = resolveTrigger(element);
  if ((trigger.getAttribute('aria-activedescendant') ?? '').length > 0) return true;
  if (trigger instanceof HTMLInputElement && trigger.type !== 'hidden') {
    return trigger.value.trim().length > 0;
  }
  return true;
}

/**
 * Both readings for one control, taken only where they mean something.
 *
 * Text boxes are exempt from the commitment reading — a typed value *is* the
 * backing value — but not from the validation reading, because a form
 * rejecting what was typed is still a form that has not accepted it.
 */
export function commitmentOf(field: DetectedField, isListControl: boolean): ControlCommitment {
  const element = findControl(document, field.selector);
  if (!element) return { committed: true, validationError: '', saysUnanswered: false };
  const validationError = validationErrorFor(element);
  return {
    committed: isListControl ? holdsCommittedValue(element) : true,
    validationError,
    saysUnanswered: validationError.length > 0 && UNANSWERED_WORDING.test(validationError),
  };
}

/**
 * Every navigation control on the page, with the submitting ones marked.
 *
 * Marked, not omitted: the agent has to know the button is there in order to
 * stop at it and report READY_FOR_REVIEW rather than wandering looking for a
 * next step that does not exist. `finalSubmit` defaults to *true* whenever the
 * wording is not clearly a step control — an unrecognised button is treated as
 * a submit and refused, because the cost of the two mistakes is not symmetric.
 */
function navigationControls(
  ats: Parameters<typeof isFinalSubmitControl>[0],
): PageObservation['navigation'] {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'),
  ).filter(isVisible);

  const navigation: PageObservation['navigation'] = [];
  for (const [index, button] of buttons.entries()) {
    const text = (button.textContent ?? (button as HTMLInputElement).value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const handle = `nav${index}`;
    // A step control by its own words; anything else is treated as final.
    const stepwise =
      /^(next|continue|save and continue|save & continue|save|back|previous|review)\b/i.test(text);
    const finalSubmit = isFinalSubmitControl(ats, text) || !stepwise;
    registry.elements.set(handle, button);
    navigation.push({
      elementId: handle,
      label: text.slice(0, 200),
      finalSubmit,
      frameId: 0,
    });
  }

  // Bounded here, not at the schema.
  //
  // This is the line the live failure turned on. `pageObservationSchema.navigation`
  // is a `z.array(...).max(20)`, and a `max` does not truncate — it *throws*. A
  // real SuccessFactors page carries a nav bar, a language picker, a help
  // launcher, per-section edit controls and a footer, so it sailed past twenty
  // buttons; `observePage` threw after building all 29 elements, the frame
  // answered nothing, and the worker skipped it. Zero elements, zero actionable
  // fields, and an application declared ready with a dozen blank required
  // controls on it.
  //
  // Step controls are kept first, so truncating can never discard the "Next"
  // button in favour of twenty pieces of vendor chrome.
  return [...navigation]
    .sort((left, right) => Number(left.finalSubmit) - Number(right.finalSubmit))
    .slice(0, MAX_NAVIGATION);
}

/**
 * The schema's own ceilings, applied *before* it sees the data.
 *
 * Every one of these is a `max` in `pageObservationSchema`, and every one of
 * them throws rather than truncating. An observation is a description of a page
 * the agent did not choose; it must never be possible for a page to be shaped
 * in a way that stops the agent seeing it at all.
 */
const MAX_NAVIGATION = 20;
const MAX_ELEMENTS = 400;
const MAX_REPEATERS = 20;
const MAX_SECTIONS = 40;

/** The repeating sections, with how many blocks exist and how many are wanted. */
function repeaters(recordCounts: {
  experience: number;
  education: number;
}): PageObservation['repeaters'] {
  const found: PageObservation['repeaters'] = [];
  for (const kind of ['experience', 'education'] as const) {
    const section = findSection(document, kind);
    if (!section) continue;
    const add = findAddControl(section);
    if (!add) continue;
    const handle = `add_${kind}`;
    registry.elements.set(handle, add);
    registry.repeaterKinds.set(handle, kind);
    found.push({
      elementId: handle,
      section: kind,
      label: (add.textContent ?? 'Add').replace(/\s+/g, ' ').trim().slice(0, 200),
      blockCount: countBlocks(section),
      recordCount: recordCounts[kind],
      frameId: 0,
    });
  }
  return found;
}

export interface ObserveInput {
  /** Values the extension trusts for each canonical question, by field id. */
  proposedValues?: Record<string, string>;
  /** Saved records per repeating section, so Add is pressed only when needed. */
  recordCounts?: { experience: number; education: number };
  /** Which dependent controls their parents currently activate, by field id. */
  dependencyActive?: Record<string, boolean>;
}

/**
 * Looks at the page and returns one observation.
 *
 * Rebuilds the handle registry from scratch every time. That is the point: an
 * `elementId` is a promise about *this* observation only, and the previous
 * observation's promises are deliberately broken so a decision made against
 * stale evidence cannot execute.
 */
export async function observePage(input: ObserveInput = {}): Promise<PageObservation> {
  const observationId = `obs-${crypto.randomUUID().slice(0, 8)}`;
  registry = {
    observationId,
    fields: new Map(),
    elements: new Map(),
    repeaterKinds: new Map(),
  };

  const { fields } = await scanDom(document, 'agent-observation', new AbortController().signal);
  // An unrecognised host is 'generic', whose final-submit wording is the
  // universal backstop — the safe reading when nothing identifies the vendor.
  const ats = detectAtsByHostname(window.location.hostname)?.id ?? 'generic';

  const handleByFieldId = new Map<string, string>();
  const elements: ObservedElement[] = [];
  const searchInputs: { handle: string; owner: string; element: HTMLElement }[] = [];

  for (const [index, field] of fields.entries()) {
    const handle = `e${index}`;
    registry.fields.set(handle, field);
    handleByFieldId.set(field.id, handle);

    const proposed = input.proposedValues?.[field.id];
    const { options, known, searchInput } = optionsOf(field, handle);
    const element = findControl(document, field.selector);
    // The search box inside an open menu, promoted to a control in its own
    // right.
    //
    // This is what keeps the searchable case from becoming an exception to the
    // rule. The dropdown stays untypeable; the query goes into a real element
    // that is genuinely a text box, and the validator checks it by exactly the
    // same test it applies to Address. Nothing had to be carved out.
    const searchHandle = searchInput ? `${handle}${SEARCH_HANDLE_SUFFIX}` : undefined;
    if (searchInput && searchHandle) {
      registry.elements.set(searchHandle, searchInput);
      searchInputs.push({ handle: searchHandle, owner: handle, element: searchInput });
    }
    // Computed once, because both readings below turn on it: only a control
    // that answers from a list can be caught displaying a choice the form did
    // not keep.
    const interactionType = interactionTypeOf(element);
    const listControl = (OPTION_INTERACTION_TYPES as readonly string[]).includes(interactionType);
    const commitment = commitmentOf(field, listControl);
    // Read here rather than at execution time so the *decision* can be made
    // against the control's stated format. That ordering is the repair: the old
    // path chose a string first and discovered the format from an "Invalid
    // date." message afterwards, by which point a wrong value was already in
    // the employer's DOM.
    const dateRequirement =
      interactionType === 'DATE_INPUT' ? dateRequirementOf(element, field) : null;
    // A date box the employer has flagged says so about itself, exactly as a
    // dropdown does. Without this the "Invalid date." beside a text-backed date
    // control was invisible to the loop, and a rejected value verified as a
    // written one.
    const dateValidation = interactionType === 'DATE_INPUT' ? readDateValidation(element) : null;
    elements.push({
      elementId: handle,
      section: field.section ?? '',
      label: field.label.slice(0, 300) || field.question.slice(0, 300),
      // The live element outranks the scan here for the same reason it does for
      // dropdowns: the scanner reads a Lincoln From Date box as ordinary text,
      // and `kind` is what a trace reports and what a coarse filter reads. A
      // control the observer has just proven to be a date says so in both
      // vocabularies rather than only in the authoritative one.
      kind: interactionType === 'DATE_INPUT' ? 'date' : kindOf(field),
      interactionType,
      // A dropdown whose options this observation can already see is open (or
      // is a native select, which is always readable); anything else is shut.
      // An open menu whose search box already holds a query is SEARCHING — the
      // list on screen is a filtered view, not the control's whole vocabulary,
      // and "not found here" does not mean "not offered".
      dropdownState: known
        ? searchInput instanceof HTMLInputElement && searchInput.value.trim().length > 0
          ? 'SEARCHING'
          : 'OPEN'
        : 'CLOSED',
      searchable: searchHandle !== undefined,
      ...(searchHandle ? { searchInputId: searchHandle } : {}),
      // The reading that closes the live failure.
      //
      // `currentValue` is what every later judgement is made from — whether the
      // control still needs attention, whether the run may call itself
      // finished — so a control displaying "BS" over an empty value must report
      // *nothing*, not "BS". Otherwise the agent skips a field the employer's
      // form is still marking required, and the applicant is told it is done.
      currentValue:
        listControl && (!commitment.committed || commitment.saysUnanswered)
          ? ''
          : currentValueOf(field),
      selectionCommitted: commitment.committed,
      // A date control's own reading wins where it has one: `commitmentOf`
      // knows about lists and about constraint validation, and knows nothing
      // about an ATS that paints "Invalid date." beside a perfectly valid text
      // box.
      validationError: (dateValidation?.message || commitment.validationError).slice(0, 300),
      ...(dateRequirement ? { dateRequirement } : {}),
      required: field.required,
      // Read from the live control rather than from the scan, because "is this
      // enabled" is exactly the fact that changes when a parent is answered.
      disabled:
        element instanceof HTMLSelectElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
          ? element.disabled
          : element?.getAttribute('aria-disabled') === 'true',
      visible: element
        ? isVisible(resolveTrigger(element)) || element instanceof HTMLSelectElement
        : false,
      options,
      optionsKnown: known,
      ...(field.recordIndex === undefined ? {} : { blockIndex: field.recordIndex }),
      ...(field.canonicalKey ? { intent: field.canonicalKey } : {}),
      policy: policyFor(field, proposed),
      ...(proposed ? { proposedValue: proposed } : {}),
      frameId: field.frameId ?? 0,
    });
  }

  // The dependency links, expressed in this observation's own handles so the
  // model never sees a field id it could confuse with an element handle.
  for (const [index, field] of fields.entries()) {
    const parentHandle = field.dependsOn ? handleByFieldId.get(field.dependsOn.fieldId) : undefined;
    const observed = elements[index];
    if (!observed || !parentHandle) continue;
    observed.dependsOnElementId = parentHandle;
    observed.dependencyActive = input.dependencyActive?.[field.id] ?? false;
  }

  // Appended only now, after the dependency pass — that loop walks `elements`
  // and `fields` by the same index, and a search box has no field behind it.
  for (const search of searchInputs) {
    const owner = elements.find((element) => element.elementId === search.owner);
    elements.push(
      observedElementSchema.parse({
        elementId: search.handle,
        section: owner?.section ?? '',
        // Named for the dropdown it belongs to, so a decision about it is
        // legible in a trace without recording what was typed.
        label: `Search within ${owner?.label ?? 'dropdown'}`,
        kind: 'text',
        interactionType: 'TEXT_INPUT',
        currentValue:
          search.element instanceof HTMLInputElement ? search.element.value.slice(0, 300) : '',
        // Never required and never carrying a saved answer: a query is a way of
        // finding an answer, not an answer. Readiness must not be satisfiable
        // by having typed one, and this is what stops it counting.
        required: false,
        policy: 'UNKNOWN_FACT',
        searchInputFor: search.owner,
        visible: isVisible(search.element),
        frameId: 0,
      }),
    );
  }

  const sections = [...new Set(fields.map((field) => field.section ?? '').filter(Boolean))];
  const requiredOutstanding = elements.filter(
    (element) => element.required && element.currentValue.trim().length === 0,
  ).length;

  const draft = {
    observationId,
    origin: (() => {
      try {
        return new URL(window.location.href).origin;
      } catch {
        return 'unknown';
      }
    })(),
    title: document.title.slice(0, 300),
    sections: sections.slice(0, MAX_SECTIONS),
    elements: elements.slice(0, MAX_ELEMENTS),
    repeaters: repeaters(input.recordCounts ?? { experience: 0, education: 0 }).slice(
      0,
      MAX_REPEATERS,
    ),
    navigation: navigationControls(ats),
    requiredOutstanding,
    takenAt: new Date().toISOString(),
  };

  try {
    return pageObservationSchema.parse(draft);
  } catch {
    // An observation that cannot be described is still an observation that
    // happened, and the elements are the part that matters. Rather than throw —
    // which the frame reports as silence, and the worker reads as "this frame
    // holds nothing" — the parts that failed validation are dropped and the
    // controls are kept.
    //
    // This exists because the alternative was catastrophic *and quiet*: one
    // over-long array of buttons cost an entire live run, and it looked from
    // outside exactly like a finished application.
    return pageObservationSchema.parse({
      ...draft,
      sections: [],
      repeaters: [],
      navigation: [],
      elements: draft.elements
        .map((element) => observedElementSchema.safeParse(element))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data)
        .slice(0, MAX_ELEMENTS),
    });
  }
}

/** For tests and for the executor: which fields the last observation issued. */
export function observedFieldIds(): string[] {
  return [...registry.fields.values()].map((field) => field.id);
}
