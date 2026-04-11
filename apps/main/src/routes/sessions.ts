import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { SessionMeta, UserMessageEvent, AgentConfig, EnvironmentConfig, FileRecord, SessionResource } from "@open-managed-agents/shared";
import { generateSessionId, generateFileId, generateResourceId } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env }>();

/**
 * Resolve the sandbox worker service binding for a given environment.
 */
async function getSandboxBinding(
  env: Env,
  environmentId: string,
): Promise<{ binding: Fetcher | null; error?: string; status?: 404 | 500 | 503 }> {
  const envData = await env.CONFIG_KV.get(`env:${environmentId}`);
  if (!envData) return { binding: null, error: "Environment not found", status: 404 };

  const envConfig = JSON.parse(envData) as EnvironmentConfig;

  if (envConfig.status === "building") {
    return { binding: null, error: "Environment is still building", status: 503 };
  }
  if (envConfig.status === "error") {
    return { binding: null, error: "Environment build failed", status: 500 };
  }
  if (!envConfig.sandbox_worker_name) {
    return { binding: null, error: "No sandbox worker configured for this environment", status: 500 };
  }

  // Binding name derived from worker name: "sandbox-default" → "SANDBOX_sandbox_default"
  const bindingName = `SANDBOX_${envConfig.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (env as unknown as Record<string, unknown>)[bindingName] as Fetcher | undefined;

  if (binding) {
    return { binding };
  }

  // Fallback: if SessionDO is available locally (test/combined worker mode),
  // create an inline fetcher that routes directly to the DO
  if (env.SESSION_DO) {
    const localFetcher: Fetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
        if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
        const [, sessionId, rest] = match;
        const doId = env.SESSION_DO!.idFromName(sessionId);
        const stub = env.SESSION_DO!.get(doId);
        return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        }));
      },
      connect: () => { throw new Error("not implemented"); },
    } as unknown as Fetcher;
    return { binding: localFetcher };
  }

  return { binding: null, error: `Service binding ${bindingName} not found`, status: 500 };
}

/**
 * Forward a request to the sandbox worker via service binding.
 */
function forwardToSandbox(
  binding: Fetcher,
  path: string,
  req: Request,
  method?: string,
  body?: BodyInit | null,
): Promise<Response> {
  const url = `https://sandbox${path}`;
  return binding.fetch(
    new Request(url, {
      method: method || req.method,
      headers: req.headers,
      body: body !== undefined ? body : (req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined),
    }),
  );
}

// POST /v1/sessions — create session
app.post("/", async (c) => {
  const body = await c.req.json<{
    agent: string;
    environment_id: string;
    title?: string;
    vault_ids?: string[];
    resources?: Array<{
      type: "file" | "memory_store" | "github_repository" | "github_repo";
      file_id?: string;
      memory_store_id?: string;
      mount_path?: string;
      access?: "read_write" | "read_only";
      url?: string;
      repo_url?: string;
      authorization_token?: string;
      checkout?: { type?: string; name?: string; sha?: string };
    }>;
  }>();

  if (!body.agent || !body.environment_id) {
    return c.json({ error: "agent and environment_id are required" }, 400);
  }

  // Verify agent exists
  const agentData = await c.env.CONFIG_KV.get(`agent:${body.agent}`);
  if (!agentData) return c.json({ error: "Agent not found" }, 404);

  // Resolve sandbox worker binding
  const { binding, error, status } = await getSandboxBinding(c.env, body.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const sessionId = generateSessionId();

  // Initialize SessionDO via sandbox worker
  await forwardToSandbox(
    binding,
    `/sessions/${sessionId}/init`,
    c.req.raw,
    "PUT",
    JSON.stringify({
      agent_id: body.agent,
      environment_id: body.environment_id,
      title: body.title || "",
      session_id: sessionId,
    }),
  );

  const session: SessionMeta = {
    id: sessionId,
    agent_id: body.agent,
    environment_id: body.environment_id,
    title: body.title || "",
    status: "idle",
    vault_ids: body.vault_ids,
    created_at: new Date().toISOString(),
  };

  // Store session with agent snapshot
  const agentSnapshot = JSON.parse(agentData) as AgentConfig;
  const sessionRecord = { ...session, agent_snapshot: agentSnapshot };
  await c.env.CONFIG_KV.put(`session:${sessionId}`, JSON.stringify(sessionRecord));

  // Process resources if provided
  const createdResources: SessionResource[] = [];
  if (body.resources && Array.isArray(body.resources)) {
    for (const res of body.resources) {
      if (res.type === "file" && res.file_id) {
        const fileData = await c.env.CONFIG_KV.get(`file:${res.file_id}`);
        if (!fileData) continue;

        const sourceFile = JSON.parse(fileData) as FileRecord;
        const sourceContent = await c.env.CONFIG_KV.get(`filecontent:${res.file_id}`);

        const scopedFileId = generateFileId();
        const scopedFile: FileRecord = {
          ...sourceFile,
          id: scopedFileId,
          scope_id: sessionId,
          created_at: new Date().toISOString(),
        };
        await c.env.CONFIG_KV.put(`file:${scopedFileId}`, JSON.stringify(scopedFile));
        if (sourceContent !== null) {
          await c.env.CONFIG_KV.put(`filecontent:${scopedFileId}`, sourceContent);
        }

        const resourceId = generateResourceId();
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "file",
          file_id: scopedFileId,
          mount_path: res.mount_path,
          created_at: new Date().toISOString(),
        };
        await c.env.CONFIG_KV.put(`sesrsc:${sessionId}:${resourceId}`, JSON.stringify(resource));
        createdResources.push(resource);
      } else if (res.type === "memory_store" && res.memory_store_id) {
        const resourceId = generateResourceId();
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "memory_store",
          memory_store_id: res.memory_store_id,
          mount_path: res.mount_path,
          created_at: new Date().toISOString(),
        };
        await c.env.CONFIG_KV.put(`sesrsc:${sessionId}:${resourceId}`, JSON.stringify(resource));
        createdResources.push(resource);
      } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
        const resourceId = generateResourceId();
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "github_repository",
          url: res.url || res.repo_url,
          repo_url: res.url || res.repo_url,
          mount_path: res.mount_path || "/workspace",
          checkout: res.checkout,
          created_at: new Date().toISOString(),
        };
        if (res.authorization_token) {
          await c.env.CONFIG_KV.put(`secret:${sessionId}:${resourceId}`, res.authorization_token);
        }
        await c.env.CONFIG_KV.put(`sesrsc:${sessionId}:${resourceId}`, JSON.stringify(resource));
        createdResources.push(resource);
      }
    }
  }

  const response: Record<string, unknown> = { ...session };
  if (createdResources.length > 0) {
    response.resources = createdResources;
  }

  return c.json(response, 201);
});

