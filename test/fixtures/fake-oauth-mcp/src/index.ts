/**
 * Fake OAuth-protected MCP server for end-to-end testing of OMA's
 * refresh-on-401 path.
 *
 * Two endpoints:
 *
 *   POST /oauth/token
 *     grant_type=refresh_token + refresh_token=<X>
 *     → returns { access_token: "fresh-<N>", refresh_token: "refresh-<N+1>", expires_in: 3600 }
 *     N increments per call so we can detect double-refresh in audit logs.
 *     Returns 400 invalid_grant if the incoming refresh_token doesn't
 *     match the latest issued one (mirrors rotating-refresh-token
 *     providers like Linear).
 *
 *   POST /mcp
 *     Authorization: Bearer <X>
 *     → 401 if X !== current valid access_token
 *     → 200 with a valid MCP JSON-RPC response if X matches
 *     Supports only `initialize` and `tools/list`. The list returns one
 *     fake tool, `fake_echo`, so we can confirm the wired-through tool
 *     ends up registered as `mcp__<server>__fake_echo` in the cloud
 *     agent's tool surface.
 *
 * State persistence: KV-backed (FAKE_STATE binding), keyed by a fixed
 * realm. State has shape:
 *   { current_access: "fresh-N", current_refresh: "refresh-(N+1)",
 *     issued_count: N, last_refresh_at: ISO-string }
 *
 * Bootstrapping: the first time a client hits us with a stale token,
 * /oauth/token starts the counter at 1. The credential the operator
 * seeds in OMA's vault should have:
 *   access_token: "stale-deliberately"   (anything not matching current_access)
 *   refresh_token: "refresh-0"           (matches our bootstrap "expected refresh in")
 * After the first refresh, current_access becomes "fresh-1",
 * current_refresh becomes "refresh-1", and OMA's D1 should reflect
 * that on the next read.
 *
 * Reset: GET /__reset wipes state and re-bootstraps. Useful when
 * re-running the test scenario.
 *
 * Inspect: GET /__state returns the current state for assertion in
 * external scripts ("did refresh actually happen?").
 *
 * NOT for production. Don't wire to anything real. The "secrets" in
 * here are not secret. Authentication is purely string equality.
 */

import { Hono } from "hono";

interface State {
  current_access: string;
  current_refresh: string;
  issued_count: number;
  last_refresh_at: string | null;
}

interface Env {
  FAKE_STATE: KVNamespace;
}

const STATE_KEY = "state:default";

async function loadState(env: Env): Promise<State> {
  const raw = await env.FAKE_STATE.get(STATE_KEY);
  if (raw) return JSON.parse(raw) as State;
  // Bootstrap: the operator's seeded credential should have
  // refresh_token="refresh-0" so the first /oauth/token call accepts
  // it. After that, state advances normally.
  return {
    current_access: "stale-bootstrap",
    current_refresh: "refresh-0",
    issued_count: 0,
    last_refresh_at: null,
  };
}

async function saveState(env: Env, s: State): Promise<void> {
  await env.FAKE_STATE.put(STATE_KEY, JSON.stringify(s));
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.text(
    "fake-oauth-mcp test server. POST /oauth/token, POST /mcp, GET /__state, GET /__reset",
  ),
);

app.get("/__state", async (c) => {
  const s = await loadState(c.env);
  return c.json(s);
});

app.get("/__reset", async (c) => {
  await saveState(c.env, {
    current_access: "stale-bootstrap",
    current_refresh: "refresh-0",
    issued_count: 0,
    last_refresh_at: null,
  });
  return c.json({ ok: true, reset_at: new Date().toISOString() });
});

app.post("/oauth/token", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  let params: URLSearchParams;
  if (ct.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await c.req.text());
  } else if (ct.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    params = new URLSearchParams(body);
  } else {
    return c.json({ error: "unsupported_content_type", content_type: ct }, 400);
  }

  const grantType = params.get("grant_type");
  const refreshToken = params.get("refresh_token");
  if (grantType !== "refresh_token") {
    return c.json({ error: "unsupported_grant_type", grant_type: grantType }, 400);
  }
  if (!refreshToken) {
    return c.json({ error: "invalid_request", reason: "missing refresh_token" }, 400);
  }

  const s = await loadState(c.env);
  if (refreshToken !== s.current_refresh) {
    // Mirrors Linear's rotating-refresh behavior: an old refresh_token
    // is invalid as soon as a new one is issued.
    return c.json({ error: "invalid_grant", reason: "refresh_token rotated; got stale" }, 400);
  }

  const next: State = {
    current_access: `fresh-${s.issued_count + 1}`,
    current_refresh: `refresh-${s.issued_count + 1}`,
    issued_count: s.issued_count + 1,
    last_refresh_at: new Date().toISOString(),
  };
  await saveState(c.env, next);

  return c.json({
    access_token: next.current_access,
    refresh_token: next.current_refresh,
    expires_in: 3600,
    token_type: "Bearer",
  });
});

app.post("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const s = await loadState(c.env);
  if (token !== s.current_access) {
    return c.json({ error: "unauthorized", reason: "stale or missing access_token" }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: unknown;
  };

  const id = body.id ?? null;

  if (body.method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "fake-oauth-mcp",
          version: "1.0.0-test",
        },
      },
    });
  }

  if (body.method === "tools/list") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "fake_echo",
            description: "Echo back the input. Used to confirm OAuth-refreshed MCP calls work.",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string", description: "Message to echo" } },
              required: ["msg"],
            },
          },
        ],
      },
    });
  }

  if (body.method === "tools/call") {
    const params = (body.params ?? {}) as { name?: string; arguments?: { msg?: string } };
    if (params.name !== "fake_echo") {
      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${params.name}` },
      });
    }
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `echo: ${params.arguments?.msg ?? ""} (issued via access_token=${s.current_access})`,
          },
        ],
      },
    });
  }

  if (body.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  return c.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${body.method}` },
  });
});

app.notFound((c) => c.text("not found", 404));

export default app;
