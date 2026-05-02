// Route-layer helpers for cursor pagination. Pairs with the cursor mechanics
// in @open-managed-agents/shared/pagination — that side does the encode /
// decode / SQL fragments; this side maps Hono's request/response idiom onto
// the service.listPage call shape.
//
// Wire contract:
//   GET /v1/<resource>?limit=N&cursor=<opaque>&include_archived=true
//
//   200 { data: T[], next_cursor?: string }
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

/** Parse `?limit=N&cursor=...&include_archived=true` from the request.
 *  Service layer clamps limit; we just shuttle the raw value through. */
export function parsePageQuery(c: Context): PageQuery {
  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor") || undefined;
  const includeArchived = c.req.query("include_archived") === "true";
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  return {
    limit: limit !== undefined && !isNaN(limit) ? limit : undefined,
    cursor,
    includeArchived,
  };
}

/** Map a service-layer page to the wire shape and emit JSON. The
 *  `next_cursor` field is omitted (not nulled) when there's no more page —
 *  matches the Anthropic API convention and keeps payloads tight. */
export function jsonPage<TRow, TApi>(
  c: Context,
  page: { items: TRow[]; nextCursor?: string },
  mapFn: (row: TRow) => TApi,
): Response {
  const data = page.items.map(mapFn);
  return c.json(page.nextCursor ? { data, next_cursor: page.nextCursor } : { data });
}
