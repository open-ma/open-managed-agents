import { useId, useState, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";

/**
 * Collapsible section with chevron indicator and aria-expanded wiring.
 *
 * Wraps `@radix-ui/react-collapsible` so we get free Escape support,
 * proper aria-controls / aria-expanded linkage, and animated height
 * transitions via CSS keyframes keyed off `data-state` (see
 * `.collapsible-content` rules in src/index.css).
 *
 * Two trigger variants:
 *   - default ("border")  → bordered row with title left + chevron right
 *   - "bare"              → no border, used inside list rows / cards
 *                           where the parent already provides chrome
 */
interface DisclosureProps {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
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
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  // Stable id pair for aria — Radix wires aria-controls / id automatically
  // on Trigger/Content, but we still want a deterministic key for tests
  // and external aria refs to attach to.
  const _id = useId();

  const wrapperCls = variant === "border" ? "border border-border rounded-md" : "";

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={`${wrapperCls} ${className}`.trim()}
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2.5 min-h-11 sm:min-h-0 text-left"
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
      </Collapsible.Trigger>
      <Collapsible.Content className="collapsible-content overflow-hidden">
        <div className="px-3 pb-3">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
