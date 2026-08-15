import { Icon, type IconName } from './Icon.js';
import {
  FIELD_STATUS_PRESENTATION,
  type FieldDisplayStatus,
  type StatusTone,
} from './fieldStatus.js';

/**
 * A status, said three ways at once: a glyph, a word, and a colour.
 *
 * The colour is the last of the three and never the only one. Someone who
 * cannot distinguish the verified teal from the success green still reads
 * "Verified" beside a double tick, and a screen reader is given the longer
 * sentence from the presentation table because "Blocked" alone does not say by
 * what.
 */

export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  icon?: IconName;
  /** What a screen reader hears instead of the visible label, when it differs. */
  announcement?: string;
  /** Marks the badge as live so the agent's own state changes are announced. */
  live?: boolean;
  size?: 'sm' | 'lg';
  className?: string;
}

export function StatusBadge({
  tone,
  label,
  icon,
  announcement,
  live = false,
  size = 'sm',
  className = '',
}: StatusBadgeProps): JSX.Element {
  return (
    <span
      className={`badge badge--${tone}${size === 'lg' ? ' badge--lg' : ''}${
        className ? ` ${className}` : ''
      }`}
      {...(live ? { 'aria-live': 'polite' as const } : {})}
    >
      {icon ? (
        <Icon
          name={icon}
          size={size === 'lg' ? 12 : 11}
          className={`badge__glyph${icon === 'spinner' ? ' spinner-glyph' : ''}`}
        />
      ) : null}
      {announcement ? (
        <>
          <span aria-hidden="true">{label}</span>
          <span className="sr-only">{announcement}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** The same badge, driven straight from a field's display status. */
export function FieldStatusBadge({
  status,
  size = 'sm',
}: {
  status: FieldDisplayStatus;
  size?: 'sm' | 'lg';
}): JSX.Element {
  const presentation = FIELD_STATUS_PRESENTATION[status];
  return (
    <StatusBadge
      tone={presentation.tone}
      label={presentation.label}
      icon={presentation.icon}
      announcement={presentation.announcement}
      size={size}
    />
  );
}
