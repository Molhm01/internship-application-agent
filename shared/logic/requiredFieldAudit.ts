import type { DetectedField } from '../schemas/fields.js';

/**
 * The closing argument of every run: what happened to each required field.
 *
 * A function returning successfully is not evidence a field was filled, and a
 * field quietly missing from a report is indistinguishable from one that was
 * never on the page. So every required field must end in exactly one of three
 * terminal states, and there is deliberately no fourth for "we did not get to
 * it" — a field that reached no state at all is reported as needing the user,
 * which is the outcome that makes the omission visible rather than invisible.
 */

export const REQUIRED_FIELD_OUTCOMES = [
  /** Written and confirmed against observed DOM state afterwards. */
  'FILLED_VERIFIED',
  /** The agent will not answer it; the user must. */
  'USER_CONFIRMATION_REQUIRED',
  /** A CAPTCHA, MFA, or verification step stands in the way. */
  'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
] as const;

export type RequiredFieldOutcome = (typeof REQUIRED_FIELD_OUTCOMES)[number];

export interface RequiredFieldVerdict {
  fieldId: string;
  label: string;
  outcome: RequiredFieldOutcome;
  /** Why, in the user's words. */
  reason: string;
}

export interface RequiredFieldAudit {
  verdicts: RequiredFieldVerdict[];
  /** True when every required field is FILLED_VERIFIED. */
  complete: boolean;
  /** The ones the user has to deal with, in page order. */
  outstanding: RequiredFieldVerdict[];
}

/** What the executor observed for one field, as far as it got. */
export interface FieldOutcomeInput {
  fieldId: string;
  /** From `fieldStatusSchema`. */
  status?: string;
  reason?: string;
  reviewReason?: string;
}

export interface RequiredFieldAuditInput {
  fields: readonly DetectedField[];
  results: readonly FieldOutcomeInput[];
  /** Set when the page is blocked; every unfilled field inherits it. */
  blockedReason?: string;
}

/**
 * Audits a finished run.
 *
 * `verified` is the only status that earns FILLED_VERIFIED. `filled` on its own
 * does not: it means a value was written, not that the page kept it, and an ATS
 * that re-renders a dropdown after selection will happily discard one.
 */
export function auditRequiredFields(input: RequiredFieldAuditInput): RequiredFieldAudit {
  const byId = new Map(input.results.map((result) => [result.fieldId, result]));

  const verdicts = input.fields
    .filter((field) => field.required && field.visible && !field.disabled)
    .map((field): RequiredFieldVerdict => {
      const label = field.label || field.question || field.id;
      const result = byId.get(field.id);

      if (result?.status === 'verified') {
        return {
          fieldId: field.id,
          label,
          outcome: 'FILLED_VERIFIED',
          reason: result.reason ?? 'Filled and confirmed on the page.',
        };
      }

      if (input.blockedReason) {
        return {
          fieldId: field.id,
          label,
          outcome: 'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
          reason: input.blockedReason,
        };
      }

      // Everything else — filled-but-unverified, skipped, failed, unsupported,
      // needs_review, and the field the run never reached at all — lands here.
      // Collapsing them is deliberate: from the user's side they are one thing,
      // "this still needs you", and enumerating the internal reasons would let
      // a new status be added that silently matches none of them.
      return {
        fieldId: field.id,
        label,
        outcome: 'USER_CONFIRMATION_REQUIRED',
        reason:
          result?.reason ??
          (result?.status === 'filled'
            ? 'A value was entered but the page did not confirm it. Check this one yourself.'
            : result
              ? 'The agent could not answer this one.'
              : 'The agent did not reach this field. Check it yourself before submitting.'),
      };
    });

  const outstanding = verdicts.filter((verdict) => verdict.outcome !== 'FILLED_VERIFIED');
  return { verdicts, complete: outstanding.length === 0, outstanding };
}

/** A one-line summary for the popup. */
export function describeAudit(audit: RequiredFieldAudit): string {
  if (audit.verdicts.length === 0) return 'No required fields were found on this page.';
  if (audit.complete) {
    return `All ${audit.verdicts.length} required ${audit.verdicts.length === 1 ? 'field is' : 'fields are'} filled and confirmed.`;
  }
  const blocked = audit.outstanding.filter(
    (verdict) => verdict.outcome === 'BLOCKED_BY_CAPTCHA_OR_VERIFICATION',
  ).length;
  const needsUser = audit.outstanding.length - blocked;
  const parts: string[] = [];
  if (needsUser > 0) parts.push(`${needsUser} still ${needsUser === 1 ? 'needs' : 'need'} you`);
  if (blocked > 0) parts.push(`${blocked} blocked by a verification step`);
  return `${audit.verdicts.length} required fields: ${audit.verdicts.length - audit.outstanding.length} confirmed, ${parts.join(', ')}.`;
}
