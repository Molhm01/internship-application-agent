import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  detectedFieldSchema,
  observedElementSchema,
  type ObservedElement,
  type PageObservation,
} from '@internship-agent/shared';
import { AgentHistory } from '../../extension/src/agent/agentHistory.js';
import { decideDeterministically } from '../../extension/src/agent/agentDecision.js';
import { decideWithChoiceFallback } from '../../extension/src/agent/agentLoop.js';
import { checkDecision } from '../../extension/src/agent/agentSafety.js';
import {
  matchActualChoice,
  validateModelChoiceDecision,
} from '../../extension/src/agent/choiceMatcher.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import {
  interactionTypeOf,
  observePage,
  policyFor,
} from '../../extension/src/agent/pageObserver.js';

const LINCOLN_CHOICES_FIXTURE = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'lab',
  'lincoln-agent-choices.html',
);

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ width: 240, height: 32, top: 0, left: 0, right: 240, bottom: 32, x: 0, y: 0, toJSON: () => ({}) }),
});

afterEach(() => {
  document.body.innerHTML = '';
});

function observation(elements: ObservedElement[], id = 'obs-test'): PageObservation {
  return {
    observationId: id,
    origin: 'https://employer.example',
    title: 'Application',
    sections: [],
    elements,
    repeaters: [],
    navigation: [],
    requiredOutstanding: elements.filter((element) => element.required && !element.currentValue).length,
    takenAt: '2026-08-12T00:00:00.000Z',
  };
}

function known(element: ObservedElement, value: string): ObservedElement {
  return observedElementSchema.parse({ ...element, policy: 'KNOWN_FACT', proposedValue: value });
}

