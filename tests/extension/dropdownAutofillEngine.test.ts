import { afterEach, describe, expect, it } from 'vitest';
import {
  aliasesFor,
  aliasesMatch,
  aliasGroupFor,
  dropdownDirectiveSchema,
  resolveIntendedAnswer,
  summarizeDropdownRun,
  toDropdownEngineTrace,
  type DropdownDirective,
  type DropdownRunResult,
  type Profile,
} from '@internship-agent/shared';
import {
  resetDropdownRegistry,
  scanDropdowns,
} from '../../extension/src/dropdown/dropdownScanner.js';
import { resolveDropdownQuestion } from '../../extension/src/dropdown/dropdownQuestionResolver.js';
import { matchIntendedAnswer } from '../../extension/src/dropdown/dropdownMatcher.js';
import { runDropdownDirectives } from '../../extension/src/dropdown/dropdownEngine.js';

/**
 * The Dropdown Autofill Engine, module by module.
 *
 * The e2e suite proves the whole pass through the built extension; this proves
 * the decisions inside it, and especially the ones it must *refuse* to make.
 * Roughly half of what follows asserts that nothing was chosen — a wrong answer
 * on an application is worse in kind than an unanswered question, so "it left
 * this alone" is the behaviour under test, not the absence of behaviour.
 */

afterEach(() => {
  document.body.innerHTML = '';
  resetDropdownRegistry();
});

/** jsdom reports zero-size rects, so visibility checks would reject everything. */
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 120,
    height: 32,
    top: 0,
    left: 0,
    right: 120,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    version: 3,
    id: 'primary',
    personal: {
      legalFirstName: 'Robin',
      legalLastName: 'Vale',
      phoneType: 'mobile',
      address: {
        city: 'Clifton',
        state: 'New Jersey',
        country: 'United States',
        type: 'home',
      },
    },
    education: [
      {
        id: 'education-1',
        institution: 'Rutgers University',
        degree: "Bachelor's Degree",
        major: 'Electrical Engineering',
        status: 'in_progress',
        coursework: [],
        honors: [],
        activities: [],
      },
    ],
    experience: [
      {
        id: 'experience-1',
        employer: 'Northwind Robotics',
        current: false,
        employmentType: 'Freelance',
        responsibilities: [],
        achievements: [],
      },
    ],
    projects: [],
    certifications: [],
    volunteering: [],
    organizations: [],
    activities: [],
    skills: {},
    eligibility: {},
    preferences: { targetRoles: [], industries: [], preferredLocations: [] },
    documents: {},
    sensitivePolicies: [],
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  } as Profile;
}

