import { afterEach, describe, expect, it } from 'vitest';
import {
  markBlockCreationFailed,
  planRepeatedSection,
  summariseMappings,
  MAX_BLOCKS,
} from '@internship-agent/shared';
import {
  findAddControl,
  growRepeatedSection,
} from '../../extension/src/content/repeatedSections.js';

/**
 * How many blocks a repeating section needs, and how they get created.
 *
 * The arithmetic is tested on its own because the two rules it enforces are the
 * ones that went wrong on a real application: never map one record into two
 * blocks, and never create a block for a record that does not exist.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

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

describe('planning how many blocks a section needs', () => {
  it('presses Add once per missing block', () => {
    const plan = planRepeatedSection({
      kind: 'experience',
      recordCount: 3,
      blockCount: 1,
      hasAddControl: true,
    });
    expect(plan.addPresses).toBe(2);
    expect(plan.targetBlockCount).toBe(3);
    expect(plan.mappings.map((entry) => entry.blockIndex)).toEqual([0, 1, 2]);
    expect(plan.mappings.map((entry) => entry.status)).toEqual([
      'MATCHED_EXISTING_BLOCK',
      'CREATED_NEW_BLOCK',
      'CREATED_NEW_BLOCK',
    ]);
  });

  it('presses nothing when the page already offers enough blocks', () => {
    const plan = planRepeatedSection({
      kind: 'education',
      recordCount: 2,
      blockCount: 3,
      hasAddControl: true,
    });
    expect(plan.addPresses).toBe(0);
    // The third block belongs to nobody and is left completely alone.
    expect(plan.surplusBlockIndexes).toEqual([2]);
    expect(plan.mappings.map((entry) => entry.blockIndex)).toEqual([0, 1]);
  });

  it('never maps one record into two blocks', () => {
    const plan = planRepeatedSection({
      kind: 'experience',
      recordCount: 2,
      blockCount: 4,
      hasAddControl: true,
    });
    const used = plan.mappings.map((entry) => entry.blockIndex);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports records that have nowhere to go rather than dropping them', () => {
    const plan = planRepeatedSection({
      kind: 'experience',
      recordCount: 3,
      blockCount: 1,
      hasAddControl: false,
    });
    expect(plan.addPresses).toBe(0);
    expect(plan.mappings.map((entry) => entry.status)).toEqual([
      'MATCHED_EXISTING_BLOCK',
      'BLOCK_LIMIT_REACHED',
      'BLOCK_LIMIT_REACHED',
    ]);
  });

  it('says so when the page has no section of this kind at all', () => {
    const plan = planRepeatedSection({
      kind: 'projects',
      recordCount: 2,
      blockCount: 0,
      hasAddControl: false,
    });
    expect(plan.mappings.every((entry) => entry.status === 'SKIPPED_NO_PAGE_SECTION')).toBe(true);
  });

  it('honours a page limit, and its own ceiling', () => {
    const limited = planRepeatedSection({
      kind: 'experience',
      recordCount: 5,
      blockCount: 1,
      hasAddControl: true,
      maxBlocks: 2,
    });
    expect(limited.addPresses).toBe(1);
    expect(summariseMappings(limited.mappings).BLOCK_LIMIT_REACHED).toBe(3);

    const unbounded = planRepeatedSection({
      kind: 'experience',
      recordCount: MAX_BLOCKS + 5,
      blockCount: 0,
      hasAddControl: true,
    });
    expect(unbounded.addPresses).toBe(MAX_BLOCKS);
  });

  it('records a press that produced nothing as its own outcome', () => {
    const plan = planRepeatedSection({
      kind: 'experience',
      recordCount: 3,
      blockCount: 1,
      hasAddControl: true,
    });
    const revised = markBlockCreationFailed(plan, 1);
    expect(revised.mappings.map((entry) => entry.status)).toEqual([
      'MATCHED_EXISTING_BLOCK',
      'FAILED_TO_CREATE_BLOCK',
      'FAILED_TO_CREATE_BLOCK',
    ]);
  });
});

describe('finding the Add control', () => {
  it('finds a control that names its own section', () => {
    document.body.innerHTML = `
      <button id="a" type="button">Add Another Employer</button>
      <button id="b" type="button">Add Another School</button>`;
    expect(findAddControl(document, 'experience')?.id).toBe('a');
    expect(findAddControl(document, 'education')?.id).toBe('b');
  });

  it('refuses a bare "Add" that names no section', () => {
    document.body.innerHTML = '<button type="button">Add</button>';
    expect(findAddControl(document, 'experience')).toBeNull();
  });

  it('never mistakes submit for an Add control', () => {
    document.body.innerHTML = '<button type="submit">Add and Submit Application</button>';
    expect(findAddControl(document, 'experience')).toBeNull();
  });

  it('refuses two equally plausible controls rather than guessing', () => {
    document.body.innerHTML = `
      <button type="button">Add Employer</button>
      <button type="button">Add Another Employer</button>`;
    expect(findAddControl(document, 'experience')).toBeNull();
  });
});

describe('growing a section', () => {
  function mountRepeater(initial: number): void {
    document.body.innerHTML = `
      <div id="blocks"></div>
      <button id="add" type="button">Add Another Employer</button>`;
    const host = document.getElementById('blocks')!;
    const build = (): void => {
      const block = document.createElement('div');
      block.className = 'block';
      host.append(block);
    };
    for (let index = 0; index < initial; index += 1) build();
    document.getElementById('add')!.addEventListener('click', build);
  }

  const count = (): number => document.querySelectorAll('.block').length;

  it('presses Add exactly as many times as there are missing blocks', async () => {
    mountRepeater(1);
    const outcome = await growRepeatedSection({
      document,
      kind: 'experience',
      recordCount: 3,
      countBlocks: count,
    });

    expect(outcome.addPressesPerformed).toBe(2);
    expect(outcome.blocksBefore).toBe(1);
    expect(outcome.blocksAfter).toBe(3);
    expect(count()).toBe(3);
  });

  it('presses nothing when the page already has enough', async () => {
    mountRepeater(4);
    const outcome = await growRepeatedSection({
      document,
      kind: 'experience',
      recordCount: 2,
      countBlocks: count,
    });
    expect(outcome.addPressesPerformed).toBe(0);
    expect(count()).toBe(4);
  });

  it('scans each new block as it appears, rather than the whole page', async () => {
    mountRepeater(1);
    const scanned: number[] = [];
    await growRepeatedSection({
      document,
      kind: 'experience',
      recordCount: 3,
      countBlocks: count,
      onBlockAdded: (blockIndex) => {
        scanned.push(blockIndex);
      },
    });
    // One callback per block created, naming the block — never a signal to
    // restart the page.
    expect(scanned).toEqual([1, 2]);
  });

  it('stops after a press that produces nothing, and says so', async () => {
    document.body.innerHTML = `
      <div id="blocks"><div class="block"></div></div>
      <button id="add" type="button">Add Another Employer</button>`;
    const outcome = await growRepeatedSection({
      document,
      kind: 'experience',
      recordCount: 3,
      countBlocks: count,
    });

    expect(outcome.addPressesPerformed).toBe(0);
    expect(outcome.plan.mappings.map((entry) => entry.status)).toEqual([
      'MATCHED_EXISTING_BLOCK',
      'FAILED_TO_CREATE_BLOCK',
      'FAILED_TO_CREATE_BLOCK',
    ]);
  }, 20_000);
});