describe('authoritative control classification and tool allowlist', () => {
  it('classifies every choice family from the live control', () => {
    document.body.innerHTML = `
      <select id="native"><option>One</option></select>
      <button id="custom" aria-haspopup="listbox"></button>
      <input id="searchable" aria-autocomplete="list" />
      <input id="r1" type="radio" name="r" /><input id="r2" type="radio" name="r" />
      <input id="c1" type="checkbox" name="c" /><input id="c2" type="checkbox" name="c" />
      <input id="single" type="checkbox" />
      <button id="button"></button><a id="link" href="#"></a>`;
    expect(interactionTypeOf(document.getElementById('native'))).toBe('NATIVE_SELECT');
    expect(interactionTypeOf(document.getElementById('custom'))).toBe('CUSTOM_SELECT');
    expect(interactionTypeOf(document.getElementById('searchable'))).toBe('SEARCHABLE_COMBOBOX');
    expect(interactionTypeOf(document.getElementById('r1'))).toBe('RADIO_GROUP');
    expect(interactionTypeOf(document.getElementById('c1'))).toBe('CHECKBOX_GROUP');
    expect(interactionTypeOf(document.getElementById('single'))).toBe('SINGLE_CHECKBOX');
    expect(interactionTypeOf(document.getElementById('button'))).toBe('BUTTON');
    expect(interactionTypeOf(document.getElementById('link'))).toBe('LINK');
  });

  it.each(['NATIVE_SELECT', 'CUSTOM_SELECT', 'SEARCHABLE_COMBOBOX', 'RADIO_GROUP', 'CHECKBOX_GROUP'] as const)(
    'rejects type on %s before execution',
    (interactionType) => {
      const element = observedElementSchema.parse({
        elementId: 'e1', label: 'Question', kind: 'dropdown', interactionType,
        policy: 'KNOWN_FACT', proposedValue: 'Yes',
      });
      const verdict = checkDecision(
        agentDecisionSchema.parse({ kind: 'ACTION', action: { tool: 'type', elementId: 'e1', value: 'Yes' } }),
        observation([element]),
        new Map([['e1', 'Yes']]),
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
    },
  );
});

describe('native options are real, temporary DOM references', () => {
  it('extracts index/value and selects the exact observed option with framework events', async () => {
    document.body.innerHTML = `<label for="state">State/Province *</label><select id="state" required><option value="">No Selection</option><option value="NJ">New Jersey</option></select>`;
    const events: string[] = [];
    const select = document.getElementById('state') as HTMLSelectElement;
    for (const name of ['input', 'change', 'blur']) select.addEventListener(name, () => events.push(name));
    const before = await observePage();
    const state = before.elements.find((element) => /state/i.test(element.label))!;
    expect(state.options[0]).toMatchObject({ index: 0, value: '', label: 'No Selection', selected: true });
    expect(state.options[1]).toMatchObject({ index: 1, value: 'NJ', label: 'New Jersey' });

    const outcome = await executeAgentTool({ tool: 'select_option', elementId: state.elementId, optionId: state.options[1]!.optionId });
    expect(outcome.executed).toBe(true);
    expect(select.value).toBe('NJ');
    expect(events).toEqual(expect.arrayContaining(['input', 'change', 'blur']));
    const after = await observePage();
    const committed = after.elements.find((element) => /state/i.test(element.label))!;
    expect(committed.currentValue).toBe('New Jersey');
    expect(committed.selectionCommitted).toBe(true);
  });

  it('rejects a stale node and an invented optionId without clicking', async () => {
    document.body.innerHTML = `<label for="state">State</label><select id="state"><option value="">No Selection</option><option value="NJ">New Jersey</option></select>`;
    const before = await observePage();
    const state = before.elements.find((element) => /state/i.test(element.label))!;
    document.querySelector('option[value="NJ"]')?.remove();
    expect((await executeAgentTool({ tool: 'select_option', elementId: state.elementId, optionId: state.options[1]!.optionId })).errorCode).toBe('STALE_OPTION_REFERENCE');
    expect((await executeAgentTool({ tool: 'select_option', elementId: state.elementId, optionId: 'invented::option::99' })).errorCode).toBe('INVALID_OPTION_ID');
  });
});

describe('actual group choices are clicked and freshly observable', () => {
  it('extracts a radio question and verifies the checked input', async () => {
    document.body.innerHTML = `<fieldset><legend>Are you willing to relocate? *</legend><label><input type="radio" name="relocate" value="yes" required /> Yes</label><label><input type="radio" name="relocate" value="no" /> No</label></fieldset>`;
    const before = await observePage();
    const group = before.elements.find((element) => /relocate/i.test(element.label))!;
    expect(group.interactionType).toBe('RADIO_GROUP');
    expect(group.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    const yes = group.options.find((option) => option.label === 'Yes')!;
    expect((await executeAgentTool({ tool: 'select_option', elementId: group.elementId, optionId: yes.optionId })).executed).toBe(true);
    const after = await observePage();
    const fresh = after.elements.find((element) => /relocate/i.test(element.label))!;
    expect(fresh.options.find((option) => option.label === 'Yes')?.selected).toBe(true);
    expect((document.querySelector('input[value="yes"]') as HTMLInputElement).checked).toBe(true);
  });

  it('selects only actual checkbox group choices and handles a single checkbox separately', async () => {
    document.body.innerHTML = `<fieldset><legend>Work arrangements</legend><label><input type="checkbox" name="mode" value="remote" /> Remote</label><label><input type="checkbox" name="mode" value="hybrid" /> Hybrid</label></fieldset><label><input id="current" type="checkbox" /> I currently work here</label>`;
    const before = await observePage();
    const group = before.elements.find((element) => /arrangements/i.test(element.label))!;
    const choices = group.options.map((option) => option.optionId);
    expect(group.interactionType).toBe('CHECKBOX_GROUP');
    expect((await executeAgentTool({ tool: 'select_options', elementId: group.elementId, optionIds: choices })).executed).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]')).every((input) => input.checked)).toBe(true);
    const refreshed = await observePage();
    const single = refreshed.elements.find((element) => /currently work/i.test(element.label))!;
    expect(single.interactionType).toBe('SINGLE_CHECKBOX');
    expect((await executeAgentTool({ tool: 'set_checked', elementId: single.elementId, checked: true })).executed).toBe(true);
  });
});

describe('custom dropdowns click the exact scoped portal option', () => {
  it('opens, re-observes, clicks the actual option node, and verifies backing state', async () => {
    document.body.innerHTML = `<label id="eduLabel">Education Type *</label><button id="edu" role="combobox" aria-haspopup="listbox" aria-labelledby="eduLabel" aria-expanded="false"><span data-selected-label>No Selection</span><input type="hidden" name="educationType" value="" /></button><span id="error">Education Type is required</span>`;
    const trigger = document.getElementById('edu')!;
    trigger.addEventListener('click', () => {
      if (document.getElementById('eduMenu')) return;
      const menu = document.createElement('ul');
      menu.id = 'eduMenu';
      menu.setAttribute('role', 'listbox');
      menu.dataset.portalMenu = 'education';
      for (const [value, label] of [
        ['hs', 'High School'],
        ['bs', 'BS'],
      ] as const) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.dataset.value = value;
        option.textContent = label;
        option.addEventListener('click', () => {
          trigger.querySelector<HTMLElement>('[data-selected-label]')!.textContent = label;
          trigger.querySelector<HTMLInputElement>('input[type="hidden"]')!.value = value;
          option.setAttribute('aria-selected', 'true');
          document.getElementById('error')?.remove();
          menu.remove();
          trigger.setAttribute('aria-expanded', 'false');
        });
        menu.appendChild(option);
      }
      document.body.appendChild(menu);
      trigger.setAttribute('aria-controls', menu.id);
      trigger.setAttribute('aria-expanded', 'true');
    });

    const closed = await observePage();
    const field = closed.elements.find((element) => /education type/i.test(element.label))!;
    expect((await executeAgentTool({ tool: 'open_dropdown', elementId: field.elementId })).executed).toBe(true);
    const opened = await observePage();
    const live = opened.elements.find((element) => /education type/i.test(element.label))!;
    const bs = live.options.find((option) => option.label === 'BS')!;
    expect(bs.optionId).toBeTruthy();
    expect((await executeAgentTool({ tool: 'select_option', elementId: live.elementId, optionId: bs.optionId })).executed).toBe(true);
    const committed = await observePage();
    const after = committed.elements.find((element) => /education type/i.test(element.label))!;
    expect(after.currentValue).toBe('BS');
    expect(after.selectionCommitted).toBe(true);
    expect(after.validationError).toBe('');
  });
});

