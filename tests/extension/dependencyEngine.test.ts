import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDependencyGraph,
  orderDependencies,
  sameScope,
  type GraphField,
} from '../../extension/src/dependencies/dependencyGraph.js';
import {
  fingerprintControl,
  hashOptions,
} from '../../extension/src/dependencies/dependencyDetector.js';
import {
  activeWatcherCount,
  awaitControlChange,
} from '../../extension/src/dependencies/dependencyWatcher.js';
import {
  applicabilityOf,
  parentIsAnswered,
} from '../../extension/src/dependencies/dependencyResolver.js';
import { runDependencyResolution } from '../../extension/src/dependencies/dependencyEngine.js';
import { fingerprintChanged, type DependencyDirective } from '@internship-agent/shared';

/**
 * The Dependency Engine, against the shapes a live application actually has.
 *
 * Every dependent list in the fixture is rebuilt *asynchronously*, on a timer,
 * which is the live failure being reproduced rather than an artificial delay: a
 * run that reads the option list synchronously after answering the parent reads
 * the list the page has not replaced yet, matches nothing, and reports
 * `No option on the page matched "New Jersey"`.
 */

const FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'lab', 'dependency-master.html');

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
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

function node(nodeId: string, intent: string, blockId?: string) {
  return {
    nodeId,
    intent,
    label: intent,
    ...(blockId === undefined ? {} : { blockId }),
  };
}

function directive(
  patch: Partial<DependencyDirective> &
    Pick<
      DependencyDirective,
      'parent' | 'dependent' | 'dependencyType' | 'parentSelector' | 'dependentSelector'
    >,
): DependencyDirective {
  return {
    intendedAnswer: '',
    intendedAnswerSource: 'profile_fact',
    alternativeValues: [],
    allowOtherFallback: false,
    requiresUserConfirmation: false,
    sensitive: false,
    ...patch,
  };
}

function choose(id: string, value: string): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  loadFixture();
});

describe('the dependency graph', () => {
  const fields: GraphField[] = [
    { nodeId: 'f-country', intent: 'country', label: 'Country' },
    { nodeId: 'f-state', intent: 'state', label: 'State/Province' },
    {
      nodeId: 'e0-type',
      intent: 'education_type',
      label: 'Education Type',
      repeaterKind: 'education',
      recordIndex: 0,
    },
    {
      nodeId: 'e0-country',
      intent: 'country',
      label: 'Education Country',
      repeaterKind: 'education',
      recordIndex: 0,
    },
    {
      nodeId: 'e0-state',
      intent: 'state',
      label: 'Education State',
      repeaterKind: 'education',
      recordIndex: 0,
    },
    {
      nodeId: 'e0-school',
      intent: 'school',
      label: 'School',
      repeaterKind: 'education',
      recordIndex: 0,
    },
    {
      nodeId: 'e1-type',
      intent: 'education_type',
      label: 'Education Type',
      repeaterKind: 'education',
      recordIndex: 1,
    },
    {
      nodeId: 'e1-country',
      intent: 'country',
      label: 'Education Country',
      repeaterKind: 'education',
      recordIndex: 1,
    },
    {
      nodeId: 'e1-state',
      intent: 'state',
      label: 'Education State',
      repeaterKind: 'education',
      recordIndex: 1,
    },
    {
      nodeId: 'e1-school',
      intent: 'school',
      label: 'School',
      repeaterKind: 'education',
      recordIndex: 1,
    },
  ];

  it('links Country to State', () => {
    const edges = buildDependencyGraph(fields);
    expect(
      edges.some(
        (edge) =>
          edge.parent.nodeId === 'f-country' &&
          edge.dependent.nodeId === 'f-state' &&
          edge.dependencyType === 'OPTION_REFRESH',
      ),
    ).toBe(true);
  });

  it('builds the four-deep education chain', () => {
    const edges = buildDependencyGraph(fields).filter((edge) => edge.dependent.recordIndex === 0);
    const pairs = edges.map((edge) => `${edge.parent.nodeId}→${edge.dependent.nodeId}`);
    expect(pairs).toContain('e0-type→e0-country');
    expect(pairs).toContain('e0-country→e0-state');
    expect(pairs).toContain('e0-state→e0-school');
  });

  /**
   * Block isolation, at the level where it is decided. Proximity is what gets
   * this wrong on a page with two education blocks, and proximity is exactly
   * what a frame would have to use.
   */
  it('never links one education block’s parent to another block’s child', () => {
    for (const edge of buildDependencyGraph(fields)) {
      if (edge.parent.repeaterKind !== 'education') continue;
      expect(edge.parent.recordIndex).toBe(edge.dependent.recordIndex);
    }
  });

  it('keeps the applicant’s own Country out of an education block', () => {
    const edges = buildDependencyGraph(fields);
    expect(
      edges.some(
        (edge) => edge.parent.nodeId === 'f-country' && edge.dependent.nodeId !== 'f-state',
      ),
    ).toBe(false);
  });

  it('treats two controls as in scope only when frame, kind and record agree', () => {
    expect(
      sameScope(
        { nodeId: 'a', intent: 'x', label: '', repeaterKind: 'education', recordIndex: 0 },
        { nodeId: 'b', intent: 'y', label: '', repeaterKind: 'education', recordIndex: 0 },
      ),
    ).toBe(true);
    expect(
      sameScope(
        { nodeId: 'a', intent: 'x', label: '', repeaterKind: 'education', recordIndex: 0 },
        { nodeId: 'b', intent: 'y', label: '', repeaterKind: 'education', recordIndex: 1 },
      ),
    ).toBe(false);
  });

  it('links a conditional child to the control the scanner named', () => {
    const edges = buildDependencyGraph([
      { nodeId: 'p', intent: 'has_relatives', label: 'Relatives?' },
      {
        nodeId: 'c',
        intent: 'relative_details',
        label: 'If yes, provide their full name',
        conditionalParentNodeId: 'p',
        conditionalParentValue: 'yes',
      },
    ]);
    expect(edges).toEqual([
      expect.objectContaining({
        dependencyType: 'CONDITIONAL_REQUIRED',
        parentRequiredState: 'yes',
      }),
    ]);
  });

  it('marks a disabled dependent as waiting to be switched on', () => {
    const edges = buildDependencyGraph([
      { nodeId: 'f-country', intent: 'country', label: 'Country' },
      { nodeId: 'f-state', intent: 'state', label: 'State', disabled: true },
    ]);
    expect(edges[0]?.dependencyType).toBe('CONTROL_ENABLE');
  });
});

