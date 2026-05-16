import * as Toast from "@radix-ui/react-toast";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

/**
 * Toast queue built on Radix Toast primitives. The public API
 * (`<ToastProvider>` and `useToast()` → `{ toast(message, type?) }`) is
 * unchanged from the previous hand-rolled version, so the ~30 pages
 * already calling `toast(...)` continue to work without edits.
 *
 * Radix buys us swipe-to-dismiss, focus management, pause-on-hover,
 * pause-on-focus, escape-to-dismiss, an aria-live region, and the
 * F8-to-jump-to-viewport landmark — all of which the previous version
 * lacked.
 *
 * Open/close animation is CSS keyframes keyed off `data-state` on
 * `Toast.Root` (see `.toast-root` rules in index.css). The swipe gesture
 * drives `data-swipe` + `--radix-toast-swipe-move-x`, so the card
 * follows the pointer during a drag and flies off when released past
 * the swipeThreshold.
 *
 * Visual treatment matches the previous design: bg/border/shadow tokens
 * with a small coloured icon at the leading edge. We deliberately do
 * NOT use a thick `border-left` colour stripe — coloured stripes that
 * read as "decorative left border > 1px" are banned by the project's
 * design system; the leading icon carries the same status signal at
 * lower visual weight.
 */

type ToastType = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export const useToast = () => useContext(ToastContext);

let nextId = 0;

// Should match the longest close animation in index.css (slide-out /
// swipe-out). After this delay the closed toast is removed from the
// queue so React unmounts the Radix root.
const REMOVE_DELAY = 250;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, type, message }]);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <Toast.Provider swipeDirection="right" duration={4000}>
        {children}
        {toasts.map((t) => (
          <ToastItem key={t.id} item={t} onRemove={() => remove(t.id)} />
        ))}
        {/* Bottom-right on desktop, bottom-center on mobile. Width is
            fixed so toasts stack consistently; on narrow screens we
            clamp to viewport width minus a 16px gutter on each side. */}
        <Toast.Viewport
          className={
            "fixed bottom-4 right-4 z-[100] m-0 flex w-[360px] " +
            "max-w-[calc(100vw-32px)] list-none flex-col gap-2 p-0 outline-none " +
            "max-sm:left-1/2 max-sm:right-auto max-sm:-translate-x-1/2"
          }
        />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

const iconColor: Record<ToastType, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
};

const icons: Record<ToastType, ReactNode> = {
  info: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  ),
  success: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  warning: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  error: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
};

function ToastItem({
  item,
  onRemove,
}: {
  item: ToastItem;
  onRemove: () => void;
}) {
  // Controlled `open` so the close animation plays before we drop the
  // item from the queue. Radix flips this to false on auto-dismiss
  // (duration), the X button, Escape, or a completed swipe.
  const [open, setOpen] = useState(true);

  // error / warning are "foreground" (assertive, interrupts SR queue);
  // info / success are "background" (polite, waits its turn). Radix
  // maps these to the appropriate aria-live + role pair.
  const priority: "foreground" | "background" =
    item.type === "error" || item.type === "warning"
      ? "foreground"
      : "background";

  return (
    <Toast.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          window.setTimeout(onRemove, REMOVE_DELAY);
        }
      }}
      type={priority}
      className={
        "toast-root pointer-events-auto flex w-full items-center gap-2.5 " +
        "rounded-md border border-border bg-bg py-2 pl-3 pr-2 " +
        "text-[13px] text-fg shadow-[var(--shadow-md)]"
      }
    >
      <span className={`shrink-0 ${iconColor[item.type]}`}>{icons[item.type]}</span>
      <Toast.Title className="flex-1 leading-tight">{item.message}</Toast.Title>
      <Toast.Close
        className={
          "shrink-0 -m-1 rounded p-1 text-fg-subtle hover:text-fg " +
          "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        }
        aria-label="Dismiss"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </Toast.Close>
    </Toast.Root>
  );
}
