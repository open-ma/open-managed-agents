/**
 * Sandbox Worker — per-environment session runtime.
 *
 * Each environment gets its own sandbox worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 *
 * Routes (called by main worker):
 *   PUT    /sessions/:id/init     — initialize SessionDO
 *   POST   /sessions/:id/event    — send user event
 *   GET    /sessions/:id/status   — get session status
 *   GET    /sessions/:id/ws       — WebSocket upgrade
 *   GET    /sessions/:id/events   — paginated event list
 *   DELETE /sessions/:id/destroy  — destroy sandbox
 */

import { Hono } from "hono";
import type { Env } from "../src/env";

// --- Register harnesses (same as main worker used to do) ---
import { registerHarness } from "../src/harness/registry";
import { DefaultHarness } from "../src/harness/default-loop";
registerHarness("default", () => new DefaultHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "../src/runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";

// --- Export outbound worker functions ---
export { outbound, outboundByHost } from "../src/outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Route all session requests to the SessionDO
app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const doId = c.env.SESSION_DO!.idFromName(sessionId);
  const doStub = c.env.SESSION_DO!.get(doId);

  // Strip /sessions/:id prefix → forward as /init, /event, /status, /ws, /events, /destroy
  const url = new URL(c.req.url);
  const subPath = url.pathname.replace(`/sessions/${sessionId}`, "") || "/";
  const internalUrl = `http://internal${subPath}${url.search}`;

  return doStub.fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    })
  );
});

export default app;
