/**
 * Cursor pagination primitives shared across every *-store package.
 *
 * The codec is deliberately tiny and dependency-free: any store package
 * with a `(created_at, id)` natural ordering can adopt cursor pagination
 * without inventing its own wire format. Adapters speak in typed
 * `{createdAt, id}` pairs; only the route ↔ client boundary deals with
 * the opaque base64url string.
 *
 * Wire format: base64url(JSON({t: number, i: string}))
 *   - `t` = created_at as ms-since-epoch (matches D1 INTEGER columns)
 *   - `i` = primary key (tie-break for inserts within the same ms)
 *
 * Stale / corrupted cursors decode to `undefined` so the next call
 * silently restarts from page 1 — kinder than throwing on a cursor
 * carried across deploys, and clients with no recovery path can keep
 * walking forward.
 */

export interface PageCursor {
  createdAt: number;
  id: string;
}

export interface PageOptions {
  /** Hard-clamped to [1, max]. Default 50, max defaults to 200. */
  limit?: number;
  /** Decoded cursor returned by `decodeCursor`. */
  after?: PageCursor;
}

export interface PageResult<T> {
  items: T[];
  /** True when more rows exist past the page just returned. */
  hasMore: boolean;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 200;

export function clampLimit(n: number | undefined, max = DEFAULT_MAX_LIMIT): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  if (n > max) return max;
  return Math.floor(n);
}

export function encodeCursor(c: PageCursor): string {
  const json = JSON.stringify({ t: c.createdAt, i: c.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string | undefined): PageCursor | undefined {
  if (!cursor) return undefined;
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const obj = JSON.parse(json) as { t?: number; i?: string };
    if (typeof obj.t !== "number" || typeof obj.i !== "string") return undefined;
    return { createdAt: obj.t, id: obj.i };
  } catch {
    return undefined;
  }
}

/**
 * Convenience builder for service layers: take a repo's PageResult plus
 * the natural-key extractor, return the wire shape `{items, nextCursor?}`.
 *
 *   const page = await repo.listPage(...);
 *   return toCursorPage(page, (r) => ({ createdAt: isoToMs(r.created_at), id: r.id }));
 */
export function toCursorPage<T>(
  page: PageResult<T>,
  extractCursor: (item: T) => PageCursor,
): { items: T[]; nextCursor?: string } {
  if (!page.hasMore || page.items.length === 0) return { items: page.items };
  return {
    items: page.items,
    nextCursor: encodeCursor(extractCursor(page.items[page.items.length - 1])),
  };
}

// ============================================================
// Cursor mechanics — adapter-agnostic helpers
// ============================================================
//
// Each store owns its SQL (rightly — column lists differ per table). The
// repeating mechanic is *cursor-as-WHERE-clause* + *fetch N+1, trim to N
// to derive hasMore*. These helpers extract that machinery, so adapters
// keep the SQL local but share one canonical cursor implementation.
//
// Adapters are expected to:
//   1. Get cursor SQL fragment from `cursorWhereSql()`.
//   2. Bind `cursorBinds(after)` between their own binds and the LIMIT bind.
//   3. Fetch `fetchN(limit)` rows.
//   4. Hand the result rows + limit to `trimPage(rows, limit)`.
// Shared owns nothing about table shape — only the (created_at, id) DESC
// ordering convention.

/** SQL fragment for the cursor WHERE clause. Empty string when there's
 *  no cursor. The fragment uses `created_at` and `id` column names —
 *  every paginated table is required to expose those (project convention). */
export function cursorWhereSql(after: PageCursor | undefined): string {
  return after ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
}

/** Bind values for the cursor clause, in matching order. Empty when no cursor. */
export function cursorBinds(after: PageCursor | undefined): unknown[] {
  return after ? [after.createdAt, after.createdAt, after.id] : [];
}

/** N+1 — adapters fetch this many to detect "has more pages" without a
 *  separate COUNT query. */
export function fetchN(limit: number): number {
  return limit + 1;
}

/** Trim an over-fetched page (from N+1) back down to N and report whether
 *  the trimmed row existed. */
export function trimPage<T>(rows: T[], limit: number): PageResult<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// ============================================================
// Service-layer helper — collapses listPage to one call
// ============================================================

/**
 * Wraps the entire service.listPage pattern: clamp limit, decode cursor,
 * invoke a fetch closure, encode nextCursor from the last item. Each
 * store's service.listPage becomes ~1 line of business + this call.
 *
 *   async listPage(opts) {
 *     return paginateVia({
 *       cursor: opts.cursor,
 *       limit: opts.limit,
 *       fetch: (after, limit) =>
 *         this.repo.listPage(opts.tenantId, {includeArchived: ..., limit, after}),
 *       extractCursor: (r) =>
 *         ({createdAt: new Date(r.created_at).getTime(), id: r.id}),
 *     });
 *   }
 */
export async function paginateVia<TRow>(opts: {
  cursor: string | undefined;
  limit: number | undefined;
  fetch: (after: PageCursor | undefined, limit: number) => Promise<PageResult<TRow>>;
  extractCursor: (row: TRow) => PageCursor;
}): Promise<{ items: TRow[]; nextCursor?: string }> {
  const limit = clampLimit(opts.limit);
  const after = decodeCursor(opts.cursor);
  const page = await opts.fetch(after, limit);
  return toCursorPage(page, opts.extractCursor);
}