// GET /v1/sessions — list sessions
app.get("/", async (c) => {
  const agentIdFilter = c.req.query("agent_id");
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  const includeArchived = c.req.query("include_archived") === "true";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: "session:" });
  let sessions = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? (JSON.parse(data) as SessionMeta) : null;
      })
    )
  ).filter((s): s is SessionMeta => s !== null);

  if (!includeArchived) {
    sessions = sessions.filter((s) => !s.archived_at);
  }

  if (agentIdFilter) {
    sessions = sessions.filter((s) => s.agent_id === agentIdFilter);
  }

  sessions.sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return order === "asc" ? cmp : -cmp;
  });

  return c.json({ data: sessions.slice(0, limit) });
});

// GET /v1/sessions/:id — get session (status from sandbox worker)
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta & { agent_snapshot?: AgentConfig };

  // Get live status, usage, and outcome evaluations from sandbox worker
  const { binding } = await getSandboxBinding(c.env, session.environment_id);
  const response: Record<string, unknown> = { ...session };

  if (binding) {
    try {
      const fullStatusRes = await forwardToSandbox(binding, `/sessions/${id}/full-status`, c.req.raw, "GET");
      const fullStatus = (await fullStatusRes.json()) as {
        status: string;
        usage: { input_tokens: number; output_tokens: number };
        outcome_evaluations: Array<{ result: string; iteration: number; feedback?: string }>;
      };
      session.status = fullStatus.status as SessionMeta["status"];
      response.usage = fullStatus.usage;
      if (fullStatus.outcome_evaluations?.length) {
        response.outcome_evaluations = fullStatus.outcome_evaluations;
      }
    } catch {
      // Sandbox worker unreachable — keep stored status
    }
  }

  if (session.agent_snapshot) {
    response.agent = session.agent_snapshot;
    delete response.agent_snapshot;
  }
  return c.json(response);
});

// POST /v1/sessions/:id/archive
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  session.archived_at = new Date().toISOString();
  session.updated_at = session.archived_at;

  await c.env.CONFIG_KV.put(`session:${id}`, JSON.stringify(session));
  return c.json(session);
});

// POST /v1/sessions/:id — update session
app.post("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const body = await c.req.json<{
    title?: string;
    metadata?: Record<string, unknown>;
  }>();

  if (body.title !== undefined) session.title = body.title;
  if (body.metadata !== undefined) {
    const existing = session.metadata || {};
    for (const [key, value] of Object.entries(body.metadata)) {
      if (value === null) {
        delete existing[key];
      } else {
        existing[key] = value;
      }
    }
    session.metadata = existing;
  }
  session.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(`session:${id}`, JSON.stringify(session));
  return c.json(session);
});

// DELETE /v1/sessions/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;

  const { binding } = await getSandboxBinding(c.env, session.environment_id);
  if (binding) {
    await forwardToSandbox(binding, `/sessions/${id}/destroy`, c.req.raw, "DELETE").catch(() => {});
  }

  await c.env.CONFIG_KV.delete(`session:${id}`);
  return c.json({ type: "session_deleted", id });
});

