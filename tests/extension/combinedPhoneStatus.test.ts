import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOFILL_SETTINGS,
  carriesDialCode,
  profileSchema,
  reconcilePhoneGroup,
  type ApplicationAutofillReport,
  type DeterministicFillPlan,
  type FillRunReport,
  type PhoneControlObservation,
  type Profile,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import {
  buildDeterministicPlan,
  setActionApproval,
} from '../../extension/src/planner/deterministicPlanner.js';
import { executeDomAction } from '../../extension/src/executor/domExecutor.js';
import {
  runApplicationAutofill,
  type HighlightPlan,
} from '../../extension/src/autofill/orchestrator.js';
import {
  clearHighlights,
  highlightField,
  isHighlighted,
} from '../../extension/src/content/highlighter.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * A phone block built as one combined control, filled and then marked.
 *
 * The reported failure: the number filled with its +1 intact and wore the green
 * verified border, and an orange "Information needed" badge stayed sitting over
 * it. The badge belonged to the country-code half of the same widget — a
 * combobox whose menu only exists once opened, so the scan finds a required
 * control with no choices on it and the planner correctly refuses to invent an
 * answer for it.
 *
 * These tests drive the real scanner, planner, executor and orchestrator over
 * the fixture, and draw the marks with the real content-script highlighter, so
 * what is asserted is what a person would see on the page.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'combined-phone.html',
);

const MARK = 'data-internship-agent-review';

/**
 * The applicant from the repair brief. No country is stated, which is what
 * leaves the whole number — dialling code included — going into the one phone
 * control, and what leaves the page's Country question genuinely unanswerable.
 */
function applicant(): Profile {
  const base = profileFixture();
  return profileSchema.parse({
    ...base,
    personal: {
      legalFirstName: 'Molhm',
      legalLastName: 'Ellis',
      email: 'molhm@example.com',
      phone: '+1 929 264 3117',
      phoneType: 'mobile',
      address: { city: 'Clifton', state: 'New Jersey' },
    },
    preferences: {},
  });
}

function value(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? element.value
    : '';
}

function markOf(id: string): string | null {
  return document.getElementById(id)?.getAttribute(MARK) ?? null;
}

/** Every badge the page is currently wearing, in the shadow layer. */
function badges(): string[] {
  const host = document.getElementById('internship-agent-review-layer');
  return Array.from(host?.shadowRoot?.querySelectorAll('.badge') ?? []).map(
    (node) => node.textContent ?? '',
  );
}

function loadPage(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
}

interface Run {
  report: ApplicationAutofillReport;
  /** The last set of marks the run asked the page for. */
  requests: HighlightPlan[];
  /** True if any code path ever asked to click the submit control. */
  submitClicked: boolean;
}

/**
 * One full run against the live fixture DOM.
 *
 * `highlight` does exactly what the content script does with the message —
 * clear, then draw each request — so the marks asserted afterwards are the real
 * ones and not a summary of them.
 */
async function run(): Promise<Run> {
  const profile = applicant();
  let current: DeterministicFillPlan | null = null;
  const observed: Run = {
    report: undefined as unknown as ApplicationAutofillReport,
    requests: [],
    submitClicked: false,
  };
  document.getElementById('submit')?.addEventListener('click', () => {
    observed.submitClicked = true;
  });

  observed.report = await runApplicationAutofill({
    loadSettings: () =>
      Promise.resolve({ ...DEFAULT_AUTOFILL_SETTINGS, applicationAutofillEnabled: true }),
    scan: async () => {
      const { fields } = await scanDom(document, 'page-phone', new AbortController().signal);
      return { scan: icimsScan(fields) };
    },
    plan: async () => {
      const { fields } = await scanDom(document, 'page-phone', new AbortController().signal);
      current = buildDeterministicPlan(icimsScan(fields), profile, []);
      return { plan: current };
    },
    approve: (decisions) => {
      if (!current) return Promise.resolve({});
      let next = current;
      for (const [id, approved] of decisions) next = setActionApproval(next, id, approved);
      current = next;
      return Promise.resolve({});
    },
    execute: async () => {
      const plan = current;
      if (!plan) return {};
      const { fields } = await scanDom(document, 'page-phone', new AbortController().signal);
      const byId = new Map(fields.map((entry) => [entry.id, entry]));
      const results: FillRunReport['results'] = [];
      for (const action of plan.actions) {
        if (!action.approved) continue;
        const field = byId.get(action.fieldId);
        if (!field) continue;
        results.push(
          await executeDomAction(document, field, action, new AbortController().signal, []),
        );
      }
      return {
        report: {
          id: 'fill-phone',
          planId: plan.id,
          startedAt: '2026-08-06T09:00:00.000Z',
          completedAt: '2026-08-06T09:00:01.000Z',
          url: plan.url,
          results,
          statistics: {
            attempted: results.length,
            verified: results.filter((entry) => entry.status === 'verified').length,
            failed: results.filter((entry) => entry.status === 'failed').length,
            cancelled: 0,
          },
          submitted: false as const,
          warnings: [],
        } as unknown as FillRunReport,
      };
    },
    highlight: (requests) => {
      observed.requests = [...requests];
      clearHighlights();
      for (const request of requests) highlightField(request);
      return Promise.resolve({});
    },
    onProgress: () => undefined,
    isCancelled: () => false,
    waitForStability: () => Promise.resolve(),
    now: () => new Date().toISOString(),
  });

  return observed;
}

