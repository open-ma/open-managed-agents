import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { SessionMeta, UserMessageEvent, AgentConfig, EnvironmentConfig, FileRecord, SessionResource, StoredEvent, ContentBlock, CredentialConfig } from "@open-managed-agents/shared";
import { generateSessionId, generateFileId, generateResourceId, buildTrajectory, fileR2Key } from "@open-managed-agents/shared";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";
import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

/**
 * Resolve the sandbox worker service binding for a given environment.
 */
async function getSandboxBinding(
  env: Env,
  environmentId: string,
  tenantId: string,
): Promise<{ binding: Fetcher | null; error?: string; status?: 404 | 500 | 503 }> {
  const envData = await env.CONFIG_KV.get(kvKey(tenantId, "env", environmentId));
  if (!envData) return { binding: null, error: "Environment not found", status: 404 };

  const envConfig = JSON.parse(envData) as EnvironmentConfig;

  if (envConfig.status === "building") {
    return { binding: null, error: "Environment is still building", status: 503 };
  }
  if (envConfig.status === "error") {
    return { binding: null, error: `Environment build failed: ${envConfig.build_error || "unknown error"}`, status: 500 };
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
        // Workaround for cloudflare/workerd#2240
        (stub as unknown as { setName?: (n: string) => void }).setName?.(sessionId);
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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

/**
 * Walk a ContentBlock[] and replace any {source:{type:"file", file_id}}
 * with {source:{type:"base64", media_type, data}} by fetching bytes from R2.
 * Also returns the list of file_ids that were resolved so the sandbox can
 * mount them at /mnt/session/uploads/{file_id} (Anthropic-style dual path).
 *
 * Mirrors the Anthropic Files-API ↔ Messages-API binding: a file_id from
 * POST /v1/files becomes inline base64 the model can read, with no client
 * re-encoding.
 */
async function resolveFileIds(
  env: Env,
  tenantId: string,
  content: ContentBlock[],
): Promise<{ content: ContentBlock[]; mountFileIds: string[] }> {
  const bucket = env.FILES_BUCKET;
  if (!bucket) return { content, mountFileIds: [] };
  const out: ContentBlock[] = [];
  const mountFileIds: string[] = [];
  for (const block of content) {
    if (
      (block.type === "document" || block.type === "image") &&
      block.source?.type === "file" &&
      block.source.file_id
    ) {
      const fileId = block.source.file_id;
      const [metaJson, obj] = await Promise.all([
        env.CONFIG_KV.get(kvKey(tenantId, "file", fileId)),
        bucket.get(fileR2Key(tenantId, fileId)),
      ]);
      if (!metaJson || !obj) {
        throw new Error(`file_id ${fileId} not found`);
      }
      const meta = JSON.parse(metaJson) as FileRecord;
      const buf = await obj.arrayBuffer();
      const data = bytesToBase64(new Uint8Array(buf));
      out.push({
        ...block,
        source: {
          type: "base64",
          media_type: block.source.media_type || meta.media_type,
          data,
        },
      } as ContentBlock);
      mountFileIds.push(fileId);
      continue;
    }
    out.push(block);
  }
  return { content: out, mountFileIds };
}

// POST /v1/sessions — create session
app.post("/", async (c) => {
  const t = c.get("tenant_id");
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
      prompt?: string;
      url?: string;
      repo_url?: string;
      authorization_token?: string;
      checkout?: { type?: string; name?: string; sha?: string };
      name?: string;
      value?: string;
    }>;
  }>();

  if (!body.agent || !body.environment_id) {
    return c.json({ error: "agent and environment_id are required" }, 400);
  }

  // Anthropic-aligned cap: max 8 memory_store resources per session.
  const memoryStoreCount = (body.resources ?? []).filter((r) => r.type === "memory_store").length;
  if (memoryStoreCount > 8) {
    return c.json({ error: "Maximum 8 memory_store resources per session" }, 422);
  }

  // Verify agent exists
  const agentData = await c.env.CONFIG_KV.get(kvKey(t, "agent", body.agent));
  if (!agentData) return c.json({ error: "Agent not found" }, 404);

  // Resolve sandbox worker binding
  const { binding, error, status } = await getSandboxBinding(c.env, body.environment_id, t);
  if (!binding) return c.json({ error }, status ?? 500);

  const sessionId = generateSessionId();

  // Pre-fetch snapshots so SessionDO doesn't have to read CONFIG_KV with a
  // tenant-prefixed key (which fails when sandbox-default's KV binding
  // differs from main's — e.g. shared sandbox + staging main).
  const agentSnapshot = JSON.parse(agentData) as AgentConfig;
  const envSnapshotData = await c.env.CONFIG_KV.get(kvKey(t, "env", body.environment_id));
  const environmentSnapshot = envSnapshotData ? (JSON.parse(envSnapshotData) as EnvironmentConfig) : undefined;
  const vaultIds = body.vault_ids || [];

  // Pre-scan github_repository resources for binding fast-path. When a
  // resource omits authorization_token AND the user has a live github
  // binding for that org, mint a fresh installation token + attach the
  // binding's vault. Done BEFORE SessionDO init so the augmented vault_ids
  // make it into the snapshot the DO uses.
  const fastPathTokens = new Map<string, string>(); // repoUrl → token
  if (body.resources?.length) {
    for (const res of body.resources) {
      if (
        (res.type === "github_repository" || res.type === "github_repo") &&
        (res.url || res.repo_url) &&
        !res.authorization_token
      ) {
        const repoUrl = res.url || res.repo_url!;
        const fast = await tryGitHubBindingFastPath(c.env, t, repoUrl);
        if (fast) {
          fastPathTokens.set(repoUrl, fast.token);
          if (!vaultIds.includes(fast.vaultId)) vaultIds.push(fast.vaultId);
        }
      }
    }
  }

  // Refresh provider-tagged credentials (e.g. GitHub installation tokens,
  // ~1hr TTL) before handing the vault to a fresh session. Best-effort:
  // failures are logged and ignored — the existing token may still be valid;
  // the outbound proxy's on-401 retry path covers any miss.
  await refreshProviderCredentialsForSession(c.env, t, body.agent, vaultIds).catch(
    () => undefined,
  );

  const vaultCredentials = await fetchVaultCredentials(c.env, t, vaultIds);

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
      tenant_id: t,
      vault_ids: vaultIds,
      agent_snapshot: agentSnapshot,
      environment_snapshot: environmentSnapshot,
      vault_credentials: vaultCredentials,
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

  // Store session with agent + environment snapshot (frozen at session start for replay/trajectory)
  const sessionRecord = { ...session, agent_snapshot: agentSnapshot, environment_snapshot: environmentSnapshot };
  await c.env.CONFIG_KV.put(kvKey(t, "session", sessionId), JSON.stringify(sessionRecord));

  // Process resources if provided
  const createdResources: SessionResource[] = [];
  if (body.resources && Array.isArray(body.resources)) {
    for (const res of body.resources) {
      if (res.type === "file" && res.file_id) {
        const fileData = await c.env.CONFIG_KV.get(kvKey(t, "file", res.file_id));
        if (!fileData) continue;

        const sourceFile = JSON.parse(fileData) as FileRecord;
        const scopedFileId = generateFileId();
        const scopedFile: FileRecord = {
          ...sourceFile,
          id: scopedFileId,
          scope_id: sessionId,
          created_at: new Date().toISOString(),
        };
        await c.env.CONFIG_KV.put(kvKey(t, "file", scopedFileId), JSON.stringify(scopedFile));

        // Copy R2 object to scoped key so the resource is independent of the
        // source file's lifecycle. Best-effort: if the source object isn't in
        // R2 (e.g. legacy file with no bytes), still create the metadata.
        if (c.env.FILES_BUCKET) {
          const obj = await c.env.FILES_BUCKET.get(fileR2Key(t, res.file_id));
          if (obj) {
            await c.env.FILES_BUCKET.put(
              fileR2Key(t, scopedFileId),
              obj.body,
              { httpMetadata: { contentType: sourceFile.media_type } },
            );
          }
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
        await c.env.CONFIG_KV.put(kvKey(t, "sesrsc", sessionId, resourceId), JSON.stringify(resource));
        createdResources.push(resource);
      } else if (res.type === "memory_store" && res.memory_store_id) {
        const resourceId = generateResourceId();
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "memory_store",
          memory_store_id: res.memory_store_id,
          mount_path: res.mount_path,
          access: res.access === "read_only" ? "read_only" : "read_write",
          prompt: typeof res.prompt === "string" ? res.prompt.slice(0, 4096) : undefined,
          created_at: new Date().toISOString(),
        };
        await c.env.CONFIG_KV.put(kvKey(t, "sesrsc", sessionId, resourceId), JSON.stringify(resource));
        createdResources.push(resource);
      } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
        const resourceId = generateResourceId();
        const repoUrl = res.url || res.repo_url!;
        const resource: SessionResource = {
          id: resourceId,
          session_id: sessionId,
          type: "github_repository",
          url: repoUrl,
          repo_url: repoUrl,
          mount_path: res.mount_path || "/workspace",
          checkout: res.checkout,
          created_at: new Date().toISOString(),
        };
        // Token resolution order: explicit authorization_token (PAT) →
        // pre-resolved binding fast-path (set during the pre-scan above).
        const token = res.authorization_token ?? fastPathTokens.get(repoUrl) ?? null;
        if (token) {
          await c.env.CONFIG_KV.put(kvKey(t, "secret", sessionId, resourceId), token);
        }
        await c.env.CONFIG_KV.put(kvKey(t, "sesrsc", sessionId, resourceId), JSON.stringify(resource));
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
        await c.env.CONFIG_KV.put(kvKey(t, "secret", sessionId, resourceId), res.value);
        await c.env.CONFIG_KV.put(kvKey(t, "sesrsc", sessionId, resourceId), JSON.stringify(resource));
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

  const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(c.get("tenant_id"), "session"));
  let sessions = (
    await Promise.all(
      list.map(async (k) => {
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
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta & { agent_snapshot?: AgentConfig };

  // Get live status, usage, and outcome evaluations from sandbox worker
  const { binding } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
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
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  session.archived_at = new Date().toISOString();
  session.updated_at = session.archived_at;

  await c.env.CONFIG_KV.put(kvKey(c.get("tenant_id"), "session", id), JSON.stringify(session));
  return c.json(session);
});

// POST /v1/sessions/:id — update session
app.post("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
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

  await c.env.CONFIG_KV.put(kvKey(c.get("tenant_id"), "session", id), JSON.stringify(session));
  return c.json(session);
});

// DELETE /v1/sessions/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;

  // Check if session is running — cannot delete while active
  const { binding } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  if (binding) {
    try {
      const statusRes = await forwardToSandbox(binding, `/sessions/${id}/status`, c.req.raw, "GET");
      const statusBody = await statusRes.json() as { status: string };
      if (statusBody.status === "running") {
        return c.json({ error: "Cannot delete a running session. Send an interrupt event first." }, 409);
      }
    } catch {}
    await forwardToSandbox(binding, `/sessions/${id}/destroy`, c.req.raw, "DELETE").catch(() => {});
  }

  await c.env.CONFIG_KV.delete(kvKey(c.get("tenant_id"), "session", id));
  return c.json({ type: "session_deleted", id });
});

// POST /v1/sessions/:id/events — send user events
app.post("/:id/events", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;

  // Archived sessions are read-only
  if (session.archived_at) {
    return c.json({ error: "Session is archived and cannot receive new events" }, 409);
  }

  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, t);
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
    let outgoing: unknown = event;
    if (event.type === "user.message" || event.type === "user.custom_tool_result") {
      const e = event as { content?: ContentBlock[] };
      if (Array.isArray(e.content)) {
        try {
          const { content: resolved, mountFileIds } = await resolveFileIds(c.env, t, e.content);
          outgoing = {
            ...event,
            content: resolved,
            // Sidecar field consumed by SessionDO POST /event handler:
            // sandbox writes each file to /mnt/session/uploads/{file_id} so
            // the agent's bash/read tools can also see them. Stripped before
            // the event is persisted.
            ...(mountFileIds.length > 0 ? { _mount_file_ids: mountFileIds } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `file_id resolution failed: ${msg}` }, 400);
        }
      }
    }
    await forwardToSandbox(
      binding,
      `/sessions/${id}/event`,
      c.req.raw,
      "POST",
      JSON.stringify(outgoing),
    );
  }

  return c.body(null, 202);
});

