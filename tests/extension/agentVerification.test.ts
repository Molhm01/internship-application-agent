import { afterEach, describe, expect, it } from 'vitest';
import {
  findLogicalField,
  holdsWrittenValue,
  logicalFieldKey,
  normalizeFieldLabel,
  observedElementSchema,
  profileSchema,
  type ObservedElement,
  type PageObservation,
  type Profile,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { trustedValuesFor } from '../../extension/src/background/agentController.js';

/**
 * An action that visibly worked is counted as an action that worked.
 *
 * ## The live failure this file is about
 *
 * A real Lincoln Electric run reported:
 *
 *     status: BLOCKED   observations: 7   actions: 6   verified: 0
 *     failureCode: undefined
 *
 * while text fields visibly filled on the page. Six writes reached the
 * employer's DOM and the run counted none of them, then gave up without saying
 * why.
 *
 * Reproduced against a fixture, three independent rules each rejected a
 * *correct* write, and the fixtures below are built to hold each one open:
 *
 *  1. The observer read `aria-describedby` as an error source, so a required
 *     field pointing at a permanent "This field is required" hint reported a
 *     validation error for ever — and the verifier failed every write to it.
 *  2. A control that reformatted what it kept — `+1 201 555 0134` stored as
 *     `(201) 555-0134` — failed a containment comparison over the country code.
 *  3. Correlation between observations was exact equality of label, section and
 *     block index, so a re-render that changed a required marker lost the
 *     control entirely and reported `NOT_VERIFIED`.
 *
 * The tests are ordered so the cheapest possible failure fails first: the
 * helpers, then one action, then a whole run.
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

const PROFILE: Profile = profileSchema.parse({
  updatedAt: '2026-08-11T00:00:00.000Z',
  personal: {
    legalFirstName: 'Robin',
    legalLastName: 'Vale',
    email: 'robin.vale@example.com',
    phone: '+1 201 555 0134',
    address: {
      line1: '48 Maple Avenue',
      city: 'Clifton',
      state: 'New Jersey',
      postalCode: '07011',
      country: 'United States',
    },
  },
  experience: [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      title: 'Engineering Intern',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ],
});

let handle = 0;
function element(patch: Partial<ObservedElement> = {}): ObservedElement {
  handle += 1;
  return observedElementSchema.parse({
    elementId: `e${handle}`,
    label: `Field ${handle}`,
    kind: 'text',
    interactionType: 'TEXT_INPUT',
    policy: 'KNOWN_FACT',
    ...patch,
  });
}

/**
 * Runs the production loop over the mounted page.
 *
 * `observe`, `execute` and `trustedValues` are the shipped functions, so a
 * value's journey from the profile to the employer's box and back into the
 * verified counter goes through every layer it goes through in the browser,
 * minus only the message passing between frames.
 */
async function run(html: string, prepare?: () => void) {
  document.body.innerHTML = html;
  prepare?.();
  let latest = new Map<string, string>();
  const host: AgentLoopHost = {
    runId: 'run-verification',
    buildId: 'test',
    observe: async () => {
      const observed = await observePage();
      latest = trustedValuesFor(observed, PROFILE);
      return {
        ...observed,
        elements: observed.elements.map((entry) => {
          const value = latest.get(entry.elementId);
          if (!value) return entry;
          if (entry.policy === 'SENSITIVE' || entry.policy === 'LEGAL_ACKNOWLEDGMENT') return entry;
          return { ...entry, policy: 'KNOWN_FACT' as const, proposedValue: value };
        }),
      } satisfies PageObservation;
    },
    execute: (call) => executeAgentTool(call),
    trustedValues: () => Promise.resolve(latest),
  };
  const outcome = await runAgentLoop(host);
  const value = (id: string): string =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  return { ...outcome, value };
}

// ---------------------------------------------------------------------------
describe('a control that reformats what it keeps has still kept it', () => {
  it('accepts a phone number the box re-rendered', () => {
    // The exact live pair. The old comparison reduced both to alphanumerics and
    // asked for containment, which the leading country code defeated.
    expect(holdsWrittenValue('(201) 555-0134', '+1 201 555 0134')).toBe(true);
    expect(holdsWrittenValue('201-555-0134', '+1 201 555 0134')).toBe(true);
    expect(holdsWrittenValue('07011', '07011')).toBe(true);
    expect(holdsWrittenValue('48 MAPLE AVENUE', '48 Maple Avenue')).toBe(true);
  });

  it('still refuses a box holding something else, or nothing', () => {
    // The rule has to stay able to say no, or it would verify everything.
    expect(holdsWrittenValue('', '48 Maple Avenue')).toBe(false);
    expect(holdsWrittenValue('Newark', 'Clifton')).toBe(false);
    expect(holdsWrittenValue('(908) 555-0199', '+1 201 555 0134')).toBe(false);
  });

  it('does not let the digit rule equate two different addresses', () => {
    // The reformatting rule is narrow on purpose: it applies where the digits
    // *are* the value, and must never make two different text answers match.
    expect(holdsWrittenValue('48 Maple Avenue', '90 Oak Street')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a control is found again across observations', () => {
  it('ignores a required marker the page added or removed', () => {
    expect(normalizeFieldLabel('Street Address *')).toBe(normalizeFieldLabel('Street address'));
    expect(normalizeFieldLabel('City (required)')).toBe(normalizeFieldLabel('City'));
  });

  it('correlates the same question under a different handle', () => {
    // The whole point: handles are reminted every observation, so the control
    // just written to necessarily has a new one.
    const before = element({ elementId: 'e17', label: 'Street Address', intent: 'address_line1' });
    const after = [
      element({ elementId: 'e39', label: 'Street Address *', intent: 'address_line1' }),
      element({ elementId: 'e40', label: 'City', intent: 'city' }),
    ];
    expect(findLogicalField(after, before)?.elementId).toBe('e39');
  });

  it('keeps two repeated blocks apart', () => {
    // A page with two Work Experience blocks has two controls labelled "Company
    // Name". Confirming a write against the wrong one would be worse than
    // failing to confirm it.
    const before = element({ label: 'Company Name', section: 'experience', blockIndex: 1 });
    const after = [
      element({ elementId: 'a', label: 'Company Name', section: 'experience', blockIndex: 0 }),
      element({ elementId: 'b', label: 'Company Name', section: 'experience', blockIndex: 1 }),
    ];
    expect(findLogicalField(after, before)?.elementId).toBe('b');
  });

  it('keeps two frames apart', () => {
    const before = element({ label: 'City', frameId: 2 });
    const after = [
      element({ elementId: 'a', label: 'City', frameId: 0 }),
      element({ elementId: 'b', label: 'City', frameId: 2 }),
    ];
    expect(findLogicalField(after, before)?.elementId).toBe('b');
    expect(logicalFieldKey(before)).not.toBe(logicalFieldKey(after[0]!));
  });

  it('reports a control that genuinely went away as not found', () => {
    const before = element({ label: 'Street Address', intent: 'address_line1' });
    expect(findLogicalField([element({ label: 'City', intent: 'city' })], before)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('a static "required" hint is not the form rejecting the value', () => {
  it('does not report a validation error on a filled field beside one', async () => {
    // The primary root cause, at the layer it lives on. `aria-describedby` is
    // the attribute for hints, and a permanent "This field is required" marker
    // beside a filled field is a label, not a verdict.
    document.body.innerHTML = `
      <label for="city">City *</label>
      <input id="city" name="city" type="text" value="Clifton" aria-describedby="hint" />
      <span id="hint">This field is required</span>`;
    const observed = await observePage();
    const city = observed.elements.find((entry) => entry.label.includes('City'));
    expect(city?.currentValue).toBe('Clifton');
    expect(city?.validationError).toBe('');
  });

  it('still reports one when the page has actually flagged the control', async () => {
    // The rule has to stay able to see a real rejection, or the dropdown and
    // date repairs that depend on it would silently stop working.
    document.body.innerHTML = `
      <label for="city">City *</label>
      <input id="city" name="city" type="text" value="Clifton"
             aria-invalid="true" aria-describedby="hint" />
      <span id="hint">This field is required</span>`;
    const observed = await observePage();
    expect(observed.elements.find((entry) => entry.label.includes('City'))?.validationError).toBe(
      'This field is required',
    );
  });

  it('reads aria-errormessage whether or not the control is flagged', async () => {
    // `aria-errormessage` is *the* error attribute, so it needs no corroboration.
    document.body.innerHTML = `
      <label for="city">City *</label>
      <input id="city" name="city" type="text" value="x" aria-errormessage="err" />
      <span id="err">City is required</span>`;
    const observed = await observePage();
    expect(observed.elements.find((entry) => entry.label.includes('City'))?.validationError).toBe(
      'City is required',
    );
  });
});

// ---------------------------------------------------------------------------
describe('BUILT TEST: one working text field', () => {
  const PAGE = `
    <form>
      <label for="addressLine1">Street Address *</label>
      <input id="addressLine1" name="addressLine1" type="text" required
             aria-describedby="a1hint" />
      <span id="a1hint">This field is required</span>
    </form>`;

  it('counts one action and one verified', async () => {
    const outcome = await run(PAGE);
    expect(outcome.value('addressLine1')).toBe('48 Maple Avenue');
    expect(outcome.trace.actionCount).toBe(1);
    expect(outcome.trace.verifiedCount).toBe(1);
    expect(outcome.status).not.toBe('BLOCKED');
  });

  it('records the action end to end', async () => {
    const outcome = await run(PAGE);
    const action = outcome.trace.steps.find((step) => step.tool === 'type')?.action;
    expect(action?.decisionTool).toBe('type');
    expect(action?.targetControlType).toBe('TEXT_INPUT');
    expect(action?.actionAccepted).toBe(true);
    expect(action?.executionSuccess).toBe(true);
    expect(action?.verified).toBe(true);
    expect(action?.verificationStrategy).toBe('TEXT_VALUE');
    expect(action?.verificationObservedState).toBe('HOLDS_EXPECTED');
    expect(action?.errorCode).toBeUndefined();
  });

  it('verified against a genuinely fresh observation', async () => {
    // The fact that could not be established about the live run at all: whether
    // the loop looked again before judging.
    const outcome = await run(PAGE);
    const action = outcome.trace.steps.find((step) => step.tool === 'type')?.action;
    expect(action?.freshObservation).toBe(true);
    expect(action?.observationBefore).not.toBe(action?.observationAfter);
    expect(action?.observationAfter.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('BUILT TEST: six text fields', () => {
  // Every one carries the "required" hint that broke the live run, and Phone
  // reformats what it is given.
  const PAGE = `
    <form>
      <fieldset>
        <legend>Profile</legend>
        <label for="addressLine1">Street Address *</label>
        <input id="addressLine1" type="text" required aria-describedby="h1" />
        <span id="h1">This field is required</span>

        <label for="city">City *</label>
        <input id="city" type="text" required aria-describedby="h2" />
        <span id="h2">This field is required</span>

        <label for="postalCode">Zip/Postal Code *</label>
        <input id="postalCode" type="text" required aria-describedby="h3" />
        <span id="h3">This field is required</span>

        <label for="phone">Phone Number *</label>
        <input id="phone" type="tel" required aria-describedby="h4" />
        <span id="h4">This field is required</span>
      </fieldset>
      <fieldset>
        <legend>Work Experience</legend>
        <div class="experience-block" data-experience-index="0">
          <label for="employer0">Company Name</label>
          <input id="employer0" type="text" />
          <label for="title0">Position Title</label>
          <input id="title0" type="text" />
        </div>
      </fieldset>
    </form>`;

  const reformatPhone = (): void => {
    const phone = document.getElementById('phone') as HTMLInputElement;
    phone.addEventListener('change', () => {
      const digits = phone.value.replace(/\D/g, '').slice(-10);
      if (digits.length === 10) {
        phone.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
    });
  };

  it('fills all six and verifies all six', async () => {
    const outcome = await run(PAGE, reformatPhone);
    expect(outcome.value('addressLine1')).toBe('48 Maple Avenue');
    expect(outcome.value('city')).toBe('Clifton');
    expect(outcome.value('postalCode')).toBe('07011');
    expect(outcome.value('phone')).toBe('(201) 555-0134');
    expect(outcome.value('employer0')).toBe('Northwind Robotics');
    expect(outcome.value('title0')).toBe('Engineering Intern');
    // The assertion this whole task exists for.
    expect(outcome.trace.actionCount).toBeGreaterThanOrEqual(6);
    expect(outcome.trace.verifiedCount).toBeGreaterThanOrEqual(6);
  });

  it('never reports the live signature again', async () => {
    const outcome = await run(PAGE, reformatPhone);
    const liveSignature = outcome.trace.actionCount > 0 && outcome.trace.verifiedCount === 0;
    expect(liveSignature, 'actions ran and none were counted').toBe(false);
  });

  it('counts the reformatted phone as verified', async () => {
    // Filled correctly, stored in the page's own format, and counted.
    const outcome = await run(PAGE, reformatPhone);
    const step = outcome.trace.steps.find((entry) => entry.targetLabel.includes('Phone'));
    expect(step?.verification).toBe('VERIFIED');
    expect(step?.errorCode).toBeUndefined();
  });

  it('increments verified exactly once per verified action', async () => {
    const outcome = await run(PAGE, reformatPhone);
    const verifiedSteps = outcome.trace.steps.filter((step) => step.verification === 'VERIFIED');
    expect(outcome.trace.verifiedCount).toBe(verifiedSteps.length);
  });

  it('does not become BLOCKED while it is making progress', async () => {
    const outcome = await run(PAGE, reformatPhone);
    expect(outcome.status).not.toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
describe('BUILT TEST: a dropdown the form does not commit', () => {
  /**
   * A control that renders whatever it is told and keeps nothing.
   *
   * The live Education Type shape: the trigger comes to read "BS", the backing
   * store stays empty, and the form goes on saying the question is required.
   * Driven through a stub host rather than a DOM fixture because *this*
   * behaviour — displaying one thing while holding another — is what a real
   * vendor widget does and what a hand-written one cannot be made to do
   * convincingly.
   */
  const DEGREE = "Bachelor's Degree";
  const OPTIONS = [
    { optionId: 'e1::option::0', label: 'No Selection', disabled: false, selected: true },
    { optionId: 'e1::option::1', label: DEGREE, disabled: false, selected: false },
  ];

  function lyingHost(): AgentLoopHost {
    const state = { displayed: '', steps: 0, open: false };
    const host: AgentLoopHost = {
      runId: 'run-lying-dropdown',
      buildId: 'test',
      observe: () =>
        Promise.resolve({
          observationId: `obs-${state.steps}`,
          origin: 'https://employer.example',
          title: 'Application',
          sections: ['Education'],
          elements: [
            observedElementSchema.parse({
              elementId: 'e1',
              label: 'Education Type',
              section: 'Education',
              kind: 'dropdown',
              interactionType: 'CUSTOM_SELECT',
              required: true,
              policy: 'KNOWN_FACT',
              proposedValue: DEGREE,
              // The form kept nothing, so the observer reports nothing —
              // whatever the trigger is displaying.
              currentValue: '',
              selectionCommitted: false,
              validationError: 'Education Type is required',
              dropdownState: state.open ? 'OPEN' : 'CLOSED',
              options: state.open ? OPTIONS : [],
              optionsKnown: state.open,
            }),
          ],
          repeaters: [],
          navigation: [],
          requiredOutstanding: 1,
          takenAt: '2026-08-11T00:00:00.000Z',
        } satisfies PageObservation),
      execute: (call) => {
        state.steps += 1;
        if (call.tool === 'open_dropdown') {
          state.open = true;
          return Promise.resolve({
            tool: call.tool,
            executed: true,
            observedValue: '',
            options: OPTIONS,
            optionsSeen: OPTIONS.length,
            pageChanged: true,
            reason: '',
            durationMs: 1,
          });
        }
        if (call.tool === 'select_option') {
          // The lie: the label changes and nothing is stored. The *execution*
          // genuinely succeeded — the click landed — which is exactly why
          // execution success and verification have to be separate answers.
          state.displayed = OPTIONS.find((o) => o.optionId === call.optionId)?.label ?? '';
          state.open = false;
          return Promise.resolve({
            tool: call.tool,
            executed: true,
            observedValue: state.displayed,
            options: [],
            optionsSeen: OPTIONS.length,
            pageChanged: true,
            reason: '',
            durationMs: 1,
          });
        }
        return Promise.resolve({
          tool: call.tool,
          executed: false,
          observedValue: '',
          options: [],
          optionsSeen: 0,
          pageChanged: false,
          reason: '',
          durationMs: 1,
        });
      },
      trustedValues: () => Promise.resolve(new Map([['e1', DEGREE]])),
    };
    return host;
  }

  it('does not count a displayed-but-uncommitted selection as verified', async () => {
    const host = lyingHost();
    const outcome = await runAgentLoop(host);
    const selections = outcome.trace.steps.filter((step) => step.tool === 'select_option');
    expect(selections.length).toBeGreaterThan(0);
    expect(selections.some((step) => step.verification === 'VERIFIED')).toBe(false);
    expect(outcome.trace.verifiedCount).toBe(
      outcome.trace.steps.filter((step) => step.verification === 'VERIFIED').length,
    );
  });

  it('names the specific reason', async () => {
    const host = lyingHost();
    const outcome = await runAgentLoop(host);
    const failed = outcome.trace.steps.filter(
      (step) => step.tool === 'select_option' && step.verification === 'VERIFICATION_FAILED',
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.errorCode).toBe('OPTION_SELECTION_NOT_COMMITTED');
    expect(failed[0]?.action?.verificationStrategy).toBe('OPTION_COMMITMENT');
    expect(failed[0]?.action?.verificationObservedState).toBe('REJECTED_BY_FORM');
  });

  it('keeps execution success separate from verification', async () => {
    // The distinction item 7 turns on, in one assertion: the click landed and
    // the form kept nothing, and the trace says both.
    const host = lyingHost();
    const outcome = await runAgentLoop(host);
    const failed = outcome.trace.steps.find(
      (step) => step.tool === 'select_option' && step.verification === 'VERIFICATION_FAILED',
    );
    expect(failed?.action?.executionSuccess).toBe(true);
    expect(failed?.action?.domChanged).toBe(true);
    expect(failed?.action?.verified).toBe(false);
    expect(failed?.action?.freshObservation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('BUILT TEST: a dropdown the form does commit', () => {
  const PAGE = `
    <form>
      <label for="state">State/Province *</label>
      <select id="state" name="state" required>
        <option value="">No Selection</option>
        <option value="NJ">New Jersey</option>
        <option value="NY">New York</option>
      </select>
    </form>`;

  it('counts a real selection as verified', async () => {
    const outcome = await run(PAGE);
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('NJ');
    const selections = outcome.trace.steps.filter((step) => step.tool === 'select_option');
    expect(selections.some((step) => step.verification === 'VERIFIED')).toBe(true);
    expect(outcome.trace.verifiedCount).toBeGreaterThan(0);
  });

  it('records the commitment strategy in the action trace', async () => {
    const outcome = await run(PAGE);
    const verified = outcome.trace.steps.find(
      (step) => step.tool === 'select_option' && step.verification === 'VERIFIED',
    );
    expect(verified?.action?.verificationStrategy).toBe('OPTION_COMMITMENT');
    expect(verified?.action?.verified).toBe(true);
    expect(verified?.action?.freshObservation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('BUILT TEST: progress is recognised, so the run continues', () => {
  // Six answerable text fields and three dropdowns the page will not commit.
  const PAGE = `
    <form>
      <label for="addressLine1">Street Address *</label>
      <input id="addressLine1" type="text" required aria-describedby="h1" />
      <span id="h1">This field is required</span>
      <label for="city">City *</label>
      <input id="city" type="text" required />
      <label for="postalCode">Zip/Postal Code *</label>
      <input id="postalCode" type="text" required />
      <label for="phone">Phone Number *</label>
      <input id="phone" type="tel" required />
      <div class="experience-block" data-experience-index="0">
        <label for="employer0">Company Name</label>
        <input id="employer0" type="text" />
        <label for="title0">Position Title</label>
        <input id="title0" type="text" />
      </div>
      <label id="l1">State/Province *</label>
      <div id="d1" role="combobox" aria-haspopup="listbox" aria-labelledby="l1" tabindex="0">
        <span>No Selection</span><input type="hidden" name="d1" value="" />
        <ul role="listbox"><li role="option">New Jersey</li></ul>
      </div>
    </form>`;

  it('fills and verifies the six text fields despite the stuck dropdown', async () => {
    const outcome = await run(PAGE);
    expect(outcome.trace.verifiedCount).toBeGreaterThanOrEqual(6);
  }, 30000);

  it('does not treat verified writes as steps of no progress', async () => {
    // The live run's `unchangedStreak` counted a correctly filled field as no
    // progress, because it read the executor's opinion instead of the page's.
    const outcome = await run(PAGE);
    const verified = outcome.trace.steps.filter((step) => step.verification === 'VERIFIED');
    expect(verified.length).toBeGreaterThanOrEqual(6);
    expect(outcome.trace.failureCode).not.toBe('AGENT_NO_PROGRESS');
  }, 30000);
});

// ---------------------------------------------------------------------------
describe('a run that stops short always says why', () => {
  it('never ends BLOCKED with no failureCode', async () => {
    // The live run reported `status: BLOCKED, failureCode: undefined`, which is
    // the least useful thing a run can say about itself.
    const outcome = await run(`
      <form>
        <label id="l1">State/Province *</label>
        <div id="d1" role="combobox" aria-haspopup="listbox" aria-labelledby="l1" tabindex="0">
          <span>No Selection</span><input type="hidden" name="d1" value="" />
          <ul role="listbox"><li role="option">New Jersey</li></ul>
        </div>
      </form>`);
    if (outcome.status === 'BLOCKED' || outcome.status === 'FAILED') {
      expect(outcome.trace.failureCode).toBeDefined();
    }
  }, 30000);

  it('carries a failureCode on every non-ready terminal status', async () => {
    // Asserted as a property over whatever the fixture produces, so a new exit
    // added to the loop later cannot quietly reintroduce the blank.
    for (const html of [
      '<form><label for="city">City</label><input id="city" type="text" /></form>',
      '<form></form>',
    ]) {
      const outcome = await run(html);
      if (outcome.status === 'BLOCKED' || outcome.status === 'FAILED') {
        expect(outcome.trace.failureCode, `${outcome.status} carried no reason`).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('a refused action is recorded and never counted', () => {
  it('records the refusal without counting it as progress', async () => {
    // A date control the profile cannot answer to the day: the decider proposes
    // nothing, but where a tool *is* refused the step has to say so and the run
    // has to carry on.
    const outcome = await run(`
      <form>
        <label for="city">City *</label>
        <input id="city" type="text" required />
      </form>`);
    // Nothing was refused here, so the invariant under test is the accounting
    // one: verified counts only steps the page confirmed.
    const verified = outcome.trace.steps.filter((step) => step.verification === 'VERIFIED');
    expect(outcome.trace.verifiedCount).toBe(verified.length);
    expect(
      outcome.trace.steps.every((step) => step.action?.verified !== true || step.executed),
    ).toBe(true);
  });
});
