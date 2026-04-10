import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import type { SessionMeta, UserMessageEvent, AgentConfig, FileRecord, SessionResource } from "../types";
import { generateSessionId, generateFileId, generateResourceId } from "../id";

const app = new Hono<{ Bindings: Env }>();

// POST /v1/sessions — create session
app.post("/", async (c) => {
  const body = await c.req.json<{
    agent: string;
    environment_id: string;
    title?: string;
    vault_ids?: string[];
    resources?: Array<{
      type: "file" | "memory_store" | "github_repository" | "github_repo" | "env_secret";
      file_id?: string;
      memory_store_id?: string;
      mount_path?: string;
      access?: "read_write" | "read_only";
      // github_repository
      url?: string;
      repo_url?: string;
      authorization_token?: string;
      checkout?: { type?: string; name?: string; sha?: string };
      // env_secret
      name?: string;
      value?: string;
    }>;
  }>();

  if (!body.agent || !body.environment_id) {
    return c.json({ error: "agent and environment_id are required" }, 400);
  }

  // Verify agent exists
  const agentData = await c.env.CONFIG_KV.get(`agent:${body.agent}`);
  if (!agentData) return c.json({ error: "Agent not found" }, 404);

  // Verify environment exists
  const envData = await c.env.CONFIG_KV.get(`env:${body.environment_id}`);
  if (!envData) return c.json({ error: "Environment not found" }, 404);

  const sessionId = generateSessionId();

  // Initialize the Session DO
  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(doId);
  await doStub.fetch(
    new Request("http://internal/init", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: body.agent,
        environment_id: body.environment_id,
        title: body.title || "",
        session_id: sessionId,
      }),
    })
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
        // Verify source file exists
        const fileData = await c.env.CONFIG_KV.get(`file:${res.file_id}`);
        if (!fileData) continue;

        const sourceFile = JSON.parse(fileData) as FileRecord;
        const sourceContent = await c.env.CONFIG_KV.get(`filecontent:${res.file_id}`);

        // Create session-scoped copy
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

        // Create resource record
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
        // Store token separately (write-only, never returned in API responses)
        if (res.authorization_token) {
          await c.env.CONFIG_KV.put(`secret:${sessionId}:${resourceId}`, res.authorization_token);
        }
        await c.env.CONFIG_KV.put(`sesrsc:${sessionId}:${resourceId}`, JSON.stringify(resource));
        createdResources.push(resource);
      } else if (res.type === "env_secret" && res.name && res.value) {
        const resourceId = generateResourceId();
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "env_secret",
          name: res.name,
          created_at: new Date().toISOString(),
        };
        // Store value separately (write-only)
        await c.env.CONFIG_KV.put(`secret:${sessionId}:${resourceId}`, res.value);
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

// GET /v1/sessions/:id — get session
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  // Get live status from DO
  const doId = c.env.SESSION_DO.idFromName(id);
  const doStub = c.env.SESSION_DO.get(doId);
  const statusRes = await doStub.fetch(new Request("http://internal/status"));
  const status = (await statusRes.json()) as { status: string };

  const session = JSON.parse(data) as SessionMeta & { agent_snapshot?: AgentConfig };
  session.status = status.status as SessionMeta["status"];

  // Include agent snapshot in response (Anthropic-compatible format)
  const response: Record<string, unknown> = { ...session };
  if (session.agent_snapshot) {
    response.agent = session.agent_snapshot;
    delete response.agent_snapshot;
  }
  return c.json(response);
});

// POST /v1/sessions/:id/archive — archive session
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

// DELETE /v1/sessions/:id — delete session + destroy sandbox
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  // Destroy sandbox in the DO
  const doId = c.env.SESSION_DO.idFromName(id);
  const doStub = c.env.SESSION_DO.get(doId);
  await doStub.fetch(new Request("http://internal/destroy", { method: "DELETE" })).catch(() => {});

  await c.env.CONFIG_KV.delete(`session:${id}`);
  return c.json({ type: "session_deleted", id });
});

// POST /v1/sessions/:id/events — send user events
app.post("/:id/events", async (c) => {
  const id = c.req.param("id");

  // Verify session exists
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json<{ events: UserMessageEvent[] }>();
  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events array is required" }, 400);
  }

  const doId = c.env.SESSION_DO.idFromName(id);
  const doStub = c.env.SESSION_DO.get(doId);

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
    await doStub.fetch(
      new Request("http://internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      })
    );
  }

  return c.body(null, 202);
});

// SSE stream handler — shared between /events and /events/stream
async function handleSSEStream(c: Context<{ Bindings: Env }>, id: string) {
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const doId = c.env.SESSION_DO.idFromName(id);
  const doStub = c.env.SESSION_DO.get(doId);

  const wsRes = await doStub.fetch(
    new Request("http://internal/ws", {
      headers: { Upgrade: "websocket" },
    })
  );

  const ws = wsRes.webSocket;
  if (!ws) {
    return c.json({ error: "Failed to establish WebSocket to session" }, 500);
  }
  ws.accept();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      ws.addEventListener("message", (event) => {
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

// JSON events handler — paginated event list from DO
async function handleJSONEvents(c: Context<{ Bindings: Env }>, id: string) {
  const data = await c.env.CONFIG_KV.get(`session:${id}`);
  if (!data) return c.json({ error: "Session not found" }, 404);

  const doId = c.env.SESSION_DO.idFromName(id);
  const doStub = c.env.SESSION_DO.get(doId);

  const params = new URLSearchParams();
  const limit = c.req.query("limit");
  const order = c.req.query("order");
  const afterParam = c.req.query("after");
  if (limit) params.set("limit", limit);
  if (order) params.set("order", order);
  // Parse cursor format "seq_N" to extract after_seq
  if (afterParam && afterParam.startsWith("seq_")) {
    params.set("after_seq", afterParam.slice(4));
  }

  const eventsRes = await doStub.fetch(
    new Request(`http://internal/events?${params.toString()}`)
  );
  const result = await eventsRes.json();
  return c.json(result);
}

// GET /v1/sessions/:id/events — SSE stream or JSON list
app.get("/:id/events", async (c) => {
  const accept = c.req.header("Accept") || "";
  if (accept.includes("text/event-stream")) {
    return handleSSEStream(c, c.req.param("id"));
  }
  return handleJSONEvents(c, c.req.param("id"));
});

// GET /v1/sessions/:id/events/stream — SSE stream (Anthropic-compatible alias)
app.get("/:id/events/stream", async (c) => handleSSEStream(c, c.req.param("id")));

// ============================================================
// Session Resources
// ============================================================

// POST /v1/sessions/:id/resources — add a resource
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

  // Max 100 resources per session
  const existingResources = await c.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
  if (existingResources.keys.length >= 100) {
    return c.json({ error: "Maximum 100 resources per session" }, 400);
  }

  if (body.type === "file") {
    if (!body.file_id) {
      return c.json({ error: "file_id is required for file resources" }, 400);
    }
    // Verify file exists
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

// GET /v1/sessions/:id/resources — list resources for session
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

// DELETE /v1/sessions/:id/resources/:resource_id — remove resource
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
