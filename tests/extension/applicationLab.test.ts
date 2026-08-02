import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNormalizedQuestions,
  type CanonicalQuestion,
  type DetectedField,
} from '@internship-agent/shared';
import { observeFormMutations, scanDom } from '../../extension/src/scanner/domScanner.js';
import { classifyUploadField } from '../../extension/src/uploads/bundleUploads.js';
import { isFinalSubmitControl } from '../../extension/src/scanner/adapters.js';

/**
 * The local application laboratory.
 *
 * Each fixture is a realistic application page whose questions are worded the
 * way employers word them, not the way the profile schema names them. The point
 * is coverage against real markup, so these assert what was *found*, not that a
 * function returned without throwing.
 */

function lab(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'lab', name), 'utf8');
}

/**
 * Loads a fixture and runs its scripts.
 *
 * Assigning `innerHTML` does not execute `<script>`, and the dynamic fixtures
 * are only interesting *because* of their scripts — without this the page would
 * be inert and the mutation tests would pass by never mutating anything.
 */
function load(name: string): void {
  document.documentElement.innerHTML = lab(name).replace(/<!doctype html>/i, '');
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const source = script.textContent ?? '';
    if (!source.trim()) continue;
    // The fixture is a file in this repository and its script is the
    // behaviour under test; jsdom does not run a script inserted via innerHTML.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('document', 'window', source)(document, window);
  }
}

async function scan(name: string): Promise<DetectedField[]> {
  load(name);
  const controller = new AbortController();
  const result = await scanDom(document, 'page-lab', controller.signal);
  return result.fields;
}

function labelsOf(fields: readonly DetectedField[]): string[] {
  return fields.map((field) => field.label);
}

function intentsOf(fields: readonly DetectedField[]): CanonicalQuestion[] {
  return buildNormalizedQuestions(fields).map((question) => question.likelyIntent);
}

describe('lab: a plain HTML application', () => {
  it('finds every answerable question and recognizes what each one asks', async () => {
    const fields = await scan('native-application.html');
    const intents = intentsOf(fields);

    for (const expected of [
      'first_name',
      'last_name',
      'preferred_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'state',
      'postal_code',
      'school',
      'major',
      'gpa',
      'graduation_month',
      'linkedin',
      'github',
      'website',
      'work_authorization',
      'sponsorship_required',
      'earliest_start_date',
      'willing_to_relocate',
      'resume',
      'cover_letter',
      'transcript',
    ] satisfies CanonicalQuestion[]) {
      expect(intents, `expected to recognize ${expected}`).toContain(expected);
    }
  });

  it('recognizes reworded eligibility questions as the saved facts they are', async () => {
    const fields = await scan('native-application.html');
    const auth = fields.find((field) => field.label.includes('permission to work'));
    const sponsor = fields.find((field) => field.label.includes('sponsor your employment'));
    expect(auth?.canonicalKey).toBe('work_authorization');
    expect(sponsor?.canonicalKey).toBe('sponsorship_required');
  });

  it('never reports the honeypot or the disabled control as answerable', async () => {
    const fields = await scan('native-application.html');
    expect(labelsOf(fields)).not.toContain('Leave this blank');
    expect(labelsOf(fields)).not.toContain('Employee referral code');
  });

  it('does not treat a placeholder as the question', async () => {
    const fields = await scan('native-application.html');
    const website = fields.find((field) => field.label === 'Personal website');
    expect(website).toBeDefined();
    expect(labelsOf(fields)).not.toContain('https://');
    expect(labelsOf(fields)).not.toContain('e.g. Jo');
  });

  it('tells the three uploads apart', async () => {
    const fields = await scan('native-application.html');
    const uploads = fields.filter((field) => field.fieldType === 'file');
    expect(uploads).toHaveLength(3);
    expect(uploads.map(classifyUploadField).sort()).toEqual([
      'cover_letter',
      'resume',
      'transcript',
    ]);
  });

  it('refuses the submit control and allows the save-draft control', () => {
    expect(isFinalSubmitControl('generic', 'Submit application')).toBe(true);
    expect(isFinalSubmitControl('generic', 'Save draft')).toBe(false);
  });
});