describe('ordering the graph', () => {
  it('puts every parent before its child, four deep', () => {
    const edges = buildDependencyGraph([
      { nodeId: 'school', intent: 'school', label: 'School' },
      { nodeId: 'state', intent: 'state', label: 'State' },
      { nodeId: 'country', intent: 'country', label: 'Country' },
      { nodeId: 'type', intent: 'education_type', label: 'Type' },
    ]);
    const { ordered, cycleDetected } = orderDependencies(edges);
    expect(cycleDetected).toBe(false);
    const order = ordered.map((edge) => edge.dependent.nodeId);
    expect(order).toEqual(['country', 'state', 'school']);
  });

  /**
   * A page whose controls each claim to produce the other's options cannot be
   * driven — and saying so beats a stack overflow. The unaffected edges still
   * run, which is why the cyclic ones are returned rather than dropped.
   */
  it('detects a cycle and still returns the edges that are not in it', () => {
    const { ordered, cyclic, cycleDetected } = orderDependencies([
      {
        parent: node('a', 'country'),
        dependent: node('b', 'state'),
        dependencyType: 'OPTION_REFRESH',
      },
      {
        parent: node('b', 'state'),
        dependent: node('a', 'country'),
        dependencyType: 'OPTION_REFRESH',
      },
      {
        parent: node('c', 'country'),
        dependent: node('d', 'state'),
        dependencyType: 'OPTION_REFRESH',
      },
    ]);
    expect(cycleDetected).toBe(true);
    expect(cyclic).toHaveLength(2);
    expect(ordered.map((edge) => edge.dependent.nodeId)).toEqual(['d']);
  });
});

describe('control fingerprints', () => {
  it('changes when a list is rebuilt, even at the same length', () => {
    expect(hashOptions(['a', 'b'])).not.toBe(hashOptions(['b', 'a']));
  });

  it('reads a control that is not on the page as absent rather than failing', () => {
    expect(fingerprintControl(document, '#nothingHere').present).toBe(false);
  });

  it('separates "the page rebuilt this list" from "it always had one option"', () => {
    const before = fingerprintControl(document, '#state');
    expect(before.optionCount).toBe(1);
    choose('country', 'United States');
    // Still the old list: the fixture rebuilds on a timer, exactly as a form
    // fetching its regions does. A synchronous read here is the live failure.
    const immediately = fingerprintControl(document, '#state');
    expect(fingerprintChanged(before, immediately)).toBe(true);
    expect(immediately.disabled).toBe(true);
  });
});

