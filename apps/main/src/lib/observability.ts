// Request-level observability for the main worker.
//
// Pairs together:
//   1. requestMetricsMiddleware — wraps every request, emits one AE row
//      per response with op, route, status, duration_ms, tenant_id.
//      Mount at the very top of the chain so it sees auth failures and
//      rate-limit rejections too.
//   2. globalErrorHandler — Hono `app.onError` callback. Catches anything
//      that escaped per-route try/catch (the bug class that gave us the
//      silent /v1/agents 500 last week — handler threw, default Hono
//      response was 500 with no body, no log, no AE row). Logs +
//      records + returns a sanitized 500.
//
// Both write to AE under op prefix `http.*` so dashboards / alerts can
// query without grepping logs.

import type { Context, MiddlewareHandler } from "hono";
import {
  errFields,
  logError,
  recordEvent,
  type Env,
} from "@open-managed-agents/shared";

/**
 * Per-request middleware. Times the handler, records one AE row on
 * completion (success or failure). Cheap: one Date.now() pair + one
 * fire-and-forget AE write.
 *
 * `op` is `http.<METHOD>.<routePath>`, where routePath is Hono's
 * declared route pattern (e.g. `/v1/agents/:id`) — NOT the concrete URL
 * (which would explode AE blob cardinality with one row per agent id).
 *
 * `error_name` is the HTTP status when the response is 4xx/5xx, empty
 * otherwise. This keeps a single op/error_name pair groupable for
 * "5xx rate by route" without needing JOINs.
 */
export const requestMetricsMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { tenant_id?: string };
}> = async (c, next) => {
  const start = Date.now();
  let threw = false;
  try {
    await next();
  } catch (err) {
    // Let it propagate to onError, but record the latency before doing so.
    threw = true;
    const duration_ms = Date.now() - start;
    recordEvent(c.env.ANALYTICS, {
      op: routeOp(c),
      tenant_id: c.get("tenant_id"),
      error_name: err instanceof Error ? err.name || "Error" : "thrown",
      error_message:
        err instanceof Error ? err.message : String(err),
      duration_ms,
    });
    throw err;
  } finally {
    if (!threw) {
      const status = c.res.status;
      const duration_ms = Date.now() - start;
      recordEvent(c.env.ANALYTICS, {
        op: routeOp(c),
        tenant_id: c.get("tenant_id"),
        // Only flag explicit failure statuses so success rows aren't noisy
        // — group-by error_name='' / status_class is the common AE query.
        error_name: status >= 500 ? `${status}` : status >= 400 ? `${status}` : "",
        duration_ms,
      });
    }
  }
};

/**
 * Hono error handler — replaces the default "500 + empty body, nothing
 * logged" with a structured log + AE row + sanitized JSON response.
 *
 * Per-route handlers should still map their KNOWN errors (ValidationError,
 * NotFoundError) to specific statuses — this is the catch-all for the
 * unexpected.
 */
export function globalErrorHandler(err: Error, c: Context<{ Bindings: Env }>) {
  const route = routeOp(c);
  const tenantId = (c.get as (k: string) => string | undefined)("tenant_id");
  logError(
    {
      op: "http.unhandled",
      route,
      tenant_id: tenantId,
      ...errFields(err),
    },
    "unhandled exception in route handler — returning 500",
  );
  recordEvent(c.env.ANALYTICS, {
    op: "http.unhandled",
    tenant_id: tenantId,
    ...errFields(err),
  });
  // Don't leak err.message to clients — could surface internal details
  // (DB column names, stack hints). Generic body, structured info in logs.
  return c.json({ error: "Internal server error" }, 500);
}

/** Build the AE op label from the matched route pattern, falling back to
 *  the literal path when no route matched (404 path). Uses Hono's
 *  routePath when available; older Hono versions only expose `path`. */
function routeOp(c: Context): string {
  const method = c.req.method;
  const route = (c.req as unknown as { routePath?: string }).routePath || c.req.path;
  return `http.${method}.${route}`;
}
