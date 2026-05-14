// CF SessionRouter — wraps the SessionDO RPC surface declared in
// apps/agent/src/runtime/session-do.ts behind the runtime-agnostic
// `SessionRouter` contract used by `@open-managed-agents/http-routes`.
// Produces the same wire output the legacy apps/main/src/routes/sessions.ts
// did, just via SessionRouter.* method calls instead of inline
// `forwardToSandbox` / `binding.fetch` boilerplate.
//
// Routing model: SessionDO requests reach the sandbox-default agent
// worker via the SANDBOX_sandbox_default service binding (production)
// or the SESSION_DO local DO binding (combined-worker test mode). This
// adapter encapsulates the fan-out so routes never see env bindings.

import { LOCAL_RUNTIME_ENV_ID, buildTrajectory } from "@open-managed-agents/shared";
import type {
  Env,
  EnvironmentConfig,
  SessionEvent,
  SessionRecord,
  StoredEvent,
} from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import type {
  SessionRouter,
  SessionInitParams,
  SessionEventsPage,
  SessionEventsQuery,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
} from "@open-managed-agents/session-runtime";

/** Inputs handed to every CF router request — closure-bound at construction. */
export interface CfSessionRouterDeps {
  env: Env;
  /** Per-tenant Services container (resolved by `servicesMiddleware` for
   *  Hono routes; constructed via `getCfServicesForTenant` for non-Hono
   *  callers). Used for environment lookups in init / status routing. */
  services: Services;
  tenantId: string;
}

export class CfSessionRouter implements SessionRouter {
  constructor(private deps: CfSessionRouterDeps) {}

