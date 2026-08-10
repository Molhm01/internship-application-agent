import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countBlocks,
  findAddControl,
  findSection,
} from '../../extension/src/repeaters/repeaterScanner.js';
import {
  matchRecordsToBlocks,
  normalizeAnchor,
} from '../../extension/src/repeaters/repeaterMatcher.js';
import { createBlock } from '../../extension/src/repeaters/repeaterCreator.js';
import { BLOCK_RECORD_ATTRIBUTE } from '../../extension/src/repeaters/repeaterBinder.js';
import { runRepeaterAutofill } from '../../extension/src/repeaters/repeaterEngine.js';
import { directivesFor } from '../../extension/src/background/repeatersAcrossFrames.js';
import type { Profile, RepeaterSectionTrace } from '@internship-agent/shared';

/**
 * The Repeater Engine, against the shape the live application has.
 *
 * The fixture starts with one Work Experience block, one Education block, and a
 * `+ Add` button under each — buttons whose own text names no section, which is
 * exactly what made them unfindable before. Every assertion here is about what
 * the *page* holds afterwards, never about what a function returned.
 */

const FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'lab', 'repeater-master.html');

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

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  // jsdom does not execute scripts written through innerHTML. Replacing each
  // one with an identical node does, which is how the fixture's own Add
  // handlers come to exist — the engine presses the page's buttons, not ours.
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

function profileWith(employers: readonly string[], schools: readonly string[]): Profile {
  return {
    profileVersion: 1,
    updatedAt: '2026-08-09T00:00:00.000Z',
    personal: {},
    education: schools.map((institution, index) => ({
      id: `education-${index + 1}`,
      institution,
      coursework: [],
      honors: [],
      activities: [],
    })),
    experience: employers.map((employer, index) => ({
      id: `experience-${index + 1}`,
      employer,
      current: false,
      responsibilities: [],
      achievements: [],
    })),
    projects: [],
    certifications: [],
    volunteering: [],
    organizations: [],
    activities: [],
    skills: {},
    eligibility: {},
    preferences: {},
    documents: {},
    sensitivePolicies: [],
  } as unknown as Profile;
}

const THREE_JOBS = ['Northwind Robotics', 'Acme Industrial', 'Lakeside Analytics'];
const TWO_SCHOOLS = ['University of Michigan', 'Clifton High School'];

async function run(profile: Profile): Promise<RepeaterSectionTrace[]> {
  return runRepeaterAutofill({ document, directives: directivesFor(profile) });
}

function traceFor(traces: readonly RepeaterSectionTrace[], kind: string): RepeaterSectionTrace {
  const found = traces.find((entry) => entry.type === kind);
  if (!found) throw new Error(`no trace for ${kind}`);
  return found;
}

/** What each Work Experience block's Company Name currently holds. */
function companyValues(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('[id^="exp-company-"]')).map(
    (input) => input.value,
  );
}

function schoolBlockIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.education-block')).map(
    (block) => block.dataset.block ?? '',
  );
}

beforeEach(() => {
  loadFixture();
});

describe('finding a repeating section and its own Add control', () => {
  it('finds the Work Experience section from its heading, not from a control label', () => {
    const section = findSection(document, 'experience');
    expect(section).not.toBeNull();
    expect(section!.heading).toMatch(/work experience/i);
    expect(section!.container.id).toBe('experienceSection');
  });

  it('finds the Education section separately from Work Experience', () => {
    expect(findSection(document, 'education')!.container.id).toBe('educationSection');
  });

  it('reports no section for a kind the application does not ask about', () => {
    expect(findSection(document, 'projects')).toBeNull();
  });

  /**
   * The narrower of the two defects the audit found. The live button reads
   * exactly `+ Add`; a search demanding the section be named in the control's
   * own text found nothing, and a search accepting any "Add" would have pressed
   * Education's button to make room for a job.
   */
  it('finds a bare "+ Add" button by the section that contains it', () => {
    const experience = findAddControl(findSection(document, 'experience')!);
    const education = findAddControl(findSection(document, 'education')!);
    expect(experience?.id).toBe('addExperience');
    expect(education?.id).toBe('addEducation');
    expect(experience).not.toBe(education);
  });

  it('never offers the submit button as an Add control', () => {
    const section = findSection(document, 'experience')!;
    // Even with the submit control moved inside the section, it is refused.
    section.container.appendChild(document.getElementById('submit')!);
    expect(findAddControl(section)?.id).toBe('addExperience');
  });

  it('counts one block per section on a freshly loaded page', () => {
    expect(countBlocks(findSection(document, 'experience')!)).toBe(1);
    expect(countBlocks(findSection(document, 'education')!)).toBe(1);
  });
});

