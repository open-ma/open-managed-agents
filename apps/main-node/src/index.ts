/**
 * apps/main-node — CFless Node entry for the Open Managed Agents API.
 *
 * Phase B1 milestone: a Node process running Hono, serving /health.
 * Phases B2+ wire authentication, the same /v1/* routes that apps/main
 * exposes on Cloudflare Workers, and the SessionRuntime that replaces
 * SessionDO. For now this file is intentionally tiny — we're proving
 * the basics: workspace packages import cleanly under Node, Hono runs
 * on @hono/node-server, and the build pipeline produces something we
 * can curl.
 *
 *   pnpm --filter @open-managed-agents/main-node start
 *   curl localhost:8787/health  → {"status":"ok","runtime":"node"}
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
  }),
);

// 404 catch-all so an unknown path returns JSON, not Hono's default text.
app.notFound((c) => c.json({ error: "not found" }, 404));

// Centralized error → JSON. Mirrors the apps/main globalErrorHandler shape so
// future ports of business routes don't have to invent a parallel error format.
app.onError((err, c) => {
  console.error("[main-node] unhandled", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[main-node] listening on http://${info.address}:${info.port}`);
});

// Graceful shutdown so docker stop / SIGTERM doesn't drop in-flight requests.
const shutdown = (signal: string) => {
  console.log(`[main-node] received ${signal}, shutting down`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
