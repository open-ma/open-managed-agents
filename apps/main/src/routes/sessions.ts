import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { SessionMeta, UserMessageEvent, AgentConfig, EnvironmentConfig, StoredEvent, ContentBlock, CredentialConfig, SessionEvent } from "@open-managed-agents/shared";
import { generateFileId, buildTrajectory, fileR2Key } from "@open-managed-agents/shared";
import type { SessionRecord, FullStatus } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { toFileRecord } from "@open-managed-agents/files-store";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import {
  SessionArchivedError,
  SessionMemoryStoreMaxExceededError,
  SessionNotFoundError,
  SessionResourceMaxExceededError,
  SessionResourceNotFoundError,
  type NewResourceInput,
} from "@open-managed-agents/sessions-store";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/**
 * Map sessions-store domain errors → HTTP responses. Centralized so every
 * route handler returns the same status codes for the same failure modes.
 */
function mapSessionError(c: Context, err: unknown): Response {
  if (err instanceof SessionNotFoundError) return c.json({ error: "Session not found" }, 404);
  if (err instanceof SessionResourceNotFoundError) return c.json({ error: "Resource not found" }, 404);
  if (err instanceof SessionArchivedError) return c.json({ error: err.message }, 409);
  if (err instanceof SessionResourceMaxExceededError) return c.json({ error: err.message }, 400);
  if (err instanceof SessionMemoryStoreMaxExceededError) return c.json({ error: err.message }, 422);
  throw err;
}

/** Strip server-internal fields from a session row before returning to API.
 *  Legacy SessionMeta did not expose tenant_id; keep that contract. */
function toApiSession<T extends { tenant_id?: string }>(row: T): Omit<T, "tenant_id"> {
  const { tenant_id: _t, ...rest } = row;
  return rest;
}

/**
 * Resolve the sandbox worker service binding for a given environment.
 */