  async init(sessionId: string, params: SessionInitParams): Promise<void> {
    const binding = await this.bindingFor(params.environmentId);
    if (!binding) throw new Error("SANDBOX binding unavailable for init");
    await binding.fetch(`https://sandbox/sessions/${sessionId}/init`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: params.agentId,
        environment_id: params.environmentId,
        title: params.title,
        session_id: sessionId,
        tenant_id: params.tenantId,
        vault_ids: params.vaultIds ?? [],
        agent_snapshot: params.agentSnapshot,
        environment_snapshot: params.environmentSnapshot,
        vault_credentials: params.vaultCredentials ?? [],
        init_events: params.initEvents ?? [],
      }),
    });
  }

  async destroy(sessionId: string): Promise<void> {
    // Look up the session to find its environment_id — required for
    // routing the destroy to the right sandbox lane. If the session
    // row is gone (already deleted), short-circuit silently.
    const sess = await this.deps.services.sessions.get({
      tenantId: this.deps.tenantId,
      sessionId,
    });
    if (!sess) return;
    const binding = await this.bindingFor(sess.environment_id);
    if (!binding) return;
    await binding
      .fetch(`https://sandbox/sessions/${sessionId}/destroy`, { method: "DELETE" })
      .catch(() => undefined);
  }

  async appendEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<SessionAppendResult> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      return {
        status: 503,
        body: JSON.stringify({ error: "sandbox binding unavailable" }),
      };
    }
    const res = await binding.fetch(`https://sandbox/sessions/${sessionId}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    return { status: res.status, body: await res.text() };
  }

  async getEvents(
    sessionId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) return { data: [], has_more: false };
    const qs = new URLSearchParams();
    if (opts.afterSeq !== undefined) qs.set("after_seq", String(opts.afterSeq));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.order) qs.set("order", opts.order);
    const url = `https://sandbox/sessions/${sessionId}/events${qs.toString() ? "?" + qs.toString() : ""}`;
    const res = await binding.fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`events fetch failed: ${res.status}`);
    }
    return (await res.json()) as SessionEventsPage;
  }

  async getThreadEvents(
    sessionId: string,
    threadId: string,
    opts: SessionEventsQuery = {},
  ): Promise<SessionEventsPage> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) return { data: [], has_more: false };
    const qs = new URLSearchParams();
    if (opts.afterSeq !== undefined) qs.set("after_seq", String(opts.afterSeq));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const url = `https://sandbox/sessions/${sessionId}/threads/${threadId}/events${qs.toString() ? "?" + qs.toString() : ""}`;
    const res = await binding.fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`thread events fetch failed: ${res.status}`);
    return (await res.json()) as SessionEventsPage;
  }

  async streamEvents(
    sessionId: string,
    opts: {
      threadId?: string;
      lastEventId?: number;
      replay?: boolean;
      include?: string[];
    } = {},
  ): Promise<SessionStreamHandle> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      // Empty stream — close immediately. SSE handler will emit nothing.
      return emptyStream();
    }

    const wsHeaders = new Headers();
    wsHeaders.set("Upgrade", "websocket");
    wsHeaders.set("Connection", "Upgrade");
    if (opts.lastEventId !== undefined) {
      wsHeaders.set("Last-Event-ID", String(opts.lastEventId));
    }
    // Forward opt-in flags. SessionDO `/ws` reads these to decide history
    // replay + spec-vs-extension event filtering. Defaults (no headers) =
    // Anthropic-spec behavior: no replay, spec event types only.
    if (opts.replay) {
      wsHeaders.set("x-oma-replay", "1");
    }
    if (opts.include && opts.include.length > 0) {
      wsHeaders.set("x-oma-include", opts.include.join(","));
    }

    const wsRes = await binding.fetch(`https://sandbox/sessions/${sessionId}/ws`, {
      method: "GET",
      headers: wsHeaders,
    });
    const ws = (wsRes as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) {
      throw new Error("Failed to establish WebSocket to session");
    }
    ws.accept();

    return wsToHandle(ws, opts.threadId);
  }

  async interrupt(sessionId: string, _reason?: string): Promise<void> {
    // SessionDO treats user.interrupt like any other event — append +
    // drainEventQueue triggers the abort path. Mirrors what
    // apps/main/src/routes/sessions.ts did inline.
    const ev: SessionEvent = { type: "user.interrupt" } as unknown as SessionEvent;
    await this.appendEvent(sessionId, ev).catch(() => undefined);
  }

  async exec(
    sessionId: string,
    body: { command: string; timeout_ms?: number },
  ): Promise<SessionExecResult> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) throw new Error("sandbox binding unavailable for exec");
    const res = await binding.fetch(`https://sandbox/sessions/${sessionId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`exec failed: ${res.status}`);
    return (await res.json()) as SessionExecResult;
  }

  async getFullStatus(sessionId: string): Promise<SessionFullStatus | null> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) return null;
    try {
      const res = await binding.fetch(
        `https://sandbox/sessions/${sessionId}/full-status`,
        { method: "GET" },
      );
      if (!res.ok) return null;
      return (await res.json()) as SessionFullStatus;
    } catch {
      return null;
    }
  }

  async readSandboxFile(
    sessionId: string,
    path: string,
  ): Promise<ArrayBuffer | null> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) return null;
    const res = await binding.fetch(
      `https://sandbox/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    if (!res.ok) return null;
    return res.arrayBuffer();
  }

  async triggerDebugRecovery(
    sessionId: string,
    token: string,
  ): Promise<{ status: number; body: string }> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      return { status: 503, body: JSON.stringify({ error: "binding unavailable" }) };
    }
    const res = await binding.fetch(
      `https://sandbox/sessions/${sessionId}/__debug_recovery__`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-debug-token": token },
      },
    );
    return { status: res.status, body: await res.text() };
  }

  async getTrajectory(
    session: SessionRecord,
    helpers: { fetchEnvironmentConfig: () => Promise<EnvironmentConfig | null> },
  ): Promise<unknown> {
    const fetchAll = async (): Promise<StoredEvent[]> => {
      const all: StoredEvent[] = [];
      let afterSeq = 0;
      while (true) {
        const page = await this.getEvents(session.id, {
          limit: 1000,
          order: "asc",
          afterSeq,
        });
        all.push(...page.data);
        if (!page.has_more || page.data.length === 0) break;
        afterSeq = page.data[page.data.length - 1].seq;
      }
      return all;
    };
    return buildTrajectory(session, {
      fetchAllEvents: fetchAll,
      fetchFullStatus: async () => this.getFullStatus(session.id),
      fetchEnvironmentConfig: helpers.fetchEnvironmentConfig,
    });
  }

  async listThreads(sessionId: string): Promise<unknown> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) return { data: [] };
    const res = await binding.fetch(`https://sandbox/sessions/${sessionId}/threads`, {
      method: "GET",
    });
    return res.json();
  }

  async getThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      return { status: 503, body: JSON.stringify({ error: "binding unavailable" }) };
    }
    const res = await binding.fetch(
      `https://sandbox/sessions/${sessionId}/threads/${threadId}`,
      { method: "GET" },
    );
    return { status: res.status, body: await res.text() };
  }

  async archiveThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      return { status: 503, body: JSON.stringify({ error: "binding unavailable" }) };
    }
    const res = await binding.fetch(
      `https://sandbox/sessions/${sessionId}/threads/${threadId}/archive`,
      { method: "POST" },
    );
    return { status: res.status, body: await res.text() };
  }

  async getPending(
    sessionId: string,
    opts?: { rawSearch?: string },
  ): Promise<{ status: number; body: string }> {
    const binding = await this.bindingForSession(sessionId);
    if (!binding) {
      return { status: 503, body: JSON.stringify({ error: "binding unavailable" }) };
    }
    const search = opts?.rawSearch ?? "";
    const res = await binding.fetch(
      `https://sandbox/sessions/${sessionId}/pending${search}`,
      { method: "GET" },
    );
    return { status: res.status, body: await res.text() };
  }

  async getLlmCallBody(
    tenantId: string,
    sessionId: string,
    eventId: string,
  ): Promise<
    | { status: number; body: BodyInit; contentType: string; contentLength?: number }
    | { status: 404 | 500 | 501; body: string; contentType: "application/json" }
  > {
    const filesBucket = (this.deps.env as unknown as { FILES_BUCKET?: R2Bucket }).FILES_BUCKET;
    if (!filesBucket) {
      return {
        status: 500,
        body: JSON.stringify({ error: "FILES_BUCKET binding not configured" }),
        contentType: "application/json",
      };
    }
    const key = `t/${tenantId}/sessions/${sessionId}/llm/${eventId}.json`;
    const obj = await filesBucket.get(key);
    if (!obj) {
      return {
        status: 404,
        body: JSON.stringify({ error: "LLM call body not found", key }),
        contentType: "application/json",
      };
    }
    return {
      status: 200,
      body: obj.body as BodyInit,
      contentType: "application/json",
      contentLength: obj.size,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /** Resolve the sandbox lane for an environment. Local-runtime sessions
   *  go through the SESSION_DO direct fetcher; cloud sessions go through
   *  the SANDBOX_sandbox_default service binding. Mirrors the legacy
   *  getSandboxBinding in apps/main/src/routes/sessions.ts. */
  private async bindingFor(environmentId: string): Promise<Fetcher | null> {
    const { env } = this.deps;
    if (environmentId === LOCAL_RUNTIME_ENV_ID) return doFallbackFetcher(env);
    const svc = (env as unknown as Record<string, unknown>)["SANDBOX_sandbox_default"] as Fetcher | undefined;
    if (svc) return svc;
    return doFallbackFetcher(env);
  }

  /** Resolve binding from a sessionId by re-reading the session row. Most
   *  routes already have the row in scope; this is the fallback path. */
  private async bindingForSession(sessionId: string): Promise<Fetcher | null> {
    const sess = await this.deps.services.sessions.get({
      tenantId: this.deps.tenantId,
      sessionId,
    });
    if (!sess) return null;
    return this.bindingFor(sess.environment_id);
  }
}

/** Direct-to-DO fallback used by local-runtime sessions (no env image)
 *  and by combined-worker test mode (SESSION_DO bound, no service
 *  binding). Mirrors sessionDoFallbackFetcher inline in the legacy
 *  sessions.ts. */
function doFallbackFetcher(env: Env): Fetcher | null {
  if (!env.SESSION_DO) return null;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
      if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
      const [, sessionId, rest] = match;
      const doId = env.SESSION_DO!.idFromName(sessionId);
      const stub = env.SESSION_DO!.get(doId);
      // Note: legacy code called `stub.setName?.(sessionId)` here as a
      // workaround for cloudflare/workerd#2240 (partyserver .name
      // seeding). Newer workerd surfaces the optional chain through to
      // the RPC receiver and throws when the method isn't declared, so
      // we omit it. The DO works fine without; partyserver naming
      // happens internally when the DO accepts the WebSocket.
      void sessionId;
      return stub.fetch(
        new Request(`http://internal/${rest}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        }),
      );
    },
    connect: () => {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function emptyStream(): SessionStreamHandle {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined as unknown as SessionStreamFrame, done: true }) };
    },
    close() {},
  };
}

function wsToHandle(ws: WebSocket, threadFilter?: string): SessionStreamHandle {
  // Pull-driven async iterator over WebSocket messages. Buffers up to
  // 1024 frames if the consumer is slow — matches the SSE backpressure
  // tolerance the legacy bridge had implicitly via Worker memory.
  let closed = false;
  const buf: SessionStreamFrame[] = [];
  let waker: ((v: IteratorResult<SessionStreamFrame>) => void) | null = null;

  const push = (f: SessionStreamFrame) => {
    if (closed) return;
    if (waker) {
      const w = waker;
      waker = null;
      w({ value: f, done: false });
    } else if (buf.length < 1024) {
      buf.push(f);
    }
    // overflow → drop newest frame (preserves earliest history during
    // a slow consumer ramp; matches the WS "writer.closed" path below).
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    if (waker) {
      const w = waker;
      waker = null;
      w({ value: undefined as unknown as SessionStreamFrame, done: true });
    }
  };

  ws.addEventListener("message", (event: MessageEvent) => {
    const raw = event.data as string;
    if (threadFilter) {
      // Best-effort filter — non-JSON heartbeats forward unconditionally.
      try {
        const payload = JSON.parse(raw) as { session_thread_id?: string };
        const tid = payload.session_thread_id ?? "sthr_primary";
        if (tid !== threadFilter) return;
      } catch {
        /* forward as-is */
      }
    }
    push({ data: raw });
  });
  ws.addEventListener("close", finish);
  ws.addEventListener("error", finish);

  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buf.length > 0) {
            return Promise.resolve({ value: buf.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({
              value: undefined as unknown as SessionStreamFrame,
              done: true,
            });
          }
          return new Promise<IteratorResult<SessionStreamFrame>>((resolve) => {
            waker = resolve;
          });
        },
      };
    },
    close() {
      finish();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Construct a CfSessionRouter outside of Hono context. Builds Services
 *  via `getCfServicesForTenant`. Used by RPC entry points. */
export async function createCfSessionRouter(
  env: Env,
  tenantId: string,
): Promise<CfSessionRouter> {
  const services = await getCfServicesForTenant(env, tenantId);
  return new CfSessionRouter({ env, services, tenantId });
}