describe('searchable dropdowns treat typing as search, never selection', () => {
  it('types only into the internal search control, re-reads results, then clicks one', async () => {
    document.body.innerHTML = `<label for="school">School *</label><input id="school" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" required />`;
    const trigger = document.getElementById('school') as HTMLInputElement;
    const schools = ['Rutgers University', 'New Jersey Institute of Technology'];
    const render = (menu: HTMLElement) => {
      menu.replaceChildren();
      for (const label of schools.filter((school) => school.toLowerCase().includes(trigger.value.toLowerCase()))) {
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.textContent = label;
        option.addEventListener('click', () => {
          trigger.value = label;
          trigger.setAttribute('aria-expanded', 'false');
          menu.remove();
        });
        menu.appendChild(option);
      }
    };
    trigger.addEventListener('click', () => {
      if (document.getElementById('schoolMenu')) return;
      const menu = document.createElement('div');
      menu.id = 'schoolMenu';
      menu.setAttribute('role', 'listbox');
      menu.dataset.portalMenu = 'school';
      document.body.appendChild(menu);
      trigger.setAttribute('aria-controls', menu.id);
      trigger.setAttribute('aria-expanded', 'true');
      render(menu);
    });
    trigger.addEventListener('input', () => {
      const menu = document.getElementById('schoolMenu');
      if (menu) render(menu);
    });

    const closed = await observePage();
    const school = closed.elements.find((element) => element.label === 'School *' || element.label === 'School')!;
    expect(school.interactionType).toBe('SEARCHABLE_COMBOBOX');
    await executeAgentTool({ tool: 'open_dropdown', elementId: school.elementId });
    const opened = await observePage();
    const owner = opened.elements.find((element) => /school/i.test(element.label) && element.interactionType === 'SEARCHABLE_COMBOBOX')!;
    expect(owner.searchInputId).toBeTruthy();
    await executeAgentTool({ tool: 'type', elementId: owner.searchInputId!, value: 'New Jersey Institute' });
    const searched = await observePage();
    const narrowed = searched.elements.find((element) => element.interactionType === 'SEARCHABLE_COMBOBOX')!;
    // The query is visible in the input but is not a committed answer.
    expect(narrowed.currentValue).toBe('');
    expect(narrowed.selectionCommitted).toBe(false);
    expect(narrowed.options.map((option) => option.label)).toEqual(['New Jersey Institute of Technology']);
    const result = narrowed.options[0]!;
    expect((await executeAgentTool({ tool: 'select_option', elementId: narrowed.elementId, optionId: result.optionId })).executed).toBe(true);
    const committed = await observePage();
    const after = committed.elements.find((element) => /school/i.test(element.label))!;
    expect(after.currentValue).toBe('New Jersey Institute of Technology');
    expect(after.selectionCommitted).toBe(true);
  });
});

