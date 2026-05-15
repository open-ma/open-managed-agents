import type { ReactNode } from "react";
import { BrandLoader } from "./BrandLoader";

/**
 * Zero-data placeholder. Renders the brand mark `[ ]` (or the BrandLoader
 * pulsing version when `loading`) plus a title + body + optional CTA slot.
 *
 * Used wherever a list / detail / dashboard panel has no content to show.
 * The brand mark anchors the empty space so it doesn't read as a broken
 * page — the bracket vocabulary signals "openma" the way a hand-drawn
 * illustration signals personality elsewhere.
 *
 * Sizes:
 *   - sm  → fits inside table-empty rows or panel slots
 *   - md  → default, used at section level
 *   - lg  → page-level (when the whole route has no content)
 */
const SIZE: Record<"sm" | "md" | "lg", { wrap: string; mark: string; gap: string; title: string; body: string }> = {
  sm: { wrap: "py-6 px-4", mark: "text-base", gap: "mb-2", title: "text-sm", body: "text-xs" },
  md: { wrap: "py-10 px-6", mark: "text-lg", gap: "mb-3", title: "text-sm", body: "text-[13px]" },
  lg: { wrap: "py-16 px-8", mark: "text-2xl", gap: "mb-4", title: "text-base", body: "text-sm" },
};

interface EmptyStateProps {
  title: string;
  /** Body text below the title. Optional. */
  body?: ReactNode;
  /** Action slot (Button, Link, or button-styled anchor). */
  action?: ReactNode;
  size?: keyof typeof SIZE;
  /** Show the BrandLoader pulse instead of the static `[ ]` mark.
   *  Used when the empty state is also a loading state — matches the
   *  visual language without a distinct spinner widget. */
  loading?: boolean;
  className?: string;
}

export function EmptyState({
  title,
  body,
  action,
  size = "md",
  loading,
  className = "",
}: EmptyStateProps) {
  const s = SIZE[size];
  return (
    <div
      className={`border border-border rounded-lg bg-bg-surface/30 text-center ${s.wrap} ${className}`.trim()}
    >
      <div className={`flex justify-center ${s.gap}`}>
        {loading ? (
          <BrandLoader size={size} label={title} />
        ) : (
          <span
            aria-hidden="true"
            className={`font-mono font-bold text-fg-subtle select-none ${s.mark}`}
          >
            [&nbsp;&nbsp;]
          </span>
        )}
      </div>
      <p className={`text-fg ${s.title} font-medium`}>{title}</p>
      {body && <p className={`text-fg-muted mt-1.5 ${s.body}`}>{body}</p>}
      {action && <div className="mt-4 inline-flex">{action}</div>}
    </div>
  );
}