describe('assigning records to blocks', () => {
  it('normalizes a name enough to survive a round trip through a form', () => {
    expect(normalizeAnchor('Acme Corp.')).toBe(normalizeAnchor('ACME CORP'));
    expect(normalizeAnchor('Northwind Robotics, Inc.')).toBe(normalizeAnchor('Northwind Robotics'));
  });

  it('binds a record to the block that already holds it before handing out empties', () => {
    const outcome = matchRecordsToBlocks(
      [
        { recordIndex: 0, anchorValue: 'Northwind Robotics' },
        { recordIndex: 1, anchorValue: 'Acme Industrial' },
      ],
      [
        { blockIndex: 0, blockId: 'experience:block:0', anchorValue: '' },
        { blockIndex: 1, blockId: 'experience:block:1', anchorValue: 'Northwind Robotics' },
      ],
    );
    // Record 0 takes block 1, which holds it, rather than the empty block 0.
    expect(outcome.assignments[0]).toMatchObject({ blockIndex: 1, reason: 'MATCHED_BY_VALUE' });
    expect(outcome.assignments[1]).toMatchObject({ blockIndex: 0, reason: 'ASSIGNED_TO_EMPTY' });
    expect(outcome.unplacedRecordIndexes).toEqual([]);
  });

  it('reports a record with nowhere to go rather than dropping it', () => {
    const outcome = matchRecordsToBlocks(
      [
        { recordIndex: 0, anchorValue: 'Northwind Robotics' },
        { recordIndex: 1, anchorValue: 'Acme Industrial' },
      ],
      [{ blockIndex: 0, blockId: 'experience:block:0', anchorValue: '' }],
    );
    expect(outcome.unplacedRecordIndexes).toEqual([1]);
    expect(outcome.assignments).toHaveLength(2);
  });

  /** The applicant's own typing is never a slot to be reused. */
  it('leaves a block holding text that matches no saved record alone', () => {
    const outcome = matchRecordsToBlocks(
      [{ recordIndex: 0, anchorValue: 'Northwind Robotics' }],
      [{ blockIndex: 0, blockId: 'experience:block:0', anchorValue: 'A Job I Typed Myself' }],
    );
    expect(outcome.conflictingBlockIndexes).toEqual([0]);
    expect(outcome.unplacedRecordIndexes).toEqual([0]);
  });
});

describe('creating one block at a time', () => {
  it('presses Add once and observes exactly one new block', async () => {
    const section = findSection(document, 'experience')!;
    const outcome = await createBlock(section);
    expect(outcome.clicksAttempted).toBe(1);
    expect(outcome.created).toBe(1);
    expect(outcome.duplicates).toBe(0);
    expect(outcome.errorCode).toBeUndefined();
    expect(countBlocks(section)).toBe(2);
  });

  it('names the failure when the page has no Add control at all', async () => {
    document.getElementById('addExperience')!.remove();
    const outcome = await createBlock(findSection(document, 'experience')!);
    expect(outcome.created).toBe(0);
    expect(outcome.errorCode).toBe('REPEATER_ADD_NOT_FOUND');
  });

  it('retries once, then reports the count never changed', async () => {
    const button = document.getElementById('addExperience')!;
    const inert = button.cloneNode(true) as HTMLElement;
    button.replaceWith(inert);

    const section = findSection(document, 'experience')!;
    const outcome = await createBlock(section);
    expect(outcome.clicksAttempted).toBe(2);
    expect(outcome.created).toBe(0);
    expect(outcome.errorCode).toBe('REPEATER_BLOCK_COUNT_UNCHANGED');
    expect(countBlocks(section)).toBe(1);
  }, 10_000);
});

