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
export { OmaSandbox as Sandbox } from "./oma-sandbox";

// --- Required by @cloudflare/sandbox 0.8.x outbound interception ---
export { ContainerProxy } from "@cloudflare/containers";

// --- Export outbound worker functions (legacy — see oma-sandbox.ts for the
// real handler wiring via @cloudflare/sandbox 0.8.x setOutboundHandler API). ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", version: "2" }));

/**
 * POST /__internal/prepare-env — invoked by the main worker over the
 * service binding when an env with `image_strategy=base_snapshot` is
 * being created or its packages change. Runs the install + snapshot
 * inside this worker (which has the SANDBOX DO binding); returns the
 * adapter's `PrepareResult` for the main worker to persist.
 *
 * Auth: X-Internal-Token must match env.INTERNAL_TOKEN. Without that
 * the endpoint is a 403 — keeps anyone with the public service binding
 * from triggering arbitrary installs.
 *
 * Body: PrepareInput (env_id, tenant_id, config). Response: PrepareResult.
 */
app.post("/__internal/prepare-env", async (c) => {
  const expected = (c.env as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  const provided = c.req.header("x-internal-token");
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const { CfBaseSnapshotStrategy } = await import("@open-managed-agents/environment-images/cf-base-snapshot");
  const { getSandbox: cfGetSandbox } = await import("@cloudflare/sandbox");
  const body = await c.req.json<{
    env_id: string;
    tenant_id: string;
    config: Record<string, unknown>;
    callback_url: string;
  }>();
  const strategy = new CfBaseSnapshotStrategy({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSandbox: (id: string) => cfGetSandbox(c.env.SANDBOX as any, id) as any,
  });

  // Fire-and-forget. prepare() can take 1-5 minutes (install + R2 upload
  // of squashfs); main-worker fetch would time out long before that.
  // We return 202 immediately and POST the result to the callback URL
  // when done. Same pattern as the dockerfile build callback.
  c.executionCtx.waitUntil((async () => {
    let result;
    try {
      result = await strategy.prepare({
        env_id: body.env_id,
        tenant_id: body.tenant_id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: body.config as any,
      });
    } catch (err) {
      result = {
        status: "error" as const,
        error: `prepare threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await fetch(body.callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": expected,
        },
        body: JSON.stringify(result),
      });
    } catch (err) {
      console.error("[prepare-env] callback failed:", err instanceof Error ? err.message : err);
    }
  })());

  return c.json({ status: "building" }, 202);
});

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const doId = c.env.SESSION_DO!.idFromName(sessionId);
  const doStub = c.env.SESSION_DO!.get(doId);
  // Workaround for cloudflare/workerd#2240: explicitly seed the partyserver
  // .name so internal getters don't throw during DO startup.
  (doStub as unknown as { setName?: (n: string) => void }).setName?.(sessionId);

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
