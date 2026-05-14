import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Local-options combobox: the input is the search box AND the value
 * editor. Useful when options come from a small static list (e.g. the
 * MCP server registry) AND the user can also type a value that isn't
 * in the list (e.g. a custom URL).
 *
 * Differs from the cursor-paginated Combobox in this folder:
 *   - Options are passed in (no fetch).
 *   - Input is freely editable; not picking an option is fine.
 *   - Dropdown renders into document.body via createPortal so it
 *     escapes ancestor `overflow:hidden`/`overflow:auto` clipping
 *     (needed when the field lives inside a Modal body).
 *
 * Pick semantics: `onPick(item)` fires when the user clicks an option.
 * Caller decides whether to also write the option's label/url back
 * into `value` via the same handler — usually yes.
 */
export interface LocalComboboxProps<T> {
  value: string;
  onChange: (text: string) => void;
  onPick?: (item: T) => void;
  options: T[];
  filter?: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Left-side adornment (e.g. picked item's favicon). */
  prefix?: ReactNode;
  placeholder?: string;
  /** Container className override; defaults to a sane input shell. */
  className?: string;
  /** Shown inside the dropdown when no options match. */
  emptyHint?: ReactNode;
  /** Max dropdown height. Default 18rem. */
  maxHeight?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

const DEFAULT_INPUT_CLS =
  "w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus-within:border-brand transition-colors flex items-center gap-2";

export function LocalCombobox<T>({
  value,
  onChange,
  onPick,
  options,
  filter,
  getKey,
  renderItem,
  prefix,
  placeholder,
  className,
  emptyHint,
  maxHeight = "18rem",
  disabled,
  autoFocus,
}: LocalComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Track input position so the portal-rendered dropdown follows on
  // resize/scroll. Uses `useLayoutEffect` to avoid a one-frame flicker
  // when first opening (rect is set before the portal paints).
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const lowerQ = value.toLowerCase().trim();
  const matches = filter
    ? options.filter((o) => filter(o, lowerQ))
    : options;

  return (
    <div className="relative" ref={anchorRef}>
      <div className={className ?? DEFAULT_INPUT_CLS} onClick={() => inputRef.current?.focus()}>
        {prefix}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          className="flex-1 bg-transparent outline-none text-sm min-w-0"
        />
        {value && !disabled && (
          <button
            type="button"
            // preventDefault on mousedown stops the input losing focus
            // before our click handler runs (which would close the
            // dropdown via blur, masking the clear).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            className="text-fg-muted hover:text-fg shrink-0 px-1"
            aria-label="Clear"
          >
            ×
          </button>
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className={`text-fg-muted hover:text-fg shrink-0 px-1 transition-transform ${open ? "rotate-180" : ""}`}
          aria-label="Toggle options"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && rect &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onMouseDown={() => setOpen(false)}
            />
            <div
              className="fixed bg-bg border border-border rounded-md shadow-xl z-[9999] overflow-y-auto"
              style={{ top: rect.top, left: rect.left, width: rect.width, maxHeight }}
            >
              {matches.length === 0 ? (
                <div className="px-3 py-4 text-center text-fg-subtle text-xs">
                  {emptyHint ?? "No matches"}
                </div>
              ) : (
                matches.map((item) => (
                  <button
                    key={getKey(item)}
                    type="button"
                    // mousedown picks before the input loses focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick?.(item);
                      setOpen(false);
                    }}
                    className="w-full text-left hover:bg-bg-surface cursor-pointer"
                  >
                    {renderItem(item)}
                  </button>
                ))
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
