import { describe, expect, it } from 'vitest';
import {
  ACTIVATED_BY_ANY_ANSWER,
  describesThirdPartyDetails,
  matchCanonicalQuestion,
} from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { conditionalGateFor } from '../../extension/src/planner/deterministicPlanner.js';

/**
 * The worst thing this project has done to a real application, pinned shut.
 *
 * Lincoln Electric asks, in these exact words:
 *
 *     Do you have any relatives, including those by marriage, employed by our
 *     Company?
 *
 * and beneath it:
 *
 *     If you have any relatives currently employed, provide their full name,
 *     location and your relationship to them.
 *
 * On the live run the parent was left on "No Selection" and the child was
 * filled with the applicant's own legal name. The submitted form then told an
 * employer that the applicant has a relative working there, and named them.
 * That is a false statement about a third party, and it is categorically worse
 * than any field left blank.
 *
 * Two protections existed and both missed:
 *
 *  - the conditional-child link requires a label beginning "If yes" / "If
 *    other". Lincoln's begins "If you have any relatives currently employed,",
 *    so no link was made and the executor's gate had nothing to enforce;
 *  - the intent matcher scored the label as `full_name` at confidence 1.0,
 *    because it contains the words "full name".
 *
 * Every test below covers one of the four repairs, and each is written so that
 * it fails if that repair alone is reverted.
 */

const PARENT_LABEL =
  'Do you have any relatives, including those by marriage, employed by our Company?';
const CHILD_LABEL =
  'If you have any relatives currently employed, provide their full name, location and your relationship to them.';

/** The Lincoln pair, in the shape the page renders it. */
function mountLincolnRelatives(parentValue = ''): void {
  document.body.innerHTML = `
    <form>
      <label for="relatives">${PARENT_LABEL}</label>
      <select id="relatives" name="relatives">
        <option value="" ${parentValue ? '' : 'selected'}>No Selection</option>
        <option value="yes" ${parentValue === 'yes' ? 'selected' : ''}>Yes</option>
        <option value="no" ${parentValue === 'no' ? 'selected' : ''}>No</option>
      </select>
      <label for="relativeDetails">${CHILD_LABEL}</label>
      <textarea id="relativeDetails" name="relativeDetails"></textarea>
    </form>`;
}

async function scan() {
  return scanDom(document, 'page-relatives', new AbortController().signal);
}

// ---------------------------------------------------------------------------
describe('the intent matcher never reads this as the applicant’s own name', () => {
  it('refuses to call the Lincoln child question a name question', () => {
    // This is the assertion that would have prevented the incident outright.
    expect(matchCanonicalQuestion(CHILD_LABEL).question).toBe('unknown');
  });

  it('still recognises the parent, which the applicant does answer', () => {
    expect(matchCanonicalQuestion(PARENT_LABEL).question).toBe('family_member_employed');
  });

  it.each([
    'Emergency Contact Name',
    'Emergency contact phone number',
    "Supervisor's name",
    'Reference name and email',
    'If referred by an employee, please provide their name',
    'Name, location and relationship of each relative',
    'Next of kin address',
  ])('treats %j as somebody else’s details', (label) => {
    expect(describesThirdPartyDetails(label)).toBe(true);
    expect(matchCanonicalQuestion(label).question).toBe('unknown');
  });

  it.each([
    ['Legal First Name', 'first_name'],
    ['Last Name', 'last_name'],
    ['Full Name', 'full_name'],
    ['Email', 'email'],
    ['Company Name', 'employer'],
    ['Employer Name', 'employer'],
    ['Name of School', 'school'],
  ])('leaves %j alone as the applicant’s own %s', (label, expected) => {
    // The guard must not swallow the questions around it. Work history and
    // education still fill; only questions naming another person are refused.
    expect(describesThirdPartyDetails(label)).toBe(false);
    expect(matchCanonicalQuestion(label).question).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
describe('the scanner links the child to its parent', () => {
  it('recognises a condition stated as a sentence, not just "If yes"', async () => {
    mountLincolnRelatives();
    const { fields } = await scan();
    const child = fields.find((field) => field.label.startsWith('If you have any relatives'));
    const parent = fields.find((field) => field.label.startsWith('Do you have any relatives'));

    expect(child, 'the child field was not scanned at all').toBeDefined();
    expect(parent).toBeDefined();
    expect(child!.dependsOn?.fieldId).toBe(parent!.id);
    // The sentence does not name the option that activates it, so nothing is
    // invented for it.
    expect(child!.dependsOn?.value).toBe(ACTIVATED_BY_ANY_ANSWER);
  });
});

// ---------------------------------------------------------------------------
describe('the gate, over the parent’s observed answer', () => {
  const gateFor = async (parentValue: string) => {
    mountLincolnRelatives(parentValue);
    const { fields } = await scan();
    const child = fields.find((field) => field.label.startsWith('If you have any relatives'))!;
    return conditionalGateFor(fields)(child);
  };

  it('is inactive while the parent shows No Selection', async () => {
    const gate = await gateFor('');
    expect(gate?.active).toBe(false);
    expect(gate?.parentAnswered).toBe(false);
  });

  it('is inactive when the parent is answered No', async () => {
    const gate = await gateFor('no');
    expect(gate?.active).toBe(false);
    expect(gate?.parentAnswered).toBe(true);
  });

  it('is active only when the parent is answered Yes', async () => {
    const gate = await gateFor('yes');
    expect(gate?.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the applicant’s own name is never the fallback', () => {
  it('is not proposed for the child even when the parent says Yes', async () => {
    // The gate opening is not a licence to answer from the applicant's identity.
    // Only explicitly saved relative details could answer this, and there is no
    // such profile field — so the honest outcome is that the applicant is asked.
    mountLincolnRelatives('yes');
    const { fields } = await scan();
    const child = fields.find((field) => field.label.startsWith('If you have any relatives'))!;
    expect(child.canonicalKey).toBeUndefined();
    expect(describesThirdPartyDetails(child.label)).toBe(true);
  });
});
