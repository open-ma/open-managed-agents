import { useEffect, useRef } from "react";

/**
 * A single Linear-style two-key chord (e.g. `g s` → "go to sessions").
 * Both keys must be single characters and are matched case-insensitively
 * via `event.key.toLowerCase()`.
 */
export interface ChordBinding {
  /** First key, e.g. "g". Must be a single character. */
  prefix: string;
  /** Second key (within window), e.g. "s". Single character. */
  key: string;
  handler: () => void;
  /** Optional human-readable label — for the palette legend. */
  label?: string;
}

/** ms window between prefix and second key before the prefix is forgotten. */
const CHORD_WINDOW_MS = 1500;

/**
 * Returns true when a keydown originated from somewhere the user is
 * actively typing text — input / textarea / select / contentEditable. We
 * walk up via `closest()` so events fired inside nested editor widgets
 * (cmdk's Command.Input, codemirror, etc.) are also ignored.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
    return true;
  }
  return false;
}

/**
 * Returns true when an open Radix-style modal/dialog is in the DOM.
 * Radix sets `data-state="open"` on Dialog.Content while visible, so a
 * single attribute selector covers Modal, CommandPalette, McpServerPicker,
 * and anything else built on `@radix-ui/react-dialog`.
 */
function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/**
 * Listens for two-key Linear-style chords on `window` and fires the
 * matching `handler`. The first key arms a 1.5s window; the second key
 * either fires (if it matches a binding under that prefix) or silently
 * cancels the chord.
 *
 * Bypassed when:
 *   - Focus is inside a form input / textarea / contenteditable
 *   - Any modifier (Cmd / Ctrl / Alt) is held (true chords are plain keys)
 *   - A Radix dialog is open (Cmd+K palette, modals, pickers, etc.)
 *
 * Mount once at the layout level. The bindings array can change between
 * renders; the effect re-subscribes (handlers are typically small inline
 * arrows that close over `navigate`, so this is cheap).
 */
export function useChordKeybinding(bindings: ChordBinding[]): void {
  const activePrefix = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearPrefix = () => {
      activePrefix.current = null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (isModalOpen()) return;

      const key = event.key.toLowerCase();
      // Ignore non-printable single keystrokes (Shift, Tab, etc.); a real
      // chord key is always exactly one character.
      if (key.length !== 1) return;

      if (activePrefix.current !== null) {
        const match = bindings.find(
          (b) => b.prefix.toLowerCase() === activePrefix.current && b.key.toLowerCase() === key,
        );
        clearPrefix();
        if (match) {
          event.preventDefault();
          match.handler();
        }
        // Non-matching second key silently cancels the chord. Don't
        // preventDefault so the keystroke still does whatever it normally
        // would (e.g. a search input getting focus later).
        return;
      }

      // Not currently armed — does this key start any chord?
      const startsChord = bindings.some((b) => b.prefix.toLowerCase() === key);
      if (!startsChord) return;

      activePrefix.current = key;
      event.preventDefault();
      timerRef.current = setTimeout(clearPrefix, CHORD_WINDOW_MS);
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearPrefix();
    };
  }, [bindings]);
}
