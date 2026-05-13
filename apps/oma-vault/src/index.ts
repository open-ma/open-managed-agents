/**
 * apps/oma-vault — outbound credential injector for Self-host OMA.
 *
 * Architecture:
 *
 *   sandbox bash → curl https://api.github.com/user
 *       │
 *       │  HTTPS_PROXY=http://oma-vault:14322
 *       │  NODE_EXTRA_CA_CERTS=/var/oma-vault-ca.crt
 *       ▼
 *   oma-vault (this process)
 *     - mockttp HTTPS proxy with self-signed CA (regenerated per install)
 *     - on incoming request: lookup credentials by host
 *     - inject Authorization / x-api-key / etc. header
 *     - forward to upstream
 *       │
 *       ▼
 *   api.github.com  ← sees Authorization: Bearer ghp_xxx
 *
 * The agent never sees the credential value. main-node doesn't either at
 * request time — apps/oma-vault reads vault credentials directly from the
 * shared sqlite db.
 *
 * This is the self-host analog of @cloudflare/sandbox's outboundByHost +
 * MAIN_MCP.outboundForward pattern. Same security model: per-sandbox CA,
 * MITM proxy, credential matched on hostname, inject header, forward.
 */

import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLocal, generateCACertificate, type CompletedRequest } from "mockttp";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import type { CredentialAuth } from "@open-managed-agents/shared";
import { createNodeLogger } from "@open-managed-agents/observability/logger/node";
import { setRootLogger, type Logger } from "@open-managed-agents/observability";

const logger: Logger = await createNodeLogger({ bindings: { service: "oma-vault" } });
setRootLogger(logger);

// ─── Bootstrap ───────────────────────────────────────────────────────────

// Backend selection mirrors main-node: DATABASE_URL (postgres:// /
// postgresql://) wins, else fall back to better-sqlite3 with DATABASE_PATH.
// Vault credentials are written by main-node into the same store, so the
// two services MUST agree on the backend or oma-vault won't see the rows.
const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres =
  dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
const caDir = process.env.OMA_VAULT_CA_DIR ?? "./data/oma-vault-ca";
const port = Number(process.env.OMA_VAULT_PORT ?? 14322);
// Tenant scoping: default "*" means look across ALL tenants by host. Set to
// a specific `tn_xxx` id to lock the proxy to a single tenant — required
// for multi-user prod deploys, since cross-tenant matching can leak a
// credential between tenants when both register the same host.
const scopeTenantId = process.env.OMA_TENANT ?? "*";

mkdirSync(resolve(caDir), { recursive: true });

const sql: SqlClient = usePostgres
  ? await createPostgresSqlClient(dbUrl)
  : await createBetterSqlite3SqlClient(dbPath);
logger.info(
  { op: "oma_vault.sql_backend", backend: usePostgres ? "postgres" : "sqlite", dsn: usePostgres ? new URL(dbUrl).host : dbPath },
  `sql backend: ${usePostgres ? `postgres ${new URL(dbUrl).host}` : `sqlite ${dbPath}`}`,
);

// ─── CA management ───────────────────────────────────────────────────────
//
// On first start we generate a self-signed CA + key, persist them at
// ${OMA_VAULT_CA_DIR}/{ca.crt,ca.key}. Subsequent starts reuse the same CA
// so sandboxes that already trust it don't need to be updated. Sandboxes
// install ca.crt at startup via NODE_EXTRA_CA_CERTS / equivalent.
//
// Multi-replica safety: when N vault replicas boot against a shared
// caDir (e.g. NFS / EFS / shared docker volume) we must avoid all N
// generating different CAs and racing to overwrite ca.key — sandboxes
// would only trust one of them. Strategy:
//   1. Try to read existing files (happy path on every start past first).
//   2. Otherwise, attempt an exclusive create (O_EXCL) on `ca.lock`. The
//      losing replicas wait+poll for ca.crt to appear, then read it.
//   3. The winner generates the CA, writes ca.crt + ca.key, then releases
//      the lock by removing ca.lock.