describe('choice hierarchy, model contract, and ASK_USER safety', () => {
  const base = observedElementSchema.parse({
    elementId: 'e1', label: 'Education Type', intent: 'education_type', kind: 'dropdown',
    interactionType: 'NATIVE_SELECT', policy: 'KNOWN_FACT', proposedValue: 'Bachelor of Science',
    optionsKnown: true,
    options: [
      { optionId: 'e1::o::option::0', label: 'No Selection', disabled: false, selected: true },
      { optionId: 'e1::o::option::1', label: 'BS', disabled: false, selected: false },
    ],
  });

  it('uses exact then question-aware aliases and never matches No Selection to No', () => {
    expect(matchActualChoice(base).strategy).toBe('ALIAS');
    expect(matchActualChoice({ ...base, proposedValue: 'BS' }).strategy).toBe('EXACT');
    const graduated = { ...base, label: 'Graduated?', intent: 'graduated', proposedValue: 'No' };
    expect(matchActualChoice({ ...graduated, options: [base.options[0]!] }).strategy).toBe('UNKNOWN');
  });

  it('rejects an LLM optionId outside the exact supplied choices', () => {
    const request = {
      fieldType: 'NATIVE_SELECT' as const,
      question: 'Education Type',
      candidateContext: { educationLevelKnown: true },
      choices: [{ optionId: 'education::option::1', label: 'BS' }],
    };
    expect(validateModelChoiceDecision(request, { decision: 'SELECT', optionId: 'education::option::99', confidence: 0.98, reason: 'x' })).toMatchObject({ valid: false, errorCode: 'INVALID_OPTION_ID' });
  });

  it('calls level-4 reasoning only after deterministic matching cannot settle a known answer', async () => {
    const unresolved = known(
      observedElementSchema.parse({
        ...base,
        proposedValue: 'Bachelor of Applied Science',
        options: [
          { optionId: 'e1::o::option::1', label: 'BAS', disabled: false, selected: false },
          { optionId: 'e1::o::option::2', label: 'BS', disabled: false, selected: false },
        ],
      }),
      'Bachelor of Applied Science',
    );
    let received: unknown;
    const decision = await decideWithChoiceFallback(
      { observation: observation([unresolved]), history: new AgentHistory(), trustedValues: new Map([['e1', 'Bachelor of Applied Science']]) },
      (request) => { received = request; return Promise.resolve({ decision: 'SELECT', optionId: 'e1::o::option::1', confidence: 0.98, reason: 'Trusted degree context corresponds to BAS.' }); },
    );
    expect(received).toMatchObject({
      question: 'Education Type',
      choices: expect.arrayContaining([{ optionId: 'e1::o::option::1', label: 'BAS' }]),
    });
    expect(decision.action).toMatchObject({ tool: 'select_option', optionId: 'e1::o::option::1' });
  });

  it('asks on unknown factual and sensitive questions without selecting', () => {
    const unknown = observedElementSchema.parse({ ...base, label: 'Have you previously worked for this company?', policy: 'UNKNOWN_FACT', proposedValue: undefined, required: true });
    const sensitive = observedElementSchema.parse({ ...base, elementId: 'e2', label: 'Disability status', policy: 'SENSITIVE', proposedValue: undefined, required: true });
    for (const element of [unknown, sensitive]) {
      const decision = decideDeterministically({ observation: observation([element]), history: new AgentHistory(), trustedValues: new Map() });
      expect(decision.kind).toBe('ASK_USER');
      expect(decision.action).toBeUndefined();
    }
  });

  it('distinguishes never-guessed factual questions from sensitive demographics', () => {
    const factual = detectedFieldSchema.parse({
      id: 'f1',
      pageId: 'page-1',
      selector: '#f1',
      label: 'Have you previously worked for this company?',
      normalizedLabel: 'have you previously worked for this company',
      question: 'Have you previously worked for this company?',
      fieldType: 'select',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
      warnings: [],
      metadata: {},
      canonicalKey: 'previously_employed',
    });
    expect(policyFor(factual, undefined)).toBe('UNKNOWN_FACT');
    expect(policyFor(factual, 'No')).toBe('KNOWN_FACT');
    expect(
      policyFor(
        {
          ...factual,
          label: 'Disability status',
          question: 'Disability status',
          canonicalKey: 'disability_status',
        },
        undefined,
      ),
    ).toBe('SENSITIVE');
  });
});

