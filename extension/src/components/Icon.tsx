import type { SVGProps } from 'react';

/**
 * The extension's icon set, drawn inline.
 *
 * No icon package. A dependency that ships a thousand glyphs to render the
 * fourteen this product uses is weight the service worker and four pages all
 * pay for, and the popup's job is to open instantly. These are hand-drawn on a
 * 16-unit grid with a 1.5 stroke, which is what keeps them looking like one
 * family rather than fourteen borrowed marks.
 *
 * Every icon inherits `currentColor`, so a status colour set on the row is the
 * only thing that decides what colour the glyph is. None of them carries
 * meaning alone — each appears beside its own word.
 */

export type IconName =
  | 'check'
  | 'check-double'
  | 'circle'
  | 'circle-dot'
  | 'spinner'
  | 'question'
  | 'alert'
  | 'shield'
  | 'lock'
  | 'minus'
  | 'slash'
  | 'x'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'external'
  | 'download'
  | 'plus'
  | 'trash'
  | 'pause'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'eye'
  | 'file'
  | 'clock'
  | 'link'
  | 'server'
  | 'cpu'
  | 'user'
  | 'settings'
  | 'activity'
  | 'layers'
  | 'copy';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

/** The path data. Kept as a lookup so the component itself stays one branchless render. */
const PATHS: Record<IconName, JSX.Element> = {
  check: <path d="M3 8.5 6.2 12 13 4.5" />,
  // Two ticks: written, then confirmed. Used only for VERIFIED, which is the
  // distinction this product is built around.
  'check-double': (
    <>
      <path d="M1.5 8.4 4.3 11.4 9.4 5" />
      <path d="M6.6 8.4 9.4 11.4 14.5 5" />
    </>
  ),
  circle: <circle cx="8" cy="8" r="5.2" />,
  'circle-dot': (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  // An arc rather than a ring: the gap is what reads as motion when it spins.
  spinner: <path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8" />,
  question: (
    <>
      <path d="M6 6.1a2.1 2.1 0 1 1 2.7 2q-.7.3-.7 1.1v.5" />
      <circle cx="8" cy="12.1" r="0.85" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.6 14.4 13.4H1.6z" />
      <path d="M8 6.6v3.1" />
      <circle cx="8" cy="11.7" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  shield: <path d="M8 1.9 13.4 4v4.1c0 3-2.2 5.3-5.4 6-3.2-.7-5.4-3-5.4-6V4z" />,
  lock: (
    <>
      <rect x="3.1" y="7" width="9.8" height="7" rx="1.4" />
      <path d="M5.6 7V5.1a2.4 2.4 0 0 1 4.8 0V7" />
    </>
  ),
  minus: <path d="M3.4 8h9.2" />,
  slash: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M4.4 4.4 11.6 11.6" />
    </>
  ),
  x: <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5 13.6 13.6" />
    </>
  ),
  'chevron-down': <path d="M4 6.2 8 10.2l4-4" />,
  'chevron-right': <path d="M6.2 4 10.2 8l-4 4" />,
  'chevron-left': <path d="M9.8 4 5.8 8l4 4" />,
  external: (
    <>
      <path d="M9.4 3.2h3.4v3.4" />
      <path d="M12.8 3.2 7.6 8.4" />
      <path d="M11.6 9.6v2.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V5.8a1.4 1.4 0 0 1 1.4-1.4h2.6" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.6v7.2" />
      <path d="M5 7.1 8 10l3-2.9" />
      <path d="M2.8 12.4h10.4" />
    </>
  ),
  plus: <path d="M8 3.4v9.2M3.4 8h9.2" />,
  trash: (
    <>
      <path d="M2.8 4.5h10.4" />
      <path d="M6.3 4.5V3.2a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.3" />
      <path d="M4.2 4.5l.6 8a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8" />
    </>
  ),
  pause: <path d="M6 3.4v9.2M10 3.4v9.2" />,
  play: <path d="M5.2 3.3 12.4 8l-7.2 4.7z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.2" />,
  refresh: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
      <path d="M13.4 2.4v3.2h-3.2" />
    </>
  ),
  eye: (
    <>
      <path d="M1.6 8S4 3.9 8 3.9 14.4 8 14.4 8 12 12.1 8 12.1 1.6 8 1.6 8" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  file: (
    <>
      <path d="M9.2 1.9H4.6a1.3 1.3 0 0 0-1.3 1.3v9.6a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.1z" />
      <path d="M9.2 1.9v3.2h3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.2 1.5" />
    </>
  ),
  link: (
    <>
      <path d="M6.7 9.3a2.6 2.6 0 0 0 3.8.2l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1 1" />
      <path d="M9.3 6.7a2.6 2.6 0 0 0-3.8-.2L3.6 8.4a2.6 2.6 0 0 0 3.7 3.7l1-1" />
    </>
  ),
  server: (
    <>
      <rect x="2.2" y="2.6" width="11.6" height="4.4" rx="1.1" />
      <rect x="2.2" y="9" width="11.6" height="4.4" rx="1.1" />
      <path d="M4.8 4.8h.01M4.8 11.2h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" />
      <path d="M6.6 1.9v2.5M9.4 1.9v2.5M6.6 11.6v2.5M9.4 11.6v2.5M1.9 6.6h2.5M1.9 9.4h2.5M11.6 6.6h2.5M11.6 9.4h2.5" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.6" r="2.7" />
      <path d="M2.9 13.6a5.1 5.1 0 0 1 10.2 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M12.6 9.8a1.1 1.1 0 0 0 .2 1.2l.1.1a1.3 1.3 0 1 1-1.8 1.8l-.1-.1a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.7 1v.2a1.3 1.3 0 1 1-2.6 0v-.1a1.1 1.1 0 0 0-.7-1 1.1 1.1 0 0 0-1.2.2l-.1.1a1.3 1.3 0 1 1-1.8-1.8l.1-.1a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1-.7h-.2a1.3 1.3 0 1 1 0-2.6h.1a1.1 1.1 0 0 0 1-.7 1.1 1.1 0 0 0-.2-1.2l-.1-.1a1.3 1.3 0 1 1 1.8-1.8l.1.1a1.1 1.1 0 0 0 1.2.2h.1a1.1 1.1 0 0 0 .7-1v-.2a1.3 1.3 0 1 1 2.6 0v.1a1.1 1.1 0 0 0 .7 1 1.1 1.1 0 0 0 1.2-.2l.1-.1a1.3 1.3 0 1 1 1.8 1.8l-.1.1a1.1 1.1 0 0 0-.2 1.2v.1a1.1 1.1 0 0 0 1 .7h.2a1.3 1.3 0 1 1 0 2.6h-.1a1.1 1.1 0 0 0-1 .7" />
    </>
  ),
  activity: <path d="M1.9 8h3l2-5.2 3 10.4 2-5.2h3.2" />,
  layers: (
    <>
      <path d="M8 1.9 14.3 5 8 8.1 1.7 5z" />
      <path d="M1.7 8 8 11.1 14.3 8" />
      <path d="M1.7 11 8 14.1 14.3 11" />
    </>
  ),
  copy: (
    <>
      <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.3" />
      <path d="M10.4 5.6V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.2a1.3 1.3 0 0 0 1.3 1.3h1.7" />
    </>
  ),
};

export function Icon({ name, size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default. Every caller pairs the glyph with its own word,
      // so announcing the icon too would read the status twice.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
