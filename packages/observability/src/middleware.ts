// Hono middleware factories. Both runtimes mount these on the root app
// before per-route middleware. Recorded metrics use OpenMetrics-standard
// names so Prometheus scrape configs / Grafana dashboards work without
// remapping.

import type { Context, MiddlewareHandler } from "hono";
import type { MetricsRecorder, Tracer, Span } from "./types";
import { errFields } from "./errors";

export interface RequestMetricsOptions {
  recorder: MetricsRecorder;
  /** Override how the route name is derived. Default: matched route pattern
   *  via Hono's routePath, falling back to the literal path. Tags need to be
   *  bounded-cardinality so dashboards stay query-able — never stuff IDs. */
  routeNameFromCtx?: (c: Context) => string;
  /** Optional histogram-buckets override; used by adapters that pre-create
   *  the registered series. Pass-through only. */
  buckets?: number[];
}

export function requestMetrics(opts: RequestMetricsOptions): MiddlewareHandler {
  const { recorder, routeNameFromCtx } = opts;
  return async (c, next) => {
    const start = Date.now();
    let threw = false;
    let status = 0;
    try {
      await next();
      status = c.res?.status ?? 0;
    } catch (err) {
      threw = true;
      status = 500;
      const route = (routeNameFromCtx ?? defaultRoute)(c);
      const f = errFields(err);
      recorder.recordEvent({
        op: `http.${c.req.method}.${route}`,
        error_name: f.error_name,
        error_message: f.error_message,
        duration_ms: Date.now() - start,
      });
      recorder.counter("http_requests_total", 1, {
        method: c.req.method,
        route,
        status: 500,
      });
      recorder.histogram(
        "http_request_duration_seconds",
        (Date.now() - start) / 1000,
        { method: c.req.method, route, status: 500 },
      );
      throw err;
    } finally {
      if (!threw) {
        const route = (routeNameFromCtx ?? defaultRoute)(c);
        const tags = { method: c.req.method, route, status };
        recorder.counter("http_requests_total", 1, tags);
        recorder.histogram(
          "http_request_duration_seconds",
          (Date.now() - start) / 1000,
          tags,
        );
        recorder.recordEvent({
          op: `http.${c.req.method}.${route}`,
          error_name:
            status >= 500 ? `${status}` : status >= 400 ? `${status}` : "",
          duration_ms: Date.now() - start,
        });
      }
    }
  };
}

export interface TracerMiddlewareOptions {
  tracer: Tracer;
  routeNameFromCtx?: (c: Context) => string;
}

/**
 * Starts an active span per request and stashes it on `c.var.span` so
 * route handlers can decorate it. The span ends in the finally; status
 * follows the response code.
 */
export function tracerMiddleware(opts: TracerMiddlewareOptions): MiddlewareHandler {
  const { tracer, routeNameFromCtx } = opts;
  return async (c, next) => {
    const route = (routeNameFromCtx ?? defaultRoute)(c);
    const name = `HTTP ${c.req.method} ${route}`;
    return tracer.startActiveSpan(
      name,
      async (span: Span) => {
        span.setAttributes({
          "http.method": c.req.method,
          "http.route": route,
          "http.target": c.req.path,
        });
        (c as unknown as { set: (k: string, v: unknown) => void }).set("span", span);
        try {
          await next();
          const status = c.res?.status ?? 0;
          span.setAttributes({ "http.status_code": status });
          if (status >= 500) span.setStatus({ code: 2, message: `HTTP ${status}` });
          else span.setStatus({ code: 1 });
        } catch (err) {
          span.recordException(err);
          span.setStatus({ code: 2 });
          throw err;
        }
      },
      { attributes: { "http.method": c.req.method, "http.route": route } },
    );
  };
}

function defaultRoute(c: Context): string {
  return (
    (c.req as unknown as { routePath?: string }).routePath
    ?? c.req.path
    ?? "/"
  );
}
