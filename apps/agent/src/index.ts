/**
 * Agent Worker — per-environment session runtime.
 *
 * Each environment gets its own agent worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 */

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

// --- Register harnesses ---
import { registerHarness } from "./harness/registry";
import { DefaultHarness } from "./harness/default-loop";
registerHarness("default", () => new DefaultHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";

// --- Export outbound worker functions ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const doId = c.env.SESSION_DO!.idFromName(sessionId);
  const doStub = c.env.SESSION_DO!.get(doId);

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
