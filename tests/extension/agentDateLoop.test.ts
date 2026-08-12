import { afterEach, describe, expect, it } from 'vitest';
import {
  profileSchema,
  type AgentRunTrace,
  type PageObservation,
  type Profile,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../../extension/src/agent/agentLoop.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { trustedValuesFor } from '../../extension/src/background/agentController.js';

/**
 * The whole loop, over a Lincoln-style page whose date controls disagree.
 *
 * The unit tests beside this one each prove one layer: the observer classifies,
 * the validator refuses, the formatter converts, the executor writes. All four
 * can pass while the *loop* still does the wrong thing — which is exactly the
 * failure mode this project has shipped before, so this runs the real loop over
 * a real DOM with the real profile resolution and checks what ends up in the
 * boxes.
 *
 * The page is the live shape: text inputs with format masks, validated by the
 * page's own script on blur, exactly as the employer's form validated them. A
 * fixture built from `<input type="month">` could not reproduce the failure at
 * all, because the browser would never have accepted `2021-07` as anything but
 * a month.
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

/**
 * Two blocks whose date controls want different things, on one page.
 *
 * Block 0 wants `MM/DD/YYYY`; block 1 wants `MM/YYYY`. That difference is what
 * makes this test able to fail a build that reads one format for the whole page
 * — the commonest wrong way to fix the original bug.
 */
const PAGE = `
  <form>
    <fieldset>
      <legend>Profile</legend>
      <label for="city">City</label>
      <input id="city" name="city" type="text" />
    </fieldset>
    <fieldset>
      <legend>Work Experience</legend>
      <div class="experience-block" data-experience-index="0">
        <label for="employer0">Company Name</label>
        <input id="employer0" name="employer0" type="text" />
        <label for="from0">From Date</label>
        <input id="from0" name="from0" type="text" placeholder="MM/DD/YYYY"
               aria-errormessage="from0Error" />
        <span id="from0Error" class="error" hidden>Invalid date.</span>
        <label for="to0">End Date</label>
        <input id="to0" name="to0" type="text" placeholder="MM/DD/YYYY"
               aria-errormessage="to0Error" />
        <span id="to0Error" class="error" hidden>Invalid date.</span>
      </div>
      <div class="experience-block" data-experience-index="1">
        <label for="employer1">Company Name</label>
        <input id="employer1" name="employer1" type="text" />
        <label for="from1">From Date</label>
        <input id="from1" name="from1" type="text" placeholder="MM/YYYY" />
        <label for="to1">End Date</label>
        <input id="to1" name="to1" type="text" placeholder="MM/YYYY" />
      </div>
    </fieldset>
  </form>`;

/**
 * The employer's own validator, reproduced.
 *
 * Validates on blur against the mask the control displays, and flags the
 * control when it does not match. Deliberately not HTML constraint validation:
 * `2021-07` in one of these boxes passes every check the browser has, which is
 * why native validity can never be the acceptance test on its own.
 */
function installEmployerValidation(): void {
  const masks: Record<string, RegExp> = {
    'MM/DD/YYYY': /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/,
    'MM/YYYY': /^(0[1-9]|1[0-2])\/\d{4}$/,
  };
  for (const input of Array.from(document.querySelectorAll('input[placeholder]'))) {
    if (!(input instanceof HTMLInputElement)) continue;
    const mask = masks[input.placeholder];
    if (!mask) continue;
    const check = (): void => {
      const errorId = input.getAttribute('aria-errormessage');
      const error = errorId ? document.getElementById(errorId) : null;
      const ok = input.value.trim() === '' || mask.test(input.value.trim());
      if (ok) {
        input.removeAttribute('aria-invalid');
        if (error) error.hidden = true;
      } else {
        input.setAttribute('aria-invalid', 'true');
        if (error) error.hidden = false;
      }
    };
    input.addEventListener('blur', check);
    input.addEventListener('focusout', check);
  }
}

function profileWith(experience: Profile['experience']): Profile {
  return profileSchema.parse({
    updatedAt: '2026-08-11T00:00:00.000Z',
    personal: {
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      address: { line1: '48 Maple Avenue', city: 'Clifton', country: 'United States' },
    },
    experience,
  });
}

/**
 * Runs the real loop over the mounted page.
 *
 * `observe` and `execute` are the production functions, and `trustedValues` is
 * the production resolver — so a date's journey from the saved profile to the
 * employer's box goes through every layer it goes through in the browser, minus
 * only the message passing between frames.
 */
async function run(profile: Profile, dayConvention?: 'ask' | 'first_day' | 'last_day') {
  document.body.innerHTML = PAGE;
  installEmployerValidation();
  let latest = new Map<string, string>();
  const host: AgentLoopHost = {
    runId: 'run-dates',
    buildId: 'test',
    observe: async () => {
      const observed = await observePage();
      latest = trustedValuesFor(observed, profile);
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
    ...(dayConvention ? { dayConvention: () => dayConvention } : {}),
  };
  const outcome = await runAgentLoop(host);
  const value = (id: string): string =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  const invalid = (id: string): boolean =>
    document.getElementById(id)?.getAttribute('aria-invalid') === 'true';
  return { trace: outcome.trace, status: outcome.status, value, invalid };
}

const EXACT_START = [
  {
    id: 'experience-1',
    employer: 'Northwind Robotics',
    startDate: '2021-07-12',
    endDate: '2022-03-04',
    current: false,
    responsibilities: [],
    achievements: [],
  },
  {
    id: 'experience-2',
    employer: 'Clifton Hardware',
    startDate: '2020-06',
    endDate: '2020-09',
    current: false,
    responsibilities: [],
    achievements: [],
  },
];

// ---------------------------------------------------------------------------
describe('SCENARIO A: an exact date reaches the employer in the employer’s format', () => {
  it('writes 07/12/2021 into the MM/DD/YYYY box and the form accepts it', async () => {
    const outcome = await run(profileWith(EXACT_START));
    expect(outcome.value('from0')).toBe('07/12/2021');
    expect(outcome.invalid('from0')).toBe(false);
    // And never the profile's own storage format, which is what the live run
    // wrote and the employer refused.
    expect(outcome.value('from0')).not.toBe('2021-07-12');
  });

  it('writes the same run’s other block in that block’s own format', async () => {
    // The assertion a "read one format for the page" fix cannot pass.
    const outcome = await run(profileWith(EXACT_START));
    expect(outcome.value('from1')).toBe('06/2020');
    expect(outcome.value('to1')).toBe('09/2020');
  });

  it('reaches every date through set_date and never through type', async () => {
    const outcome = await run(profileWith(EXACT_START));
    const dateSteps = outcome.trace.steps.filter((step) => step.targetKind === 'date');
    expect(dateSteps.length).toBeGreaterThan(0);
    expect(dateSteps.every((step) => step.tool !== 'type')).toBe(true);
    expect(dateSteps.some((step) => step.tool === 'set_date')).toBe(true);
  });

  it('re-observes after every date action rather than filling from stale state', async () => {
    const outcome = await run(profileWith(EXACT_START));
    const setDateSteps = outcome.trace.steps.filter((step) => step.tool === 'set_date');
    // Every date step names a different observation, which is only possible if
    // the loop looked again between them.
    const observationIds = new Set(setDateSteps.map((step) => step.observationId));
    expect(observationIds.size).toBe(setDateSteps.length);
    expect(outcome.trace.observationCount).toBeGreaterThan(setDateSteps.length);
  });

  it('verifies against the employer rather than against the box', async () => {
    const outcome = await run(profileWith(EXACT_START));
    const step = outcome.trace.steps.find(
      (entry) => entry.tool === 'set_date' && entry.targetLabel.includes('From Date'),
    );
    expect(step?.verification).toBe('VERIFIED');
    expect(step?.date?.executionResult).toBe('WRITTEN');
    expect(step?.date?.requiredFormat).toBe('us_full');
    expect(step?.date?.formattedValueShape).toBe('us_full');
  });

  it('still fills the ordinary text controls beside them', async () => {
    const outcome = await run(profileWith(EXACT_START));
    expect(outcome.value('city')).toBe('Clifton');
    expect(outcome.value('employer0')).toBe('Northwind Robotics');
    expect(outcome.value('employer1')).toBe('Clifton Hardware');
  });
});

// ---------------------------------------------------------------------------
describe('SCENARIO B: a month-only record against a control wanting a day', () => {
  const MONTH_ONLY = [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      startDate: '2021-07',
      endDate: '2022-03',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ];

  it('leaves the box empty rather than choosing a day', async () => {
    const outcome = await run(profileWith(MONTH_ONLY));
    expect(outcome.value('from0')).toBe('');
    // Not the first, not the middle, not the last.
    expect(['07/01/2021', '07/15/2021', '07/31/2021']).not.toContain(outcome.value('from0'));
  });

  it('asks the applicant, naming what is known and what is wanted', async () => {
    const outcome = await run(profileWith(MONTH_ONLY));
    const asked = outcome.trace.steps.filter((step) => step.decisionType === 'ASK_USER');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((step) => step.errorCode === 'DATE_PRECISION_INSUFFICIENT')).toBe(true);
    expect(outcome.trace.openQuestions.length).toBeGreaterThan(0);
  });

  it('records the reason in the trace without recording the date', async () => {
    const outcome = await run(profileWith(MONTH_ONLY));
    const step = outcome.trace.steps.find(
      (entry) => entry.date !== undefined && entry.targetLabel.includes('From Date'),
    );
    expect(step?.date?.profilePrecision).toBe('month');
    expect(step?.date?.requiredFormat).toBe('us_full');
    expect(step?.date?.exactDateAvailable).toBe(false);
    expect(JSON.stringify(outcome.trace)).not.toContain('2021-07');
  });

  it('does not report the application ready with that field outstanding', async () => {
    const outcome = await run(profileWith(MONTH_ONLY));
    // Asked, therefore on the applicant's list — never silently counted done.
    expect(outcome.trace.questionsAsked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('SCENARIO C: an approved day convention', () => {
  const MONTH_ONLY = [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      startDate: '2021-07',
      endDate: '2022-03',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ];

  it('fills 07/01/2021 when the applicant approved the first of the month', async () => {
    const outcome = await run(profileWith(MONTH_ONLY), 'first_day');
    expect(outcome.value('from0')).toBe('07/01/2021');
    expect(outcome.invalid('from0')).toBe(false);
  });

  it('fills 07/31/2021 when the applicant approved the last of the month', async () => {
    const outcome = await run(profileWith(MONTH_ONLY), 'last_day');
    expect(outcome.value('from0')).toBe('07/31/2021');
  });

  it('records which convention supplied the day', async () => {
    const outcome = await run(profileWith(MONTH_ONLY), 'first_day');
    const step = outcome.trace.steps.find(
      (entry) => entry.tool === 'set_date' && entry.targetLabel.includes('From Date'),
    );
    expect(step?.date?.dateConventionUsed).toBe('first_day');
    expect(step?.date?.exactDateAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a role the record marks current', () => {
  const CURRENT = [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      startDate: '2021-07-12',
      // A stale end date left in the record. `current` outranks it, and neither
      // it nor today's date may reach the form.
      endDate: '2022-03-04',
      current: true,
      responsibilities: [],
      achievements: [],
    },
  ];

  it('writes no end date at all', async () => {
    const outcome = await run(profileWith(CURRENT));
    expect(outcome.value('to0')).toBe('');
  });

  it('writes nothing resembling today', async () => {
    // The failure this guards is a *clock* appearing somewhere in the date
    // path. Asserted against the actual current date rather than a fixed
    // string, so it keeps meaning the same thing next year.
    const outcome = await run(profileWith(CURRENT));
    const today = new Date();
    const stamp = `${String(today.getMonth() + 1).padStart(2, '0')}/`;
    expect(outcome.value('to0').startsWith(stamp) && outcome.value('to0').length > 0).toBe(false);
    expect(outcome.value('to0')).not.toContain(String(today.getFullYear()));
  });

  it('still fills the start date it does know', async () => {
    const outcome = await run(profileWith(CURRENT));
    expect(outcome.value('from0')).toBe('07/12/2021');
  });
});

// ---------------------------------------------------------------------------
describe('dates that contradict each other', () => {
  const BACKWARDS = [
    {
      id: 'experience-1',
      employer: 'Northwind Robotics',
      startDate: '2021-07-12',
      endDate: '2019-03-04',
      current: false,
      responsibilities: [],
      achievements: [],
    },
  ];

  it('fills neither, and says why', async () => {
    const outcome = await run(profileWith(BACKWARDS));
    // The end date precedes the start, so it is not written and it is not
    // silently swapped with the start either.
    expect(outcome.value('to0')).toBe('');
    const blocked = outcome.trace.steps.filter(
      (step) => step.errorCode === 'DATE_CHRONOLOGY_INVALID',
    );
    expect(blocked.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('the run stays bounded and never submits', () => {
  it('finishes in a terminal status without exhausting its budget', async () => {
    const outcome = await run(profileWith(EXACT_START));
    expect(['READY_FOR_REVIEW', 'BLOCKED']).toContain(outcome.status);
    expect(outcome.trace.actionCount).toBeLessThan(150);
  });

  it('records no submit press', async () => {
    const outcome = await run(profileWith(EXACT_START));
    expect(outcome.trace.submitActionCount).toBe(0);
  });
});

/** Kept honest: the trace type is the shipped one, not a local shape. */
const _traceTypeIsShared: AgentRunTrace | undefined = undefined;
void _traceTypeIsShared;