// POST /v1/sessions/:id/files — container_upload: promote a sandbox file to
// a first-class file_id. Mirrors Anthropic's pattern where code-execution
// outputs become re-referenceable file_ids. The created file is scope_id-tagged
// to the session and `downloadable: true` by default.
app.post("/:id/files", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const sessionData = await c.env.CONFIG_KV.get(kvKey(t, "session", id));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const bucket = c.env.FILES_BUCKET;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const session = JSON.parse(sessionData) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, t);
  if (!binding) return c.json({ error }, status ?? 500);

  const body = await c.req.json<{
    path: string;
    filename?: string;
    media_type?: string;
    downloadable?: boolean;
  }>();
  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const fileRes = await forwardToSandbox(
    binding,
    `/sessions/${id}/file?path=${encodeURIComponent(body.path)}`,
    c.req.raw,
    "GET",
  );
  if (!fileRes.ok) {
    const msg = await fileRes.text().catch(() => "sandbox read failed");
    return c.json({ error: `Cannot read sandbox path: ${msg}` }, 400);
  }
  const buf = await fileRes.arrayBuffer();

  const filename = body.filename || body.path.split("/").pop() || "file";
  const ext = filename.toLowerCase().split(".").pop() || "";
  const guessed: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", json: "application/json",
  };
  const mediaType = body.media_type || guessed[ext] || "application/octet-stream";
  const downloadable = body.downloadable === undefined ? true : body.downloadable === true;

  const newFileId = generateFileId();
  await bucket.put(fileR2Key(t, newFileId), buf, { httpMetadata: { contentType: mediaType } });

  const record: FileRecord = {
    id: newFileId,
    type: "file" as const,
    filename,
    media_type: mediaType,
    size_bytes: buf.byteLength,
    scope_id: id,
    downloadable,
    created_at: new Date().toISOString(),
  };
  await c.env.CONFIG_KV.put(kvKey(t, "file", newFileId), JSON.stringify(record));
  await c.env.CONFIG_KV.put(kvKey(t, "filebyscope", id, newFileId), "1");

  return c.json(record, 201);
});

