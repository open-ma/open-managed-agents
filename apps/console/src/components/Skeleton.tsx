import type { CSSProperties, JSX } from "react";

interface SkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
  style?: CSSProperties;
}

const radiusCls: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

/**
 * Static placeholder block for in-flight content. Pulses opacity instead
 * of a gradient sweep — quieter at scale (a long list of skeleton rows
 * shouldn't read as "moving"). prefers-reduced-motion freezes it.
 *
 * Caller controls width/height via className. Example:
 *   <Skeleton className="h-4 w-32" />
 *   <Skeleton className="h-9 w-9" rounded="full" />
 */
export function Skeleton({ className = "", rounded = "md", style }: SkeletonProps): JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={`bg-bg-surface skeleton-pulse ${radiusCls[rounded]} ${className}`}
    />
  );
}

interface SkeletonRowsProps {
  count: number;
  height?: number;
  gap?: number;
}

/**
 * Convenience for "loading a tabular list" — N evenly-spaced full-width
 * rows. Match approximate row height of your real table to avoid a
 * jarring layout shift when data lands.
 */
export function SkeletonRows({ count, height = 36, gap = 12 }: SkeletonRowsProps): JSX.Element {
  return (
    <div className="px-4 py-3" style={{ display: "grid", gap: `${gap}px` }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="w-full" rounded="md" style={{ height: `${height}px` }} />
      ))}
    </div>
  );
}
