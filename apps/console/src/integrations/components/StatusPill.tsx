// Shared status pill — used by both Linear and GitHub list/workspace pages.
// The status string set here matches both providers' publication state machine
// since they share the same vocabulary (live | pending_setup | awaiting_install
// | needs_reauth | unpublished). Centralizing avoids drift when we add another
// state and forget to update one of two copies.

export type PublicationStatus =
  | "live"
  | "pending_setup"
  | "awaiting_install"
  | "needs_reauth"
  | "unpublished";

interface StatusPillProps {
  status: PublicationStatus;
  /** Slightly larger pill — used in the workspace bot-identity header. */
  size?: "sm" | "md";
}

const MAP: Record<PublicationStatus, { label: string; cls: string; dot: string }> = {
  live: {
    label: "Live",
    cls: "text-success bg-success-subtle",
    dot: "bg-success",
  },
  pending_setup: {
    label: "Pending setup",
    cls: "text-fg-muted bg-bg-surface",
    dot: "bg-fg-muted",
  },
  awaiting_install: {
    label: "Awaiting install",
    cls: "text-warning bg-warning-subtle",
    dot: "bg-warning",
  },
  needs_reauth: {
    label: "Needs reauth",
    cls: "text-danger bg-danger-subtle",
    dot: "bg-danger",
  },
  unpublished: {
    label: "Unpublished",
    cls: "text-fg-subtle bg-bg-surface",
    dot: "bg-fg-subtle",
  },
};

export function StatusPill({ status, size = "sm" }: StatusPillProps) {
  const v = MAP[status];
  const padding = size === "md" ? "px-2.5 py-1 text-[12px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full ${padding} ${v.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      {v.label}
    </span>
  );
}