// SSE stream
async function handleSSEStream(c: Context<{ Bindings: Env; Variables: { tenant_id: string } }>, id: string) {
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, t);
  if (!binding) return c.json({ error }, status ?? 500);

  const wsHeaders = new Headers(c.req.raw.headers);
  wsHeaders.set("Upgrade", "websocket");
  wsHeaders.set("Connection", "Upgrade");

  const wsReq = new Request(`https://sandbox/sessions/${id}/ws`, {
    method: "GET",
    headers: wsHeaders,
  });

  const wsRes = await binding.fetch(wsReq);

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
async function handleJSONEvents(c: Context<{ Bindings: Env; Variables: { tenant_id: string } }>, id: string) {
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, t);
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

// GET /v1/sessions/:id/trajectory — full Trajectory v1 envelope
app.get("/:id/trajectory", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const sessionData = await c.env.CONFIG_KV.get(kvKey(t, "session", id));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(sessionData) as SessionRecord;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, t);
  if (!binding) return c.json({ error }, status ?? 500);

  // Paginate through all events from sandbox /events (max 1000 per page)
  async function fetchAllEvents(): Promise<StoredEvent[]> {
    const all: StoredEvent[] = [];
    let afterSeq = 0;
    while (true) {
      const res = await forwardToSandbox(
        binding!,
        `/sessions/${id}/events?limit=1000&order=asc&after_seq=${afterSeq}`,
        c.req.raw,
        "GET",
      );
      if (!res.ok) break;
      const body = (await res.json()) as { data?: StoredEvent[]; has_more?: boolean };
      const batch = body.data || [];
      all.push(...batch);
      if (!body.has_more || batch.length === 0) break;
      const last = batch[batch.length - 1];
      afterSeq = last.seq;
    }
    return all;
  }

  async function fetchFullStatus(): Promise<FullStatus | null> {
    const res = await forwardToSandbox(binding!, `/sessions/${id}/full-status`, c.req.raw, "GET");
    if (!res.ok) return null;
    return (await res.json()) as FullStatus;
  }

  async function fetchEnvironmentConfig(): Promise<EnvironmentConfig | null> {
    const data = await c.env.CONFIG_KV.get(kvKey(t, "env", session.environment_id));
    return data ? (JSON.parse(data) as EnvironmentConfig) : null;
  }

  try {
    const trajectory = await buildTrajectory(session, {
      fetchAllEvents,
      fetchFullStatus,
      fetchEnvironmentConfig,
    });
    return c.json(trajectory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
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
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  if (!binding) return c.json({ error }, status ?? 500);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads`, c.req.raw, "GET");
  return c.json(await res.json());
});

// GET /v1/sessions/:id/threads/:thread_id/events — thread events
app.get("/:id/threads/:thread_id/events", async (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("thread_id");
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", id));
  if (!data) return c.json({ error: "Session not found" }, 404);

  const session = JSON.parse(data) as SessionMeta;
  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
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
  const sessionData = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", sessionId));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json<{
    type: "file" | "memory_store";
    file_id?: string;
    memory_store_id?: string;
    mount_path?: string;
    access?: "read_write" | "read_only";
    prompt?: string;
  }>();

  if (!body.type) {
    return c.json({ error: "type is required" }, 400);
  }

  const t = c.get("tenant_id");
  const existingResources = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "sesrsc", sessionId));
  if (existingResources.length >= 100) {
    return c.json({ error: "Maximum 100 resources per session" }, 400);
  }

  if (body.type === "file") {
    if (!body.file_id) {
      return c.json({ error: "file_id is required for file resources" }, 400);
    }
    const fileData = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "file", body.file_id));
    if (!fileData) return c.json({ error: "File not found" }, 404);
  }

  if (body.type === "memory_store") {
    if (!body.memory_store_id) {
      return c.json({ error: "memory_store_id is required for memory_store resources" }, 400);
    }
    // Anthropic-aligned cap: max 8 memory_store resources per session.
    let memoryStoreCount = 0;
    for (const k of existingResources) {
      const data = await c.env.CONFIG_KV.get(k.name);
      if (data && (JSON.parse(data) as SessionResource).type === "memory_store") {
        memoryStoreCount++;
      }
    }
    if (memoryStoreCount >= 8) {
      return c.json({ error: "Maximum 8 memory_store resources per session" }, 422);
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

  if (body.type === "memory_store") {
    resource.access = body.access === "read_only" ? "read_only" : "read_write";
    if (typeof body.prompt === "string") {
      resource.prompt = body.prompt.slice(0, 4096);
    }
  }

  await c.env.CONFIG_KV.put(kvKey(t, "sesrsc", sessionId, resourceId), JSON.stringify(resource));
  return c.json(resource, 201);
});

app.get("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  const sessionData = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", sessionId));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(c.get("tenant_id"), "sesrsc", sessionId));
  const resources = (
    await Promise.all(
      list.map(async (k) => {
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

  const sessionData = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "session", sessionId));
  if (!sessionData) return c.json({ error: "Session not found" }, 404);

  const t = c.get("tenant_id");
  const resourceData = await c.env.CONFIG_KV.get(kvKey(t, "sesrsc", sessionId, resourceId));
  if (!resourceData) return c.json({ error: "Resource not found" }, 404);

  await c.env.CONFIG_KV.delete(kvKey(t, "sesrsc", sessionId, resourceId));
  return c.json({ type: "resource_deleted", id: resourceId });
});

/**
 * Pre-fetch all credentials for the given vaults so they can be passed into
 * SessionDO at /init. Mirrors the list+get loop SessionDO would otherwise
 * do against its own (potentially wrong) CONFIG_KV namespace.
 */
async function fetchVaultCredentials(
  env: Env,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>> {
  if (!vaultIds.length) return [];
  const out: Array<{ vault_id: string; credentials: CredentialConfig[] }> = [];
  for (const vaultId of vaultIds) {
    const list = await env.CONFIG_KV.list({ prefix: kvKey(tenantId, "cred", vaultId) + ":" });
    const credentials: CredentialConfig[] = [];
    for (const k of list.keys) {
      const data = await env.CONFIG_KV.get(k.name);
      if (!data) continue;
      try {
        credentials.push(JSON.parse(data) as CredentialConfig);
      } catch {
        // skip malformed
      }
    }
    out.push({ vault_id: vaultId, credentials });
  }
  return out;
}

/**
 * Refresh provider-tagged credentials in the given vaults before a session
 * starts using them. Avoids the "user starts a session 90 minutes after the
 * last webhook → installation token already expired → bot 401s on first
 * MCP call" failure mode. Best-effort: any failure is swallowed so the
 * session still starts (the outbound proxy's on-401 retry will catch it
 * later).
 */
async function refreshProviderCredentialsForSession(
  env: Env,
  tenantId: string,
  agentId: string,
  vaultIds: string[],
): Promise<void> {
  if (!vaultIds.length || !env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET) return;

  // Resolve owning userId for this session via the agent row's tenant + a
  // direct user lookup. We need userId because the integrations gateway
  // scopes refresh per-user.
  let userId: string | null = null;
  if (env.AUTH_DB) {
    const row = await env.AUTH_DB.prepare(
      `SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`,
    )
      .bind(tenantId)
      .first<{ id: string }>();
    userId = row?.id ?? null;
  }
  if (!userId) return;

  // Find providers represented in this session's vaults.
  const providers = new Set<string>();
  for (const vaultId of vaultIds) {
    const list = await env.CONFIG_KV.list({ prefix: kvKey(tenantId, "cred", vaultId) + ":" });
    for (const k of list.keys) {
      const data = await env.CONFIG_KV.get(k.name);
      if (!data) continue;
      try {
        const cred = JSON.parse(data) as CredentialConfig;
        if (cred.auth?.provider) providers.add(`${cred.auth.provider}:${vaultId}`);
      } catch {
        // ignore
      }
    }
  }

  // Fan out one refresh per (provider, vault) pair.
  await Promise.all(
    [...providers].map(async (key) => {
      const [provider, vaultId] = key.split(":");
      if (provider !== "github" && provider !== "linear") return;
      try {
        await env.INTEGRATIONS!.fetch(
          `http://gateway/${provider}/internal/refresh-by-vault`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET!,
            },
            body: JSON.stringify({ userId, vaultId }),
          },
        );
      } catch {
        // best-effort
      }
    }),
  );
  // agentId is currently unused (refresh is per-user not per-agent), but
  // we accept it for signature symmetry — future per-agent rate limiting
  // would slot here.
  void agentId;
}