/** The run's own record for one question, by the label the page shows. */
function outcomeFor(report: ApplicationAutofillReport, label: string) {
  const outcome = report.fieldOutcomes.find((entry) => entry.label.startsWith(label));
  expect(outcome, `no outcome recorded for "${label}"`).toBeDefined();
  return outcome!;
}

describe('a phone block whose country code lives inside the number control', () => {
  beforeEach(() => {
    clearHighlights();
    loadPage();
  });

  it('fills the number with its dialling code intact', async () => {
    await run();
    expect(value('phoneNumber')).toBe('+19292643117');
    expect(carriesDialCode(value('phoneNumber'))).toBe(true);
  });

  it('ends the phone number FILLED_VERIFIED', async () => {
    const { report } = await run();
    expect(outcomeFor(report, 'Phone Number').status).toBe('FILLED_VERIFIED');
  });

  it('ends the phone type FILLED_VERIFIED', async () => {
    const { report } = await run();
    expect(value('phoneType')).toBe('mobile');
    expect(outcomeFor(report, 'Contact Phone Type').status).toBe('FILLED_VERIFIED');
  });

  it('lets the embedded +1 answer the country-code control', async () => {
    const { report } = await run();
    const code = outcomeFor(report, 'Country Phone Code');
    expect(code.status).toBe('FILLED_VERIFIED');
    expect(code.annotation).toBe('verified');
  });

  it('leaves no Information needed mark anywhere in the phone block', async () => {
    await run();
    // The reported symptom, asserted against the page itself.
    expect(markOf('phoneNumber')).toBe('verified');
    expect(markOf('countryPhoneCode')).toBe('verified');
    expect(markOf('phoneType')).toBe('verified');
    // One badge is left on the page and it is the Country question's, which
    // nothing in the profile answers. The phone block carries none.
    expect(badges()).toEqual(['Information needed']);
    expect(markOf('country')).toBe('information_needed');
  });

  it('draws one mark per control and never two on one', async () => {
    const { requests } = await run();
    const marked = requests.filter((request) => request.annotation !== 'none');
    expect(new Set(marked.map((request) => request.selector)).size).toBe(marked.length);
    expect(new Set(marked.map((request) => request.fieldId)).size).toBe(marked.length);
  });

  it('does not restore the orange annotation on a repeated scan', async () => {
    await run();
    // Everything already on the page, scanned and marked again from scratch.
    const second = await run();
    expect(markOf('phoneNumber')).not.toBe('information_needed');
    expect(markOf('countryPhoneCode')).not.toBe('information_needed');
    expect(markOf('phoneType')).not.toBe('information_needed');
    // Still exactly one badge, still the Country question's. The phone block is
    // now the user's own already-correct answer, so it is left unmarked
    // entirely — including the country code the number states.
    expect(badges()).toEqual(['Information needed']);
    expect(outcomeFor(second.report, 'Country Phone Code').status).not.toBe(
      'USER_CONFIRMATION_REQUIRED',
    );
    expect(value('phoneNumber')).toBe('+19292643117');
  });

  it('keeps the name and email fields verified', async () => {
    const { report } = await run();
    expect(value('firstName')).toBe('Molhm');
    expect(value('lastName')).toBe('Ellis');
    expect(value('email')).toBe('molhm@example.com');
    for (const label of ['Legal First Name', 'Legal Last Name', 'Email Address']) {
      expect(outcomeFor(report, label).status, label).toBe('FILLED_VERIFIED');
    }
  });

  it('still reports the unanswerable Country question as the user’s', async () => {
    const { report } = await run();
    // The repair reconciles evidence; it does not turn every mark green.
    expect(outcomeFor(report, 'Country *').status).toBe('USER_CONFIRMATION_REQUIRED');
    expect(markOf('country')).toBe('information_needed');
    expect(value('country')).toBe('');
    expect(isHighlighted(outcomeFor(report, 'Country *').fieldId)).toBe(true);
  });

  it('never clicks the submit control', async () => {
    const { report, submitClicked } = await run();
    expect(submitClicked).toBe(false);
    expect(report.submissionPrevented).toBe(true);
  });
});

/**
 * The reconciliation rule on its own.
 *
 * The end-to-end tests prove it fires on the page that reported the bug; these
 * prove it does not fire on the pages it must not, which no fixture can show as
 * clearly.
 */