async function getSandboxBinding(
  env: Env,
  environmentId: string,
  tenantId: string,
): Promise<{ binding: Fetcher | null; error?: string; status?: 404 | 500 | 503 }> {
  const services = await getCfServicesForTenant(env, tenantId);
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow) return { binding: null, error: "Environment not found", status: 404 };

  const envConfig = toEnvironmentConfig(envRow);

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
  services: Services,
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
      const meta = await services.files.get({ tenantId, fileId });
      const obj = meta ? await bucket.get(meta.r2_key) : null;
      if (!meta || !obj) {
        throw new Error(`file_id ${fileId} not found`);
      }
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

  // The 8-memory-store sub-cap is enforced inside sessions-store on
  // create — but mirror the early 422 here so over-large payloads fail
  // before snapshot fetches and credential refreshes.
  const memoryStoreCount = (body.resources ?? []).filter((r) => r.type === "memory_store").length;
  if (memoryStoreCount > 8) {
    return c.json({ error: "Maximum 8 memory_store resources per session" }, 422);
  }

  // Verify agent exists
  const agentRow = await c.var.services.agents.get({ tenantId: t, agentId: body.agent });
  if (!agentRow) return c.json({ error: "Agent not found" }, 404);

  // Resolve sandbox worker binding
  const { binding, error, status } = await getSandboxBinding(c.env, body.environment_id, t);
  if (!binding) return c.json({ error }, status ?? 500);

  // Pre-fetch snapshots so SessionDO doesn't have to read CONFIG_KV with a
  // tenant-prefixed key (which fails when sandbox-default's KV binding
  // differs from main's — e.g. shared sandbox + staging main).
  const { tenant_id: _atid, ...agentSnapshot } = agentRow;
  const envRow = await c.var.services.environments.get({
    tenantId: t,
    environmentId: body.environment_id,
  });
  const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;
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
  // ~1hr TTL) before handing the vault to a fresh session. Per OPE-12: failures
  // are no longer silent — they become session.warning events the console
  // renders, so users see "credential refresh failed" instead of mysterious
  // 401s mid-task. Refresh failure is non-fatal: the existing token may still
  // be valid, and the outbound proxy's on-401 retry path covers a true miss.
  const refreshResult = await refreshProviderCredentialsForSession(
    c.env,
    c.var.services,
    t,
    body.agent,
    vaultIds,
  );

  const vaultCredentials = await fetchVaultCredentials(c.var.services, t, vaultIds);

  // Build the non-file initial resources (memory_store, github_repository,
  // env_secret). File resources need the session id BEFORE we can create the
  // scoped file row, so they're handled after the session row exists.
  const nonFileInputs: NewResourceInput[] = [];
  for (const res of body.resources ?? []) {
    if (res.type === "memory_store" && res.memory_store_id) {
      nonFileInputs.push({
        type: "memory_store",
        memory_store_id: res.memory_store_id,
        mount_path: res.mount_path,
        access: res.access === "read_only" ? "read_only" : "read_write",
        prompt: typeof res.prompt === "string" ? res.prompt.slice(0, 4096) : undefined,
      });
    } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
      const repoUrl = res.url || res.repo_url!;
      nonFileInputs.push({
        type: "github_repository",
        url: repoUrl,
        repo_url: repoUrl,
        mount_path: res.mount_path || "/workspace",
        checkout: res.checkout,
      });
    } else if (res.type === "env_secret" && res.name && res.value) {
      nonFileInputs.push({
        type: "env_secret",
        name: res.name,
      });
    }
  }

  // Atomic create — session row + non-file resources in one D1 batch.
  // sessions-store throws SessionResourceMaxExceededError /
  // SessionMemoryStoreMaxExceededError if either cap is hit; route maps to
  // 400/422 via mapSessionError.
  let session;
  let createdResources;
  try {
    const result = await c.var.services.sessions.create({
      tenantId: t,
      agentId: body.agent,
      environmentId: body.environment_id,
      title: body.title || "",
      vaultIds,
      agentSnapshot,
      environmentSnapshot,
      resources: nonFileInputs,
    });
    session = result.session;
    createdResources = result.resources;
  } catch (err) {
    return mapSessionError(c, err);
  }
  const sessionId = session.id;

  // Build refresh warnings with the freshly-allocated sessionId.
  const refreshWarnings = refreshResultToInitEvents(refreshResult, {
    sessionId,
    tenantId: t,
  });

  // Initialize SessionDO via sandbox worker. Resources land before the DO's
  // first warmup reads `listResourcesBySession` — so any resource we add
  // below (files) must be in place before the SessionDO actually mounts
  // them; the DO does that lazily so this ordering is fine.
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
      init_events: refreshWarnings,
    }),
  );

  // Persist secret KV entries for the env_secret + github_repository inputs
  // we created above. These continue to live in CONFIG_KV — sessions-store
  // intentionally records resource METADATA only.
  for (let i = 0; i < (body.resources?.length ?? 0); i++) {
    const res = body.resources![i];
    if (res.type === "env_secret" && res.name && res.value) {
      // Find the matching createdResource by metadata equality (env_secret
      // has no meaningful natural key beyond name; the order is preserved
      // because we built nonFileInputs in source order and sessions-store
      // returns the same order).
      const created = createdResources.find(
        (r) => r.type === "env_secret" && r.resource.type === "env_secret" && r.resource.name === res.name,
      );
      if (created) {
        await c.var.services.sessionSecrets.put({
          tenantId: t,
          sessionId,
          resourceId: created.id,
          value: res.value,
        });
      }
    } else if ((res.type === "github_repository" || res.type === "github_repo") && (res.url || res.repo_url)) {
      const repoUrl = res.url || res.repo_url!;
      const token = res.authorization_token ?? fastPathTokens.get(repoUrl) ?? null;
      if (token) {
        const created = createdResources.find(
          (r) => r.type === "github_repository" && r.resource.type === "github_repository" && r.resource.url === repoUrl,
        );
        if (created) {
          await c.var.services.sessionSecrets.put({
            tenantId: t,
            sessionId,
            resourceId: created.id,
            value: token,
          });
        }
      }
    }
  }

  // File resources require sessionId to scope the new R2 + file_metadata
  // row — handle these after the session exists. addResource runs the
  // per-session cap check each time; we already pre-validated 8-memory-store
  // so the only failure mode here is hitting the 100-resource ceiling
  // (extremely unlikely at create time).
  for (const res of body.resources ?? []) {
    if (res.type === "file" && res.file_id) {
      const sourceFile = await c.var.services.files.get({
        tenantId: t,
        fileId: res.file_id,
      });
      if (!sourceFile) continue;

      const scopedFileId = generateFileId();
      const scopedR2Key = fileR2Key(t, scopedFileId);

      // R2 copy first — best-effort (legacy files may have no R2 bytes).
      if (c.env.FILES_BUCKET) {
        const obj = await c.env.FILES_BUCKET.get(sourceFile.r2_key);
        if (obj) {
          await c.env.FILES_BUCKET.put(
            scopedR2Key,
            obj.body,
            { httpMetadata: { contentType: sourceFile.media_type } },
          );
        }
      }

      await c.var.services.files.create({
        id: scopedFileId,
        tenantId: t,
        sessionId,
        filename: sourceFile.filename,
        mediaType: sourceFile.media_type,
        sizeBytes: sourceFile.size_bytes,
        r2Key: scopedR2Key,
        downloadable: sourceFile.downloadable,
      });

      try {
        const added = await c.var.services.sessions.addResource({
          tenantId: t,
          sessionId,
          resource: {
            type: "file",
            file_id: scopedFileId,
            mount_path: res.mount_path,
          },
        });
        createdResources.push(added);
      } catch (err) {
        return mapSessionError(c, err);
      }
    }
  }

  // Surface a Session-shaped response (legacy SessionMeta + frozen snapshots).
  const responseSession: SessionMeta = {
    id: session.id,
    agent_id: session.agent_id,
    environment_id: session.environment_id,
    title: session.title,
    status: session.status,
    vault_ids: session.vault_ids ?? undefined,
    created_at: session.created_at,
  };
  const response: Record<string, unknown> = { ...responseSession };
  if (createdResources.length > 0) {
    response.resources = createdResources.map((r) => r.resource);
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

  const sessions = await c.var.services.sessions.list({
    tenantId: c.get("tenant_id"),
    agentId: agentIdFilter ?? undefined,
    includeArchived,
    order,
    limit,
  });
  return c.json({ data: sessions.map(toApiSession) });
});