/**
 * Look up a live github binding the tenant owns for the given repo URL. When
 * found, calls the integrations gateway to mint a fresh installation token
 * (~1hr TTL) and returns it alongside the binding's vault id. Returns null
 * when no binding matches or any step fails — caller falls back to PAT.
 */
async function tryGitHubBindingFastPath(
  env: Env,
  tenantId: string,
  repoUrl: string,
): Promise<{ token: string; vaultId: string } | null> {
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET || !env.AUTH_DB) return null;
  const org = parseGitHubOrg(repoUrl);
  if (!org) return null;

  // Resolve the user owning this tenant. Single-user-per-tenant assumption
  // matches the rest of the integrations layer.
  const userRow = await env.AUTH_DB.prepare(
    `SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = userRow?.id;
  if (!userId) return null;

  // Look up active github installations for this user matching the org. The
  // workspace_name field on linear_installations holds the GitHub org login.
  const row = await env.AUTH_DB.prepare(
    `SELECT id, vault_id FROM linear_installations
       WHERE user_id = ? AND provider_id = 'github'
         AND lower(workspace_name) = lower(?)
         AND revoked_at IS NULL AND vault_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, org)
    .first<{ id: string; vault_id: string }>();
  if (!row?.vault_id) return null;

  // Mint fresh token via integrations gateway. The gateway holds the
  // App private key — we don't.
  try {
    const res = await env.INTEGRATIONS.fetch(
      `http://gateway/github/internal/refresh-by-vault`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET,
        },
        body: JSON.stringify({ userId, vaultId: row.vault_id }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    if (!data.token) return null;
    return { token: data.token, vaultId: row.vault_id };
  } catch {
    return null;
  }
}

/**
 * Extract the org login from a GitHub repo URL. Handles
 * `https://github.com/<org>/<repo>(.git)?`, `git@github.com:<org>/<repo>`,
 * and bare `<org>/<repo>` forms. Returns null when unparseable or not GitHub.
 */
function parseGitHubOrg(repoUrl: string): string | null {
  // Try full URL form first
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    return parts[0] || null;
  } catch {
    // SSH form: git@github.com:owner/repo
    const ssh = repoUrl.match(/^git@github\.com:([^/]+)\//);
    if (ssh) return ssh[1];
    // Bare owner/repo
    const bare = repoUrl.match(/^([^/]+)\/[^/]+$/);
    if (bare) return bare[1];
    return null;
  }
}

export default app;