describe('first run: the page grows to fit the profile', () => {
  it('presses Add twice for three jobs and once for two schools', async () => {
    const traces = await run(profileWith(THREE_JOBS, TWO_SCHOOLS));

    const experience = traceFor(traces, 'experience');
    expect(experience.profileRecords).toBe(3);
    expect(experience.existingBlocksInitially).toBe(1);
    expect(experience.blocksNeeded).toBe(2);
    expect(experience.addControlFound).toBe(true);
    expect(experience.addClicksAttempted).toBe(2);
    expect(experience.blocksCreated).toBe(2);
    expect(experience.duplicateBlocksCreated).toBe(0);
    expect(experience.errorCode).toBeUndefined();
    expect(countBlocks(findSection(document, 'experience')!)).toBe(3);

    const education = traceFor(traces, 'education');
    expect(education.profileRecords).toBe(2);
    expect(education.existingBlocksInitially).toBe(1);
    expect(education.addClicksAttempted).toBe(1);
    expect(education.blocksCreated).toBe(1);
    expect(education.errorCode).toBeUndefined();
    expect(countBlocks(findSection(document, 'education')!)).toBe(2);
  }, 20_000);

  it('binds record i to block i, in profile order', async () => {
    const traces = await run(profileWith(THREE_JOBS, TWO_SCHOOLS));

    expect(traceFor(traces, 'experience').recordBindings).toEqual([
      expect.objectContaining({ recordIndex: 0, blockIndex: 0 }),
      expect.objectContaining({ recordIndex: 1, blockIndex: 1 }),
      expect.objectContaining({ recordIndex: 2, blockIndex: 2 }),
    ]);
    expect(traceFor(traces, 'education').recordBindings).toEqual([
      expect.objectContaining({ recordIndex: 0, blockIndex: 0 }),
      expect.objectContaining({ recordIndex: 1, blockIndex: 1 }),
    ]);
  }, 20_000);

  it('marks each block on the page with the record it is for', async () => {
    await run(profileWith(THREE_JOBS, TWO_SCHOOLS));
    const marks = Array.from(
      document.querySelectorAll<HTMLElement>(`.experience-block[${BLOCK_RECORD_ATTRIBUTE}]`),
    ).map((block) => block.getAttribute(BLOCK_RECORD_ATTRIBUTE));
    expect(marks).toEqual(['0', '1', '2']);
  }, 20_000);

  it('verifies every block it bound', async () => {
    const traces = await run(profileWith(THREE_JOBS, TWO_SCHOOLS));
    expect(traceFor(traces, 'experience').blocksVerified).toBe(3);
    expect(traceFor(traces, 'education').blocksVerified).toBe(2);
  }, 20_000);

  it('never presses Add for a section the applicant has no records for', async () => {
    const traces = await run(profileWith([], []));
    // One trace per directive, always. A section reported as "0 records, 0
    // presses" is a different fact from a section the frame stayed silent
    // about, and the worker is what drops the silent ones.
    expect(traces.every((entry) => entry.addClicksAttempted === 0)).toBe(true);
    expect(traces.every((entry) => entry.errorCode === undefined)).toBe(true);
    expect(countBlocks(findSection(document, 'experience')!)).toBe(1);
  });

  /**
   * A form offering more blocks than the applicant needs is offering an
   * optional extra. An empty optional block is finished work, not a gap.
   */
  it('presses Add zero times when the page already offers enough blocks', async () => {
    document.getElementById('addExperience')!.click();
    document.getElementById('addExperience')!.click();
    const traces = await run(profileWith(['Northwind Robotics'], []));
    const experience = traceFor(traces, 'experience');
    expect(experience.existingBlocksInitially).toBe(3);
    expect(experience.addClicksAttempted).toBe(0);
    expect(countBlocks(findSection(document, 'experience')!)).toBe(3);
  });
});

