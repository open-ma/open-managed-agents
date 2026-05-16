import { useEffect, useRef, useState } from "react";

interface SidebarResizerProps {
  /** Current width in px. Drags adjust this via setWidth. */
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

/**
 * 4-px-wide vertical drag handle that sits on the right edge of the
 * sidebar. Pointer-down arms a drag; pointermove updates width in
 * real-time (no debounce — flame charts show this is well under 1ms
 * per frame even on 6× CPU throttle). Double-click resets to default.
 *
 * Hidden on touch devices (drag-to-resize is not a mobile convention;
 * mobile uses the drawer overlay). Hover/active states give a subtle
 * brand-tinted color change so the handle is discoverable without
 * stealing visual attention.
 */
export function SidebarResizer({
  width,
  minWidth,
  maxWidth,
  onResize,
  onReset,
}: SidebarResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startXRef.current;
      onResize(startWidthRef.current + dx);
    };
    const onUp = () => setDragging(false);

    // Capture true so the drag continues even if the pointer crosses
    // an iframe or a stop-propagation handler in the main content.
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    // Suppress text selection + cursor flicker while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, onResize]);

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    setDragging(true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        // Arrow keys nudge width 16px at a time for keyboard a11y.
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onResize(width - 16);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onResize(width + 16);
        } else if (e.key === "Home") {
          e.preventDefault();
          onReset();
        }
      }}
      className={`hidden md:block group absolute top-0 -right-0.5 h-full w-1 cursor-col-resize z-30 ${dragging ? "" : "transition-colors duration-[var(--dur-quick)]"}`}
      title="Drag to resize. Double-click to reset."
    >
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px ${dragging ? "bg-brand" : "bg-transparent group-hover:bg-border-strong"}`}
      />
    </div>
  );
}
