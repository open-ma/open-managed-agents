import * as Dialog from "@radix-ui/react-dialog";
import { type JSX, type ReactNode } from "react";

/**
 * Modal wrapper around Radix Dialog. Public API is unchanged from the
 * previous hand-rolled version (open / onClose / title / subtitle /
 * maxWidth / children / footer); internals delegate focus trap, scroll
 * lock, escape handling, and tab cycling to Radix's primitives.
 *
 * Animations are CSS keyframes keyed off `data-state` (set by Radix on
 * Overlay/Content). The .modal-overlay and .modal-content rules in
 * index.css drive fade + zoom on open/close — Radix waits for the
 * close animation to finish before unmounting via its internal
 * Presence wrapper.
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  maxWidth?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidth = "max-w-lg",
  children,
  footer,
}: ModalProps): JSX.Element {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay fixed inset-0 bg-bg-overlay z-50" />
        <Dialog.Content
          // When there's no subtitle we don't render Dialog.Description, so
          // tell Radix not to expect one (suppresses the dev a11y warning
          // without overriding the auto-wired aria-describedby when a
          // Description IS rendered).
          {...(subtitle === undefined ? { "aria-describedby": undefined } : {})}
          className={`modal-content bg-bg rounded-lg shadow-xl w-full ${maxWidth} max-h-[85vh] flex flex-col fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 outline-none`}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold font-display truncate">
                {title}
              </Dialog.Title>
              {subtitle && (
                <Dialog.Description className="text-sm text-fg-muted mt-0.5">
                  {subtitle}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                className="shrink-0 inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 text-fg-subtle hover:text-fg rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                aria-label="Close"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>

          {/* Footer */}
          {footer && (
            <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
