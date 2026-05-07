// Route-layer helpers for cursor pagination. Pairs with the cursor mechanics
// in @open-managed-agents/shared/pagination — that side does the encode /
// decode / SQL fragments; this side maps Hono's request/response idiom onto
// the service.listPage call shape.
//
// Wire contract (dual — accepts both Anthropic and legacy OMA forms):
//   GET /v1/<resource>?limit=N&page=<opaque>&include_archived=true   ← Anthropic SDK
//   GET /v1/<resource>?limit=N&cursor=<opaque>&include_archived=true ← legacy
//
//   200 { data: T[], next_page?: string, next_cursor?: string }
//        ── both keys carry the same opaque value; emit both so OMA SDK /
//        Console (read next_cursor) and @anthropic-ai/sdk (reads next_page,
//        per its core/pagination.js) both iterate correctly.
//
// Each route handler collapses to:
//
//   app.get("/", async (c) => {
//     const params = parsePageQuery(c);
//     const page = await c.var.services.foo.listPage({
//       tenantId: c.get("tenant_id"),
//       ...params,
//     });
//     return jsonPage(c, page, toApiFoo);
//   });

import type { Context } from "hono";

export interface PageQuery {
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
}

/** Parse `?limit=N&{cursor|page}=...&include_archived=true` from the request.
 *  Service layer clamps limit; we just shuttle the raw value through.
 *  Accepts both `cursor` (legacy OMA) and `page` (Anthropic SDK) — they carry
 *  the same opaque token, so whichever the caller sends maps to `cursor`. */
export function parsePageQuery(c: Context): PageQuery {
  const limitParam = c.req.query("limit");
  // Anthropic SDK sends `?page=`; legacy OMA callers send `?cursor=`. Honor
  // both. If both are set, prefer `cursor` so old code that explicitly chose
  // it doesn't silently flip behavior.
  const cursor = c.req.query("cursor") || c.req.query("page") || undefined;
  const includeArchived = c.req.query("include_archived") === "true";
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  return {
    limit: limit !== undefined && !isNaN(limit) ? limit : undefined,
    cursor,
    includeArchived,
  };
}

/** Map a service-layer page to the wire shape and emit JSON. Emits, for
 *  every list response:
 *
 *    - `data`       — array of the mapped items
 *    - `next_page`  — opaque token (Anthropic SDK reads `body.next_page`,
 *                     see its core/pagination.js) or `null` when no more
 *                     pages. ALWAYS present — Anthropic OpenAPI marks it
 *                     required for several namespaces (environments,
 *                     skills, user_profiles), so emit even when null
 *                     instead of omitting.
 *    - `next_cursor`— same opaque token as `next_page`, kept for the
 *                     legacy OMA Console / CLI clients that read this key
 *                     (apps/console/src/lib/useCursorList.ts). Omitted
 *                     when no more pages, mirroring the historical OMA
 *                     contract.
 *    - `has_more`   — boolean. Anthropic's BetaListSkillsResponse marks
 *                     this required; harmless on namespaces that don't.
 */
export function jsonPage<TRow, TApi>(
  c: Context,
  page: { items: TRow[]; nextCursor?: string },
  mapFn: (row: TRow) => TApi,
): Response {
  const data = page.items.map(mapFn);
  const hasMore = !!page.nextCursor;
  const body: Record<string, unknown> = {
    data,
    next_page: page.nextCursor ?? null,
    has_more: hasMore,
  };
  if (hasMore) body.next_cursor = page.nextCursor;
  return c.json(body);
}