async function loadOrCreateCA(): Promise<{ cert: string; key: string }> {
  const certPath = resolve(caDir, "ca.crt");
  const keyPath = resolve(caDir, "ca.key");
  const lockPath = resolve(caDir, "ca.lock");

  // Happy path: cert + key already on disk.
  const existing = await tryReadCA(certPath, keyPath);
  if (existing) return existing;

  // Race-safe create. O_EXCL means exactly one replica succeeds; the
  // others fall through to the wait-and-read path.
  let lockFd: import("node:fs/promises").FileHandle | null = null;
  try {
    lockFd = await fs.open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another replica is generating; wait for ca.crt to appear.
    return waitForCA(certPath, keyPath);
  }

  try {
    // Re-check inside the lock — a third replica may have generated
    // between our initial read and our lock acquisition.
    const inLock = await tryReadCA(certPath, keyPath);
    if (inLock) return inLock;

    logger.info({ op: "oma_vault.ca_generate", ca_dir: caDir }, `generating new CA at ${caDir}`);
    const ca = await generateCACertificate({
      subject: { commonName: "OMA Vault Local CA" },
    });
    await fs.writeFile(certPath, ca.cert);
    await fs.writeFile(keyPath, ca.key, { mode: 0o600 });
    return ca;
  } finally {
    await lockFd.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function tryReadCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string } | null> {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    return { cert, key };
  } catch {
    return null;
  }
}

/** Poll until the winning replica finishes writing ca.crt + ca.key. The
 *  generator runs in <1s on commodity hardware; bound the wait at 30s
 *  to avoid wedging a deploy when the lock holder dies mid-generation. */
async function waitForCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const got = await tryReadCA(certPath, keyPath);
    if (got) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[oma-vault] timed out waiting for peer to generate CA at ${certPath}`,
  );
}

const ca = await loadOrCreateCA();

// ─── Credential matching ─────────────────────────────────────────────────

interface MatchedCred {
  vaultId: string;
  credentialId: string;
  injectHeader: { name: string; value: string };
}

/**
 * Find the active credential whose mcp_server_url host matches the request
 * host. Returns the header to inject, or null when no credential applies.
 *
 * Today's matcher: exact hostname match against
 * URL(credential.mcp_server_url).host. Wildcards / suffix match TBD when
 * we hit a use case (e.g. `*.googleapis.com` for google credentials).
 */
/**
 * Find the active credential whose mcp_server_url host matches the request
 * host. Returns the header to inject, or null when no credential applies.
 *
 * Today's matcher: exact hostname match against
 * URL(credential.mcp_server_url).host. Wildcards / suffix match TBD when
 * we hit a use case (e.g. `*.googleapis.com` for google credentials).
 *
 * Cross-tenant note: with better-auth multi-tenant, credentials live under
 * per-user tenants (tn_xxx), not under a static OMA_TENANT. The proxy
 * intercepts traffic from any sandbox and has no way to attribute the
 * request to a specific tenant from its hostname alone — we'd need a
 * per-session port or a sandbox-side header tag for that.
 *
 * For the PoC we look across ALL tenants by host, matching the first
 * active credential. SECURITY LIMITATION: if two tenants both register a
 * credential for the same host (e.g. `https://api.github.com`), the
 * second tenant's request can pick up the first tenant's token. Not OK
 * for shared multi-tenant deploys; OK for single-operator self-host
 * (every credential ultimately belongs to "me"). Document the limit.
 *
 * Setting OMA_TENANT to a specific tenant id locks lookup to that tenant
 * only — recommended for prod multi-user deploys until per-session
 * attribution lands.
 */
async function findCredentialForUrl(url: string): Promise<MatchedCred | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  // Cross-tenant lookup against the partial unique index
  // idx_credentials_mcp_url_active. The index contains hostname-as-substring
  // (LIKE) is unindexed; we materialize candidates by parsing mcp_server_url.
  // Acceptable cost: typical deploys have O(10) credentials.
  type Row = { id: string; tenant_id: string; vault_id: string; auth: string };
  // Cross-tenant lookup. When OMA_TENANT="*" we accept any tenant; when
  // it's a specific tenant id we filter to that one (recommended for
  // multi-user prod deploys).
  const result = await sql
    .prepare(
      `SELECT id, tenant_id, vault_id, auth
         FROM credentials
        WHERE archived_at IS NULL
          AND mcp_server_url IS NOT NULL
          AND ( ? = '*' OR tenant_id = ? )`,
    )
    .bind(scopeTenantId, scopeTenantId)
    .all<Row>();
  for (const row of result.results ?? []) {
    let auth: CredentialAuth;
    try { auth = JSON.parse(row.auth) as CredentialAuth; } catch { continue; }
    if (!auth.mcp_server_url) continue;
    let credHost: string;
    try { credHost = new URL(auth.mcp_server_url).host; } catch { continue; }
    if (credHost !== host) continue;
    const headerSpec = authToHeader(auth);
    if (!headerSpec) continue;
    return {
      vaultId: row.vault_id,
      credentialId: row.id,
      injectHeader: headerSpec,
    };
  }
  return null;
}

