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
console.log(
  `[oma-vault] sql backend: ${usePostgres ? `postgres ${new URL(dbUrl).host}` : `sqlite ${dbPath}`}`,
);

// ─── CA management ───────────────────────────────────────────────────────
//
// On first start we generate a self-signed CA + key, persist them at
// ${OMA_VAULT_CA_DIR}/{ca.crt,ca.key}. Subsequent starts reuse the same CA
// so sandboxes that already trust it don't need to be updated. Sandboxes
// install ca.crt at startup via NODE_EXTRA_CA_CERTS / equivalent.

async function loadOrCreateCA(): Promise<{ cert: string; key: string }> {
  const certPath = resolve(caDir, "ca.crt");
  const keyPath = resolve(caDir, "ca.key");
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    return { cert, key };
  } catch {
    console.log(`[oma-vault] generating new CA at ${caDir}`);
    const ca = await generateCACertificate({
      subject: { commonName: "OMA Vault Local CA" },
    });
    await fs.writeFile(certPath, ca.cert);
    await fs.writeFile(keyPath, ca.key, { mode: 0o600 });
    return ca;
  }
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
    case "command_secret":
      // command_secret is an env-var injection mechanism for CLI tools, not
      // an HTTP header. Skip it on the proxy side.
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
    console.log(
      `[oma-vault] inject ${matched.injectHeader.name} for ${url} (cred=${matched.credentialId})`,
    );
  } else {
    console.log(`[oma-vault] passthrough ${req.method} ${url}`);
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
    console.error(`[oma-vault] forward failed for ${url}:`, msg);
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

console.log(`[oma-vault] listening on http://0.0.0.0:${port}`);
console.log(`[oma-vault] tenant scope: ${scopeTenantId === "*" ? "all tenants (single-operator deploy)" : scopeTenantId}`);
console.log(`[oma-vault] CA cert: ${resolve(caDir, "ca.crt")}`);
console.log(`[oma-vault] sandbox env to set:`);
console.log(`  HTTPS_PROXY=http://localhost:${port}`);
console.log(`  HTTP_PROXY=http://localhost:${port}`);
console.log(`  NODE_EXTRA_CA_CERTS=${resolve(caDir, "ca.crt")}`);
console.log(`  SSL_CERT_FILE=${resolve(caDir, "ca.crt")}  # for curl/python`);

const shutdown = (signal: string) => {
  console.log(`[oma-vault] received ${signal}, stopping proxy`);
  proxy.stop().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
