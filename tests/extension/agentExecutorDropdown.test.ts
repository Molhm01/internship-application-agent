import { afterEach, describe, expect, it } from 'vitest';
import { agentToolCallSchema } from '@internship-agent/shared';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * The production executor, driven against a real control.
 *
 * Every other test in this area proves what the agent *decides*. This one
 * proves what actually reaches the page, because the decision layer is not the
 * only way an action can arrive: a model's call, a repaired call, a page that
 * changed shape since it was observed. The guarantees have to hold at the hands
 * as well as at the brain.
 *
 * Three of them:
 *
 *  1. A control that answers from a list is never typed into, whatever it is
 *     made of.
 *  2. A choice is named by a handle resolved against the menu as it stands at
 *     the moment of the click, not against a list read some cycles ago.
 *  3. A handle that no longer names anything is refused rather than approximated
 *     into whichever row now occupies that position.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 200,
    height: 32,
    top: 0,
    left: 0,
    right: 200,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

const STATE_SELECT = `
  <label for="state">State/Province *</label>
  <select id="state" name="state" required>
    <option value="" selected>No Selection</option>
    <option value="NY">New York</option>
    <option value="NJ">New Jersey</option>
  </select>`;

/** Observes the page and returns the handle of the control matching `label`. */
async function handleFor(label: RegExp): Promise<string> {
  const observed = await observePage();
  const element = observed.elements.find((entry) => label.test(entry.label));
  if (!element) throw new Error(`no observed element matching ${String(label)}`);
  return element.elementId;
}

async function optionIdFor(
  control: RegExp,
  option: RegExp,
): Promise<{ elementId: string; optionId: string }> {
  const observed = await observePage();
  const element = observed.elements.find((entry) => control.test(entry.label));
  const choice = element?.options.find((entry) => option.test(entry.label));
  if (!element || !choice) throw new Error(`no observed option matching ${String(option)}`);
  return { elementId: element.elementId, optionId: choice.optionId };
}

const call = (patch: Record<string, unknown>) => agentToolCallSchema.parse(patch);

// ---------------------------------------------------------------------------
describe('the executor refuses to type into anything that answers from a list', () => {
  it('refuses a native select, and leaves it on its placeholder', async () => {
    document.body.innerHTML = STATE_SELECT;
    const { elementId } = await optionIdFor(/state/i, /^New Jersey$/i);

    const outcome = await executeAgentTool(call({ tool: 'type', elementId, value: 'New Jersey' }));

    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    const select = document.getElementById('state') as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('refuses a readonly custom combobox, which is an input and is not a text box', async () => {
    // The shape that makes the type check necessary rather than obvious. This
    // *is* an `<input>`; it is also a dropdown, and typing into it changes what
    // it displays while selecting nothing — the live failure, in one element.
    document.body.innerHTML = `
      <label for="edu">Education Type *</label>
      <input id="edu" name="edu" type="text" readonly role="combobox"
             aria-haspopup="listbox" aria-expanded="false" />`;
    const elementId = await handleFor(/education type/i);

    const outcome = await executeAgentTool(call({ tool: 'type', elementId, value: 'BS' }));

    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect((document.getElementById('edu') as HTMLInputElement).value).toBe('');
  });

  it('still types into an ordinary text box', async () => {
    // The other half of the guarantee, and the one worth stating: the working
    // text path is untouched by any of this.
    document.body.innerHTML = `
      <label for="city">City *</label>
      <input id="city" name="city" type="text" />`;
    const elementId = await handleFor(/city/i);

    const outcome = await executeAgentTool(call({ tool: 'type', elementId, value: 'Clifton' }));

    expect(outcome.executed).toBe(true);
    expect((document.getElementById('city') as HTMLInputElement).value).toBe('Clifton');
  });
});

// ---------------------------------------------------------------------------
describe('a choice is resolved against the live menu and actually taken', () => {
  it('selects the option the handle names, and the form holds it', async () => {
    document.body.innerHTML = STATE_SELECT;
    const { elementId, optionId } = await optionIdFor(/state/i, /^New Jersey$/i);

    const outcome = await executeAgentTool(
      call({
        tool: 'select_option',
        elementId,
        optionId,
      }),
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.errorCode).toBeUndefined();
    // Not "the control displays New Jersey" — the value the form submits.
    const select = document.getElementById('state') as HTMLSelectElement;
    expect(select.value).toBe('NJ');
    expect(select.selectedIndex).toBe(2);

    // And the observation agrees, which is what the loop verifies against.
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.currentValue).toBe('New Jersey');
    expect(state.selectionCommitted).toBe(true);
  });

  it('refuses a handle naming a row the list no longer has', async () => {
    document.body.innerHTML = STATE_SELECT;
    const { elementId, optionId } = await optionIdFor(/state/i, /^New Jersey$/i);
    document.querySelector('option[value="NJ"]')?.remove();

    const outcome = await executeAgentTool(
      call({
        tool: 'select_option',
        elementId,
        optionId,
      }),
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('STALE_OPTION_REFERENCE');
    // Nothing was chosen in its place, which is the whole point of refusing.
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('');
  });

  it('rejects the stale option when the list has shifted under the handle', async () => {
    // The rows moved between the observation and the click — a region list
    // rebuilt after Country was answered. Row 2 is now New York, and the
    // decision meant New Jersey. The answer is followed; the index is not.
    document.body.innerHTML = `
      <label for="state">State/Province *</label>
      <select id="state" name="state" required>
        <option value="" selected>No Selection</option>
        <option value="NJ">New Jersey</option>
        <option value="NY">New York</option>
      </select>`;
    const { elementId, optionId } = await optionIdFor(/state/i, /^New Jersey$/i);
    const select = document.getElementById('state') as HTMLSelectElement;
    select.insertBefore(select.options[2]!, select.options[1]!);

    const outcome = await executeAgentTool(
      call({
        tool: 'select_option',
        elementId,
        optionId,
        value: 'New Jersey',
      }),
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('STALE_OPTION_REFERENCE');
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('');
  });

  it('refuses when neither the handle nor the value names a live choice', async () => {
    document.body.innerHTML = STATE_SELECT;
    const elementId = await handleFor(/state/i);

    const outcome = await executeAgentTool(
      call({
        tool: 'select_option',
        elementId,
        optionId: `${elementId}::option::7`,
        value: 'Ontario',
      }),
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.errorCode).toBe('INVALID_OPTION_ID');
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('');
  });

  it('never settles for the placeholder when the answer is not offered', async () => {
    // "No Selection" is row 0 of almost every list on a form, and selecting it
    // to have selected *something* is the failure mode this whole path exists
    // to prevent.
    document.body.innerHTML = STATE_SELECT;
    const elementId = await handleFor(/state/i);

    const outcome = await executeAgentTool(
      call({ tool: 'select_option', elementId, value: 'Ontario' }),
    );

    expect(outcome.executed).toBe(false);
    const select = document.getElementById('state') as HTMLSelectElement;
    expect(select.value).toBe('');

    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.currentValue).toBe('');
    expect(state.selectionCommitted).toBe(false);
  });
});
