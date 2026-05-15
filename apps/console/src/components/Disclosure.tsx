import { useId, useState, type ReactNode } from "react";

/**
 * Collapsible section with chevron indicator and aria-expanded wiring.
 * Replaces the 5+ in-page disclosure patterns (vault OAuth sections,
 * memory version-history, sidebar groups, tool-call cards) that each
 * reimplemented chevron rotation + aria-expanded + panel id.
 *
 * Visual: chevron right→down on open, content below. Trigger uses the
 * same `transition-transform` motion tokens as the rest of the app.
 *
 * Two trigger variants:
 *   - default ("border")  → bordered row with title left + chevron right
 *   - "bare"              → no border, used inside list rows / cards
 *                           where the parent already provides chrome
 */
interface DisclosureProps {
  /** Trigger label content (string or arbitrary nodes). */
  title: ReactNode;
  /** Optional right-aligned label (e.g. "Optional", a count chip). */
  meta?: ReactNode;
  /** Whether the disclosure starts open. */
  defaultOpen?: boolean;
  /** Controlled mode: pass both to override internal state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "border" | "bare";
  className?: string;
  children: ReactNode;
}

export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  variant = "border",
  className = "",
  children,
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const panelId = useId();
  const wrapperCls = variant === "border" ? "border border-border rounded-md" : "";

  return (
    <div className={`${wrapperCls} ${className}`.trim()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={`text-fg-muted transition-transform duration-[var(--dur-base)] ease-[var(--ease-soft)] ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        <span className="text-sm font-medium text-fg flex-1 min-w-0">{title}</span>
        {meta && <span className="text-xs text-fg-muted shrink-0">{meta}</span>}
      </button>
      {open && (
        <div id={panelId} className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
