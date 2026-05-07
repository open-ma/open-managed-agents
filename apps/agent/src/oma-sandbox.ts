// OMA Sandbox subclass — wires the @cloudflare/sandbox 0.8.x outbound
// handler API so vault credentials get injected into outbound requests
// (e.g. Bearer header for MCP server calls). The handler is bound at
// runtime via `sandbox.setOutboundHandler("inject_vault_creds", { ... })`
// — see apps/agent/src/runtime/session-do.ts for where that fires.
//
// Architectural property (mirrors Anthropic Managed Agents' "credential
// proxy outside the harness" pattern): this handler runs in the agent
// worker process, but it does NOT receive plaintext vault credentials in
// its `ctx.params`. The only data passed in is `(tenantId, sessionId)` —
// public identifiers that the model could already see. The actual
// credential lookup and injection happen in main worker via the
// `env.MAIN_MCP.outboundForward` WorkerEntrypoint RPC, where the vault
// data already lives.
//
// Pre-refactor we passed `vault_credentials` directly to setOutboundHandler;
// CF Sandbox SDK then stashed them in container memory. A
// container-escape or prompt-injection-driven RCE could read them out.
// Post-refactor: the agent worker's address space never contains the
// credentials at all. Container compromise can't exfiltrate what the
// container's host process never loaded.
//
// API reference: https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/

import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "@open-managed-agents/shared";
import { recordBackup } from "./runtime/workspace-backups";
import { recordSandboxUsage } from "./runtime/usage-events";

const BACKUP_TTL_SEC = 7 * 24 * 3600;
const BACKUP_CTX_KEY = "oma_backup_ctx";
// Wall-clock ms of the most recent warmup completion. Cleared on
// onStop / onActivityExpired after a usage_events row is written, so
// the next warmup-after-sleep cycle records its own row.
const ACTIVE_STARTED_KEY = "oma_active_started_at";

interface BackupContext {
  tenantId: string;
  environmentId: string;
  sessionId: string;
  agentId?: string;
}

// Match the SDK's OutboundHandlerContext shape (see @cloudflare/containers).
// We accept `unknown` env + cast at the boundary, so we don't need a direct
// import of the SDK's internal types.
interface SdkContext<P = unknown> {
  containerId: string;
  className: string;
  params: P;
}

interface OutboundContextParams {
  tenantId?: string;
  sessionId?: string;
}

/**
 * Headers we strip before forwarding upstream. CF Workers auto-adds some
 * of these when you invoke `fetch()` from a worker; if they're in the
 * upstream's SigV4-signed-headers list (boto3, aws-sdk, s3fs, awscli),
 * the signature mismatch produces a 403. The container's libcurl/sdk
 * never set these — they're CF artifacts of going through our handler.
 *
 * `host` is also problematic: container's libcurl set it to upstream's
 * host; if we forward via `new Request(url, { headers })` the runtime
 * may rewrite based on URL. We trust the runtime's auto-set Host
 * (matches URL) so we strip the explicit one to avoid header collision.
 */
const HOP_BY_HOP_OR_CF_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-amzn-trace-id",
  "host",
]);

