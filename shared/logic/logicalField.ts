/**
 * Which control on *this* observation is the control we acted on last time.
 *
 * ## Why a handle cannot answer this
 *
 * An `elementId` is minted per observation and is deliberately meaningless
 * outside it — that is what stops a decision made against a stale page from
 * executing. The cost of that guarantee is that after an action, the control
 * just written to has a *different* handle, and verification has to find it
 * again from scratch.
 *
 * The previous answer was "the element with the same label, section and block
 * index". That is nearly right and fails in three ways that all look identical
 * from outside — the control is simply not found, the step records
 * `NOT_VERIFIED`, and a correctly filled field is reported as unconfirmed:
 *
 *  - the page re-renders the label with different whitespace, a changed
 *    required marker (`City` becoming `City *`), or a newly appended error;
 *  - the control moves frame, or two frames carry the same label and the first
 *    one wins;
 *  - the scanner resolves `section` or `blockIndex` differently on the second
 *    pass, so an exact triple-equality match finds nothing.
 *
 * ## What is used instead
 *
 * The canonical intent when both sides have one — `postal_code` is the same
 * question however the page words it — and otherwise the normalized label.
 * Either way the match is *scoped*: same frame, same section, same repeated
 * block. That scoping is what keeps "Company Name" in Work Experience block 2
 * from being confirmed against block 1's, which was a real bug in the
 * label-only version of this.
 */

/** The parts of a control that identify *which question it is*. */
export interface LogicalFieldIdentity {
  label: string;
  section?: string;
  blockIndex?: number | undefined;
  intent?: string | undefined;
  frameId?: number | undefined;
}

/**
 * Reduces a label to the part a re-render cannot change.
 *
 * Required markers, colons, and the whitespace a framework rewrites are all
 * dropped, because none of them says *which* question this is. "Street Address
 * *" and "Street address:" are the same control, and a verifier that thought
 * otherwise reported a filled field as unconfirmed.
 */
export function normalizeFieldLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[*✱]/g, ' ')
    .replace(/\(\s*required\s*\)/g, ' ')
    .replace(/\brequired\b/g, ' ')
    .replace(/\boptional\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A stable key for one control across observations.
 *
 * Intent-first, because it is the identity the extension itself assigned and it
 * survives any amount of re-wording. The label is the fallback for the many
 * controls no canonical question matches.
 */
export function logicalFieldKey(field: LogicalFieldIdentity): string {
  const what =
    field.intent && field.intent.trim().length > 0
      ? `intent:${field.intent.trim().toLowerCase()}`
      : `label:${normalizeFieldLabel(field.label)}`;
  return [
    `frame:${field.frameId ?? 0}`,
    `section:${normalizeFieldLabel(field.section ?? '')}`,
    `block:${field.blockIndex ?? ''}`,
    what,
  ].join('|');
}

/** Whether these two readings are of the same question. */
export function sameLogicalField(left: LogicalFieldIdentity, right: LogicalFieldIdentity): boolean {
  return logicalFieldKey(left) === logicalFieldKey(right);
}

/**
 * The control in `candidates` that is the same question as `target`.
 *
 * Three passes, narrowest first, and the order matters. An exact logical key is
 * the confident answer. Failing that, an intent match inside the same block is
 * still specific. Only as a last resort is the label matched without its
 * section — which covers a page that re-parented the control between
 * observations, and which is why the pass exists at all rather than reporting
 * a filled field as gone.
 *
 * A pass that finds more than one candidate is *discarded*, not guessed at:
 * confirming a write against the wrong control is worse than failing to
 * confirm it.
 */
export function findLogicalField<T extends LogicalFieldIdentity>(
  candidates: readonly T[],
  target: LogicalFieldIdentity,
): T | undefined {
  const key = logicalFieldKey(target);
  const exact = candidates.filter((candidate) => logicalFieldKey(candidate) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact[0];

  const intent = (target.intent ?? '').trim().toLowerCase();
  if (intent.length > 0) {
    const byIntent = candidates.filter(
      (candidate) =>
        (candidate.intent ?? '').trim().toLowerCase() === intent &&
        (candidate.blockIndex ?? null) === (target.blockIndex ?? null) &&
        (candidate.frameId ?? 0) === (target.frameId ?? 0),
    );
    if (byIntent.length === 1) return byIntent[0];
  }

  const label = normalizeFieldLabel(target.label);
  if (label.length === 0) return undefined;
  const byLabel = candidates.filter(
    (candidate) =>
      normalizeFieldLabel(candidate.label) === label &&
      (candidate.blockIndex ?? null) === (target.blockIndex ?? null) &&
      (candidate.frameId ?? 0) === (target.frameId ?? 0),
  );
  return byLabel.length === 1 ? byLabel[0] : undefined;
}
