import { useCallback, useEffect, useState } from "react";

const COLLAPSED_KEY = "oma_sidebar_collapsed";
const WIDTH_KEY = "oma_sidebar_width";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
/** Below this drag width we auto-collapse — saves the user the extra
 *  click of dragging then hitting the toggle. Matches VSCode behavior. */
const COLLAPSE_THRESHOLD = 140;

/**
 * Linear-style sidebar collapse + resize state, persisted to localStorage
 * so the choice survives reloads + tabs.
 *
 * - `[` toggles collapsed (matches Linear / Notion / Zed conventions).
 * - `collapsed`: full icon-only mode at a fixed narrow width.
 * - `width`: the expanded width in px, drag-adjustable between 200-400.
 *   Dragging below 140 auto-collapses; expanding from collapsed restores
 *   to the last saved width (or DEFAULT if none).
 *
 * Returns stable callbacks so consumers downstream don't re-render when
 * a single value changes.
 */
export function useSidebarCollapsed(): {
  collapsed: boolean;
  width: number;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
  setWidth: (w: number) => void;
  resetWidth: () => void;
  // Min / max exposed so the resize handle can clamp at the same bounds
  // the hook would have anyway.
  minWidth: number;
  maxWidth: number;
  collapseThreshold: number;
  defaultWidth: number;
} {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [width, setWidthState] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(WIDTH_KEY) ?? "", 10);
      if (Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH) return v;
    } catch {
      // ignore
    }
    return DEFAULT_WIDTH;
  });

  useEffect(() => {
    try {
      if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1");
      else localStorage.removeItem(COLLAPSED_KEY);
    } catch {
      // localStorage disabled (private mode); not fatal — state still
      // works within the session, just doesn't persist.
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      if (width !== DEFAULT_WIDTH) localStorage.setItem(WIDTH_KEY, String(width));
      else localStorage.removeItem(WIDTH_KEY);
    } catch {
      // ignore
    }
  }, [width]);

  // `[` keybind matches Linear / Notion / Zed. Single-key, no prefix —
  // distinct from the `g`-prefix route chords. Skipped inside form
  // inputs / contentEditable so typing `[` in a textarea works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      e.preventDefault();
      setCollapsed((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  const setWidth = useCallback((w: number) => {
    // Auto-collapse below threshold so dragging tiny doesn't leave the
    // sidebar in an unusable in-between state.
    if (w < COLLAPSE_THRESHOLD) {
      setCollapsed(true);
      return;
    }
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
    setWidthState(clamped);
    // Drag implies user wants expanded mode — if currently collapsed,
    // expand and apply the new width.
    setCollapsed(false);
  }, []);

  const resetWidth = useCallback(() => setWidthState(DEFAULT_WIDTH), []);

  return {
    collapsed,
    width,
    toggle,
    setCollapsed,
    setWidth,
    resetWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    collapseThreshold: COLLAPSE_THRESHOLD,
    defaultWidth: DEFAULT_WIDTH,
  };
}