describe('the mutation watcher', () => {
  it('resolves when the dependent list is actually rebuilt', async () => {
    const before = fingerprintControl(document, '#state');
    choose('country', 'United States');
    const outcome = await awaitControlChange(document, '#state', before, 2000);
    expect(outcome.mutationObserved).toBe(true);
    expect(outcome.fingerprint.optionCount).toBeGreaterThan(1);
  });

  it('gives up at the bound when nothing ever happens', async () => {
    const before = fingerprintControl(document, '#state');
    const started = Date.now();
    const outcome = await awaitControlChange(document, '#state', before, 300);
    expect(outcome.mutationObserved).toBe(false);
    // Bounded, and not a long fixed sleep.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  /** No observer leaks: every path out disconnects, including the timeout. */
  it('holds no observers after a wait that succeeded or timed out', async () => {
    expect(activeWatcherCount()).toBe(0);
    const before = fingerprintControl(document, '#state');
    choose('country', 'Canada');
    await awaitControlChange(document, '#state', before, 2000);
    expect(activeWatcherCount()).toBe(0);
    await awaitControlChange(document, '#state', fingerprintControl(document, '#state'), 200);
    expect(activeWatcherCount()).toBe(0);
  });
});

describe('deciding whether a form is asking a question', () => {
  it('reads an unanswered parent as unanswered, not as "no"', () => {
    expect(applicabilityOf(document, '#hasRelatives', 'yes')).toBe('PARENT_UNANSWERED');
  });

  it('reads a parent sitting on its own prompt as unanswered', () => {
    expect(parentIsAnswered(document, '#country')).toBe(false);
  });

  it('reads "No" as not applicable', () => {
    choose('hasRelatives', 'No');
    expect(applicabilityOf(document, '#hasRelatives', 'yes')).toBe('NOT_APPLICABLE');
  });

  it('reads "Yes" as applicable', () => {
    choose('hasRelatives', 'Yes');
    expect(applicabilityOf(document, '#hasRelatives', 'yes')).toBe('APPLIES');
  });
});

describe('Country → State, end to end in the frame', () => {
  it('waits for the rebuilt list and selects from it', async () => {
    choose('country', 'United States');

    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('p', 'country'),
          dependent: node('c', 'state'),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: '#country',
          dependentSelector: '#state',
          intendedAnswer: 'New Jersey',
        }),
      ],
    });

    const edge = edges[0]!;
    expect(edge.parentVerified).toBe(true);
    expect(edge.mutationObserved).toBe(true);
    expect(edge.dependentRescanned).toBe(true);
    expect(edge.initialDependentFingerprint?.optionCount).toBe(1);
    expect(edge.newFingerprint?.optionCount).toBeGreaterThan(1);
    expect(edge.finalStatus).toBe('RESOLVED');
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('New Jersey');
  }, 15_000);

  /**
   * The status that did not exist. A State control whose Country is still open
   * is next in the queue, not broken, and it used to wear a red "Autofill
   * failed" for the page's own ordering.
   */
  it('leaves State untouched and waiting when Country was never answered', async () => {
    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('p', 'country'),
          dependent: node('c', 'state'),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: '#country',
          dependentSelector: '#state',
          intendedAnswer: 'New Jersey',
        }),
      ],
    });
    expect(edges[0]?.finalStatus).toBe('WAITING_FOR_DEPENDENCY');
    expect(edges[0]?.errorCode).toBe('DEPENDENCY_PARENT_UNRESOLVED');
    expect((document.getElementById('state') as HTMLSelectElement).value).toBe('');
  });
});

