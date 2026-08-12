import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  observedElementSchema,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import { checkDecision } from '../../extension/src/agent/agentSafety.js';
import { decideDeterministically } from '../../extension/src/agent/agentDecision.js';
import { AgentHistory } from '../../extension/src/agent/agentHistory.js';
import { interactionTypeOf, observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * A dropdown is opened and chosen from. It is never typed into.
 *
 * On a live Lincoln Electric application the agent called `type` on a dropdown:
 * the control kept its placeholder, nothing was selected, and the run believed
 * the field was answered. The decision was *reasonable* given what the decider
 * had been told the control was — the interaction type was inherited from a
 * scanner field type that reads some vendor controls as text boxes.
 *
 * So there are now two independent protections, and this file tests both:
 *
 *  1. the observer computes the interaction type from the live element;
 *  2. the tool validator refuses `type` on anything that answers from a list,
 *     whatever a decider asks for.
 *
 * The second is the one that matters. A prompt is a request; this is a rule.
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

let handle = 0;
function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  handle += 1;
  return observedElementSchema.parse({
    elementId: `e${handle}`,
    label: `Field ${handle}`,
    kind: 'dropdown',
    interactionType: 'CUSTOM_SELECT',
    policy: 'KNOWN_FACT',
    proposedValue: 'New Jersey',
    ...patch,
  });
}

