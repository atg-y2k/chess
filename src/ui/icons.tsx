/**
 * Minimal inline SVG icon set (24x24, stroke = currentColor). Size with CSS (`width/height`)
 * or the `size` prop.
 */
import type { ComponentChildren } from 'preact';

interface IconProps {
  size?: number;
  class?: string;
}

function Svg({ size = 24, class: cls, children }: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const IconBulb = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18h6M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
  </Svg>
);

export const IconFlip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4v16M7 20l-3-3M7 20l3-3" />
    <path d="M17 20V4M17 4l-3 3M17 4l3 3" />
  </Svg>
);

export const IconCoach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h16v10H9l-5 4V5Z" />
    <path d="M9 9h6M9 12h3" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="m7 15 4-4 3 3 6-7" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const IconShare = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v13M7 8l5-5 5 5" />
    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const IconSound = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
);

export const IconCpu = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Svg>
);

export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 18a9 9 0 1 1 15 0" />
    <path d="m12 14 4-5" />
    <circle cx="12" cy="14" r="1.2" />
  </Svg>
);

export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.8 2.8L16.5 9.5" />
  </Svg>
);

/** The explorer: a branching line (try moves off the game). */
export const IconExplore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="7" r="2.5" />
    <path d="M6 7v8.5" />
    <path d="M18 9.5c0 4.5-6.5 3.5-10.5 7" />
  </Svg>
);

/** Start over (the explorer's Reset). */
export const IconReset = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
    <path d="M3.5 3.5v5h5" />
  </Svg>
);

/** Rating the opponent's moves: the computer's head with a verdict mark. */
export const IconBotRated = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="8" width="13" height="11" rx="3" />
    <path d="M9.5 8V5M8.5 3.5h2" />
    <circle cx="7" cy="13" r="0.6" fill="currentColor" />
    <circle cx="12" cy="13" r="0.6" fill="currentColor" />
    <path d="M7.5 16.2h4" />
    <path d="M20 4v7M20 14.5v.5" />
  </Svg>
);

/** Openings: an open book. */
export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 6.5C10.2 5 7.6 4.5 3.5 4.8v13.4c4.1-.3 6.7.2 8.5 1.8 1.8-1.6 4.4-2.1 8.5-1.8V4.8c-4.1-.3-6.7.2-8.5 1.7Z" />
    <path d="M12 6.5V20" />
  </Svg>
);