describe('block isolation', () => {
  it('gives every block its own set of controls', async () => {
    await run(profileWith(THREE_JOBS, TWO_SCHOOLS));
    const companies = Array.from(
      document.querySelectorAll<HTMLInputElement>('[id^="exp-company-"]'),
    );
    expect(companies).toHaveLength(3);
    expect(new Set(companies.map((input) => input.id)).size).toBe(3);
    expect(new Set(companies.map((input) => input.name)).size).toBe(3);
  }, 20_000);

  it("keeps each Education block's Country → State chain to itself", async () => {
    await run(profileWith([], TWO_SCHOOLS));
    expect(schoolBlockIds()).toEqual(['education-0', 'education-1']);

    const countryZero = document.getElementById('edu-country-0') as HTMLSelectElement;
    const stateZero = document.getElementById('edu-state-0') as HTMLSelectElement;
    const stateOne = document.getElementById('edu-state-1') as HTMLSelectElement;

    countryZero.value = 'United States';
    countryZero.dispatchEvent(new Event('change'));

    // Block 0's states populated; block 1's did not move.
    expect(stateZero.options.length).toBeGreaterThan(1);
    expect(stateOne.options.length).toBe(1);
    expect(stateOne.options[0]!.textContent).toMatch(/select a country first/i);
  }, 20_000);

  it("does not let one block's If-other box belong to another block", async () => {
    await run(profileWith([], TWO_SCHOOLS));
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('[id^="edu-other-school-"]'),
    );
    expect(boxes.map((box) => box.id)).toEqual(['edu-other-school-0', 'edu-other-school-1']);
    // Both start blank, and neither parent has selected Other.
    expect(boxes.every((box) => box.value === '')).toBe(true);
  }, 20_000);
});

describe('second run: zero duplicates', () => {
  /**
   * The guarantee that matters most. Pressing Autofill twice against a page the
   * first run already filled must add nothing at all — not "usually nothing",
   * and not "nothing as long as the values round-tripped exactly".
   */
  it('presses Add zero times and creates zero blocks when the page already holds every record', async () => {
    const profile = profileWith(THREE_JOBS, TWO_SCHOOLS);
    await run(profile);

    // Stand in for the fill the ordinary pipeline performs between the two
    // runs: each block now holds its own record's employer and school.
    const companies = Array.from(
      document.querySelectorAll<HTMLInputElement>('[id^="exp-company-"]'),
    );
    companies.forEach((input, index) => {
      input.value = THREE_JOBS[index]!;
    });
    TWO_SCHOOLS.forEach((school, index) => {
      const select = document.getElementById(`edu-school-${index}`) as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = school;
      option.textContent = school;
      select.appendChild(option);
      select.value = school;
    });

    const second = await run(profile);

    const experience = traceFor(second, 'experience');
    expect(experience.existingBlocksInitially).toBe(3);
    expect(experience.blocksNeeded).toBe(0);
    expect(experience.addClicksAttempted).toBe(0);
    expect(experience.blocksCreated).toBe(0);
    expect(experience.duplicateBlocksCreated).toBe(0);
    expect(experience.recordBindings.every((entry) => entry.reason === 'MATCHED_BY_VALUE')).toBe(
      true,
    );

    const education = traceFor(second, 'education');
    expect(education.addClicksAttempted).toBe(0);
    expect(education.blocksCreated).toBe(0);

    expect(countBlocks(findSection(document, 'experience')!)).toBe(3);
    expect(countBlocks(findSection(document, 'education')!)).toBe(2);
    expect(companyValues()).toEqual(THREE_JOBS);
  }, 30_000);

  /**
   * The case that produced a third education block on a live page.
   *
   * An Education block's anchor is the School dropdown, which has no options at
   * all until Country and then State are answered. A first run that grew the
   * section but could not complete that chain leaves both blocks holding
   * nothing — and a second run matching on values alone sees two empty blocks,
   * gives one to each record, finds one record unplaced, and presses Add.
   */
  it('adds nothing when the blocks it bound are still empty, whatever their values', async () => {
    const profile = profileWith([], TWO_SCHOOLS);
    await run(profile);
    expect(countBlocks(findSection(document, 'education')!)).toBe(2);

    // Stand in for a first run whose dependent chain did not complete: one
    // block empty, the other holding a value matching no saved school.
    const stray = document.getElementById('edu-school-1') as HTMLSelectElement;
    const other = document.createElement('option');
    other.value = 'Other';
    other.textContent = 'Other';
    stray.appendChild(other);
    stray.value = 'Other';

    const second = await run(profile);
    const education = traceFor(second, 'education');
    expect(education.addClicksAttempted).toBe(0);
    expect(education.blocksCreated).toBe(0);
    expect(education.recordBindings.map((entry) => entry.blockIndex)).toEqual([0, 1]);
    expect(countBlocks(findSection(document, 'education')!)).toBe(2);
  }, 30_000);

  it('adds nothing on a second run even when the page never got filled', async () => {
    const profile = profileWith(THREE_JOBS, TWO_SCHOOLS);
    await run(profile);
    const second = await run(profile);
    // The blocks are still empty, so they are still free for the same records.
    expect(traceFor(second, 'experience').addClicksAttempted).toBe(0);
    expect(countBlocks(findSection(document, 'experience')!)).toBe(3);
  }, 30_000);
});

