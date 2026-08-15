import { useMemo, useState } from 'react';
import type { AgentRunTrace } from '@internship-agent/shared';
import { Icon, type IconName } from './Icon.js';
import type { StatusTone } from './fieldStatus.js';

/**
 * What the agent did, in order.
 *
 * Built from the run trace the loop already produces — no second event channel,
 * no logging added to the automation path. That matters twice over: the trace is
 * the artefact people attach to bug reports, so rendering *it* means the screen
 * and the bug report can never disagree; and the trace schema is strict and has
 * no member able to hold a typed value, a password or a model prompt, so
 * nothing shown here can leak an answer.
 *
 * Two densities. The compact view is a sentence and a time, which is what
 * somebody watching a run wants. The detailed view adds the tool, the control
 * kind, how verification was decided, the duration and any error code — the
 * things somebody debugging a run wants, and nobody else.
 */

export interface TimelineEvent {
  id: string;
  /** Wall-clock time, already formatted. */
  time: string;
  /** One sentence in the product's own voice. Never a raw enum. */
  text: string;
  icon: IconName;
  tone: StatusTone;
  /** The technical row, shown only in the detailed view. */
  detail?: {
    tool?: string;
    control?: string;
    verification?: string;
    durationMs?: number;
    errorCode?: string;
    optionsSeen?: number;
  };
}

/** `08:41:04`, in the user's own locale, from an ISO timestamp or a step offset. */
function clockFrom(startedAt: string, offsetMs: number): string {
  const base = Date.parse(startedAt);
  const at = Number.isNaN(base) ? Date.now() : base + offsetMs;
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Turns one trace step into the one or two events a person would recognise.
 *
 * A step that opened a menu, read its choices, clicked one and confirmed it is
 * four things that happened and one row in the trace. Splitting it here is what
 * makes the timeline read like a narrative instead of a table — and the split is
 * driven entirely by fields the step already carries, so no event can describe
 * something the run did not record.
 */
function eventsForStep(
  step: AgentRunTrace['steps'][number],
  startedAt: string,
  offsetMs: number,
): TimelineEvent[] {
  const time = clockFrom(startedAt, offsetMs);
  const label = step.targetLabel || 'the page';
  const events: TimelineEvent[] = [];

  if (step.dropdown && step.optionsSeen > 0) {
    events.push({
      id: `${step.step}-options`,
      time,
      text: `Read ${step.optionsSeen} ${step.optionsSeen === 1 ? 'choice' : 'choices'} in ${label}`,
      icon: 'layers',
      tone: 'idle',
      detail: { control: step.targetKind ?? '', optionsSeen: step.optionsSeen },
    });
  }

  if (step.executed) {
    events.push({
      id: `${step.step}-act`,
      time,
      // "Attempted" is the word, and it is chosen. The verify event below is
      // what is allowed to say it worked.
      text: step.wroteValue ? `Filled ${label}` : `Acted on ${label}`,
      icon: 'circle-dot',
      tone: 'running',
      detail: {
        tool: step.tool ?? '',
        control: step.targetKind ?? '',
        durationMs: step.durationMs,
      },
    });
  }

  if (step.verification === 'VERIFIED') {
    events.push({
      id: `${step.step}-verify`,
      time,
      text: `Verified ${label}`,
      icon: 'check-double',
      tone: 'verified',
      detail: { verification: step.verification, durationMs: step.durationMs },
    });
  } else if (step.verification === 'VERIFICATION_FAILED') {
    events.push({
      id: `${step.step}-verify-failed`,
      time,
      text: `${label} did not keep the value`,
      icon: 'alert',
      tone: 'danger',
      detail: { verification: step.verification, errorCode: step.errorCode ?? '' },
    });
  }

  if (step.decisionType === 'ASK_USER') {
    events.push({
      id: `${step.step}-ask`,
      time,
      text: `Asked you about ${label}`,
      icon: 'question',
      tone: 'pending',
      detail: { control: step.targetKind ?? '' },
    });
  }

  if (events.length === 0) {
    events.push({
      id: `${step.step}-observe`,
      time,
      text: `Observed ${step.observedElements} ${
        step.observedElements === 1 ? 'control' : 'controls'
      }`,
      icon: 'eye',
      tone: 'idle',
      detail: { durationMs: step.durationMs },
    });
  }

  return events;
}

/** Every event in a finished run, oldest first. */
export function eventsFromTrace(trace: AgentRunTrace): TimelineEvent[] {
  let offset = 0;
  return trace.steps.flatMap((step) => {
    const events = eventsForStep(step, trace.startedAt, offset);
    offset += step.durationMs;
    return events;
  });
}

export interface ActivityTimelineProps {
  events: readonly TimelineEvent[];
  /** Starts compact. The toggle is offered only when detail exists to show. */
  defaultDetailed?: boolean;
  /** Caps the rendered list. The newest events are the ones kept. */
  limit?: number;
  emptyLabel?: string;
}

export function ActivityTimeline({
  events,
  defaultDetailed = false,
  limit,
  emptyLabel = 'Nothing has happened yet.',
}: ActivityTimelineProps): JSX.Element {
  const [detailed, setDetailed] = useState(defaultDetailed);
  const shown = useMemo(
    () => (limit === undefined ? events : events.slice(-limit)),
    [events, limit],
  );

  if (shown.length === 0) {
    return <p className="timeline__empty muted">{emptyLabel}</p>;
  }

  return (
    <div className="timeline">
      <div className="timeline__toolbar">
        <span className="eyebrow">Activity</span>
        <button
          type="button"
          className="btn--ghost btn--sm"
          onClick={() => setDetailed((value) => !value)}
          aria-pressed={detailed}
        >
          {detailed ? 'Compact view' : 'Detailed view'}
        </button>
      </div>
      {/*
        Not a live region. A long run produces hundreds of these, and announcing
        each one would bury the two things that actually need saying — the stage
        and the questions — under a stream of narration. Those two are the live
        regions; this is the record you read afterwards.
      */}
      <ol className={`timeline__list${detailed ? ' timeline__list--detailed' : ''}`}>
        {shown.map((event) => (
          <li key={event.id} className={`timeline__event timeline__event--${event.tone} reveal`}>
            <time className="timeline__time">{event.time}</time>
            <span className="timeline__rail" aria-hidden="true">
              <Icon name={event.icon} size={12} />
            </span>
            <span className="timeline__body">
              <span className="timeline__text">{event.text}</span>
              {detailed && event.detail ? (
                <span className="timeline__detail">
                  {event.detail.tool ? <span>tool {event.detail.tool}</span> : null}
                  {event.detail.control ? <span>{event.detail.control}</span> : null}
                  {event.detail.verification ? (
                    <span>verify {event.detail.verification.toLowerCase()}</span>
                  ) : null}
                  {event.detail.optionsSeen ? (
                    <span>{event.detail.optionsSeen} options</span>
                  ) : null}
                  {event.detail.durationMs ? <span>{event.detail.durationMs}ms</span> : null}
                  {event.detail.errorCode ? (
                    <span className="timeline__error">{event.detail.errorCode}</span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
