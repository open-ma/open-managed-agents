/**
 * Inline SVG icons used across the console — single source of truth so the
 * sidebar nav, page headers, badges, and any future surfaces all render the
 * same glyph for the same concept.
 *
 * Each icon accepts an optional `className` (defaults to w-4 h-4) and
 * inherits `currentColor` from its parent text color, so dark mode and
 * status tones (info / danger / success) work automatically.
 *
 * Stroke-based by default; brand marks (Linear / GitHub / Slack) pass
 * `fill` because their official paths are designed for fill rendering.
 */

import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

function StrokeIcon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      className={className ?? "w-4 h-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}

function FillIcon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      className={className ?? "w-4 h-4"}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * Wrapper for the larger, thinner-stroked icons used inside `<EmptyState>`.
 * Defaults to 36px (w-9) and stroke-width 1.5 so the glyph reads as a
 * decorative illustration rather than a chunky UI affordance. Takes
 * `children` so individual icons can mix paths, circles, and grouped
 * transforms (e.g. the tilted `EmptyFileIcon`).
 */
function EmptyStateSvg({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className ?? "w-9 h-9"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

// ─── Resource icons (used in sidebar nav AND page header badges) ──────────

export function DashboardIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />;
}

export function AgentIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />;
}

export function SessionsIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />;
}

export function EnvIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />;
}

export function VaultIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />;
}

export function SkillsIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M13 10V3L4 14h7v7l9-11h-7z" />;
}

export function MemoryIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />;
}

export function ModelCardsIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />;
}

export function ApiKeysIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />;
}

/** Local Runtimes — the user's machine running `oma bridge daemon`. Laptop /
 *  desktop-mac silhouette. */
export function RuntimesIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />;
}

export function FilesIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />;
}

// ─── Brand marks (simple-icons paths, full 0..24 coverage, fill-rendered) ─

export function LinearIcon({ className }: IconProps) {
  return <FillIcon className={className} d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />;
}

export function GitHubIcon({ className }: IconProps) {
  return <FillIcon className={className} d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />;
}

export function SlackIcon({ className }: IconProps) {
  return <FillIcon className={className} d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />;
}

// ─── Generic UI icons ────────────────────────────────────────────────────

export function ClockIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />;
}

// "Time spent" / duration. Same glyph as ClockIcon for now — kept separate
// so the call site reads as intent (duration vs absolute time).
export function DurationIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />;
}

export function ChevronDownIcon({ className }: IconProps) {
  return <StrokeIcon className={className} d="M19 9l-7 7-7-7" />;
}

// ─── EmptyState entity icons ──────────────────────────────────────────────
// Larger, thinner-stroked illustrations rendered above the title in
// `<EmptyState>`. Distinct from the sidebar nav icons (which are 16px and
// chunkier) so the empty page reads as an illustration, not a button. Each
// is intentionally a different shape vocabulary (hexagon, isometric box,
// bar chart, padlock, …) so a user glancing at any list page can tell at a
// distance "ah, that's the agents empty state, not the vaults one."

/** Hexagonal robot head with two eye slits and a mouth bar. Avoids the
 *  cliché chat-bubble "AI assistant" look. */
export function EmptyAgentIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z" />
      <path d="M9 11 v2 M15 11 v2" />
      <path d="M9.5 16 h5" />
    </EmptyStateSvg>
  );
}

/** Two overlapping speech bubbles — back bubble in the top-right, front
 *  bubble in the bottom-left. Reads as "a conversation" without copying
 *  any existing messenger app icon. */
export function EmptySessionIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M11 3 h9 a1 1 0 011 1 v6 a1 1 0 01-1 1 h-3 l-2 2 v-2 h-4 a1 1 0 01-1-1 V4 a1 1 0 011-1 Z" />
      <path d="M3 9 h9 a1 1 0 011 1 v6 a1 1 0 01-1 1 h-4 l-2 2 v-2 H3 a1 1 0 01-1-1 v-6 a1 1 0 011-1 Z" />
    </EmptyStateSvg>
  );
}

/** Document with the canonical folded corner, tilted ~6° so it doesn't
 *  feel like a database table row. */
export function EmptyFileIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <g transform="rotate(-6 12 12)">
        <path d="M6 3 h8 l4 4 v13 a1 1 0 01-1 1 H6 a1 1 0 01-1-1 V4 a1 1 0 011-1 Z" />
        <path d="M14 3 v4 h4" />
        <path d="M8 12 h7 M8 15 h5 M8 18 h6" />
      </g>
    </EmptyStateSvg>
  );
}