// GET /v1/sessions/:id — get session (status from sandbox worker)
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Get live status, usage, and outcome evaluations from sandbox worker
  const { binding } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  const response: Record<string, unknown> = { ...toApiSession(session) };

  if (binding) {
    try {
      const fullStatusRes = await forwardToSandbox(binding, `/sessions/${id}/full-status`, c.req.raw, "GET");
      const fullStatus = (await fullStatusRes.json()) as {
        status: string;
        usage: { input_tokens: number; output_tokens: number };
        outcome_evaluations: Array<{ result: string; iteration: number; feedback?: string }>;
      };
      response.status = fullStatus.status;
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
  try {
    const session = await c.var.services.sessions.archive({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
    });
    return c.json(toApiSession(session));
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// POST /v1/sessions/:id — update session
app.post("/:id", async (c) => {
  const body = await c.req.json<{
    title?: string;
    metadata?: Record<string, unknown>;
  }>();
  try {
    const updated = await c.var.services.sessions.update({
      tenantId: c.get("tenant_id"),
      sessionId: c.req.param("id"),
      title: body.title,
      metadata: body.metadata,
    });
    return c.json(toApiSession(updated));
  } catch (err) {
    return mapSessionError(c, err);
  }
});

// DELETE /v1/sessions/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Check if session is running — cannot delete while active
  const { binding } = await getSandboxBinding(c.env, session.environment_id, t);
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

  // Cascade-delete the session row + every session_resources row in one
  // batch. Caller is still responsible for the per-session secret KV
  // entries (env_secret.value, github_repository.token) and for files
  // uploaded under this session — both are cleaned up below.
  try {
    await c.var.services.sessions.delete({ tenantId: t, sessionId: id });
  } catch (err) {
    return mapSessionError(c, err);
  }

  // Cascade-delete file metadata (files-store) and remove the corresponding
  // R2 blobs. Best-effort: a partial failure leaks at most a few bytes of
  // R2 storage, not user-visible.
  try {
    const orphanedFiles = await c.var.services.files.deleteBySession({
      sessionId: id,
    });
    if (c.env.FILES_BUCKET && orphanedFiles.length) {
      await Promise.all(
        orphanedFiles.map((f) =>
          c.env.FILES_BUCKET!.delete(f.r2_key).catch(() => undefined),
        ),
      );
    }
  } catch {
    // best-effort; metadata cleanup never blocks the session delete itself
  }

  // Best-effort secret cleanup — cascade all per-resource secrets for this
  // session. The route doesn't track resourceIds at delete time, so the
  // store walks its keyspace internally.
  await c.var.services.sessionSecrets.deleteAllForSession({
    tenantId: t,
    sessionId: id,
  });

  return c.json({ type: "session_deleted", id });
});

// POST /v1/sessions/:id/events — send user events
app.post("/:id/events", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

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
          const { content: resolved, mountFileIds } = await resolveFileIds(c.env, c.var.services, t, e.content);
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
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const bucket = c.env.FILES_BUCKET;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

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
  const r2Key = fileR2Key(t, newFileId);
  await bucket.put(r2Key, buf, { httpMetadata: { contentType: mediaType } });

  const row = await c.var.services.files.create({
    id: newFileId,
    tenantId: t,
    sessionId: id,
    filename,
    mediaType,
    sizeBytes: buf.byteLength,
    r2Key,
    downloadable,
  });

  return c.json(toFileRecord(row), 201);
});

