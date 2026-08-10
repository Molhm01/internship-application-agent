import { z } from 'zod';
import { errorCodeSchema } from './error.js';

/**
 * The Dependency Engine's contract: what depends on what, and what happened.
 *
 * A dependency is a claim about the *form*, not about the applicant — "this
 * page will not offer State's choices until Country is answered". So the shapes
 * here carry field identities, control fingerprints, counts and codes, and
 * never an answer. The one exception would be an intended value, and there is
 * no field for one: resolving the answer stays with the resolver that already
 * does it, and driving the control stays with the Dropdown Engine.
 */

/**
 * How a parent's answer changes its child.
 *
 * Six kinds rather than one flag, because the *wait* differs for each. Waiting
 * for a list to be rebuilt is watching an option set; waiting for a control to
 * be created is watching a subtree for a node that is not there yet; and a
 * conditionally-required child needs no wait at all — it needs a decision about
 * whether the question is being asked.
 */
export const DEPENDENCY_TYPES = [
  /** The parent's answer rebuilds the child's option list. Country → State. */
  'OPTION_REFRESH',
  /** The child exists and is disabled until the parent is answered. */
  'CONTROL_ENABLE',
  /** The child is not in the DOM until the parent is answered. */
  'CONTROL_APPEAR',
  /** The parent's answer removes the child from the form. */
  'CONTROL_HIDE',
  /** The child applies only when the parent holds a particular answer. */
  'CONDITIONAL_REQUIRED',
  /** The parent's answer rebuilds a whole section around the child. */
  'SECTION_REFRESH',
] as const;
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);
export type DependencyType = z.infer<typeof dependencyTypeSchema>;

/** What became of one dependency edge. */
export const DEPENDENCY_STATUSES = [
  /** Not reached yet. */
  'PENDING',
  /** The parent is unsettled, so the child is correctly untouched. */
  'WAITING_FOR_DEPENDENCY',
  /** The parent settled and the child was driven and verified. */
  'RESOLVED',
  /** The parent settled to a value that switches this child off. */
  'NOT_APPLICABLE',
  /** The parent settled and the child could not be driven. */
  'FAILED',
  /** Nobody can answer the parent, so the child is the user's. */
  'USER_CONFIRMATION_REQUIRED',
] as const;
export const dependencyStatusSchema = z.enum(DEPENDENCY_STATUSES);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/**
 * A control's identity, reduced to what tells one instance from another.
 *
 * The block id and record index are what keep Education block 0's State
 * separate from block 1's. Without them a canonical intent names *a* State
 * control rather than *this* one, and driving "the" State control on a page
 * with two education blocks answers whichever the selector found first.
 */
export const dependencyNodeSchema = z.object({
  /** Stable within a run. Never a selector. */
  nodeId: z.string().min(1).max(200),
  /** The canonical question, when the scanner recognised one. */
  intent: z.string().max(120).default(''),
  /** Sanitized label, for the diagnostic line. Never a value. */
  label: z.string().max(200).default(''),
  frameId: z.number().int().nonnegative().optional(),
  /** `experience` / `education` / `projects`, when inside a repeating block. */
  repeaterKind: z.string().max(40).optional(),
  blockId: z.string().max(120).optional(),
  recordIndex: z.number().int().nonnegative().max(99).optional(),
});
export type DependencyNode = z.infer<typeof dependencyNodeSchema>;

/**
 * What a dependent control looked like before its parent was answered.
 *
 * Compared afterwards to tell "the page rebuilt this list" from "the page has
 * not rebuilt it yet, and it happened to have one option all along". Hashes and
 * counts only: the option *texts* are the page's, not the applicant's, but they
 * are not needed here and a diagnostic that carries them is a diagnostic that
 * leaks the shape of somebody's application.
 */
export const controlFingerprintSchema = z.object({
  present: z.boolean(),
  disabled: z.boolean(),
  optionCount: z.number().int().nonnegative(),
  /**
   * How many of those options are choices rather than prompts.
   *
   * Separate from `optionCount` because a list holding only "Select a state
   * first" has one option and no choices, and the difference is what tells a
   * rebuilt list from a cleared one. A form that answers a parent by queueing
   * *two* rebuilds — one clearing the child, one filling it — passes through
   * exactly that state, and a wait that ended on "enabled and changed" handed
   * the executor an empty list and reported the answer as unmatched.
   */
  usableOptionCount: z.number().int().nonnegative().default(0),
  /** Order-sensitive digest of the option values and labels. */
  optionsHash: z.string().max(64),
  ariaExpanded: z.string().max(16).default(''),
  ariaDisabled: z.string().max(16).default(''),
});
export type ControlFingerprint = z.infer<typeof controlFingerprintSchema>;

/**
 * One edge, as an instruction to the frame that holds it.
 *
 * The split is the same one the Dropdown and Repeater engines use. The worker
 * owns the applicant's facts and the graph — it decides what each question
 * means, what the answer is, and what order the edges run in. The frame owns
 * the DOM: it fingerprints, waits, rescans and drives, and decides none of the
 * above. Selectors travel in; answers travel in; nothing about the applicant
 * travels out.
 */