describe('blocks the applicant created themselves', () => {
  it('binds an existing block that already holds a saved record', async () => {
    const first = document.getElementById('exp-company-0') as HTMLInputElement;
    // The applicant typed their second job into the block the page shipped with.
    first.value = 'Acme Industrial';

    const traces = await run(profileWith(THREE_JOBS, []));
    const experience = traceFor(traces, 'experience');

    expect(experience.recordBindings[1]).toMatchObject({
      recordIndex: 1,
      blockIndex: 0,
      reason: 'MATCHED_BY_VALUE',
    });
    // Two more blocks for the two records that had nowhere to go — not three.
    expect(experience.addClicksAttempted).toBe(2);
    expect(countBlocks(findSection(document, 'experience')!)).toBe(3);
    expect(first.value).toBe('Acme Industrial');
  }, 20_000);

  it('refuses to overwrite a block holding text that matches no saved record', async () => {
    const first = document.getElementById('exp-company-0') as HTMLInputElement;
    first.value = 'A Job I Typed Myself';

    const traces = await run(profileWith(['Northwind Robotics'], []));
    const experience = traceFor(traces, 'experience');

    expect(experience.errorCode).toBe('REPEATER_BINDING_REQUIRES_REVIEW');
    expect(first.value).toBe('A Job I Typed Myself');
    // The saved record went into a block of its own rather than over theirs.
    expect(experience.recordBindings[0]?.blockIndex).toBe(1);
  }, 20_000);
});

describe('what the trace reports when the page will not grow', () => {
  it('names every record that could not be placed', async () => {
    document.getElementById('addExperience')!.remove();
    const traces = await run(profileWith(THREE_JOBS, []));
    const experience = traceFor(traces, 'experience');

    expect(experience.addControlFound).toBe(false);
    expect(experience.errorCode).toBe('REPEATER_ADD_NOT_FOUND');
    expect(experience.recordBindings[0]?.blockIndex).toBe(0);
    expect(experience.recordBindings[1]).toMatchObject({ errorCode: 'REPEATER_ADD_NOT_FOUND' });
    expect(experience.recordBindings[2]).toMatchObject({ errorCode: 'REPEATER_ADD_NOT_FOUND' });
  });

  it('reports a missing section without calling it an error when there are no records', async () => {
    const traces = await run(profileWith(THREE_JOBS, []));
    // The fixture has no Projects section and the profile has no projects, so
    // there is nothing missing: a page that does not ask about projects is not
    // a page missing the projects.
    const projects = traceFor(traces, 'projects');
    expect(projects.errorCode).toBeUndefined();
    expect(projects.addClicksAttempted).toBe(0);

    // Education is the opposite case in the same run: also absent from the
    // profile, so also not an error.
    expect(traceFor(traces, 'education').errorCode).toBeUndefined();
  }, 20_000);
});