describe('conditional choice questions keep children safe', () => {
  it('marks the child waiting while the parent is unknown and not applicable after No', async () => {
    document.body.innerHTML = `<label for="relatives">Do you have relatives employed by this company? *</label><select id="relatives" required><option value="">No Selection</option><option value="yes">Yes</option><option value="no">No</option></select><label for="details">If yes, provide the name and relationship of each relative</label><input id="details" />`;
    const initial = await observePage();
    const parent = initial.elements.find((element) => /relatives employed/i.test(element.label))!;
    const child = initial.elements.find((element) => /if yes/i.test(element.label))!;
    expect(child.dependencyStatus).toBe('WAITING_FOR_DEPENDENCY');
    expect(decideDeterministically({ observation: observation([parent, child]), history: new AgentHistory(), trustedValues: new Map() }).kind).toBe('ASK_USER');
    const no = parent.options.find((option) => option.label === 'No')!;
    await executeAgentTool({ tool: 'select_option', elementId: parent.elementId, optionId: no.optionId });
    const after = await observePage();
    const dormant = after.elements.find((element) => /if yes/i.test(element.label))!;
    expect(dormant.dependencyStatus).toBe('NOT_APPLICABLE');
    expect((document.getElementById('details') as HTMLInputElement).value).toBe('');
  });
});

describe('working text controls remain on the type path', () => {
  it.each(['Address', 'City', 'Postal Code', 'Phone', 'Company Name', 'Position Title'])(
    'types %s normally',
    async (label) => {
      document.body.innerHTML = `<label for="field">${label}</label><input id="field" />`;
      const observed = await observePage();
      const field = observed.elements.find((element) => element.label === label)!;
      const outcome = await executeAgentTool({ tool: 'type', elementId: field.elementId, value: 'saved text' });
      expect(outcome.executed).toBe(true);
      expect((document.getElementById('field') as HTMLInputElement).value).toBe('saved text');
    },
  );
});