export const dependencyDirectiveSchema = z.object({
  parent: dependencyNodeSchema,
  dependent: dependencyNodeSchema,
  dependencyType: dependencyTypeSchema,
  /** Where each control is. Re-resolved in the frame against the live DOM. */
  parentSelector: z.string().min(1).max(2000),
  dependentSelector: z.string().min(1).max(2000),
  /** The parent answer that switches a conditional child on. */
  parentRequiredState: z.string().max(120).optional(),
  /** The answer to reach in the dependent control. Empty means nobody knows. */
  intendedAnswer: z.string().max(600).default(''),
  intendedAnswerSource: z.string().max(60).default('none'),
  alternativeValues: z.array(z.string().max(600)).max(12).default([]),
  searchText: z.string().max(600).optional(),
  allowOtherFallback: z.boolean().default(false),
  requiresUserConfirmation: z.boolean().default(false),
  sensitive: z.boolean().default(false),
});
export type DependencyDirective = z.infer<typeof dependencyDirectiveSchema>;

/** One edge, and everything observed about driving it. */
export const dependencyTraceSchema = z.object({
  parent: dependencyNodeSchema,
  dependent: dependencyNodeSchema,
  dependencyType: dependencyTypeSchema,
  /** The parent answer that switches the child on, for a conditional edge. */
  parentRequiredState: z.string().max(120).optional(),
  parentResolved: z.boolean().default(false),
  parentVerified: z.boolean().default(false),
  initialDependentFingerprint: controlFingerprintSchema.optional(),
  mutationObserved: z.boolean().default(false),
  dependentRescanned: z.boolean().default(false),
  newFingerprint: controlFingerprintSchema.optional(),
  dependentExecuted: z.boolean().default(false),
  dependentVerified: z.boolean().default(false),
  /**
   * How many choices the dependent control offered *while it was being driven*.
   *
   * Not the same as `newFingerprint.usableOptionCount`, and the difference is
   * the whole reason this exists. A fingerprint reads the control as it stands;
   * for a `<select>` that is its option list, but for a button-menu widget the
   * menu is closed by then and there is nothing to count. So "Education State"
   * came back verified, holding New Jersey, with a record saying its list had
   * offered nothing at all. This is the count the engine actually read, at the
   * moment it read it.
   */
  dependentOptionCount: z.number().int().nonnegative().default(0),
  finalStatus: dependencyStatusSchema,
  errorCode: errorCodeSchema.optional(),
  durationMs: z.number().int().nonnegative().default(0),
});
export type DependencyTrace = z.infer<typeof dependencyTraceSchema>;

export const dependencyRunSummarySchema = z.object({
  edges: z.array(dependencyTraceSchema).max(120).default([]),
  /** Nodes in the graph, whether or not they had an edge to drive. */
  nodeCount: z.number().int().nonnegative().default(0),
  resolved: z.number().int().nonnegative().default(0),
  notApplicable: z.number().int().nonnegative().default(0),
  waiting: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  /** True when the graph could not be ordered. The rest still ran. */
  cycleDetected: z.boolean().default(false),
  durationMs: z.number().int().nonnegative().default(0),
});
export type DependencyRunSummary = z.infer<typeof dependencyRunSummarySchema>;

/** An empty fingerprint, for a control that is not on the page at all. */
export const ABSENT_FINGERPRINT: ControlFingerprint = {
  present: false,
  disabled: false,
  optionCount: 0,
  usableOptionCount: 0,
  optionsHash: '',
  ariaExpanded: '',
  ariaDisabled: '',
};

/**
 * True when the page has done something to this control since the parent was
 * answered.
 *
 * Any of the five signals is enough. A control that gained options, lost its
 * disabled attribute, or appeared at all has been rebuilt — and a page that
 * replaces the element wholesale changes the count and the hash together.
 */
export function fingerprintChanged(before: ControlFingerprint, after: ControlFingerprint): boolean {
  return (
    before.present !== after.present ||
    before.disabled !== after.disabled ||
    before.optionCount !== after.optionCount ||
    before.usableOptionCount !== after.usableOptionCount ||
    before.optionsHash !== after.optionsHash ||
    before.ariaExpanded !== after.ariaExpanded ||
    before.ariaDisabled !== after.ariaDisabled
  );
}

/** One human-readable line per edge. Identities and outcomes, never values. */
export function describeDependency(trace: DependencyTrace): string {
  const where = trace.dependent.blockId ? ` [${trace.dependent.blockId}]` : '';
  return (
    `${trace.parent.intent || trace.parent.label} → ` +
    `${trace.dependent.intent || trace.dependent.label}${where} ` +
    `(${trace.dependencyType}): parent ${trace.parentVerified ? 'verified' : 'unsettled'}, ` +
    `mutation ${trace.mutationObserved ? 'observed' : 'none'}, ` +
    `${trace.dependentRescanned ? 'rescanned, ' : ''}` +
    `${trace.finalStatus}` +
    (trace.errorCode ? ` (${trace.errorCode})` : '') +
    ` in ${trace.durationMs}ms`
  );
}

export function summarizeDependencyRun(
  edges: readonly DependencyTrace[],
  nodeCount: number,
  cycleDetected: boolean,
  durationMs: number,
): DependencyRunSummary {
  return dependencyRunSummarySchema.parse({
    edges,
    nodeCount,
    resolved: edges.filter((edge) => edge.finalStatus === 'RESOLVED').length,
    notApplicable: edges.filter((edge) => edge.finalStatus === 'NOT_APPLICABLE').length,
    waiting: edges.filter((edge) => edge.finalStatus === 'WAITING_FOR_DEPENDENCY').length,
    failed: edges.filter((edge) => edge.finalStatus === 'FAILED').length,
    cycleDetected,
    durationMs,
  });
}