function authToHeader(auth: CredentialAuth): { name: string; value: string } | null {
  switch (auth.type) {
    case "static_bearer":
      return { name: "authorization", value: `Bearer ${auth.token}` };
    case "cap_cli":
      // cap_cli credentials are injected via cap's spec-driven enforcement
      // (header_inject mode for most CLIs). The simple Bearer fallback
      // here works for header-mode CLIs whose spec just sets Authorization;
      // metadata_ep / exec_helper CLIs need richer routing — handled when
      // self-host oma-vault adopts cap.handleHttp directly (follow-up PR).
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "mcp_oauth":
      // OAuth would need refresh-token handling; not in PoC scope. Skip
      // until the oma-vault supports it; the credential just gets ignored.
      return null;
    default:
      return null;
  }
}

// ─── mockttp proxy ───────────────────────────────────────────────────────

const proxy = getLocal({
  https: { cert: ca.cert, key: ca.key },
  // record traffic = false; we don't keep request bodies in memory
  recordTraffic: false,
});

// Match all proxied traffic. For each request: look up credentials, inject
// header, forward. Plain HTTP and HTTPS via CONNECT both flow through the
// same handler thanks to mockttp's TLS termination.
proxy.forAnyRequest().thenCallback(async (req: CompletedRequest) => {
  const url = req.url;
  const matched = await findCredentialForUrl(url);

  // Strip any incoming Authorization headers — the agent must not be able
  // to override the injected value or smuggle a stolen token. Mirrors the
  // Infisical Agent Vault + CF outboundByHost zero-trust behaviour.
  //
  // Also strip hop-by-hop / connection-level headers that would confuse
  // node:fetch's outbound — `host` (we let fetch infer from the URL),
  // `content-length` (fetch sets it), proxy-* headers, etc. Without this
  // strip, fetch() throws "fetch failed" when the inbound `host:
  // oma-vault:14322` clashes with the upstream URL's actual host.
  const STRIP = new Set([
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (STRIP.has(lower)) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }

  if (matched) {
    headers[matched.injectHeader.name] = matched.injectHeader.value;
    logger.info(
      { op: "oma_vault.inject", header: matched.injectHeader.name, url, credential_id: matched.credentialId },
      `inject ${matched.injectHeader.name} for ${url}`,
    );
  } else {
    logger.debug({ op: "oma_vault.passthrough", method: req.method, url }, `passthrough ${req.method} ${url}`);
  }

  // Forward to upstream. Read body as buffer to handle binary uploads.
  const bodyBuf = req.body.buffer;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: bodyBuf.byteLength > 0 ? bodyBuf : undefined,
      redirect: "manual",
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, op: "oma_vault.forward_failed", url }, `forward failed for ${url}: ${msg}`);
    return {
      statusCode: 502,
      headers: { "content-type": "text/plain" },
      body: `oma-vault: upstream forward failed: ${msg}`,
    };
  }

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    // content-encoding would force the client to re-decompress something
    // we already have decoded. content-length will be wrong post-buffer.
    // Drop both; let the client re-derive.
    const lower = k.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length") return;
    respHeaders[k] = v;
  });

  return {
    statusCode: upstream.status,
    headers: respHeaders,
    body: Buffer.from(await upstream.arrayBuffer()),
  };
});

await proxy.start(port);

logger.info(
  {
    op: "oma_vault.listening",
    port,
    tenant_scope: scopeTenantId === "*" ? "all" : scopeTenantId,
    ca_cert: resolve(caDir, "ca.crt"),
  },
  `listening on http://0.0.0.0:${port}`,
);
// User-facing copy/paste env block — kept on stdout intentionally so first
// run shows operators what to configure for sandbox processes.
const caCert = resolve(caDir, "ca.crt");
process.stdout.write(`\n# OMA vault sandbox env (copy into sandbox process):\nHTTPS_PROXY=http://localhost:${port}\nHTTP_PROXY=http://localhost:${port}\nNODE_EXTRA_CA_CERTS=${caCert}\nSSL_CERT_FILE=${caCert}\n\n`);

const shutdown = (signal: string) => {
  logger.info({ op: "oma_vault.shutdown", signal }, `received ${signal}, stopping proxy`);
  proxy.stop().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
