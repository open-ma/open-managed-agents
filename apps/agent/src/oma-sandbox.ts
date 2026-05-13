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
import {
  buildCfTenantDbProvider,
  getCfServicesForTenant,
} from "@open-managed-agents/services";
import { recordBackup } from "./runtime/workspace-backups";

const BACKUP_TTL_SEC = 7 * 24 * 3600;
const BACKUP_CTX_KEY = "oma_backup_ctx";
// Per-container persistent storage of billing context — survives across
// onStart/onStop cycles within the same DO. We need both the (tenant,
// session, agent) tuple AND the start timestamp so onStop can compute
// elapsed seconds even after a DO restart.
const BILLING_CTX_KEY = "oma_billing_ctx";

interface BackupContext {
  tenantId: string;
  environmentId: string;
  sessionId: string;
}

interface BillingContext {
  tenantId: string;
  sessionId: string;
  agentId: string | null;
  /** Unix ms when the container most recently started (or first call landed). */
  startedAt: number;
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
  }

  /**
   * Per-container billing context. SessionDO calls this once per warmup
   * with (tenant, session, agent). We use it to attribute the
   * sandbox_active_seconds emit at onStop time — without context the
   * emit silently no-ops (self-host / dev path).
   *
   * startedAt is mint-or-fetch: if a context already exists in storage
   * we keep its startedAt (containers within one logical session may
   * stop/restart on idle teardown — we credit the user only for the
   * fresh window). Actual lifecycle events come through onStart / onStop
   * below.
   */
  async setBillingContext(ctx: Omit<BillingContext, "startedAt">): Promise<void> {
    const existing = (await this.ctx.storage.get(BILLING_CTX_KEY)) as
      | BillingContext
      | undefined;
    if (existing && existing.sessionId === ctx.sessionId) {
      // Same session, container still warm — keep the original startedAt
      // so we don't double-bill on a no-op re-warm.
      return;
    }
    await this.ctx.storage.put(BILLING_CTX_KEY, {
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      startedAt: Date.now(),
    });
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
      // Route to the tenant's shard — workspace_backups is per-tenant data.
      // The CF tenant-DB provider is the wiring boundary; resolve once and
      // pass the resolved DB into the (port-shaped) recordBackup function.
      const provider = buildCfTenantDbProvider(env);
      const backupDb = await provider.resolve(ctx.tenantId);
      await recordBackup(backupDb, {
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
   * just calls this.stop(). We override to:
   *   1. snapshotWorkspaceNow() — preserve /workspace state to R2
   *   2. unmount every active bucket — keep the SDK's `activeMounts`
   *      table consistent with actual container state. Without this,
   *      the SDK's bookkeeping survives container teardown but the
   *      fuse mounts inside the container do not; the next warmup's
   *      `mountBucket(...)` call hits InvalidMountConfigError("already
   *      in use") because `activeMounts.has(path)` is true while the
   *      new container has nothing mounted. Calling unmountBucket WHILE
   *      the container is still alive lets fusermount succeed and the
   *      SDK properly clears the table. Caught 2026-05-13 — every
   *      sleepAfter recycle bricked /mnt/session/outputs for the rest
   *      of the session.
   *   3. defer to default super impl so the container actually shuts down
   */
  override async onActivityExpired(): Promise<void> {
    await this.snapshotWorkspaceNow();
    await this.unmountAllBuckets();
    await super.onActivityExpired();
  }

  /**
   * Best-effort: unmount every entry in the SDK's `activeMounts` table.
   * Idempotent + per-path failures swallowed — we run this from
   * onActivityExpired right before container shutdown, so even if
   * fusermount on one path fails the container's about to die anyway
   * and the SDK table will be effectively reset on next warmup (the
   * container won't have those mounts to conflict with the entries we
   * couldn't clear). Logs failures so a recurring leak shows up in
   * observability.
   */
  private async unmountAllBuckets(): Promise<void> {
    const self = this as unknown as { activeMounts?: Map<string, unknown> };
    const paths = Array.from(self.activeMounts?.keys() ?? []);
    if (!paths.length) return;
    await Promise.all(
      paths.map((p) =>
        this.unmountBucket(p).catch((err: Error) =>
          console.warn(
            `[oma-sandbox] pre-stop unmount ${p} failed: ${err?.message ?? err}`,
          ),
        ),
      ),
    );
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
    await this.recordSandboxActiveOnStop();
  }

  /**
   * Public entry point for the SessionDO `/destroy` path to emit the
   * sandbox_active_seconds row BEFORE calling `sandbox.destroy()`. The
   * CF Containers SDK fires `onStop` async to destroy() — by the time
   * SessionDO returns 200, the onStop callback may still be inflight or
   * may have been dropped if the DO got evicted. Calling this explicitly
   * gives us a synchronous emit in the SessionDO's request lifecycle.
   *
   * Idempotent via storage-delete-after-emit — a later onStop fires this
   * again but reads `undefined` from storage and no-ops.
   */
  async emitSandboxActiveNow(): Promise<void> {
    await this.recordSandboxActiveOnStop();
  }

  /**
   * Compute container active-seconds from the stored billing context's
   * startedAt and emit one usage_events row of kind=sandbox_active_seconds.
   * Resets the startedAt cursor so a re-start in the same session DO
   * doesn't re-bill the previous window.
   *
   * Best-effort: any failure logs and returns. We do NOT block the
   * container teardown on a billing emit (that would couple billing
   * availability to sandbox availability — wrong direction).
   */
  private async recordSandboxActiveOnStop(): Promise<void> {
    try {
      const env = this.env as Env;
      const ctx = (await this.ctx.storage.get(BILLING_CTX_KEY)) as
        | BillingContext
        | undefined;
      if (!ctx) return;
      const elapsedMs = Date.now() - ctx.startedAt;
      if (elapsedMs <= 0) return;
      const seconds = Math.floor(elapsedMs / 1000);
      if (seconds <= 0) return;
      const services = await getCfServicesForTenant(env, ctx.tenantId);
      await services.usage.recordUsage({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        kind: "sandbox_active_seconds",
        value: seconds,
      });
      // Drop the stored context so a re-start in the same DO mints a
      // fresh window (re-warm = new billing window, not "continue prior
      // window"). The next setBillingContext() call from SessionDO at
      // warmup will repopulate.
      await this.ctx.storage.delete(BILLING_CTX_KEY);
      console.log(
        `[oma-sandbox] usage emit sandbox_active_seconds=${seconds} session=${ctx.sessionId.slice(0, 12)}`,
      );
    } catch (err) {
      console.error(
        `[oma-sandbox] recordSandboxActiveOnStop failed: ${(err as Error).message ?? err}`,
      );
    }
  }
}

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

// Per-host network-layer GitHub credential injection (γ proxy).
//
// Sandbox containers fire plain HTTPS at github.com (smart-HTTP git
// protocol) and api.github.com (REST/GraphQL) with no Authorization
// header — neither ~/.git-credentials nor GITHUB_TOKEN env exists in the
// sandbox by design. Two-track credential resolution:
//
//   ① per-repo lookup (lookupGithubCredential): for sessions that
//     attached one or more github_repository resources. Most specific —
//     matches the request's owner/repo path, returns that resource's
//     scoped token.
//   ② vault fallback (lookupOutboundCredential → cap_cli cli_id="gh"):
//     for sessions whose vault has a cap_cli credential for gh but no
//     per-repo resource. Generic GitHub access via the user's vault.
//
// Per-repo wins over vault (more specific scope > less specific). When
// neither matches, fall through unauthenticated — same as before.
//
// Auth scheme is host-specific:
//   - github.com   → Basic base64("x-access-token:<token>") (smart-HTTP)
//   - api.github.com → Bearer <token> (REST/GraphQL)
//
// Multi-repo per-repo fallback: if the request URL doesn't match any
// mounted repo's owner/repo slug, lookupGithubCredential uses the first
// declared repo's token. Cross-token mutations (graphql to repo B with
// token A's scope) return GitHub's standard error envelope; we don't
// retry.
const githubAuthHandler = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;

  let cred: { scheme: "Basic" | "Bearer"; token: string; slug: string } | null = null;

  // ① per-repo first
  if (params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      cred = await e.MAIN_MCP.lookupGithubCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: url.hostname,
        pathname: url.pathname,
      });
    } catch (err) {
      console.error(
        `[oma-sandbox] lookupGithubCredential threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      // Fall through to vault fallback below.
    }
  }

  // ② vault fallback (cap_cli cli_id="gh")
  //
  // Always query at api.github.com (cap's gh spec endpoint) regardless of
  // the actual request host — same GitHub token serves both git protocol
  // and REST API, scheme is decided locally based on request host. cap's
  // spec model intentionally doesn't carry per-endpoint scheme config;
  // GitHub's dual-scheme quirk lives in this GitHub-specific handler.
  if (!cred && params.tenantId && params.sessionId && e.MAIN_MCP) {
    try {
      const fallback = await e.MAIN_MCP.lookupOutboundCredential({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        hostname: "api.github.com",
      });
      if (fallback) {
        cred = {
          scheme: url.hostname === "github.com" ? "Basic" : "Bearer",
          token: fallback.token,
          slug: "vault:gh",
        };
      }
    } catch (err) {
      console.error(
        `[oma-sandbox] cap fallback threw host=${url.hostname}: ${(err as Error)?.message ?? err}`,
      );
      // Fall through unauthenticated.
    }
  }

  const outHeaders = new Headers(request.headers);
  for (const h of HOP_BY_HOP_OR_CF_HEADERS) outHeaders.delete(h);
  if (cred) {
    const value = cred.scheme === "Basic"
      ? `Basic ${btoa(`x-access-token:${cred.token}`)}`
      : `Bearer ${cred.token}`;
    outHeaders.set("authorization", value);
  }

  let upstreamReq: Request;
  if (request.method === "GET" || request.method === "HEAD") {
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      redirect: "manual",
    });
  } else {
    // Materialize body — Workers needs known-length to set Content-Length
    // (same constraint as injectVaultCredsHandler / r2OutboundPassthrough).
    const bodyBytes = await request.arrayBuffer();
    upstreamReq = new Request(request.url, {
      method: request.method,
      headers: outHeaders,
      body: bodyBytes,
      redirect: "manual",
    });
  }

  console.log(
    `[oma-sandbox] github host=${url.hostname} method=${request.method} cred=${cred ? cred.slug : "none"}`,
  );
  return fetch(upstreamReq);
};

// Static handler-to-method-name registrations. Both maps are inherited
// get/set accessors on Sandbox/Container; class field syntax `static
// outboundHandlers = {...}` would shadow without triggering the setter,
// leaving the SDK unable to find the handler at runtime.
//
// inject_vault_creds: catch-all, params bound at runtime via
//   sandbox.setOutboundHandler("inject_vault_creds", { tenantId, sessionId })
//   in session-do.ts:setOutboundContext.
//
// github_auth: per-host, params bound at runtime via
//   sandbox.setOutboundByHost("api.github.com", "github_auth", ...)
//   (and same for "github.com") in session-do.ts:setOutboundContext.
//   Pre-fix the github handler was registered directly in static
//   `outboundByHost` as a function reference; per CF Containers SDK,
//   handlers in the static map are invoked with `ctx.params = undefined`
//   — so the handler's `params.tenantId && params.sessionId` guard
//   always failed, MAIN_MCP credential lookups never fired, and gh /
//   git push attempts silently sent the `__cap_managed__` sentinel
//   through unauthenticated. Caught 2026-05-13 testing `gh repo list`.
//
// r2OutboundPassthrough doesn't need params (purely streams the request
// to R2 unchanged), so it stays as a direct function reference in
// outboundByHost below.
(OmaSandbox as unknown as {
  outboundHandlers: Record<string, typeof injectVaultCredsHandler>;
}).outboundHandlers = {
  inject_vault_creds: injectVaultCredsHandler,
  github_auth: githubAuthHandler,
};

(OmaSandbox as unknown as {
  outboundByHost: Record<string, (req: Request, env: unknown, ctx: SdkContext<OutboundContextParams>) => Promise<Response>>;
}).outboundByHost = {
  "*.r2.cloudflarestorage.com": r2OutboundPassthrough,
  // github.com / api.github.com handled at runtime via
  // sandbox.setOutboundByHost("...", "github_auth", { tenantId, sessionId })
  // from session-do.ts:setOutboundContext — see comment on outboundHandlers
  // above for why the static-map shape can't carry the params we need.
};