// SSE stream
async function handleSSEStream(c: Context<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>, id: string) {
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

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
async function handleJSONEvents(c: Context<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>, id: string) {
  const t = c.get("tenant_id");
  const session = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!session) return c.json({ error: "Session not found" }, 404);

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
  const sessionRow = await c.var.services.sessions.get({ tenantId: t, sessionId: id });
  if (!sessionRow) return c.json({ error: "Session not found" }, 404);

  // Build a SessionRecord-shaped object for buildTrajectory: it expects the
  // same shape the legacy KV record had (id + agent_id + environment_id +
  // agent_snapshot + environment_snapshot + title + status + timestamps).
  const session = {
    id: sessionRow.id,
    agent_id: sessionRow.agent_id,
    environment_id: sessionRow.environment_id,
    title: sessionRow.title,
    status: sessionRow.status,
    created_at: sessionRow.created_at,
    updated_at: sessionRow.updated_at ?? undefined,
    archived_at: sessionRow.archived_at ?? undefined,
    vault_ids: sessionRow.vault_ids ?? undefined,
    metadata: sessionRow.metadata ?? undefined,
    agent_snapshot: sessionRow.agent_snapshot ?? undefined,
    environment_snapshot: sessionRow.environment_snapshot ?? undefined,
  } as SessionRecord;

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
    const row = await c.var.services.environments.get({
      tenantId: t,
      environmentId: session.environment_id,
    });
    return row ? toEnvironmentConfig(row) : null;
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
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const { binding, error, status } = await getSandboxBinding(c.env, session.environment_id, c.get("tenant_id"));
  if (!binding) return c.json({ error }, status ?? 500);

  const res = await forwardToSandbox(binding, `/sessions/${id}/threads`, c.req.raw, "GET");
  return c.json(await res.json());
});