// POST /v1/sessions/:id/events — send user events
app.post("/:id/events", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const body = await c.req.json<{ events: UserMessageEvent[] }>();
  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events array is required" }, 400);
  }

  const ALLOWED_EVENT_TYPES = [
    "user.message",
    "user.interrupt",
    "user.tool_confirmation",
    "user.custom_tool_result",
    "user.define_outcome",
  ];

  for (const event of body.events) {
    if (!ALLOWED_EVENT_TYPES.includes(event.type)) {
      return c.json({ error: `Unsupported event type: ${event.type}` }, 400);
    }
    await forwardToSandbox(
      binding,
      `/sessions/${id}/event`,
      c.req.raw,
      "POST",
      JSON.stringify(event),
    );
  }

  return c.body(null, 202);
});

// SSE stream
async function handleSSEStream(c: Context<{ Bindings: Env }>, id: string) {
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const wsRes = await forwardToSandbox(binding, `/sessions/${id}/ws`, c.req.raw, "GET");

  const ws = (wsRes as any).webSocket;
  if (!ws) {
    return c.json({ error: "Failed to establish WebSocket to session" }, 500);
  }
  ws.accept();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (event: MessageEvent) => {
        controller.enqueue(encoder.encode(`data: ${event.data}\n\n`));
      });
      ws.addEventListener("close", () => {
        controller.close();
      });
      ws.addEventListener("error", () => {
        controller.close();
      });
    },
    cancel() {
      ws.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// JSON events
async function handleJSONEvents(c: Context<{ Bindings: Env }>, id: string) {
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const url = new URL(c.req.url);
  const res = await forwardToSandbox(binding, `/sessions/${id}/events${url.search}`, c.req.raw, "GET");
  const result = await res.json();
  return c.json(result);
}

app.get("/:id/events", async (c) => {
  const accept = c.req.header("Accept") || "";
  if (accept.includes("text/event-stream")) {
    return handleSSEStream(c, c.req.param("id"));
  }
  return handleJSONEvents(c, c.req.param("id"));
});

// Anthropic-compatible SSE stream path
app.get("/:id/stream", async (c) => handleSSEStream(c, c.req.param("id")));
// Legacy alias
app.get("/:id/events/stream", async (c) => handleSSEStream(c, c.req.param("id")));

// ============================================================
// Session Threads (multi-agent)
// ============================================================

// GET /v1/sessions/:id/threads — list threads
app.get("/:id/threads", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads`, c.req.raw, "GET");
  return c.json(await res.json());
});

// GET /v1/sessions/:id/threads/:thread_id/events — thread events
app.get("/:id/threads/:thread_id/events", async (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("thread_id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id);
  if (!binding) return c.json({ error }, status ?? 500);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads/${threadId}/events`, c.req.raw, "GET");
  return c.json(await res.json());
});

// GET /v1/sessions/:id/threads/:thread_id/stream — SSE stream for thread
app.get("/:id/threads/:thread_id/stream", async (c) => {
  // Same as session SSE but filtered by thread_id — for now, use full session stream
  return handleSSEStream(c, c.req.param("id"));
});

// ============================================================
// Session Resources (KV only — stays in main worker)
// ============================================================

app.post("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  const sessionData = await c.env.CONFIG_KV.get(`session:${sessionId}`);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json<{
    type: "file" | "memory_store";
    file_id?: string;
    memory_store_id?: string;
    mount_path?: string;
  }>();

  if (!body.type) {
    return c.json({ error: "type is required" }, 400);
  }

  const existingResources = await c.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
  if (existingResources.keys.length >= 100) {
    return c.json({ error: "Maximum 100 resources per session" }, 400);
  }

  if (body.type === "file") {
    if (!body.file_id) {
      return c.json({ error: "file_id is required for file resources" }, 400);
    }
    const fileData = await c.env.CONFIG_KV.get(`file:${body.file_id}`);
    if (!fileData) return c.json({ error: "File not found" }, 404);
  }

  if (body.type === "memory_store") {
    if (!body.memory_store_id) {
      return c.json({ error: "memory_store_id is required for memory_store resources" }, 400);
    }
  }

  const resourceId = generateResourceId();
  const resource: SessionResource = {
    id: resourceId,
    session_id: sessionId,
    type: body.type,
    file_id: body.file_id,
    memory_store_id: body.memory_store_id,
    mount_path: body.mount_path,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`sesrsc:${sessionId}:${resourceId}`, JSON.stringify(resource));
  return c.json(resource, 201);
});

app.get("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  const sessionData = await c.env.CONFIG_KV.get(`session:${sessionId}`);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const list = await c.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
  const resources = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        return data ? (JSON.parse(data) as SessionResource) : null;
      })
    )
  ).filter((r): r is SessionResource => r !== null);

  return c.json({ data: resources });
});

app.delete("/:id/resources/:resource_id", async (c) => {
  const sessionId = c.req.param("id");
  const resourceId = c.req.param("resource_id");

  const sessionData = await c.env.CONFIG_KV.get(`session:${sessionId}`);
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const resourceData = await c.env.CONFIG_KV.get(`sesrsc:${sessionId}:${resourceId}`);
  if (!resourceData) return c.json({ error: "Resource not found" }, 404);

  await c.env.CONFIG_KV.delete(`sesrsc:${sessionId}:${resourceId}`);
  return c.json({ type: "resource_deleted", id: resourceId });
});

export default app;
