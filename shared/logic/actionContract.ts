import { isOptionFieldType, isTextFieldType, type FieldType } from '../schemas/fields.js';

/**
 * The contract between a control's type, the action a planner may propose for
 * it, and the action an executor may perform.
 *
 * This exists because the three drifted. A `text` input reached an
 * option-selecting executor and came back with *"No option on the page matched
 * Molhm"* — a sentence that can only be produced by asking a list of choices
 * for a value the user was supposed to type. Nothing in the type system stopped
 * it, because `DeterministicFillAction` can name any action for any field.
 *
 * So the rule is stated once, here, and enforced at both ends: the planner
 * refuses to emit an incompatible plan, and the executor refuses to run one it
 * was somehow handed. Neither trusts the other.
 */

/** Every action a deterministic plan can carry that actually touches a control. */
export const CONTROL_ACTIONS = [
  'fill_text',
  'fill_generated_text',
  'set_password',
  'set_date',
  'select_option',
  'select_suggested_option',
  'select_resolved_option',
  'choose_radio',
  'toggle_checkbox',
  'upload_file',
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Actions that answer by choosing from the page's own list of choices. */
export const OPTION_ACTIONS: readonly ControlAction[] = [
  'select_option',
  'select_suggested_option',
  'select_resolved_option',
  'choose_radio',
  'toggle_checkbox',
];

/** Actions that answer by writing a value into the control. */
export const TEXT_ACTIONS: readonly ControlAction[] = [
  'fill_text',
  'fill_generated_text',
  'set_password',
];

/**
 * The actions a control of this type may legitimately receive.
 *
 * Exhaustive over `FieldType` on purpose: a new control type will fail to
 * compile here until someone decides how it is answered, which is far better
 * than it silently inheriting a default that types text into a dropdown.
 */
const ALLOWED_ACTIONS: Record<FieldType, readonly ControlAction[]> = {
  text: ['fill_text', 'fill_generated_text'],
  textarea: ['fill_text', 'fill_generated_text'],
  email: ['fill_text'],
  tel: ['fill_text'],
  number: ['fill_text'],
  url: ['fill_text'],
  // Written like any other text, but only ever from the credential vault. The
  // separate action name is what makes "did a password reach a plan?" a
  // question a test can answer.
  password: ['set_password'],
  date: ['set_date', 'fill_text'],
  month: ['set_date', 'fill_text'],
  select: ['select_option'],
  combobox: ['select_resolved_option', 'select_suggested_option', 'select_option'],
  radio: ['choose_radio'],
  checkbox: ['toggle_checkbox'],
  multi_select: ['toggle_checkbox', 'select_suggested_option', 'select_resolved_option'],
  file: ['upload_file'],
  contenteditable: ['fill_text', 'fill_generated_text'],
  unknown: [],
};

export interface ContractViolation {
  fieldType: FieldType;
  action: string;
  reason: string;
}

/** True when this action is a legitimate way to answer this control. */
export function actionSuitsControl(fieldType: FieldType, action: string): boolean {
  return (ALLOWED_ACTIONS[fieldType] as readonly string[]).includes(action);
}

/**
 * The reason an action does not suit a control, or null when it does.
 *
 * Actions that do not touch a control at all — `manual_review`, `skip`,
 * `missing_information`, `unsupported` — are always legal: they are statements
 * about what will *not* be done, and every control type may receive one.
 */
export function contractViolation(fieldType: FieldType, action: string): ContractViolation | null {
  if (!(CONTROL_ACTIONS as readonly string[]).includes(action)) return null;
  if (actionSuitsControl(fieldType, action)) return null;

  const isOptionAction = (OPTION_ACTIONS as readonly string[]).includes(action);
  const isTextAction = (TEXT_ACTIONS as readonly string[]).includes(action);
  const reason =
    isOptionAction && isTextFieldType(fieldType)
      ? `A ${fieldType} control is typed into, not chosen from, so "${action}" would search the page for an option that was never meant to exist.`
      : isTextAction && isOptionFieldType(fieldType)
        ? `A ${fieldType} control is answered by choosing one of its options, so "${action}" would write text the control cannot hold.`
        : `"${action}" is not a way to answer a ${fieldType} control.`;

  return { fieldType, action, reason };
}

/**
 * The action a text-like control should have received instead.
 *
 * Used to repair a plan rather than merely reject it: the value is usually
 * right and only the strategy is wrong, and a repaired action fills the field
 * where a rejected one leaves it blank.
 */
export function textActionFor(fieldType: FieldType): ControlAction | null {
  if (fieldType === 'password') return 'set_password';
  if (fieldType === 'date' || fieldType === 'month') return 'set_date';
  return isTextFieldType(fieldType) ? 'fill_text' : null;
}

/** The option action a choice control should have received instead. */
export function optionActionFor(fieldType: FieldType): ControlAction | null {
  if (fieldType === 'radio') return 'choose_radio';
  if (fieldType === 'checkbox' || fieldType === 'multi_select') return 'toggle_checkbox';
  if (fieldType === 'select') return 'select_option';
  if (fieldType === 'combobox') return 'select_resolved_option';
  return null;
}