const injectVaultCredsHandler = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;

  // Look up credential metadata for this host. Lightweight RPC — only
  // the resolved bearer token crosses the wire. Body + response stay
  // local to the agent worker so transparent forwarding preserves all
  // HTTP semantics (HEAD Content-Length, SigV4 signed headers,
  // Transfer-Encoding: chunked, streaming, Trailer, etc).
  let cred: { type: "bearer"; token: string } | null = null;
  if (params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      cred = await e.MAIN_MCP.lookupOutboundCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: url.hostname,
      });
    } catch (err) {
      console.error(
        `[oma-sandbox] lookupOutboundCredential threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      // Fall through to passthrough — RPC failure shouldn't block
      // legitimate outbound. The host either needs a credential (agent
      // sees auth failure) or doesn't (passthrough is correct).
    }
  }

  // Build outgoing request: clone with CF-internal headers stripped +
  // bearer token injected. Body handling:
  //   - GET / HEAD: no body
  //   - others: materialize body as ArrayBuffer so Workers fetch can
  //     compute and send Content-Length. Workers strips Content-Length
  //     from stream bodies and switches to chunked encoding, which R2
  //     presigned-URL PUTs reject with 411 "Length Required". Buffering
  //     is acceptable for our use case (workspace squashfs uploads
  //     are typically <100 MB; very large would need a streaming-with-
  //     known-length API, doesn't currently exist in Workers).
  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  if (cred) {
    outHeaders.set("authorization", `Bearer ${cred.token}`);
  }

  let upstreamReq: Request;
  if (request.method === "GET" || request.method === "HEAD") {
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      redirect: "manual",
    });
  } else {
    // Materialize body — Workers needs a known-length body to set
    // Content-Length on the outbound request.
    const bodyBytes = await request.arrayBuffer();
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    });
  }

  console.log(
    `[oma-sandbox] outbound host=${url.hostname} method=${request.method} cred=${cred ? "yes" : "no"}`,
  );

  // Return upstream Response unchanged — preserves status, headers,
  // body stream, all HTTP semantics. NO new Response() constructor
  // reconstruction (which is what was overwriting Content-Length on
  // HEAD responses for s3fs reading R2-mounted backup files).
  return fetch(upstreamReq);
};

export class OmaSandbox extends Sandbox {
  // Required by sandbox-container PID 1: with interceptHttps=true, the
  // container's trustRuntimeCert() polls cloudflare-containers-ca.crt for
  // 5s on startup. The cert is only pushed by the platform once
  // setOutboundHandler has been called from the worker side — so
  // session-do.ts must call setOutboundContext for every session, vault
  // or not, before the 5s deadline. See cert-race bisection 2026-05-04
  // (cf-sandbox-cert-demo): containers without the handler call exit(1)
  // with "Certificate not found, refusing to start without HTTPS
  // interception enabled" 100% of the time.
  override interceptHttps = true;

  // Container lifecycle: 5-minute idle TTL. Cost-friendly default.
  override sleepAfter = "5m";

  /**
   * SessionDO calls this once per warmup with the (tenant, env, session)
   * tuple. Stashed in this DO's storage so snapshotWorkspaceNow() (called
   * from onActivityExpired or directly from /destroy) can record the
   * backup against the right (tenant, env) scope. Container DO is keyed
   * by sessionId via getSandbox(env, sessionId), so the stored context
   * belongs to exactly one logical session.
   */
  async setBackupContext(ctx: BackupContext): Promise<void> {
    await this.ctx.storage.put(BACKUP_CTX_KEY, ctx);
    // Mark active-time start once per warmup cycle. Idempotent: if the
    // SDK calls setBackupContext twice on the same live container (resume,
    // re-entry), keep the original start so duration spans the full
    // active window. The key is cleared in onStop after recording.
    const existing = await this.ctx.storage.get<number>(ACTIVE_STARTED_KEY);
    if (existing == null) {
      await this.ctx.storage.put(ACTIVE_STARTED_KEY, Date.now());
    }
  }

  /**
   * Snapshot /workspace into BACKUP_BUCKET + record the handle in AUTH_DB
   * scoped to the stored backup context. Best-effort: any failure logs
   * and returns; never throws because all callers (sleepAfter teardown,
   * explicit /destroy) need to proceed even if backup fails.
   *
   * Single source of truth for the actual backup operation. Both the
   * sleepAfter pre-stop hook and SessionDO's explicit-destroy path call
   * this — there used to be a parallel impl on SessionDO that drifted.
   */
  async snapshotWorkspaceNow(): Promise<void> {
    try {
      const env = this.env as Env;
      const ctx = (await this.ctx.storage.get(BACKUP_CTX_KEY)) as
        | BackupContext
        | undefined;
      if (!ctx || !env.AUTH_DB) return;
      const startMs = Date.now();
      const isDev = !env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID;
      const backup = await this.createBackup({
        dir: "/workspace",
        name: `session-${ctx.sessionId}`,
        ttl: BACKUP_TTL_SEC,
        excludes: ["node_modules", ".cache", "__pycache__", ".next", "target"],
        gitignore: true,
        ...(isDev ? { localBucket: true } : {}),
      });
      const elapsedMs = Date.now() - startMs;
      if (!backup) return;
      await recordBackup(env.AUTH_DB, {
        tenantId: ctx.tenantId,
        environmentId: ctx.environmentId,
        handle: { id: backup.id, dir: backup.dir, localBucket: backup.localBucket },
        nowMs: Date.now(),
        ttlSec: BACKUP_TTL_SEC,
        sessionId: ctx.sessionId,
      });
      console.log(
        `[oma-sandbox] backup recorded id=${backup.id} session=${ctx.sessionId.slice(0, 12)} elapsed_ms=${elapsedMs}`,
      );
    } catch (err) {
      console.error(
        `[oma-sandbox] snapshotWorkspaceNow failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Pre-stop hook: SDK calls this when sleepAfter elapses, default impl
   * just calls this.stop(). We override to snapshot first, then defer
   * to default so the container actually shuts down.
   */
  override async onActivityExpired(): Promise<void> {
    await this.snapshotWorkspaceNow();
    await super.onActivityExpired();
  }

  // Lightweight visibility: log every container exit so we can see why
  // containers recycle without the SQL table from the prior diagnostic
  // scaffolding. CF Workers Logs captures these.
  // The Sandbox base class narrows onStop to `() => Promise<void>` (drops
  // the params), but the underlying Container.callOnStop DOES pass
  // `{ exitCode, reason }` at runtime (container.js:1520). Use rest args to
  // satisfy TS while still capturing the runtime payload.
  override async onStop(...args: unknown[]): Promise<void> {
    const params = (args[0] ?? {}) as { exitCode?: number; reason?: string };
    const ec = typeof params.exitCode === "number" ? params.exitCode : -1;
    const reason = typeof params.reason === "string" ? params.reason : "unknown";
    // 137 = SIGKILL (likely OOM or destroy()); 143 = SIGTERM (graceful)
    console.log(`[oma-sandbox] onStop exit=${ec} reason=${reason}`);

    // Emit a usage_events row covering the wall-clock window between the
    // most recent setBackupContext (warmup completion) and now. Best-effort:
    // a missing context, missing start key, or D1 failure all silently
    // skip — we never want to throw from a teardown hook.
    try {
      const env = this.env as Env;
      if (!env.AUTH_DB) return;
      const ctx = (await this.ctx.storage.get(BACKUP_CTX_KEY)) as
        | BackupContext
        | undefined;
      const startedAt = await this.ctx.storage.get<number>(ACTIVE_STARTED_KEY);
      if (!ctx || startedAt == null) return;
      const endedAt = Date.now();
      const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
      await recordSandboxUsage(env.AUTH_DB, {
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        environmentId: ctx.environmentId,
        startedAt,
        endedAt,
        sandboxActiveSeconds: seconds,
        exitCode: ec,
        exitReason: reason,
      });
      await this.ctx.storage.delete(ACTIVE_STARTED_KEY);
    } catch (err) {
      console.error(
        `[oma-sandbox] usage record on stop failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

// Assign via the inherited static setter (Sandbox/Container expose
// outboundHandlers as a get/set accessor, not a plain field — class field
// syntax `static outboundHandlers = {...}` would shadow without triggering
// the setter, leaving the SDK unable to find the handler at runtime).
(OmaSandbox as unknown as {
  outboundHandlers: Record<string, typeof injectVaultCredsHandler>;
}).outboundHandlers = {
  inject_vault_creds: injectVaultCredsHandler,
};

// Per-host bypass for R2 — createBackup / restoreBackup do raw S3-style
// PUT/GET/HEAD against `*.r2.cloudflarestorage.com` from inside the
// container, and so do agent-driven presigned PUTs from the
// /v1/internal/sessions/:id/uploads/presign flow. Routing those through
// inject_vault_creds (which materializes bodies + uses Workers fetch)
// corrupts the squashfs blob — see cloudflare/sandbox-sdk#619 ("Failed
// to mount squashfs: This doesn't look like a squashfs image" when
// interceptHttps + custom handler). outboundByHost runs at line 217 of
// @cloudflare/containers/lib/container.js BEFORE the catch-all handler.
//
// PUT body shape: Workers fetch ignores user-set Content-Length and
// switches stream bodies to chunked encoding (per
// developers.cloudflare.com/workers/runtime-apis/request — "Any value
// manually set by user code in the Headers will be ignored"). R2 returns
// 411 MissingContentLength on chunked PUTs (sandbox-sdk#660). To
// preserve Content-Length, we materialize the body to ArrayBuffer for
// PUT/POST/PATCH/DELETE and let Workers fetch derive the size from a
// known-length source. GET/HEAD pass through unchanged so squashfs reads
// keep their byte-exact streaming behaviour.
const r2OutboundPassthrough = async (request: Request): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return fetch(request);
  }
  const bodyBytes = await request.arrayBuffer();
  // Strip the Cf-derived headers that confuse upstream signature-checks
  // when the request is replayed through Workers fetch.
  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  return fetch(
    new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    }),
  );
};

(OmaSandbox as unknown as {
  outboundByHost: Record<string, (req: Request) => Promise<Response>>;
}).outboundByHost = {
  "*.r2.cloudflarestorage.com": r2OutboundPassthrough,
};