/** Padlock with a combination dial in the body — the dial is the
 *  visual differentiator from a generic lock icon and from `EnvIcon`'s
 *  rectangle silhouette. */
export function EmptyVaultIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M5 11 h14 a1 1 0 011 1 v7 a1 1 0 01-1 1 H5 a1 1 0 01-1-1 v-7 a1 1 0 011-1 Z" />
      <path d="M8 11 V7 a4 4 0 018 0 V11" />
      <circle cx="12" cy="15.5" r="2" />
      <path d="M12 13.5 V14.5" />
    </EmptyStateSvg>
  );
}

/** Isometric 3D box / container. Picked over a flat rectangle so it can't
 *  be confused with `EmptyVaultIcon`'s padlock body or
 *  `EmptyRuntimeIcon`'s rack units. */
export function EmptyEnvIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M12 3 L20 7 L20 16 L12 20 L4 16 L4 7 Z" />
      <path d="M4 7 L12 11 L20 7" />
      <path d="M12 11 V20" />
    </EmptyStateSvg>
  );
}

/** Three vertical bars of unequal height with a baseline — reads as
 *  "benchmark results" without copying any specific chart lib. */
export function EmptyEvalIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M3 20 H21" />
      <path d="M6 20 V14 H9 V20" />
      <path d="M11 20 V7 H14 V20" />
      <path d="M16 20 V11 H19 V20" />
    </EmptyStateSvg>
  );
}

/** Front card with two stack-hint lines above suggesting more cards
 *  layered behind. Picked over "stacked discs" because discs would
 *  collide visually with the database cylinder used for memory. */
export function EmptySkillIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M5 6 h12 v1" />
      <path d="M3 9 h14 v1" />
      <path d="M2 12 h16 a1 1 0 011 1 v6 a1 1 0 01-1 1 H2 a1 1 0 01-1-1 v-6 a1 1 0 011-1 Z" />
    </EmptyStateSvg>
  );
}

/** Database cylinder with one mid-line divider — the universal "data
 *  store" glyph, kept simple so it stays distinguishable from the
 *  stacked-card `EmptySkillIcon` above. */
export function EmptyMemoryIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M3 6 a9 3 0 1 0 18 0 a9 3 0 1 0 -18 0" />
      <path d="M3 6 v12 a9 3 0 0 0 18 0 V6" />
      <path d="M3 12 a9 3 0 0 0 18 0" />
    </EmptyStateSvg>
  );
}

/** Card frame with three horizontal bars inside — mocks the
 *  label/value/sub layout of an actual model-card row. */
export function EmptyModelCardIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M3 5 h18 a1 1 0 011 1 v12 a1 1 0 01-1 1 H3 a1 1 0 01-1-1 V6 a1 1 0 011-1 Z" />
      <path d="M6 10 h6" />
      <path d="M6 13 h12" />
      <path d="M6 16 h8" />
    </EmptyStateSvg>
  );
}

/** Key silhouette — round bow on the left with a hole in it, shaft
 *  pointing right, two teeth at the tip. Different from the existing
 *  `ApiKeysIcon` (hex-handle key) so the empty state has its own
 *  vocabulary. */
export function EmptyApiKeyIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <circle cx="7" cy="12" r="3.5" />
      <circle cx="7" cy="12" r="1" />
      <path d="M10.5 12 H21" />
      <path d="M19 12 V14" />
      <path d="M16 12 V13.5" />
    </EmptyStateSvg>
  );
}

/** Server rack with two stacked 1U units, each with a left-side handle
 *  bar and a right-side indicator dot. Reads unmistakably as
 *  "hardware" so it can't be confused with the env container or the
 *  vault padlock. */
export function EmptyRuntimeIcon({ className }: IconProps) {
  return (
    <EmptyStateSvg className={className}>
      <path d="M3 4 h18 a1 1 0 011 1 v5 a1 1 0 01-1 1 H3 a1 1 0 01-1-1 V5 a1 1 0 011-1 Z" />
      <path d="M3 13 h18 a1 1 0 011 1 v5 a1 1 0 01-1 1 H3 a1 1 0 01-1-1 v-5 a1 1 0 011-1 Z" />
      <path d="M5 6 v3 M5 15 v3" />
      <circle cx="18" cy="7.5" r="0.6" />
      <circle cx="18" cy="16.5" r="0.6" />
    </EmptyStateSvg>
  );
}
