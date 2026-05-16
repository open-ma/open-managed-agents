import { useEffect, useState } from "react";

const STORAGE_KEY = "oma_sidebar_collapsed";

/**
 * Linear-style sidebar collapse state, persisted to localStorage so the
 * choice survives reloads + tabs. `[` toggles it globally (matches Linear
 * + Notion conventions); the toggle button in the sidebar does the same.
 *
 * Returns a stable `toggle` function so callers don't churn render
 * downstream when only the value changes.
 */
export function useSidebarCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
} {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      if (collapsed) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage disabled (private mode); not fatal — state still
      // works within the session, just doesn't persist.
    }
  }, [collapsed]);

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

  const toggle = () => setCollapsed((v) => !v);

  return { collapsed, toggle, setCollapsed };
}