describe('lab: controls that are not inputs', () => {
  it('finds the ARIA combobox, the trigger button, React Select, and contenteditable', async () => {
    const fields = await scan('custom-controls.html');
    const labels = labelsOf(fields);

    expect(labels).toContain('Country of residence');
    expect(labels).toContain('Highest level of study completed');
    expect(labels).toContain('How did you come across this opening?');
    expect(labels).toContain('Phone country code');
    expect(labels).toContain('When are you available to start?');
    expect(labels).toContain('In a few sentences, why does this role interest you?');
  });

  it('reads the options a collapsed combobox already carries', async () => {
    const fields = await scan('custom-controls.html');
    const country = fields.find((field) => field.label === 'Country of residence');
    expect(country?.fieldType).toBe('combobox');
    expect(country?.options?.map((option) => option.label)).toEqual([
      'United States of America',
      'Canada',
      'United Kingdom',
    ]);
  });

  it('reads the options behind a menu trigger button', async () => {
    const fields = await scan('custom-controls.html');
    const degree = fields.find((field) => field.label === 'Highest level of study completed');
    expect(degree?.options?.map((option) => option.label)).toContain("Bachelor's Degree");
  });

  it('reports the React Select root once, not the root plus its search box', async () => {
    const fields = await scan('custom-controls.html');
    const matching = fields.filter(
      (field) => field.label === 'How did you come across this opening?',
    );
    expect(matching).toHaveLength(1);
  });

  it('keeps the phone country code separate from the phone number', async () => {
    const fields = await scan('custom-controls.html');
    expect(fields.find((field) => field.label === 'Phone country code')?.canonicalKey).toBe(
      'phone_country_code',
    );
    expect(fields.find((field) => field.label === 'Phone number')?.canonicalKey).toBe('phone');
  });
});

describe('lab: protected characteristics and open questions', () => {
  it('collapses each radio group into one question carrying its options', async () => {
    const fields = await scan('sensitive-and-custom.html');
    const gender = fields.filter((field) => field.canonicalKey === 'gender');
    expect(gender).toHaveLength(1);
    expect(gender[0]!.fieldType).toBe('radio');
    expect(gender[0]!.options).toHaveLength(4);
  });

  it('marks every protected question with a sensitive category', async () => {
    const questions = buildNormalizedQuestions(await scan('sensitive-and-custom.html'));
    const sensitive = new Map(
      questions.map((question) => [question.likelyIntent, question.sensitiveCategory]),
    );
    expect(sensitive.get('gender')).toBe('gender');
    expect(sensitive.get('race_ethnicity')).toBe('ethnicity');
    expect(sensitive.get('hispanic_latino')).toBe('ethnicity');
    expect(sensitive.get('veteran_status')).toBe('veteran_status');
    expect(sensitive.get('disability_status')).toBe('disability');
    expect(sensitive.get('sexual_orientation')).toBe('sexual_orientation');
    expect(sensitive.get('salary_expectation')).toBe('salary_expectation');
    expect(sensitive.get('security_clearance')).toBe('security_clearance');
  });

  it('captures every differently worded decline option', async () => {
    const fields = await scan('sensitive-and-custom.html');
    const declines = fields
      .flatMap((field) => field.options ?? [])
      .map((option) => option.label)
      .filter((label) => /wish|decline|prefer not|choose not/i.test(label));
    expect(declines).toEqual(
      expect.arrayContaining([
        'I do not wish to answer',
        'Decline to self-identify',
        'Prefer not to disclose',
        'I choose not to answer',
        "I don't wish to answer",
        'Prefer not to say',
      ]),
    );
  });

  it('recognizes the open-ended questions it is expected to answer', async () => {
    const intents = intentsOf(await scan('sensitive-and-custom.html'));
    expect(intents).toContain('why_this_company');
    expect(intents).toContain('challenge');
    expect(intents).toContain('technical_skills');
  });

  it('reports a genuinely unrecognizable question as unknown rather than guessing', async () => {
    const questions = buildNormalizedQuestions(await scan('sensitive-and-custom.html'));
    const sandwich = questions.find((question) =>
      question.questionText.includes('favourite type of sandwich'),
    );
    expect(sandwich?.likelyIntent).toBe('unknown');
  });

  it('finds both legal attestations', async () => {
    const fields = await scan('sensitive-and-custom.html');
    const attestations = fields.filter(
      (field) => field.fieldType === 'checkbox' && /certify|agree to the terms/i.test(field.label),
    );
    expect(attestations).toHaveLength(2);
  });

  it('refuses "Send application" as a final submission', () => {
    expect(isFinalSubmitControl('generic', 'Send application')).toBe(true);
  });
});