describe('reconciling a phone group', () => {
  const control = (
    overrides: Partial<PhoneControlObservation> & Pick<PhoneControlObservation, 'fieldId'>,
  ): PhoneControlObservation => ({
    canonicalKey: 'phone_country_code',
    fieldType: 'combobox',
    selector: `#${overrides.fieldId}`,
    frameId: 0,
    disabled: false,
    optionCount: 0,
    status: 'USER_CONFIRMATION_REQUIRED',
    observedValue: '',
    ...overrides,
  });

  const filledNumber = (observedValue: string): PhoneControlObservation =>
    control({
      fieldId: 'number',
      canonicalKey: 'phone',
      fieldType: 'tel',
      status: 'FILLED_VERIFIED',
      observedValue,
    });

  it('answers a choiceless code control from the verified number beside it', () => {
    const result = reconcilePhoneGroup([
      filledNumber('+19292643117'),
      control({ fieldId: 'code' }),
    ]);
    expect(result.statuses.get('code')).toBe('FILLED_VERIFIED');
    expect(result.satisfiedByCombinedControl).toEqual(['code']);
    expect(result.groupComplete).toBe(true);
  });

  it('reads the country prefix a combined widget renders beside the code', () => {
    const result = reconcilePhoneGroup([
      filledNumber('US +1 (929) 264-3117'),
      control({ fieldId: 'code' }),
    ]);
    expect(result.statuses.get('code')).toBe('FILLED_VERIFIED');
  });

  it('mirrors a number the page already held rather than claiming to have filled it', () => {
    const result = reconcilePhoneGroup([
      control({
        fieldId: 'number',
        canonicalKey: 'phone',
        fieldType: 'tel',
        status: 'SKIPPED_ALREADY_VALID',
        observedValue: '+19292643117',
      }),
      control({ fieldId: 'code' }),
    ]);
    expect(result.statuses.get('code')).toBe('SKIPPED_ALREADY_VALID');
    expect(result.groupComplete).toBe(true);
  });

  it('requires both controls to verify when the page really has two', () => {
    // A dialling-code dropdown with choices on it is a question the user can
    // answer, so it stays theirs until something answers it.
    const result = reconcilePhoneGroup([
      filledNumber('+19292643117'),
      control({ fieldId: 'code', optionCount: 212 }),
    ]);
    expect(result.statuses.size).toBe(0);
    expect(result.groupComplete).toBe(false);
  });

  it('does nothing when the number states no dialling code', () => {
    const result = reconcilePhoneGroup([
      filledNumber('(929) 264-3117'),
      control({ fieldId: 'code' }),
    ]);
    expect(result.statuses.size).toBe(0);
  });

  it('does nothing when the number itself did not verify', () => {
    const result = reconcilePhoneGroup([
      control({
        fieldId: 'number',
        canonicalKey: 'phone',
        fieldType: 'tel',
        status: 'FAILED_EXECUTION',
        observedValue: '+19292643117',
      }),
      control({ fieldId: 'code' }),
    ]);
    expect(result.statuses.size).toBe(0);
    expect(result.groupComplete).toBe(false);
  });

  it('never overwrites a failure or a block with a verification', () => {
    for (const status of ['FAILED_EXECUTION', 'BLOCKED'] as const) {
      const result = reconcilePhoneGroup([
        filledNumber('+19292643117'),
        control({ fieldId: 'code', status }),
      ]);
      expect(result.statuses.size, status).toBe(0);
    }
  });

  it('never crosses a frame boundary', () => {
    const result = reconcilePhoneGroup([
      filledNumber('+19292643117'),
      control({ fieldId: 'code', frameId: 3 }),
    ]);
    expect(result.statuses.size).toBe(0);
  });

  it('holds the group open while the phone type is still outstanding', () => {
    const result = reconcilePhoneGroup([
      filledNumber('+19292643117'),
      control({ fieldId: 'code' }),
      control({ fieldId: 'type', canonicalKey: 'phone_type', fieldType: 'select', optionCount: 4 }),
    ]);
    expect(result.statuses.get('code')).toBe('FILLED_VERIFIED');
    expect(result.groupComplete).toBe(false);
  });

  it('leaves every question that is not a phone control alone', () => {
    const result = reconcilePhoneGroup([
      filledNumber('+19292643117'),
      control({ fieldId: 'country', canonicalKey: 'country', fieldType: 'select', optionCount: 4 }),
    ]);
    expect(result.statuses.size).toBe(0);
  });
});

describe('stating a dialling code', () => {
  it('recognises a code however the control spells it', () => {
    expect(carriesDialCode('+19292643117')).toBe(true);
    expect(carriesDialCode('+1 929 264 3117')).toBe(true);
    expect(carriesDialCode('US +1 (929) 264-3117')).toBe(true);
    expect(carriesDialCode(' +44 20 7946 0958')).toBe(true);
  });

  it('does not read a local number as one', () => {
    expect(carriesDialCode('(929) 264-3117')).toBe(false);
    expect(carriesDialCode('9292643117')).toBe(false);
    expect(carriesDialCode('')).toBe(false);
    expect(carriesDialCode('Mobile')).toBe(false);
  });
});
