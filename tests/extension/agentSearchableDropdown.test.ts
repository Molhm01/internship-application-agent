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
import { observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * The searchable dropdown, which is where the rule against typing could have
 * been quietly dissolved into an exception.
 *
 * It is not an exception. A menu that carries its own search box has that box
 * emitted as an element in its own right, typed `TEXT_INPUT`, and the validator
 * admits a query into it by exactly the test it applies to Address. The
 * dropdown itself stays untypeable.
 *
 * The part that matters most is at the end of the file: typing a query never
 * makes the field answered. A control is finished when an option offered by the
 * page has been selected and verified, and at no other moment.
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
    interactionType: 'SEARCHABLE_COMBOBOX',
    policy: 'KNOWN_FACT',
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

const WANTED = 'New Jersey Institute of Technology';

/** The Lincoln-style searchable School control, rendered open. */
const OPEN_COMBOBOX = `
  <label for="school">School/Institution Name *</label>
  <div id="schoolRoot">
    <input id="school" name="school" type="text" role="combobox"
           aria-autocomplete="list" aria-controls="schoolList" aria-expanded="true" />
    <ul id="schoolList" role="listbox">
      <li role="option">New Jersey Institute of Technology</li>
      <li role="option">New Jersey City University</li>
    </ul>
  </div>`;

// ---------------------------------------------------------------------------
describe('the observer promotes the search box to a control of its own', () => {
  it('reports it as a TEXT_INPUT belonging to the dropdown', async () => {
    document.body.innerHTML = OPEN_COMBOBOX;
    const observed = await observePage();
    const school = observed.elements.find((entry) => /school/i.test(entry.label))!;
    expect(school.interactionType).toBe('SEARCHABLE_COMBOBOX');
    expect(school.searchable).toBe(true);
    expect(school.searchInputId).toBeDefined();

    const search = observed.elements.find((entry) => entry.elementId === school.searchInputId)!;
    expect(search.interactionType).toBe('TEXT_INPUT');
    expect(search.searchInputFor).toBe(school.elementId);
    // Never a question in its own right, so having typed into it can never be
    // the reason a run considers itself finished.
    expect(search.required).toBe(false);
    expect(search.policy).toBe('UNKNOWN_FACT');
  });

  it('reports a shut combobox as CLOSED with no search box', async () => {
    // An ARIA combobox keeps its empty listbox in the document while shut.
    // Reading that as an open menu would turn "never opened" into "opened and
    // offers nothing", which is the difference between asking the applicant a
    // question and silently skipping the field.
    document.body.innerHTML = `
      <label for="school">School/Institution Name *</label>
      <div id="schoolRoot">
        <input id="school" name="school" type="text" role="combobox"
               aria-autocomplete="list" aria-controls="schoolList" aria-expanded="false" />
        <ul id="schoolList" role="listbox" style="display:none"></ul>
      </div>`;
    const observed = await observePage();
    const school = observed.elements.find((entry) => /school/i.test(entry.label))!;
    expect(school.dropdownState).toBe('CLOSED');
    expect(school.searchInputId).toBeUndefined();
  });

  it('reports SEARCHING once the box holds a query', async () => {
    document.body.innerHTML = OPEN_COMBOBOX;
    (document.getElementById('school') as HTMLInputElement).value = 'New Jersey';
    const observed = await observePage();
    const school = observed.elements.find(
      (entry) => /school/i.test(entry.label) && entry.searchInputFor === undefined,
    )!;
    expect(school.dropdownState).toBe('SEARCHING');
  });
});

// ---------------------------------------------------------------------------
describe('the validator admits a query only to the search box', () => {
  const pair = (patch: Partial<ObservedElement> = {}) => {
    const school = element({
      elementId: 'e100',
      label: 'School/Institution Name',
      dropdownState: 'OPEN',
      searchable: true,
      searchInputId: 'e100::search',
      proposedValue: WANTED,
      ...patch,
    });
    const search = element({
      elementId: 'e100::search',
      label: 'Search within School/Institution Name',
      kind: 'text',
      interactionType: 'TEXT_INPUT',
      policy: 'UNKNOWN_FACT',
      searchInputFor: 'e100',
    });
    return { school, search };
  };

  const decide = (elementId: string, value: string, patch: Partial<ObservedElement> = {}) => {
    const { school, search } = pair(patch);
    return checkDecision(
      agentDecisionSchema.parse({
        kind: 'ACTION',
        action: { tool: 'type', elementId, value },
      }),
      observation([school, search]),
      new Map([['e100', WANTED]]),
    );
  };

  it('refuses a query typed into the combobox itself', () => {
    const verdict = decide('e100', 'NJIT');
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
  });

  it('permits the saved answer typed into the search box', () => {
    expect(decide('e100::search', WANTED).allowed).toBe(true);
  });

  it('permits a shortened query, because that is what narrowing is', () => {
    // `searchQueriesFor` shortens a saved value until a filtered list matches
    // it. Every one of those shortenings is part of the saved answer.
    expect(decide('e100::search', 'New Jersey').allowed).toBe(true);
    expect(decide('e100::search', 'Technology').allowed).toBe(true);
  });

  it('refuses a query the saved answer does not contain', () => {
    // A decider casting about for something that might match is inventing, and
    // an invented query returns a list of invented-looking things to pick from.
    const verdict = decide('e100::search', 'Harvard');
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
  });

  it('refuses a query while the menu is shut', () => {
    const verdict = decide('e100::search', 'New Jersey', { dropdownState: 'CLOSED' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.suggestedTool).toBe('open_dropdown');
  });
});

// ---------------------------------------------------------------------------
describe('the agent searches, then chooses, and never mistakes one for the other', () => {
  const school = (patch: Partial<ObservedElement> = {}) =>
    element({
      elementId: 'e400',
      label: 'School/Institution Name',
      dropdownState: 'OPEN',
      searchable: true,
      searchInputId: 'e400::search',
      proposedValue: WANTED,
      options: [
        {
          optionId: 'e400::option::0',
          label: 'Rutgers University',
          disabled: false,
          selected: false,
        },
      ],
      ...patch,
    });

  const searchBox = element({
    elementId: 'e400::search',
    label: 'Search within School/Institution Name',
    kind: 'text',
    interactionType: 'TEXT_INPUT',
    policy: 'UNKNOWN_FACT',
    searchInputFor: 'e400',
  });

  it('searches before concluding an open list does not offer the answer', () => {
    // The list on screen is what the control chose to render, not its whole
    // vocabulary. "Not here" is unproven until the list has been narrowed.
    const decision = decideDeterministically({
      observation: observation([school(), searchBox]),
      history: new AgentHistory(),
      trustedValues: new Map([['e400', WANTED]]),
    });
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('type');
    expect(decision.action?.elementId).toBe('e400::search');
  });

  it('chooses a real option once the narrowed list offers one', () => {
    const decision = decideDeterministically({
      observation: observation([
        school({
          dropdownState: 'SEARCHING',
          options: [
            { optionId: 'e400::option::0', label: WANTED, disabled: false, selected: false },
          ],
        }),
        searchBox,
      ]),
      history: new AgentHistory(),
      trustedValues: new Map([['e400', WANTED]]),
    });
    expect(decision.kind).toBe('ACTION');
    expect(decision.action?.tool).toBe('select_option');
    expect(decision.action?.optionId).toBe('e400::option::0');
  });

  it('asks rather than typing once a searched list still offers nothing', () => {
    // The end of the road, and the end of the road is a question — never the
    // answer typed into the control.
    const decision = decideDeterministically({
      observation: observation([school({ dropdownState: 'SEARCHING' }), searchBox]),
      history: new AgentHistory(),
      trustedValues: new Map([['e400', WANTED]]),
    });
    expect(decision.kind).toBe('ASK_USER');
    expect(decision.errorCode).toBe('DROPDOWN_TARGET_NOT_FOUND');
  });

  it('does not consider the field answered merely because a query was typed', () => {
    // The heart of it. The search box holds the whole saved answer, and the
    // control it belongs to is still on its placeholder — so the agent's next
    // decision is about that control, not about something else.
    const decision = decideDeterministically({
      observation: observation([
        school({
          dropdownState: 'SEARCHING',
          currentValue: '',
          options: [
            { optionId: 'e400::option::0', label: WANTED, disabled: false, selected: false },
          ],
        }),
        element({
          elementId: 'e400::search',
          label: 'Search within School/Institution Name',
          kind: 'text',
          interactionType: 'TEXT_INPUT',
          policy: 'UNKNOWN_FACT',
          searchInputFor: 'e400',
          currentValue: WANTED,
        }),
      ]),
      history: new AgentHistory(),
      trustedValues: new Map([['e400', WANTED]]),
    });
    expect(decision.action?.elementId).toBe('e400');
    expect(decision.action?.tool).toBe('select_option');
  });
});
