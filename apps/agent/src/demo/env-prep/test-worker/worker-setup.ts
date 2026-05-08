// Worker for setup-on-warmup demo. AMA-style "set up cloud container →
// clone repo → run setup script → ready" lifecycle, no pre-build, no
// snapshot.

import { Hono } from "hono";
import { SetupOrchestrator, SetupContainer } from "./setup-on-warmup";

export { SetupOrchestrator, SetupContainer };

// Required by @cloudflare/sandbox 0.9.x for the proxy layer.
export { ContainerProxy } from "@cloudflare/containers";

interface Env {
  SETUP_ORCHESTRATOR: DurableObjectNamespace;
  SETUP_CONTAINER: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: "setup-on-warmup" }));

/**
 * Start a session: kick off setup in container DO, return immediately.
 * Body: { gitRepo?: { url, branch? }, setupScript?: string }
 */
app.post("/start/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{
    gitRepo?: { url: string; branch?: string };
    setupScript?: string;
    diskCapPct?: number;
  }>();
  const stub = orchestratorStub(c.env, sessionId);
  return c.json(await stub.startSession(body));
});

app.get("/poll/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = orchestratorStub(c.env, sessionId);
  return c.json(await stub.pollSession());
});

app.post("/reset/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = orchestratorStub(c.env, sessionId);
  await stub.resetSession();
  return c.json({ ok: true });
});

app.post("/exec/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ cmd: string }>();
  const stub = orchestratorStub(c.env, sessionId);
  return c.json(await stub.diagExec(body.cmd));
});

/**
 * Per-message ensureReady probe. Mirrors what SessionDO would call
 * before processing a user message in production.
 */
app.post("/ensure-ready/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{
    gitRepo?: { url: string; branch?: string };
    setupScript?: string;
    diskCapPct?: number;
  }>();
  const stub = orchestratorStub(c.env, sessionId);
  return c.json(await stub.ensureReady(body));
});

function orchestratorStub(
  env: Env,
  sessionId: string,
): DurableObjectStub<SetupOrchestrator> {
  const id = env.SETUP_ORCHESTRATOR.idFromName(`setup-orch:${sessionId}`);
  return env.SETUP_ORCHESTRATOR.get(id) as DurableObjectStub<SetupOrchestrator>;
}

export default app;
