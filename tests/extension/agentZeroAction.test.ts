import { afterEach, describe, expect, it } from 'vitest';
import { observePage } from '../../extension/src/agent/pageObserver.js';

/**
 * The zero-action exit, reproduced.
 *
 * A real Lincoln Electric (SuccessFactors) run produced:
 *
 *     [agent] agent run
 *     status: READY_FOR_REVIEW
 *     observations: 1
 *     actions: 0
 *     verified: 0
 *
 * on a blank application whose scan had just reported 29 fields across 2
 * frames. One observation, no actions, and a claim that the application was
 * ready — over a form with a dozen visible unanswered required controls.
 *
 * The fixtures never caught it because they are small: a lab page has a handful
 * of buttons, and a real vendor page has dozens — a nav bar, a language picker,
 * a help launcher, per-section edit controls, a footer. Every one of those is
 * `button` or `[role="button"]`, and `pageObservationSchema.navigation` was
 * capped at 20.
 *
 * The cap is a `z.array(...).max(20)`, so exceeding it does not truncate: it
 * throws. `observePage` therefore threw *after* building all 29 elements, the
 * frame answered `undefined`, the worker's `safeParse` failed, and the frame
 * was skipped — leaving an observation with no elements at all. No elements
 * means nothing actionable, and nothing actionable means READY_FOR_REVIEW.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** jsdom reports zero-size rects, so visibility would reject everything. */
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 120,
    height: 30,
    top: 0,
    left: 0,
    right: 120,
    bottom: 30,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

/**
 * A page shaped like the live one: a few real questions, and the chrome a
 * vendor portal wraps them in.
 */
function mountVendorPage(buttonCount: number): void {
  const chrome = Array.from(
    { length: buttonCount },
    (_, index) => `<button type="button">Vendor control ${index}</button>`,
  ).join('');
  document.body.innerHTML = `
    <header>${chrome}</header>
    <form>
      <label for="firstName">First Name *</label>
      <input id="firstName" name="firstName" required />
      <label for="addressLine1">Street Address *</label>
      <input id="addressLine1" name="addressLine1" required />
      <label for="city">City *</label>
      <input id="city" name="city" required />
      <label for="state">State/Province *</label>
      <select id="state" name="state" required>
        <option value="">No Selection</option>
        <option value="NJ">New Jersey</option>
      </select>
    </form>`;
}

describe('the observation survives a real vendor page', () => {
  it('is produced when the page has only a few buttons', async () => {
    mountVendorPage(3);
    const observation = await observePage();
    expect(observation.elements.length).toBeGreaterThan(0);
  });

  it('is still produced when the page has more buttons than the schema cap', async () => {
    // The reproduction. Before the repair this threw, the frame answered
    // nothing, and the worker built an observation with zero elements — which
    // is exactly how 29 scanned fields became zero actionable tasks.
    mountVendorPage(40);
    const observation = await observePage();
    expect(observation.elements.length, 'the page contributed no elements at all').toBeGreaterThan(
      0,
    );
    expect(observation.elements.some((element) => /street address/i.test(element.label))).toBe(
      true,
    );
    expect(observation.elements.some((element) => /state\/province/i.test(element.label))).toBe(
      true,
    );
  });

  it('reports a bounded number of navigation controls rather than failing', async () => {
    mountVendorPage(40);
    const observation = await observePage();
    expect(observation.navigation.length).toBeLessThanOrEqual(20);
  });

  it('never throws, whatever the page looks like', async () => {
    // An observation that throws is indistinguishable from a frame that has
    // gone away, and the agent treats both as "this frame has nothing" — which
    // is the property that turned one schema cap into a silent no-op run.
    document.body.innerHTML = '<div>Nothing here is a form at all.</div>';
    await expect(observePage()).resolves.toBeDefined();
  });
});

describe('placeholders are unresolved', () => {
  it('reports a control sitting on its prompt as holding nothing', async () => {
    mountVendorPage(2);
    const observation = await observePage();
    const state = observation.elements.find((element) => /state\/province/i.test(element.label));
    expect(state, 'State was not observed').toBeDefined();
    // "No Selection" is a prompt, not an answer. Reporting it as a value is
    // what made every dropdown look already answered.
    expect(state!.currentValue).toBe('');
  });
});
