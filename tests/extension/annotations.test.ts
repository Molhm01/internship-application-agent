import { beforeEach, describe, expect, it } from 'vitest';
import { ANNOTATION_COLOURS } from '@internship-agent/shared';
import {
  clearHighlights,
  highlightCount,
  highlightField,
  isHighlighted,
  needsAttention,
  reviewOrder,
} from '../../extension/src/content/highlighter.js';

/**
 * The marks the content script actually leaves on an employer's page.
 *
 * The reported failure was a filled field still displaying "Information
 * needed". These tests exercise the mechanism that failure lived in: what
 * happens to an existing mark when a field is annotated a second time, which is
 * precisely what a redraw after verification does.
 */

const MARK = 'data-internship-agent-review';

function form(): void {
  document.body.innerHTML = `
    <form>
      <input id="firstName" />
      <input id="middleName" />
      <input id="city" value="Clifton" />
      <input id="referralName" />
    </form>
  `;
}

function markOf(id: string): string | null {
  return document.getElementById(id)?.getAttribute(MARK) ?? null;
}

function badges(): string[] {
  const host = document.getElementById('internship-agent-review-layer');
  return Array.from(host?.shadowRoot?.querySelectorAll('.badge') ?? []).map(
    (node) => node.textContent ?? '',
  );
}

function request(fieldId: string, annotation: string, badge = '') {
  return { fieldId, selector: `#${fieldId}`, annotation, badge } as Parameters<
    typeof highlightField
  >[0];
}

describe('page annotations', () => {
  beforeEach(() => {
    clearHighlights();
    form();
  });

  it('draws each meaning in its own colour', () => {
    highlightField(request('firstName', 'verified'));
    highlightField(request('middleName', 'optional_blank'));
    highlightField(request('referralName', 'information_needed'));
    expect(markOf('firstName')).toBe('verified');
    expect(markOf('middleName')).toBe('optional_blank');
    expect(markOf('referralName')).toBe('information_needed');
    expect(document.getElementById('referralName')!.style.outline).toContain(
      ANNOTATION_COLOURS.information_needed,
    );
    expect(document.getElementById('middleName')!.style.outline).toContain(
      ANNOTATION_COLOURS.optional_blank,
    );
  });

  it('replaces an Information needed mark when the field later verifies', () => {
    // The reported bug, reproduced and then fixed: a field marked as needing
    // the user, which then fills and verifies, must not keep the old mark.
    highlightField(request('firstName', 'information_needed', 'Information needed'));
    expect(markOf('firstName')).toBe('information_needed');
    expect(badges()).toContain('Information needed');

    highlightField(request('firstName', 'verified'));
    expect(markOf('firstName')).toBe('verified');
    expect(badges()).not.toContain('Information needed');
    // One mark per field, never two stacked.
    expect(highlightCount()).toBe(1);
  });

  it('removes the mark entirely for a field the agent did not touch', () => {
    highlightField(request('city', 'information_needed', 'Information needed'));
    expect(isHighlighted('city')).toBe(true);

    // `none` is a request to un-mark, not an instruction to skip. A skipped
    // field would keep whatever the earlier pass drew, which is the bug.
    expect(highlightField(request('city', 'none'))).toBe(true);
    expect(markOf('city')).toBeNull();
    expect(isHighlighted('city')).toBe(false);
    expect(document.getElementById('city')!.style.outline).toBe('');
  });

  it('restores the element exactly as it was found', () => {
    const element = document.getElementById('firstName')!;
    element.style.outline = '1px dotted red';
    highlightField(request('firstName', 'execution_failed'));
    expect(element.style.outline).toContain(ANNOTATION_COLOURS.execution_failed);
    highlightField(request('firstName', 'none'));
    expect(element.style.outline).toBe('1px dotted red');
  });

  it('counts only the marks that ask something of the user', () => {
    expect(needsAttention('information_needed')).toBe(true);
    expect(needsAttention('sensitive_decision')).toBe(true);
    expect(needsAttention('execution_failed')).toBe(true);
    // Reporting is not asking.
    expect(needsAttention('verified')).toBe(false);
    expect(needsAttention('optional_blank')).toBe(false);
    expect(needsAttention('none')).toBe(false);
  });

  it('offers only the fields needing a person in the review queue', () => {
    highlightField(request('firstName', 'verified'));
    highlightField(request('middleName', 'optional_blank'));
    highlightField(request('referralName', 'information_needed'));
    // Scrolling the user to the first green tick and calling it "the first
    // field needing review" is how a finished form looked unfinished.
    expect(reviewOrder().map((entry) => entry.fieldId)).toEqual(['referralName']);
  });

  it('leaves one control wearing one mark when two records resolve to it', () => {
    // A superseded record, a deduplicated one, or the two halves of a combined
    // widget can all resolve to the same element. Keying marks by field id alone
    // let both draw — an orange badge above the green border the other one had
    // just put on, which is exactly what the page showed.
    highlightField({
      fieldId: 'phone-code',
      selector: '#firstName',
      annotation: 'information_needed',
      badge: 'Information needed',
    });
    highlightField(request('firstName', 'verified'));

    expect(markOf('firstName')).toBe('verified');
    expect(badges()).not.toContain('Information needed');
    expect(isHighlighted('phone-code')).toBe(false);
    expect(highlightCount()).toBe(1);
  });

  it('does not let a needs-you mark displace a verdict already settled', () => {
    // The surviving mark must not depend on which order the requests arrived
    // in: a control that verified stays verified whichever record is drawn last.
    highlightField(request('firstName', 'verified'));
    highlightField({
      fieldId: 'phone-code',
      selector: '#firstName',
      annotation: 'information_needed',
      badge: 'Information needed',
    });

    expect(markOf('firstName')).toBe('verified');
    expect(badges()).not.toContain('Information needed');
    expect(highlightCount()).toBe(1);
  });

  it('never lets an un-mark erase another record’s verdict', () => {
    // `none` un-marks its own field. A field the agent did not touch must not
    // strip the tick a different record earned on a control they share.
    highlightField(request('firstName', 'verified'));
    highlightField({
      fieldId: 'shadow-record',
      selector: '#firstName',
      annotation: 'none',
      badge: '',
    });
    expect(markOf('firstName')).toBe('verified');
    expect(isHighlighted('firstName')).toBe(true);
  });

  it('reports honestly when the element has left the page', () => {
    document.getElementById('firstName')!.remove();
    expect(highlightField(request('firstName', 'verified'))).toBe(false);
  });

  it('leaves no trace of itself once cleared', () => {
    highlightField(request('firstName', 'verified'));
    highlightField(request('referralName', 'information_needed'));
    clearHighlights();
    expect(document.getElementById('internship-agent-review-layer')).toBeNull();
    expect(markOf('firstName')).toBeNull();
    expect(markOf('referralName')).toBeNull();
    expect(highlightCount()).toBe(0);
  });
});
