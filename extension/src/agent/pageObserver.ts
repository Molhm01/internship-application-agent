import {
  answerPolicySchema,
  describesThirdPartyDetails,
  isNeverGuessedQuestion,
  isPlaceholderSelection,
  observedControlKindSchema,
  pageObservationSchema,
  type AnswerPolicy,
  type DetectedField,
  type ObservedControlKind,
  type ObservedElement,
  type RepeaterKind,
  type PageObservation,
} from '@internship-agent/shared';
import { scanDom } from '../scanner/domScanner.js';
import { detectAtsByHostname, isFinalSubmitControl } from '../scanner/adapters.js';
import { readSelectedText, resolveTrigger, isVisible } from '../scanner/optionDiscovery.js';
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
function optionsOf(field: DetectedField): {
  options: ObservedElement['options'];
  known: boolean;
} {
  const element = findControl(document, field.selector);
  if (element instanceof HTMLSelectElement) {
    return {
      options: Array.from(element.options).map((option) => ({
        label: (option.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        disabled: option.disabled,
        selected: option.selected,
      })),
      known: true,
    };
  }
  return { options: [], known: false };
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
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.slice(0, 300);
  }
  const displayed = readSelectedText(element);
  return isPlaceholderSelection(displayed) ? '' : displayed.slice(0, 300);
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
  return navigation;
}

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

  for (const [index, field] of fields.entries()) {
    const handle = `e${index}`;
    registry.fields.set(handle, field);
    handleByFieldId.set(field.id, handle);

    const proposed = input.proposedValues?.[field.id];
    const { options, known } = optionsOf(field);
    const element = findControl(document, field.selector);
    elements.push({
      elementId: handle,
      section: field.section ?? '',
      label: field.label.slice(0, 300) || field.question.slice(0, 300),
      kind: kindOf(field),
      currentValue: currentValueOf(field),
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

  const sections = [...new Set(fields.map((field) => field.section ?? '').filter(Boolean))];
  const requiredOutstanding = elements.filter(
    (element) => element.required && element.currentValue.trim().length === 0,
  ).length;

  return pageObservationSchema.parse({
    observationId,
    origin: (() => {
      try {
        return new URL(window.location.href).origin;
      } catch {
        return 'unknown';
      }
    })(),
    title: document.title.slice(0, 300),
    sections,
    elements,
    repeaters: repeaters(input.recordCounts ?? { experience: 0, education: 0 }),
    navigation: navigationControls(ats),
    requiredOutstanding,
    takenAt: new Date().toISOString(),
  });
}

/** For tests and for the executor: which fields the last observation issued. */
export function observedFieldIds(): string[] {
  return [...registry.fields.values()].map((field) => field.id);
}
