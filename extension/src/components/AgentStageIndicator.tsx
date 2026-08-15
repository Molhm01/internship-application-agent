import type { AutofillRunPhaseState } from '../storage/runState.js';

/**
 * Observe → Decide → Act → Verify.
 *
 * The loop is the product's actual architecture, not a metaphor drawn on top of
 * it: `agentLoop.ts` observes the page, `agentDecision.ts` returns exactly one
 * decision, `agentToolExecutor.ts` performs it, and `domVerifier.ts` checks
 * what the page kept. Showing those four stages is showing the system, which is
 * why this is the one place the interface is allowed to be emphatic.
 *
 * Two rules keep it honest:
 *
 * 1. **The stage shown is derived from the run's own state**, never from a
 *    timer. A stage that advances on a schedule is an animation pretending to
 *    be telemetry, and it would be lying precisely when the run is stuck —
 *    which is the moment somebody is watching it.
 * 2. **Verify is a stage, not a flourish.** It gets equal weight to the other
 *    three because "we checked" is the claim this product is built on.
 */

export const AGENT_STAGES = ['observe', 'decide', 'act', 'verify'] as const;

export type AgentStage = (typeof AGENT_STAGES)[number];

export const AGENT_STAGE_LABELS: Record<AgentStage, string> = {
  observe: 'Observe',
  decide: 'Decide',
  act: 'Act',
  verify: 'Verify',
};

/**
 * Which stage a run state belongs to.
 *
 * Every run state maps to exactly one stage, and the terminal states map to
 * `null` — a finished run is not sitting in Verify, it is done, and leaving the
 * last stage lit would read as work still in flight.
 */
export function stageForRunState(state: AutofillRunPhaseState): AgentStage | null {
  switch (state) {
    case 'SCANNING':
    case 'NORMALIZING':
    case 'RESCANNING_DEPENDENCIES':
      return 'observe';
    case 'RESOLVING_DETERMINISTIC':
    case 'ANALYZING_AI':
      return 'decide';
    case 'EXECUTING_DETERMINISTIC':
    case 'EXECUTING_AI':
    case 'PROCESSING_DROPDOWNS':
      return 'act';
    case 'VERIFYING_DETERMINISTIC':
    case 'VERIFYING_AI':
      return 'verify';
    case 'IDLE':
    case 'WAITING_FOR_USER':
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED':
      return null;
    default:
      return null;
  }
}

export interface AgentStageIndicatorProps {
  /** The stage in flight, or null when nothing is running. */
  current: AgentStage | null;
  /**
   * One line per stage saying what it did or is doing — "32 controls detected",
   * "Saved profile matches New Jersey". Supplied by the caller from the run's
   * real activity; this component invents nothing.
   */
  detail?: Partial<Record<AgentStage, string>>;
  /** Compact drops the per-stage detail lines. Used in the popup. */
  compact?: boolean;
}

export function AgentStageIndicator({
  current,
  detail,
  compact = false,
}: AgentStageIndicatorProps): JSX.Element {
  const currentIndex = current ? AGENT_STAGES.indexOf(current) : -1;

  return (
    <ol
      className={`stages${compact ? ' stages--compact' : ''}`}
      // The whole strip is one live region: the stage and its detail change
      // together, and announcing them separately would interleave into
      // nonsense on a fast run.
      aria-live="polite"
      aria-label="Agent loop stage"
    >
      {AGENT_STAGES.map((stage, index) => {
        const state =
          currentIndex === -1
            ? 'idle'
            : index < currentIndex
              ? 'done'
              : index === currentIndex
                ? 'active'
                : 'ahead';
        const line = detail?.[stage];
        return (
          <li key={stage} className={`stage stage--${state}`}>
            <span className="stage__marker" aria-hidden="true">
              <span className="stage__dot" />
            </span>
            <span className="stage__label">{AGENT_STAGE_LABELS[stage]}</span>
            {!compact && line ? <span className="stage__detail">{line}</span> : null}
            {/* The visible label is one word; on its own it does not say which
                of the four is happening now. */}
            {state === 'active' ? <span className="sr-only">— in progress</span> : null}
            {state === 'done' ? <span className="sr-only">— complete</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
