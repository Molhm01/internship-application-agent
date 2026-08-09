import { describe, expect, it } from 'vitest';
import {
  chooseDiscoverySource,
  DISCOVERY_SOURCE_CANDIDATES,
  DISCOVERY_SOURCE_PREFERENCES,
} from '@internship-agent/shared';

/**
 * The written-out categories, and the ranking they are the wording of.
 *
 * Two lists that mean the same thing are two lists that drift, and the drift
 * here would be silent and wrong: the engine would be handed a category the
 * ranking does not actually endorse, and would select it on a live form. So the
 * pairing is asserted rather than documented.
 */

describe('the discovery-source candidates and the ranking they come from', () => {
  it('has one written-out wording per ranked category', () => {
    expect(DISCOVERY_SOURCE_CANDIDATES.length).toBe(DISCOVERY_SOURCE_PREFERENCES.length);
  });

  for (const [index, pattern] of DISCOVERY_SOURCE_PREFERENCES.entries()) {
    it(`candidate ${index} is the wording of the pattern beside it`, () => {
      const wording = DISCOVERY_SOURCE_CANDIDATES[index]!;
      expect(pattern.test(wording), `${wording} does not match ${String(pattern)}`).toBe(true);
    });
  }

  it('names no category that would be false about a job found through an aggregator', () => {
    for (const wording of DISCOVERY_SOURCE_CANDIDATES) {
      expect(wording).not.toMatch(/referral|career fair|recruiter|newspaper|professor/i);
    }
  });

  it('is chosen from by the same ranking when a form does offer its options', () => {
    // Each candidate, offered on its own, is the one the live ranking picks —
    // so handing them to the engine cannot select something the ranking would
    // have refused.
    for (const wording of DISCOVERY_SOURCE_CANDIDATES) {
      const chosen = chooseDiscoverySource([
        { label: 'Employee Referral', value: 'referral' },
        { label: wording, value: wording.toLowerCase().replace(/\W+/g, '_') },
      ]);
      expect(chosen?.option.label).toBe(wording);
    }
  });
});