describe('Lincoln-style acceptance fixture', () => {
  async function choose(
    label: RegExp,
    wanted: string,
    expectedStrategy: 'EXACT' | 'ALIAS' = 'EXACT',
  ) {
    let page = await observePage();
    let field = page.elements.find((element) => label.test(element.label));
    expect(field, `fixture field ${String(label)} was not observed`).toBeTruthy();
    if (field!.options.length === 0) {
      const opened = await executeAgentTool({
        tool: 'open_dropdown',
        elementId: field!.elementId,
      });
      expect(opened.executed).toBe(true);
      page = await observePage();
      field = page.elements.find((element) => label.test(element.label));
    }
    const match = matchActualChoice({ ...field!, proposedValue: wanted });
    expect(match.strategy).toBe(expectedStrategy);
    expect(match.optionId).toBeTruthy();
    const selected = await executeAgentTool({
      tool: 'select_option',
      elementId: field!.elementId,
      optionId: match.optionId!,
    });
    expect(selected.executed).toBe(true);
    const fresh = await observePage();
    const committed = fresh.elements.find((element) => label.test(element.label));
    expect(committed?.selectionCommitted).toBe(true);
    expect(committed?.validationError).toBe('');
    return committed!;
  }

  it('drives State, education, searchable School, Graduated, and radio through real options', async () => {
    document.documentElement.innerHTML = readFileSync(LINCOLN_CHOICES_FIXTURE, 'utf8').replace(
      /<!doctype html>/i,
      '',
    );
    for (const script of Array.from(document.querySelectorAll('script'))) {
      const replacement = document.createElement('script');
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }

    expect((await choose(/^State\/Province \*$/i, 'New Jersey')).currentValue).toBe(
      'New Jersey',
    );
    expect((await choose(/^Education Type \*$/i, 'Bachelor of Science', 'ALIAS')).currentValue).toBe(
      'BS',
    );
    expect((await choose(/^Education Country \*$/i, 'United States', 'EXACT')).currentValue).toBe(
      'United States',
    );
    expect((await choose(/^Education State\/Province \*$/i, 'New Jersey', 'ALIAS')).currentValue).toBe(
      'NJ',
    );

    let page = await observePage();
    let school = page.elements.find((element) => /^School \*$/i.test(element.label));
    expect(school?.interactionType).toBe('CUSTOM_SELECT');
    expect(
      (await executeAgentTool({ tool: 'open_dropdown', elementId: school!.elementId })).executed,
    ).toBe(true);
    page = await observePage();
    school = page.elements.find((element) => /^School \*$/i.test(element.label));
    expect(school?.interactionType).toBe('SEARCHABLE_COMBOBOX');
    expect(school?.searchInputId).toBeTruthy();
    expect(
      (
        await executeAgentTool({
          tool: 'type',
          elementId: school!.searchInputId!,
          value: 'New Jersey Institute',
        })
      ).executed,
    ).toBe(true);
    page = await observePage();
    school = page.elements.find((element) => /^School \*$/i.test(element.label));
    expect(school?.currentValue).toBe('');
    expect(school?.selectionCommitted).toBe(false);
    const njit = school!.options.find(
      (option) => option.label === 'New Jersey Institute of Technology',
    );
    expect(njit).toBeTruthy();
    expect(
      (
        await executeAgentTool({
          tool: 'select_option',
          elementId: school!.elementId,
          optionId: njit!.optionId,
        })
      ).executed,
    ).toBe(true);
    page = await observePage();
    school = page.elements.find((element) => /^School \*$/i.test(element.label));
    expect(school?.currentValue).toBe('New Jersey Institute of Technology');
    expect(school?.selectionCommitted).toBe(true);

    expect((await choose(/^Area of Study \*$/i, 'Electrical Engineering')).currentValue).toBe(
      'Electrical Engineering',
    );
    expect((await choose(/^Graduated\? \*$/i, 'No')).currentValue).toBe('No');
    const radio = await choose(/willing to relocate/i, 'Yes');
    expect(radio.interactionType).toBe('RADIO_GROUP');
    expect(radio.options.find((option) => option.label === 'Yes')?.selected).toBe(true);

    const unknown = (await observePage()).elements.find((element) =>
      /previously worked for lincoln/i.test(element.label),
    )!;
    const decision = decideDeterministically({
      observation: observation([unknown]),
      history: new AgentHistory(),
      trustedValues: new Map(),
    });
    expect(decision.kind).toBe('ASK_USER');
    expect(decision.action).toBeUndefined();
  });
});
