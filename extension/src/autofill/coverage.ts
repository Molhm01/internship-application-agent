import {
  contractViolation,
  type DetectedField,
  type DeterministicFillAction,
  type DeterministicFillPlan,
} from '@internship-agent/shared';

/**
 * Why each field did or did not fill, in one row per question.
 *
 * The live run filled exactly one field out of twenty-seven and there was no
 * way to see where the other twenty-six were lost — the report said "needs
 * information" for all of them, which is the symptom of every possible cause.
 * This is the missing instrument: for each field it records which stage
 * dropped it, so "no profile value" is distinguishable from "value found but
 * the action was rejected" and from "executed but the page refused it".
 *
 * Counts, intents, control types and failure codes only. Never a field value,
 * a credential, a document, or a prompt — the whole point is that this can be
 * left on.
 */

/** The stage at which a field stopped progressing. */
export const COVERAGE_STAGES = [
  /** Scanned, but nothing recognized what it was asking. */
  'unclassified',
  /** Recognized, but the profile holds no value for it. */
  'no_profile_value',
  /** A value existed but the planner produced nothing executable. */
  'no_action',
  /** An action existed but broke the control-type contract. */
  'action_rejected',
  /** Executable, and handed to the executor. */
  'executed',
  /** Executed and confirmed against the page afterwards. */
  'verified',
  /** Deliberately left empty. */
  'optional_blank',
] as const;

export type CoverageStage = (typeof COVERAGE_STAGES)[number];

export interface FieldCoverage {
  questionId: string;
  /** The canonical question, or `unknown`. Never the label's own words. */
  intent: string;
  controlType: string;
  required: boolean;
  section: string;
  hasProfileValue: boolean;
  plannedAction: string;
  contractValid: boolean;
  stage: CoverageStage;
  failureCode?: string;
  durationMs?: number;
}

/** Actions that mean the planner declined rather than produced work. */
const NON_ACTIONS = new Set(['manual_review', 'missing_information', 'unsupported', 'skip']);

function stageFor(action: DeterministicFillAction, contractValid: boolean): CoverageStage {
  if (!contractValid) return 'action_rejected';
  if (action.action === 'skip') return 'optional_blank';
  if (NON_ACTIONS.has(action.action)) {
    // The planner reached the field and had nothing to write. Whether that is
    // "the profile is empty" or "nobody recognized the question" is the single
    // most useful distinction in this whole table, and it is exactly what the
    // report could not previously express.
    return action.source === 'none' ? 'no_profile_value' : 'no_action';
  }
  return 'executed';
}

/**
 * Builds the coverage table for one pass.
 *
 * `verified` is layered on afterwards from the executor's own results, because
 * a planned action is not evidence of a filled field.
 */
export function buildCoverage(
  fields: readonly DetectedField[],
  plan: DeterministicFillPlan,
  verifiedFieldIds: ReadonlySet<string> = new Set(),
  failureCodes: ReadonlyMap<string, string> = new Map(),
): FieldCoverage[] {
  const actions = new Map(plan.actions.map((action) => [action.fieldId, action]));

  return fields.map((field): FieldCoverage => {
    const action = actions.get(field.id);
    const intent = field.canonicalKey ?? 'unknown';
    const contractValid =
      action === undefined || contractViolation(field.fieldType, action.action) === null;
    const stage: CoverageStage = action
      ? verifiedFieldIds.has(field.id)
        ? 'verified'
        : stageFor(action, contractValid)
      : intent === 'unknown'
        ? 'unclassified'
        : 'no_action';

    return {
      questionId: field.id,
      intent,
      controlType: field.fieldType,
      required: field.required,
      section:
        typeof field.metadata.sectionHeading === 'string' ? field.metadata.sectionHeading : '',
      // Whether a value was found — never what it was.
      hasProfileValue: action?.source === 'profile' || action?.source === 'approved_answer',
      plannedAction: action?.action ?? 'none',
      contractValid,
      stage,
      ...(failureCodes.get(field.id) ? { failureCode: failureCodes.get(field.id)! } : {}),
    };
  });
}

export interface CoverageSummary {
  scanned: number;
  classified: number;
  deterministic: number;
  executed: number;
  verified: number;
  optionalBlank: number;
  rejected: number;
  unclassified: number;
  noProfileValue: number;
  /** Verified as a share of everything that was safely answerable. */
  coverageRatio: number;
}

export function summarizeCoverage(rows: readonly FieldCoverage[]): CoverageSummary {
  const count = (stage: CoverageStage): number => rows.filter((row) => row.stage === stage).length;
  const verified = count('verified');
  const answerable = rows.filter(
    (row) => row.stage !== 'optional_blank' && row.stage !== 'unclassified',
  ).length;

  return {
    scanned: rows.length,
    classified: rows.filter((row) => row.intent !== 'unknown').length,
    deterministic: rows.filter((row) => row.hasProfileValue).length,
    executed: count('executed') + verified,
    verified,
    optionalBlank: count('optional_blank'),
    rejected: count('action_rejected'),
    unclassified: count('unclassified'),
    noProfileValue: count('no_profile_value'),
    coverageRatio: answerable === 0 ? 1 : verified / answerable,
  };
}

/** One log line per run. Safe to leave on: no values, only shapes and counts. */
export function describeCoverage(rows: readonly FieldCoverage[]): string {
  const summary = summarizeCoverage(rows);
  const byStage = COVERAGE_STAGES.map(
    (stage) => `${stage}=${rows.filter((row) => row.stage === stage).length}`,
  ).join(' ');
  return `scanned=${summary.scanned} classified=${summary.classified} ${byStage} coverage=${Math.round(
    summary.coverageRatio * 100,
  )}%`;
}