// GET /v1/sessions/:id/threads/:thread_id/events — thread events
app.get("/:id/threads/:thread_id/events", async (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("thread_id");
  const session = await c.var.services.sessions.get({
    tenantId: c.get("tenant_id"),
    sessionId: id,
  });
  if (!session) return c.json({ error: "Session not found" }, 404);

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
  const t = c.get("tenant_id");

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

  // Per-resource pre-checks the service can't enforce (file existence is a
  // cross-store concern; memory_store sub-cap stays inside sessions-store).
  if (body.type === "file") {
    if (!body.file_id) {
      return c.json({ error: "file_id is required for file resources" }, 400);
    }
    const file = await c.var.services.files.get({
      tenantId: t,
      fileId: body.file_id,
    });
    if (!file) return c.json({ error: "File not found" }, 404);
  }

  if (body.type === "memory_store" && !body.memory_store_id) {
    return c.json({ error: "memory_store_id is required for memory_store resources" }, 400);
  }

  try {
    const added = await c.var.services.sessions.addResource({
      tenantId: t,
      sessionId,
      resource: {
        type: body.type,
        file_id: body.file_id,
        memory_store_id: body.memory_store_id,
        mount_path: body.mount_path,
        access: body.type === "memory_store"
          ? (body.access === "read_only" ? "read_only" : "read_write")
          : undefined,
        prompt: body.type === "memory_store" && typeof body.prompt === "string"
          ? body.prompt.slice(0, 4096)
          : undefined,
      },
    });
    return c.json(added.resource, 201);
  } catch (err) {
    return mapSessionError(c, err);
  }
});

app.get("/:id/resources", async (c) => {
  const sessionId = c.req.param("id");
  try {
    const resources = await c.var.services.sessions.listResources({
      tenantId: c.get("tenant_id"),
      sessionId,
    });
    return c.json({ data: resources.map((r) => r.resource) });
  } catch (err) {
    return mapSessionError(c, err);
  }
});

app.delete("/:id/resources/:resource_id", async (c) => {
  const sessionId = c.req.param("id");
  const resourceId = c.req.param("resource_id");
  const t = c.get("tenant_id");

  try {
    await c.var.services.sessions.deleteResource({
      tenantId: t,
      sessionId,
      resourceId,
    });
  } catch (err) {
    return mapSessionError(c, err);
  }

  // Best-effort cleanup of the corresponding secret entry (if any).
  // The route doesn't know which resource type this was without re-fetching;
  // a stray delete on a non-existent key is a no-op so this is safe.
  await c.var.services.sessionSecrets.deleteOne({
    tenantId: t,
    sessionId,
    resourceId,
  });

  return c.json({ type: "resource_deleted", id: resourceId });
});

/**
 * Pre-fetch all credentials for the given vaults so they can be passed into
 * SessionDO at /init. Reads from D1 via the credentials-store service.
 * SessionDO consumers only need the id + auth fields, so the extra
 * `tenant_id` on CredentialRow is harmless when serialized.
 */
