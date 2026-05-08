// Small SQL helpers shared by adapter implementations.
//
// Kept in @open-managed-agents/shared so all *-store packages can import a
// single canonical version instead of each one copying the same 4 lines.

/**
 * Escape `%` and `_` (LIKE wildcards) plus the escape char itself so a user
 * substring becomes a literal substring. Pair with `LIKE ? ESCAPE '\\'` in
 * the SQL — without the explicit ESCAPE clause SQLite has no escape char
 * and the `\%` / `\_` would slip through.
 *
 * SQLite's LIKE is ASCII-case-insensitive by default, which is what the
 * Combobox typeahead callers want; no extra `lower()` wrappers needed.
 *
 * Usage:
 *
 *   const sql = `... AND name LIKE ? ESCAPE '\\' ...`;
 *   const bind = `%${escapeLikePattern(q)}%`;
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