function observation(elements: ObservedElement[]): PageObservation {
  return {
    observationId: 'obs-1',
    origin: 'https://employer.example',
    title: 'Application',
    sections: [],
    elements,
    repeaters: [],
    navigation: [],
    requiredOutstanding: 0,
    takenAt: '2026-08-11T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
describe('the observer classifies from the live element', () => {
  const classify = (html: string, id: string) => {
    document.body.innerHTML = html;
    return interactionTypeOf(document.getElementById(id));
  };

  it('a real select is NATIVE_SELECT', () => {
    expect(classify('<select id="a"><option>x</option></select>', 'a')).toBe('NATIVE_SELECT');
  });

  it('a div that opens a menu is CUSTOM_SELECT', () => {
    expect(classify('<div id="a" role="combobox" aria-haspopup="listbox"></div>', 'a')).toBe(
      'CUSTOM_SELECT',
    );
  });

  it('a button that opens a list is CUSTOM_SELECT, not BUTTON', () => {
    expect(
      classify('<button id="a" aria-haspopup="listbox" aria-expanded="false"></button>', 'a'),
    ).toBe('CUSTOM_SELECT');
  });

  it('a readonly input that opens a list is CUSTOM_SELECT, not a text box', () => {
    // The live shape that caused the failure: it looks like an input, so the
    // scanner reads it as text, so the agent typed into it.
    expect(classify('<input id="a" readonly aria-haspopup="listbox" />', 'a')).toBe(
      'CUSTOM_SELECT',
    );
  });

  it('an editable input whose completions come from a list is SEARCHABLE_COMBOBOX', () => {
    expect(classify('<input id="a" role="combobox" aria-autocomplete="list" />', 'a')).toBe(
      'SEARCHABLE_COMBOBOX',
    );
  });

  it('an ordinary text box is still TEXT_INPUT', () => {
    expect(classify('<input id="a" type="text" />', 'a')).toBe('TEXT_INPUT');
    expect(classify('<textarea id="a"></textarea>', 'a')).toBe('TEXTAREA');
  });

  it('a date control is DATE_INPUT and a file control is FILE_UPLOAD', () => {
    expect(classify('<input id="a" type="month" />', 'a')).toBe('DATE_INPUT');
    expect(classify('<input id="a" type="file" />', 'a')).toBe('FILE_UPLOAD');
    // The Lincoln Electric From Date box: an ordinary text input whose only
    // statement about itself is its placeholder. This is the control the agent
    // typed `2021-07` into on a live application.
    expect(classify('<input id="a" type="text" placeholder="MM/DD/YYYY" />', 'a')).toBe(
      'DATE_INPUT',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the tool validator refuses typing into a list control', () => {
  const typeInto = (target: ObservedElement) =>
    checkDecision(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'type', elementId: target.elementId, value: 'New Jersey' },
      }),
      observation([target]),
      new Map([[target.elementId, 'New Jersey']]),
    );

  it.each(['NATIVE_SELECT', 'CUSTOM_SELECT', 'SEARCHABLE_COMBOBOX'] as const)(
    'rejects type() on %s',
    (interactionType) => {
      const verdict = typeInto(element({ interactionType }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
      expect(verdict.suggestedTool).toBe('open_dropdown');
    },
  );

  it('suggests select_option when the control is already open', () => {
    const target = element({
      interactionType: 'CUSTOM_SELECT',
      dropdownState: 'OPEN',
      options: [
        { optionId: 'e1::option::0', label: 'New Jersey', disabled: false, selected: false },
      ],
    });
    expect(typeInto(target).suggestedTool).toBe('select_option');
  });

  it.each(['TEXT_INPUT', 'TEXTAREA'] as const)('still permits type() on %s', (interactionType) => {
    // The regression that matters: Address, City, Postal Code and Phone all
    // started working, and this must not take that away.
    const verdict = typeInto(element({ interactionType, kind: 'text' }));
    expect(verdict.allowed).toBe(true);
  });

  it('rejects type() on DATE_INPUT and names set_date instead', () => {
    // This assertion used to say the opposite, with a comment noting the date
    // format was not yet fixed. It is now, and the reason it had to change is
    // that permitting `type` on a date control is precisely what let the
    // profile's `2021-07` reach an `MM/DD/YYYY` box on a live Lincoln Electric
    // application, where the employer answered "Invalid date."
    //
    // `type` cannot be made safe for a date control by choosing a better value,
    // because the value is chosen before anything has looked at the control.
    // The tool is the thing that is wrong.
    const verdict = typeInto(element({ interactionType: 'DATE_INPUT', kind: 'date' }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect(verdict.suggestedTool).toBe('set_date');
  });
});

// ---------------------------------------------------------------------------
describe('selecting requires the list to have been read', () => {
  const select = (target: ObservedElement, optionId?: string) =>
    checkDecision(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: {
          tool: 'select_option',
          elementId: target.elementId,
          ...(optionId ? { optionId } : {}),
          value: 'New Jersey',
        },
      }),
      observation([target]),
      new Map([[target.elementId, 'New Jersey']]),
    );

  it('refuses selecting from a control whose options are unknown', () => {
    const verdict = select(element({ options: [] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    expect(verdict.suggestedTool).toBe('open_dropdown');
  });

  it('refuses an option handle the control is not offering', () => {
    const target = element({
      options: [
        { optionId: 'e1::option::0', label: 'New Jersey', disabled: false, selected: false },
      ],
    });
    const verdict = select(target, 'e1::option::99');
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('OPTION_HANDLE_UNKNOWN');
  });

  it('permits selecting an option the control actually offers', () => {
    const target = element({
      options: [
        {
          optionId: `e${handle + 1}::option::0`,
          label: 'New Jersey',
          disabled: false,
          selected: false,
        },
      ],
    });
    const offered = target.options[0]!.optionId;
    expect(select(target, offered).allowed).toBe(true);
  });

  it('refuses opening something that is not a list control', () => {
    const target = element({ interactionType: 'TEXT_INPUT', kind: 'text' });
    const verdict = checkDecision(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        reason: 'x',
        action: { tool: 'open_dropdown', elementId: target.elementId },
      }),
      observation([target]),
      new Map(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.suggestedTool).toBe('type');
  });
});

// ---------------------------------------------------------------------------
describe('the decider opens before it chooses', () => {
  const decide = (elements: ObservedElement[], history = new AgentHistory()) =>
    decideDeterministically({
      observation: observation(elements),
      history,
      trustedValues: new Map(),
    });

  it('opens a closed dropdown rather than selecting blind', () => {
    const decision = decide([element({ options: [] })]);
    expect(decision.action?.tool).toBe('open_dropdown');
  });

  it('never types into a dropdown, even one the scanner called text', () => {
    // `kind: 'text'` and `interactionType: 'CUSTOM_SELECT'` is exactly the live
    // mismatch. The authoritative type wins.
    const decision = decide([
      element({ kind: 'text', interactionType: 'CUSTOM_SELECT', options: [] }),
    ]);
    expect(decision.action?.tool).toBe('open_dropdown');
  });

  it('selects an offered option by its handle once the list is known', () => {
    const target = element({
      options: [
        { optionId: 'x::option::0', label: 'No Selection', disabled: false, selected: true },
        { optionId: 'x::option::1', label: 'New Jersey', disabled: false, selected: false },
      ],
    });
    const decision = decide([target]);
    expect(decision.action?.tool).toBe('select_option');
    expect(decision.action?.optionId).toBe('x::option::1');
    // The value carried is the option's own label, not the profile's wording.
    expect(decision.action?.value).toBe('New Jersey');
  });

  it('never chooses the placeholder', () => {
    const target = element({
      proposedValue: 'No',
      options: [
        { optionId: 'x::option::0', label: 'No Selection', disabled: false, selected: true },
        { optionId: 'x::option::1', label: 'Yes', disabled: false, selected: false },
        { optionId: 'x::option::2', label: 'No', disabled: false, selected: false },
      ],
    });
    const decision = decide([target]);
    // "No Selection" contains "No" and is a prompt. The real No is chosen.
    expect(decision.action?.optionId).toBe('x::option::2');
  });

  it('matches a saved answer against the form’s own wording', () => {
    const target = element({
      proposedValue: 'United States',
      options: [
        { optionId: 'x::option::0', label: 'No Selection', disabled: false, selected: true },
        {
          optionId: 'x::option::1',
          label: 'United States of America',
          disabled: false,
          selected: false,
        },
      ],
    });
    expect(decide([target]).action?.optionId).toBe('x::option::1');
  });

  it('asks rather than typing when the list offers no match', () => {
    const target = element({
      required: true,
      proposedValue: 'Atlantis',
      options: [
        { optionId: 'x::option::0', label: 'No Selection', disabled: false, selected: true },
        { optionId: 'x::option::1', label: 'New Jersey', disabled: false, selected: false },
      ],
    });
    const decision = decide([target]);
    expect(decision.kind).toBe('ASK_USER');
    // Emphatically not a type().
    expect(decision.action).toBeUndefined();
  });

  it('skips a disabled option', () => {
    const target = element({
      options: [{ optionId: 'x::option::0', label: 'New Jersey', disabled: true, selected: false }],
    });
    expect(decide([target]).kind).toBe('ASK_USER');
  });
});

// ---------------------------------------------------------------------------
describe('an open menu is readable by the next observation', () => {
  it('reports the options of a custom control that is currently open', async () => {
    // The middle step of the contract: open → *look* → choose. Without this the
    // agent would be back to deciding an answer before seeing the choices.
    document.body.innerHTML = `
      <label for="state">State/Province *</label>
      <div id="state" role="combobox" aria-haspopup="listbox" aria-controls="menu" aria-expanded="true">
        <span>No Selection</span>
      </div>
      <ul id="menu" role="listbox">
        <li role="option">Alabama</li>
        <li role="option">New Jersey</li>
      </ul>`;
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label));
    expect(state, 'State was not observed').toBeDefined();
    expect(state!.interactionType).toBe('CUSTOM_SELECT');
    expect(state!.options.map((option) => option.label)).toEqual(['Alabama', 'New Jersey']);
    expect(state!.options[0]!.optionId).toMatch(/::option::0$/);
    expect(state!.dropdownState).toBe('OPEN');
    // And the placeholder is still not an answer.
    expect(state!.currentValue).toBe('');
  });

  it('reports a closed custom control as having no options yet', async () => {
    document.body.innerHTML = `
      <label for="state">State/Province *</label>
      <div id="state" role="combobox" aria-haspopup="listbox"><span>No Selection</span></div>`;
    const observed = await observePage();
    const state = observed.elements.find((entry) => /state/i.test(entry.label))!;
    expect(state.options).toEqual([]);
    expect(state.dropdownState).toBe('CLOSED');
  });

  it('mints option handles for a native select', async () => {
    document.body.innerHTML = `
      <label for="grad">Graduated? *</label>
      <select id="grad"><option value="">No Selection</option><option value="no">No</option></select>`;
    const observed = await observePage();
    const grad = observed.elements.find((entry) => /graduated/i.test(entry.label))!;
    expect(grad.interactionType).toBe('NATIVE_SELECT');
    expect(grad.options).toHaveLength(2);
    expect(grad.options[1]!.optionId).toMatch(/::option::1$/);
  });
});