async function fetchVaultCredentials(
  services: Services,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>> {
  if (!vaultIds.length) return [];
  const grouped = await services.credentials.listByVaults({
    tenantId,
    vaultIds,
  });
  return grouped.map((g) => ({
    vault_id: g.vault_id,
    credentials: g.credentials as unknown as CredentialConfig[],
  }));
}

/**
 * Outcome of a pre-session credential refresh attempt. The session start path
 * uses this to decide whether to emit warning events into the session stream
 * (so the user sees something in the console instead of a silent expired token
 * surfacing as a 401 mid-task — see OPE-12).
 */
export interface CredentialRefreshResult {
  /** Total (provider, vault) pairs we tried to refresh. */
  attempted: number;
  /** Successful refreshes. */
  succeeded: number;
  /** Per-failure detail for caller's warning event / log. */
  failures: Array<{
    provider: "github" | "linear";
    vaultId: string;
    error: string;
    httpStatus?: number;
  }>;
  /**
   * Set when the refresh path could not run at all (e.g. integrations binding
   * missing, no user row for tenant). Distinct from per-(provider, vault)
   * failure: the whole pass was skipped.
   */
  skippedReason?: "no_integrations_binding" | "no_auth_db" | "no_user_for_tenant" | "no_provider_credentials";
}

/**
 * Refresh provider-tagged credentials in the given vaults before a session
 * starts using them. Avoids the "user starts a session 90 minutes after the
 * last webhook → installation token already expired → bot 401s on first
 * MCP call" failure mode.
 *
 * Returns a structured result instead of throwing — the caller decides
 * whether to surface failures (e.g. as session.warning events). Per-OPE-12,
 * we never silently swallow.
 */
async function refreshProviderCredentialsForSession(
  env: Env,
  services: Services,
  tenantId: string,
  agentId: string,
  vaultIds: string[],
): Promise<CredentialRefreshResult> {
  const empty = (): CredentialRefreshResult => ({ attempted: 0, succeeded: 0, failures: [] });

  if (!vaultIds.length) return empty();
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET) {
    return { ...empty(), skippedReason: "no_integrations_binding" };
  }
  if (!env.AUTH_DB) return { ...empty(), skippedReason: "no_auth_db" };

  // Resolve owning userId for this session via the agent row's tenant + a
  // direct user lookup. We need userId because the integrations gateway
  // scopes refresh per-user.
  const row = await env.AUTH_DB.prepare(
    `SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = row?.id ?? null;
  if (!userId) return { ...empty(), skippedReason: "no_user_for_tenant" };

  // One SQL round-trip via the partial-index on (tenant_id, vault_id, provider).
  // Replaces the previous N-vault × M-key KV scan.
  const tagged = await services.credentials.listProviderTagged({
    tenantId,
    vaultIds,
  });
  if (!tagged.length) return { ...empty(), skippedReason: "no_provider_credentials" };

  // Dedupe to one refresh per (provider, vault) pair.
  const targets = new Map<string, { provider: "github" | "linear"; vaultId: string }>();
  for (const cred of tagged) {
    const provider = cred.auth.provider;
    if (provider !== "github" && provider !== "linear") continue;
    const key = `${provider}:${cred.vault_id}`;
    if (!targets.has(key)) targets.set(key, { provider, vaultId: cred.vault_id });
  }

  const failures: CredentialRefreshResult["failures"] = [];
  let succeeded = 0;
  await Promise.all(
    Array.from(targets.values()).map(async ({ provider, vaultId }) => {
      try {
        const res = await env.INTEGRATIONS!.fetch(
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
        if (!res.ok) {
          let bodyText: string | undefined;
          try {
            bodyText = (await res.text()).slice(0, 200);
          } catch {
            // ignore body-read failures — status code is the load-bearing signal
          }
          failures.push({
            provider,
            vaultId,
            httpStatus: res.status,
            error: `gateway returned ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
          });
          return;
        }
        succeeded++;
      } catch (err) {
        failures.push({
          provider,
          vaultId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  // agentId is currently unused (refresh is per-user not per-agent), but
  // we accept it for signature symmetry — future per-agent rate limiting
  // would slot here.
  void agentId;
  return { attempted: targets.size, succeeded, failures };
}

/**
 * Convert refresh failures to session.warning events the SessionDO appends to
 * the event stream at /init. One event per failure so the console can surface
 * each (provider, vault) pair distinctly. Per-OPE-12: never silent — even when
 * the whole refresh pass was skipped (no integrations binding, etc.) we log
 * but don't emit a stream event since that's a config/infrastructure signal
 * not actionable to the end user.
 */
function refreshResultToInitEvents(
  result: CredentialRefreshResult,
  ctx: { sessionId: string; tenantId: string },
): SessionEvent[] {
  if (result.skippedReason) {
    console.warn(
      `[session-start] credential refresh skipped: reason=${result.skippedReason} session=${ctx.sessionId} tenant=${ctx.tenantId}`,
    );
    return [];
  }
  if (!result.failures.length) return [];
  console.warn(
    `[session-start] credential refresh: ${result.failures.length}/${result.attempted} failed session=${ctx.sessionId} tenant=${ctx.tenantId}`,
    result.failures,
  );
  return result.failures.map((f) => ({
    type: "session.warning",
    source: "credential_refresh",
    message: `${f.provider} credential refresh failed for vault ${f.vaultId} — tools using this credential may 401 mid-task and trigger an on-401 retry. ${f.error}`,
    details: {
      provider: f.provider,
      vault_id: f.vaultId,
      http_status: f.httpStatus,
      error: f.error,
    },
  }));
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

// Test-only re-exports — keep route surface clean by namespacing helpers
// that have no business being a public API but need coverage in unit tests.
export const __test__ = {
  refreshResultToInitEvents,
};
