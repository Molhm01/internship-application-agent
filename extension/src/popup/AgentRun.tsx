import type { AgentProgress } from '@internship-agent/shared';
import {
  AgentStageIndicator,
  stageForRunState,
  type AgentStage,
} from '../components/AgentStageIndicator.js';
import { FieldStatusRow } from '../components/FieldStatusRow.js';
import { refineActiveStatus, type FieldDisplayStatus } from '../components/fieldStatus.js';
import type { AutofillRunPhaseState } from '../storage/runState.js';

/**
 * What the agent is doing to this page, while it is doing it.
 *
 * Everything rendered here comes from two sources the run already produces: the
 * run state stored by the background worker, and the `AGENT_PROGRESS`
 * broadcasts the loop emits on each step. Nothing is inferred, nothing is
 * timed, and nothing is animated forward on its own — a stage that advances on
 * a schedule would be lying at exactly the moment somebody is watching.
 *
 * The one rule this component exists to enforce: **attempted is not verified.**
 * The verified list is the loop's own `completed`, which a label may only enter
 * after `verification === 'VERIFIED'`. The control being worked on right now is
 * rendered from the activity sentence, in a running tone, with no value beside
 * it. There is no path by which the second can render as the first.
 */

/** The employer's wording, taken from the loop's own activity sentence. */
function activeLabelFrom(activity: string): string | null {
  const working = /^Working on (.+)$/.exec(activity);
  if (working?.[1]) return working[1];
  const asking = /^Need your input: (.+)$/.exec(activity);
  if (asking?.[1]) return asking[1];
  return null;
}

/**
 * The per-stage line under Observe / Decide / Act / Verify.
 *
 * Only stages the run has actually reported anything about get a line. An empty
 * stage says nothing rather than filling the space with a plausible sentence,
 * which is the difference between instrumentation and decoration.
 */
export function stageDetail(
  progress: AgentProgress | null,
  runState: AutofillRunPhaseState,
  fieldsDetected: number | null,
): Partial<Record<AgentStage, string>> {
  const detail: Partial<Record<AgentStage, string>> = {};
  if (fieldsDetected !== null) {
    detail.observe = `${fieldsDetected} ${fieldsDetected === 1 ? 'control' : 'controls'} detected`;
  }
  const stage = stageForRunState(runState);
  const activity = progress?.activity ?? '';
  const label = activeLabelFrom(activity);
  if (stage === 'decide' && activity) detail.decide = activity;
  if (stage === 'act' && label) detail.act = `Working on ${label}`;
  if (progress && progress.completed.length > 0) {
    detail.verify = `${progress.completed.length} ${
      progress.completed.length === 1 ? 'answer' : 'answers'
    } accepted by the page`;
  }
  return detail;
}

export interface AgentRunProps {
  runState: AutofillRunPhaseState;
  progress: AgentProgress | null;
  /** Controls the scan found on this page, when a scan has run. */
  fieldsDetected: number | null;
  /** How far the fill pipeline has got, when it is reporting counts. */
  fieldsCompleted?: number;
  fieldsTotal?: number;
  /** The sentence the run state names, e.g. "Verifying saved answers…". */
  phaseLabel: string;
  elapsed: string;
  onCancel: () => void;
  /** Caps the verified list, so the popup does not become a scroll. */
  limit?: number;
}

export function AgentRun({
  runState,
  progress,
  fieldsDetected,
  fieldsCompleted,
  fieldsTotal,
  phaseLabel,
  elapsed,
  onCancel,
  limit = 6,
}: AgentRunProps): JSX.Element {
  const stage = stageForRunState(runState);
  const activity = progress?.activity ?? '';
  const activeLabel = activeLabelFrom(activity);
  const askingAbout = /^Need your input: /.test(activity);
  // Coarse from the run state, then narrowed by the activity sentence — the
  // order matters, and `refineActiveStatus` can never return VERIFIED.
  const activeStatus: FieldDisplayStatus = askingAbout
    ? 'NEEDS_INPUT'
    : refineActiveStatus('PROCESSING', activity);
  // The newest first: on a long form the last few verified controls are the
  // evidence that the run is moving, and the first few are minutes old.
  const verified = [...(progress?.completed ?? [])].reverse().slice(0, limit);
  const hidden = Math.max(0, (progress?.completed.length ?? 0) - verified.length);
  const total = fieldsTotal ?? 0;
  const done = Math.min(fieldsCompleted ?? 0, total);

  return (
    <div className="agentrun">
      <div className="agentrun__head">
        {/*
          The one live region for the run. The stage strip and the field list
          change on every step; announcing each of them would bury the sentence
          that actually says what is happening.
        */}
        <p className="agentrun__phase" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {phaseLabel}
        </p>
        <span className="agentrun__elapsed mono">{elapsed}</span>
      </div>

      {total > 0 ? (
        <div className="agentrun__meter">
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-label="Fields handled"
          >
            <div
              className="progress-fill"
              style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
            />
          </div>
          <span className="agentrun__count mono">
            {done} / {total} fields
          </span>
        </div>
      ) : (
        // No counts yet is a real state — the scan has not finished — and it is
        // shown as an indeterminate bar rather than as 0 / 0, which reads as a
        // run that found nothing.
        <div className="progress-track progress-track--indeterminate" aria-hidden="true">
          <div className="progress-fill" />
        </div>
      )}

      <AgentStageIndicator
        current={stage}
        detail={stageDetail(progress, runState, fieldsDetected)}
      />

      {activeLabel || verified.length > 0 ? (
        <ul className="agentrun__fields">
          {activeLabel ? (
            <FieldStatusRow
              key={`active-${activeLabel}`}
              label={activeLabel}
              status={activeStatus}
              {...(askingAbout ? {} : { reason: activity })}
            />
          ) : null}
          {verified.map((label) => (
            <FieldStatusRow key={label} label={label} status="VERIFIED" />
          ))}
        </ul>
      ) : null}

      {hidden > 0 ? (
        <p className="agentrun__more muted">
          and {hidden} more {hidden === 1 ? 'answer' : 'answers'} verified earlier in this run
        </p>
      ) : null}

      <button type="button" className="btn--ghost btn--sm agentrun__cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