describe('the education chain, per block', () => {
  async function driveBlock(index: number, state: string, school: string) {
    return runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node(`t${index}`, 'education_type'),
          dependent: node(`c${index}`, 'country', `education:block:${index}`),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: `#edu-type-${index}`,
          dependentSelector: `#edu-country-${index}`,
          intendedAnswer: 'United States',
        }),
        directive({
          parent: node(`c${index}`, 'country'),
          dependent: node(`s${index}`, 'state', `education:block:${index}`),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: `#edu-country-${index}`,
          dependentSelector: `#edu-state-${index}`,
          intendedAnswer: state,
        }),
        directive({
          parent: node(`s${index}`, 'state'),
          dependent: node(`h${index}`, 'school', `education:block:${index}`),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: `#edu-state-${index}`,
          dependentSelector: `#edu-school-${index}`,
          intendedAnswer: school,
        }),
      ],
    });
  }

  it('drives Type → Country → State → School in order and verifies each', async () => {
    choose('edu-type-0', 'College/University');
    const edges = await driveBlock(0, 'New Jersey', 'Rutgers University');

    expect(edges.map((edge) => edge.finalStatus)).toEqual(['RESOLVED', 'RESOLVED', 'RESOLVED']);
    expect(edges.every((edge) => edge.dependentRescanned)).toBe(true);
    expect((document.getElementById('edu-country-0') as HTMLSelectElement).value).toBe(
      'United States',
    );
    expect((document.getElementById('edu-state-0') as HTMLSelectElement).value).toBe('New Jersey');
    expect((document.getElementById('edu-school-0') as HTMLSelectElement).value).toBe(
      'Rutgers University',
    );
  }, 30_000);

  /** Block 0's chain must not move block 1's controls, and the reverse. */
  it('keeps each education block’s chain inside that block', async () => {
    document.getElementById('addEducation')!.click();
    choose('edu-type-0', 'College/University');
    choose('edu-type-1', 'High School');

    await driveBlock(0, 'New Jersey', 'Rutgers University');
    const stateOne = document.getElementById('edu-state-1') as HTMLSelectElement;
    expect(stateOne.value).toBe('');
    expect(stateOne.options.length).toBe(1);

    await driveBlock(1, 'Michigan', 'University of Michigan');
    expect((document.getElementById('edu-state-0') as HTMLSelectElement).value).toBe('New Jersey');
    expect((document.getElementById('edu-state-1') as HTMLSelectElement).value).toBe('Michigan');
    expect((document.getElementById('edu-school-0') as HTMLSelectElement).value).toBe(
      'Rutgers University',
    );
    expect((document.getElementById('edu-school-1') as HTMLSelectElement).value).toBe(
      'University of Michigan',
    );
  }, 40_000);
});