describe('lab: a Workday step', () => {
  it('reads labels from the automation-id containers, not from label[for]', async () => {
    const fields = await scan('workday-step.html');
    const labels = labelsOf(fields);
    expect(labels).toContain('First Name');
    expect(labels).toContain('Last Name');
    expect(labels).toContain('City');
    expect(labels).toContain('Phone Number');
  });

  it('recognizes the Workday wording of the eligibility questions', async () => {
    const fields = await scan('workday-step.html');
    const intents = intentsOf(fields);
    expect(intents).toContain('work_authorization');
    expect(intents).toContain('sponsorship_required');
  });

  it('surfaces the validation message on the field it belongs to', async () => {
    const fields = await scan('workday-step.html');
    const phone = fields.find((field) => field.label === 'Phone Number');
    expect(phone?.validationText).toContain('required');
  });

  it('reads the upload instructions beside the file input', async () => {
    const fields = await scan('workday-step.html');
    const upload = fields.find((field) => field.fieldType === 'file');
    expect(classifyUploadField(upload!)).toBe('resume');
    expect(String(upload!.metadata.uploadInstructions)).toContain('PDF');
  });

  it('treats Save and Continue as navigation, not submission', () => {
    expect(isFinalSubmitControl('workday', 'Save and Continue')).toBe(false);
    expect(isFinalSubmitControl('workday', 'Submit application')).toBe(true);
  });
});

describe('lab: sections that appear later', () => {
  it('sees only the first education entry before anything is clicked', async () => {
    const fields = await scan('dynamic-sections.html');
    expect(fields.filter((field) => field.label.startsWith('School'))).toHaveLength(1);
    expect(fields.filter((field) => field.label.startsWith('Employer'))).toHaveLength(0);
  });

  it('finds the added education and experience groups on a rescan', async () => {
    load('dynamic-sections.html');
    document.getElementById('add-education')!.dispatchEvent(new Event('click'));
    document.getElementById('add-experience')!.dispatchEvent(new Event('click'));

    const controller = new AbortController();
    const result = await scanDom(document, 'page-lab', controller.signal);
    const labels = labelsOf(result.fields);
    expect(labels.filter((label) => label.startsWith('School'))).toHaveLength(2);
    expect(labels.filter((label) => label.startsWith('Employer'))).toHaveLength(1);
  });

  it('finds the dependent region control the country choice revealed', async () => {
    load('dynamic-sections.html');
    const country = document.getElementById('country') as HTMLSelectElement;
    country.value = 'us';
    country.dispatchEvent(new Event('change'));

    const controller = new AbortController();
    const result = await scanDom(document, 'page-lab', controller.signal);
    const region = result.fields.find((field) => field.label === 'State');
    expect(region).toBeDefined();
    expect(region?.options?.map((option) => option.label)).toContain('New Jersey');
  });

  it('notifies once for a burst of new controls rather than once per control', async () => {
    load('dynamic-sections.html');
    let notifications = 0;
    const observer = observeFormMutations(document, () => (notifications += 1), {
      debounceMs: 10,
      minimumIntervalMs: 0,
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        document.getElementById('add-education')!.dispatchEvent(new Event('click'));
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(notifications).toBe(1);
    } finally {
      observer.stop();
    }
  });

  it('ignores mutations that add no answerable control', async () => {
    load('dynamic-sections.html');
    let notifications = 0;
    const observer = observeFormMutations(document, () => (notifications += 1), {
      debounceMs: 10,
      minimumIntervalMs: 0,
    });
    try {
      document.body.append(document.createElement('p'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(notifications).toBe(0);
    } finally {
      observer.stop();
    }
  });
});