function resolve(
  canonicalQuestion: Parameters<typeof resolveIntendedAnswer>[0]['canonicalQuestion'],
  label: string,
  overrides: Partial<Parameters<typeof resolveIntendedAnswer>[0]> = {},
) {
  return resolveIntendedAnswer({
    canonicalQuestion,
    label,
    sectionContext: '',
    profile: profile(),
    approvedAnswers: [],
    companyName: 'Quanta Robotics',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
describe('discovery finds option controls without asking the planner', () => {
  it('finds native selects, ARIA comboboxes and button menus alike', () => {
    document.body.innerHTML = `
      <label for="state">State/Province</label>
      <select id="state"><option value="">Select…</option><option value="NJ">NJ</option></select>
      <label id="typeLabel">Employment Type</label>
      <div id="type" role="combobox" aria-haspopup="listbox" aria-labelledby="typeLabel"></div>
      <label id="countryLabel">Country</label>
      <button id="country" aria-haspopup="listbox" aria-labelledby="countryLabel"></button>
    `;
    const found = scanDropdowns(document);
    expect(found.map((entry) => entry.descriptor.controlStrategy).sort()).toEqual([
      'aria_combobox',
      'aria_combobox',
      'native_select',
    ]);
  });

  it('never mistakes a text box for a dropdown, whatever it calls itself', () => {
    // The live failure this prevents: an ATS renders "Legal First Name" as
    // `input[role=combobox]`, and opening a menu over it is how a name ends up
    // matched against a list of countries.
    document.body.innerHTML = `
      <label for="firstName">Legal First Name</label>
      <input id="firstName" type="text" role="combobox" />
    `;
    expect(scanDropdowns(document)).toEqual([]);
  });

  it('leaves the extension’s own controls alone', () => {
    document.body.innerHTML = `
      <div data-internship-agent-owned="true">
        <select id="ours"><option>One</option></select>
      </div>
    `;
    expect(scanDropdowns(document)).toEqual([]);
  });

  it('does not treat another control’s popup as a question of its own', () => {
    // A searchable combobox renders its results into a listbox beside it. That
    // list is the answer surface of the question next to it, and discovering it
    // separately invented a question out of the nearest heading.
    document.body.innerHTML = `
      <label for="school">School</label>
      <input id="school" role="combobox" aria-autocomplete="list" aria-controls="schoolList" />
      <ul id="schoolList" role="listbox"></ul>
    `;
    const found = scanDropdowns(document);
    expect(found).toHaveLength(1);
    expect(found[0]!.descriptor.controlStrategy).toBe('searchable_combobox');
  });

  it('reads the control’s own state rather than assuming it is empty', () => {
    document.body.innerHTML = `
      <label for="state">State</label>
      <select id="state"><option value="NJ" selected>New Jersey</option></select>
    `;
    expect(scanDropdowns(document)[0]!.descriptor.currentValue).toBe('New Jersey');
  });

  it('describes a control the same way the scan addresses it', () => {
    document.body.innerHTML = `<label for="state">State</label><select id="state"></select>`;
    expect(scanDropdowns(document)[0]!.descriptor.selector).toBe('#state');
  });

  it('records which repeated block a control belongs to', () => {
    document.body.innerHTML = `
      <fieldset><label id="a">Area of Study</label>
        <div role="combobox" aria-haspopup="listbox" aria-labelledby="a"></div></fieldset>
      <fieldset><label id="b">Area of Study</label>
        <div role="combobox" aria-haspopup="listbox" aria-labelledby="b"></div></fieldset>
    `;
    const found = scanDropdowns(document);
    expect(found.map((entry) => entry.descriptor.recordIndex)).toEqual([undefined, 1]);
  });
});

// ---------------------------------------------------------------------------
describe('the question is understood before the control is opened', () => {
  const ask = (label: string, sectionContext = '') =>
    resolveDropdownQuestion({
      dropdownId: 'dropdown-1',
      frameId: 0,
      label,
      selector: '#x',
      sectionContext,
      required: true,
      controlStrategy: 'native_select',
      currentValue: '',
      disabled: false,
      dependencyState: 'independent',
    });

  it.each([
    ['State/Province', 'state'],
    ['Education Country', 'country'],
    ['Area of Study', 'major'],
    ['Graduated?', 'graduated'],
    ['Employment Type', 'employment_type'],
    ['Will you require sponsorship?', 'sponsorship_required'],
    ['Phone Type', 'phone_type'],
  ])('reads "%s" as %s', (label, expected) => {
    expect(ask(label).canonicalQuestion).toBe(expected);
  });

  it('uses the section to tell two identically worded questions apart', () => {
    // "Country" under Education and "Country" under Home Address are the same
    // eight characters, and a form routinely asks both.
    expect(ask('Country', 'Education').canonicalQuestion).toBe('country');
    expect(ask('Country', 'Home Address').canonicalQuestion).toBe('country');
  });

  it('says it does not know, rather than guessing', () => {
    expect(ask('Widget flange preference').canonicalQuestion).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
describe('intended answers come from saved facts, or from nobody', () => {
  it('restates a profile fact', () => {
    const answer = resolve('state', 'State/Province');
    expect(answer.intendedAnswer).toBe('New Jersey');
    expect(answer.source).toBe('profile_fact');
    expect(answer.requiresUserConfirmation).toBe(false);
  });

  it('offers the aliases of that fact, so a form may word it differently', () => {
    expect(resolve('country', 'Country').alternativeValues).toContain('United States of America');
  });

  it('answers "Graduated?" from a stored status and never from an absent one', () => {
    expect(resolve('graduated', 'Graduated?').intendedAnswer).toBe('No');

    const undecided = profile({
      education: [
        {
          id: 'education-1',
          institution: 'Rutgers University',
          coursework: [],
          honors: [],
          activities: [],
        },
      ],
    });
    // An absent status means the applicant has not said, which is not the same
    // as "not graduated" and must stay different.
    const answer = resolve('graduated', 'Graduated?', { profile: undecided });
    expect(answer.requiresUserConfirmation).toBe(true);
    expect(answer.intendedAnswer).toBe('');
  });

  it('never answers "highest degree awarded" with a degree in progress', () => {
    // Overstating a qualification is a misrepresentation, not a rounding.
    expect(resolve('highest_degree_awarded', 'Highest Level of Education').intendedAnswer).toBe('');
  });

  it('reads Employment Type from the record and not from the employer’s name', () => {
    expect(resolve('employment_type', 'Employment Type').intendedAnswer).toBe('Freelance');
  });

  it('will not invent a reason for leaving', () => {
    const answer = resolve('reason_for_leaving', 'Reason for Leaving');
    expect(answer.requiresUserConfirmation).toBe(true);
    expect(answer.source).toBe('none');
  });

  it('offers both readings of "Education Type", and lets the form choose', () => {
    const answer = resolve('education_type', 'Education Type');
    expect(answer.intendedAnswer).toBe('College/University');
    expect(answer.alternativeValues).toContain("Bachelor's Degree");
  });

  it('answers a second education block from the second education record', () => {
    const two = profile({
      education: [
        {
          id: 'education-1',
          institution: 'Rutgers University',
          major: 'Electrical Engineering',
          status: 'in_progress',
          coursework: [],
          honors: [],
          activities: [],
        },
        {
          id: 'education-2',
          institution: 'Clifton High School',
          major: 'General Studies',
          status: 'completed',
          coursework: [],
          honors: [],
          activities: [],
        },
      ],
    });
    expect(resolve('major', 'Area of Study', { profile: two, recordIndex: 1 }).intendedAnswer).toBe(
      'General Studies',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the answers it refuses to produce', () => {
  it('will not infer a protected characteristic', () => {
    const answer = resolve('gender', 'Gender');
    expect(answer.requiresUserConfirmation).toBe(true);
    expect(answer.sensitive).toBe(true);
    expect(answer.intendedAnswer).toBe('');
  });

  it('reaches a decline-to-answer wording only from a saved preference', () => {
    const declined = profile({
      sensitivePolicies: [{ category: 'gender', policy: 'decline_to_answer' }],
    });
    const answer = resolve('gender', 'Gender', { profile: declined });
    // A statement about disclosure, not about identity.
    expect(answer.intendedAnswer).toBe('Decline to answer');
    expect(answer.source).toBe('saved_preference');
  });

  it('will not answer sponsorship or work authorization without a stored fact', () => {
    for (const question of ['sponsorship_required', 'citizenship'] as const) {
      expect(resolve(question, 'Do you require sponsorship?').requiresUserConfirmation).toBe(true);
    }
  });

  it('will not decide whether the applicant worked here before', () => {
    // The résumé's silence about this employer is evidence about a document,
    // not about the applicant's history.
    const answer = resolve('previously_employed', 'Have you worked for this company?');
    expect(answer.requiresUserConfirmation).toBe(true);
    expect(answer.confirmationPrompt).toContain('Quanta Robotics');
  });

  it('answers an employer question once the fact has been saved for that employer', () => {
    const answer = resolve('previously_employed', 'Have you worked for this company?', {
      companyRelationship: {
        companyKey: 'quanta-robotics',
        companyName: 'Quanta Robotics',
        previouslyEmployed: true,
      },
    });
    expect(answer.intendedAnswer).toBe('Yes');
    expect(answer.source).toBe('employer_fact');
  });

  it('ignores an approved answer the user did not authorise for filling', () => {
    const answer = resolve('reason_for_leaving', 'Reason for Leaving', {
      approvedAnswers: [
        {
          id: 'answer-1',
          canonicalQuestion: 'Reason for Leaving',
          aliases: [],
          answerType: 'text',
          answer: 'Returned to school',
          category: 'experience',
          approved: true,
          autoFillAllowed: false,
          sensitive: false,
          tailoringAllowed: false,
          requiresReview: false,
          lastUpdatedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    });
    expect(answer.requiresUserConfirmation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the alias library', () => {
  it('treats documented spellings of one answer as the same answer', () => {
    expect(aliasesMatch('United States', 'United States of America')).toBe(true);
    expect(aliasesMatch('New Jersey', 'NJ')).toBe(true);
    expect(aliasesMatch('Freelance', 'Self-Employed')).toBe(true);
    expect(aliasesMatch('Mobile', 'Cell')).toBe(true);
  });

  it('refuses aliases that would change what the answer means', () => {
    // A form offering both is asking a distinction the applicant answered.
    expect(aliasesMatch('Freelance', 'Contractor')).toBe(false);
    expect(aliasesMatch('Yes', 'No')).toBe(false);
    expect(aliasesMatch('Bachelor', "Master's")).toBe(false);
    expect(aliasesMatch('Home', 'Work')).toBe(false);
  });

  it('leaves a term it has never heard of alone', () => {
    expect(aliasGroupFor('Quantum Basketweaving')).toBeUndefined();
    expect(aliasesFor('Quantum Basketweaving')).toEqual(['Quantum Basketweaving']);
  });
});

// ---------------------------------------------------------------------------
describe('matching the answer to what the control offers', () => {
  const directive = (overrides: Partial<DropdownDirective> = {}): DropdownDirective =>
    dropdownDirectiveSchema.parse({
      dropdownId: 'dropdown-1',
      canonicalQuestion: 'state',
      intendedAnswer: 'New Jersey',
      intendedAnswerSource: 'profile_fact',
      ...overrides,
    });

  const options = (...labels: string[]) =>
    labels.map((label, index) => ({
      optionId: `option-${index}`,
      displayedText: label,
      value: label,
      disabled: false,
      selected: false,
      normalizedText: label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim(),
    }));

  it('prefers the page’s own wording', () => {
    const match = matchIntendedAnswer(directive(), options('New York', 'New Jersey', 'Ohio'));
    expect(match.option?.displayedText).toBe('New Jersey');
    expect(match.method).toBe('literal');
  });

  it('reaches an abbreviation through the alias table', () => {
    const match = matchIntendedAnswer(directive(), options('NY', 'NJ', 'PA'));
    expect(match.option?.displayedText).toBe('NJ');
  });

  it('reaches a longer official name', () => {
    const match = matchIntendedAnswer(
      directive({ canonicalQuestion: 'country', intendedAnswer: 'United States' }),
      options('Canada', 'Mexico', 'United States of America'),
    );
    expect(match.option?.displayedText).toBe('United States of America');
  });

  it('reaches the arrangement the form happens to name differently', () => {
    const match = matchIntendedAnswer(
      directive({ canonicalQuestion: 'employment_type', intendedAnswer: 'Freelance' }),
      options('Full-Time', 'Part-Time', 'Contractor', 'Self-Employed'),
    );
    expect(match.option?.displayedText).toBe('Self-Employed');
  });

  it('tries a documented alternative wording when the first misses', () => {
    const match = matchIntendedAnswer(
      directive({
        canonicalQuestion: 'education_type',
        intendedAnswer: 'College/University',
        alternativeValues: ["Bachelor's Degree"],
      }),
      options('Associate', "Bachelor's Degree", "Master's"),
    );
    expect(match.option?.displayedText).toBe("Bachelor's Degree");
  });

  it('chooses nothing when the answer is genuinely not on the list', () => {
    const match = matchIntendedAnswer(
      directive({ canonicalQuestion: 'country', intendedAnswer: 'United States' }),
      options('Canada', 'Mexico', 'Brazil'),
    );
    expect(match.option).toBeUndefined();
  });

  it('never selects a disabled option', () => {
    const list = options('New Jersey', 'New York');
    list[0]!.disabled = true;
    expect(matchIntendedAnswer(directive(), list).option?.displayedText).not.toBe('New Jersey');
  });

  it('does not fall through to "Other" unless the caller allows it', () => {
    const list = options('Canada', 'Mexico', 'Other');
    expect(
      matchIntendedAnswer(
        directive({ canonicalQuestion: 'country', intendedAnswer: 'United States' }),
        list,
      ).option,
    ).toBeUndefined();
    expect(
      matchIntendedAnswer(
        directive({
          canonicalQuestion: 'how_did_you_hear',
          intendedAnswer: 'A friend’s cousin',
          allowOtherFallback: true,
        }),
        list,
      ).option?.displayedText,
    ).toBe('Other');
  });
});

// ---------------------------------------------------------------------------
describe('driving a control, and proving it took', () => {
  const directive = (overrides: Partial<DropdownDirective> = {}): DropdownDirective =>
    dropdownDirectiveSchema.parse({
      dropdownId: 'dropdown-1',
      canonicalQuestion: 'state',
      intendedAnswer: 'New Jersey',
      intendedAnswerSource: 'profile_fact',
      ...overrides,
    });

  const only = (): string => scanDropdowns(document)[0]!.descriptor.dropdownId;

  it('selects in a native select and verifies against the control’s own state', async () => {
    document.body.innerHTML = `
      <label for="state">State</label>
      <select id="state">
        <option value="">Select…</option><option value="NJ">New Jersey</option>
      </select>`;
    const [result] = await runDropdownDirectives([directive({ dropdownId: only() })]);
    expect(result!.finalStatus).toBe('FILLED_VERIFIED');
    expect(result!.verified).toBe(true);
    expect(result!.matchedOption).toBe('New Jersey');
    expect(document.querySelector<HTMLSelectElement>('#state')!.value).toBe('NJ');
  });

  it('leaves a control that already holds the answer completely alone', async () => {
    // Re-selecting a value fires `change`, and a page that rebuilds a dependent
    // list on that event discards the answer chosen moments earlier.
    document.body.innerHTML = `
      <label for="state">State</label>
      <select id="state"><option value="NJ" selected>New Jersey</option></select>`;
    const [result] = await runDropdownDirectives([directive({ dropdownId: only() })]);
    expect(result!.finalStatus).toBe('SKIPPED_ALREADY_VALID');
    expect(result!.selected).toBe(false);
    expect(result!.verified).toBe(true);
  });

  it('reports a disabled dependent control as blocked, not as a failure', async () => {
    document.body.innerHTML = `
      <label for="state">State</label>
      <select id="state" disabled data-depends-on="country"></select>`;
    const [result] = await runDropdownDirectives([directive({ dropdownId: only() })]);
    expect(result!.finalStatus).toBe('BLOCKED');
    expect(result!.errorCode).toBe('CONTROL_DISABLED');
  });

  it('opens a control it cannot answer, records the choices, and selects nothing', async () => {
    document.body.innerHTML = `
      <label for="worked">Have you worked here before?</label>
      <select id="worked">
        <option value="">Select…</option><option value="y">Yes</option><option value="n">No</option>
      </select>`;
    const [result] = await runDropdownDirectives([
      directive({
        dropdownId: only(),
        canonicalQuestion: 'previously_employed',
        intendedAnswer: '',
        intendedAnswerSource: 'none',
        requiresUserConfirmation: true,
        confirmationPrompt: 'Only you know this.',
      }),
    ]);
    expect(result!.finalStatus).toBe('USER_CONFIRMATION_REQUIRED');
    expect(result!.selected).toBe(false);
    // The choices travel with the question, so the applicant answers rather
    // than hunting for the control.
    expect(result!.availableOptions.map((option) => option.displayedText)).toEqual(['Yes', 'No']);
    expect(document.querySelector<HTMLSelectElement>('#worked')!.value).toBe('');
  });

  it('hands back a control whose list does not offer the answer', async () => {
    document.body.innerHTML = `
      <label for="state">State</label>
      <select id="state"><option value="">Select…</option><option value="TX">Texas</option></select>`;
    const [result] = await runDropdownDirectives([directive({ dropdownId: only() })]);
    expect(result!.finalStatus).toBe('USER_CONFIRMATION_REQUIRED');
    expect(result!.errorCode).toBe('OPTION_NOT_FOUND');
    expect(result!.optionsFound).toBe(1);
  });

  it('always returns a record, even for a control that has left the page', async () => {
    document.body.innerHTML = `<label for="state">State</label><select id="state"></select>`;
    const id = only();
    document.body.innerHTML = '';
    const [result] = await runDropdownDirectives([directive({ dropdownId: id })]);
    // A dropdown missing from the results is indistinguishable from one that
    // was never on the form, and that is how a half-filled page looks complete.
    expect(result!.finalStatus).toBe('BLOCKED');
    expect(result!.errorCode).toBe('CONTROL_NOT_FOUND');
  });

  it('one control’s trouble does not stop the next', async () => {
    document.body.innerHTML = `
      <label for="gone">State</label><select id="gone"></select>
      <label for="state">State</label>
      <select id="state"><option value="">Select…</option><option value="NJ">New Jersey</option></select>`;
    const ids = scanDropdowns(document).map((entry) => entry.descriptor.dropdownId);
    const results = await runDropdownDirectives(ids.map((id) => directive({ dropdownId: id })));
    expect(results).toHaveLength(2);
    expect(results[1]!.finalStatus).toBe('FILLED_VERIFIED');
  });
});

// ---------------------------------------------------------------------------
describe('what a diagnostic is allowed to say', () => {
  const result = (overrides: Partial<DropdownRunResult> = {}): DropdownRunResult => ({
    dropdownId: 'dropdown-1',
    frameId: 0,
    question: 'State/Province',
    selector: '#state',
    canonicalQuestion: 'state',
    controlStrategy: 'native_select',
    intendedAnswerSource: 'profile_fact',
    intendedAnswerResolved: true,
    optionsFound: 51,
    matchedOption: 'New Jersey',
    opened: true,
    scrolled: true,
    selected: true,
    verified: true,
    finalStatus: 'FILLED_VERIFIED',
    reason: 'Selected "New Jersey".',
    durationMs: 12,
    availableOptions: [],
    mayHaveEnabledDependents: true,
    ...overrides,
  });

  it('keeps the stages and drops every trace of the answer', () => {
    const trace = toDropdownEngineTrace(result());
    expect(trace.optionsFound).toBe(51);
    expect(trace.scrolled).toBe(true);
    expect(trace.finalStatus).toBe('FILLED_VERIFIED');
    // The question is the page's own words; the answer is the applicant's.
    expect(JSON.stringify(trace)).not.toContain('New Jersey');
  });

  it('counts the pass by outcome', () => {
    const summary = summarizeDropdownRun(
      [
        result(),
        result({ finalStatus: 'USER_CONFIRMATION_REQUIRED', selected: false, verified: false }),
        result({ finalStatus: 'BLOCKED', selected: false, verified: false }),
      ],
      120,
    );
    expect(summary).toMatchObject({
      discovered: 3,
      selected: 1,
      verified: 1,
      awaitingUser: 1,
      blocked: 1,
    });
  });
});