describe('conditional children', () => {
  function relativesDirective(answer: string): DependencyDirective {
    return directive({
      parent: node('p', 'has_relatives'),
      dependent: node('c', 'relative_details'),
      dependencyType: 'CONDITIONAL_REQUIRED',
      parentSelector: '#hasRelatives',
      dependentSelector: '#relativeDetails',
      parentRequiredState: 'yes',
      intendedAnswer: answer,
    });
  }

  /**
   * The regression this engine exists to make impossible.
   *
   * The live run typed the applicant's own name into "If yes, provide their
   * full name, location, and relationship" because that label contains the word
   * "name", while the relatives question above it had never been answered. The
   * form then stated to the employer that the applicant had a relative working
   * there.
   */
  it('never writes the applicant’s name into relatives details with the parent unanswered', async () => {
    const edges = await runDependencyResolution({
      document,
      // The worst case: an answer *is* offered, and it is the applicant's own
      // name. The gate must refuse it because the parent is unanswered.
      directives: [relativesDirective('Robin Vale')],
    });

    expect(edges[0]?.finalStatus).toBe('WAITING_FOR_DEPENDENCY');
    expect(edges[0]?.errorCode).toBe('DEPENDENCY_PARENT_UNRESOLVED');
    expect((document.getElementById('relativeDetails') as HTMLInputElement).value).toBe('');
  });

  it('makes the child not applicable when the parent says No, and leaves it blank', async () => {
    choose('hasRelatives', 'No');
    const edges = await runDependencyResolution({
      document,
      directives: [relativesDirective('Robin Vale')],
    });
    expect(edges[0]?.finalStatus).toBe('NOT_APPLICABLE');
    expect((document.getElementById('relativeDetails') as HTMLInputElement).value).toBe('');
  });

  it('asks the user when the parent says Yes and nothing saved answers it', async () => {
    choose('hasRelatives', 'Yes');
    const edges = await runDependencyResolution({
      document,
      directives: [relativesDirective('')],
    });
    expect(edges[0]?.finalStatus).toBe('USER_CONFIRMATION_REQUIRED');
    expect((document.getElementById('relativeDetails') as HTMLInputElement).value).toBe('');
  });

  it('fills the child from an explicitly saved answer when the parent says Yes', async () => {
    choose('hasRelatives', 'Yes');
    const edges = await runDependencyResolution({
      document,
      directives: [relativesDirective('Dana Vale — Newark, NJ — sibling')],
    });
    expect(edges[0]?.finalStatus).toBe('RESOLVED');
    expect((document.getElementById('relativeDetails') as HTMLInputElement).value).toBe(
      'Dana Vale — Newark, NJ — sibling',
    );
  });

  it('leaves "If other" blank while School holds a real school', async () => {
    choose('edu-type-0', 'College/University');
    choose('edu-country-0', 'United States');
    await new Promise((done) => setTimeout(done, 250));
    choose('edu-state-0', 'New Jersey');
    await new Promise((done) => setTimeout(done, 250));
    choose('edu-school-0', 'Rutgers University');

    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('s', 'school'),
          dependent: node('o', 'school_other'),
          dependencyType: 'CONDITIONAL_REQUIRED',
          parentSelector: '#edu-school-0',
          dependentSelector: '#edu-other-school-0',
          parentRequiredState: 'other',
          intendedAnswer: 'Rutgers University',
        }),
      ],
    });
    expect(edges[0]?.finalStatus).toBe('NOT_APPLICABLE');
    expect((document.getElementById('edu-other-school-0') as HTMLInputElement).value).toBe('');
  }, 15_000);

  it('fills "If other" once School actually holds Other', async () => {
    choose('edu-type-0', 'College/University');
    choose('edu-country-0', 'United States');
    await new Promise((done) => setTimeout(done, 250));
    choose('edu-state-0', 'New Jersey');
    await new Promise((done) => setTimeout(done, 250));
    choose('edu-school-0', 'Other');

    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('s', 'school'),
          dependent: node('o', 'school_other'),
          dependencyType: 'CONDITIONAL_REQUIRED',
          parentSelector: '#edu-school-0',
          dependentSelector: '#edu-other-school-0',
          parentRequiredState: 'other',
          intendedAnswer: 'Clifton Technical Institute',
        }),
      ],
    });
    expect(edges[0]?.finalStatus).toBe('RESOLVED');
    expect((document.getElementById('edu-other-school-0') as HTMLInputElement).value).toBe(
      'Clifton Technical Institute',
    );
  }, 15_000);

  it('leaves "If other, enter Area of Study" blank for a real subject', async () => {
    choose('edu-area-0', 'Electrical Engineering');
    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('a', 'major'),
          dependent: node('ao', 'major_other'),
          dependencyType: 'CONDITIONAL_REQUIRED',
          parentSelector: '#edu-area-0',
          dependentSelector: '#edu-other-area-0',
          parentRequiredState: 'other',
          intendedAnswer: 'Electrical Engineering',
        }),
      ],
    });
    expect(edges[0]?.finalStatus).toBe('NOT_APPLICABLE');
    expect((document.getElementById('edu-other-area-0') as HTMLInputElement).value).toBe('');
  });
});

describe('a control the parent reveals', () => {
  it('waits for the graduation date field to be created, then fills it', async () => {
    choose('currentStudent', 'Yes');

    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('p', 'current_student'),
          dependent: node('c', 'graduation_date'),
          dependencyType: 'CONTROL_APPEAR',
          parentSelector: '#currentStudent',
          dependentSelector: '#graduationDate',
          intendedAnswer: '2027-05',
        }),
      ],
    });

    expect(edges[0]?.initialDependentFingerprint?.present).toBe(false);
    expect(edges[0]?.mutationObserved).toBe(true);
    expect(edges[0]?.finalStatus).toBe('RESOLVED');
    expect((document.getElementById('graduationDate') as HTMLInputElement).value).toBe('2027-05');
  }, 15_000);

  it('names the failure when the parent never reveals the control', async () => {
    choose('currentStudent', 'No');
    const edges = await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('p', 'current_student'),
          dependent: node('c', 'graduation_date'),
          dependencyType: 'CONTROL_APPEAR',
          parentSelector: '#currentStudent',
          dependentSelector: '#graduationDate',
          intendedAnswer: '2027-05',
        }),
      ],
    });
    expect(edges[0]?.finalStatus).toBe('FAILED');
    expect(edges[0]?.errorCode).toBe('DEPENDENCY_CHILD_NOT_CREATED');
  }, 15_000);

  it('leaves no observers behind after a whole run', async () => {
    choose('country', 'United States');
    await runDependencyResolution({
      document,
      directives: [
        directive({
          parent: node('p', 'country'),
          dependent: node('c', 'state'),
          dependencyType: 'OPTION_REFRESH',
          parentSelector: '#country',
          dependentSelector: '#state',
          intendedAnswer: 'New Jersey',
        }),
      ],
    });
    expect(activeWatcherCount()).toBe(0);
  }, 15_000);
});
