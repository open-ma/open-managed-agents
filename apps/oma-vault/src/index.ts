/**
 * apps/oma-vault — outbound credential injector for CFless OMA.
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
 * This is the CFless analog of @cloudflare/sandbox's outboundByHost +
 * MAIN_MCP.outboundForward pattern. Same security model: per-sandbox CA,
 * MITM proxy, credential matched on hostname, inject header, forward.
 */

import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLocal, generateCACertificate, type CompletedRequest } from "mockttp";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import {
  createSqliteVaultService,
} from "@open-managed-agents/vaults-store";
import {
  createSqliteCredentialService,
} from "@open-managed-agents/credentials-store";
import type { CredentialAuth } from "@open-managed-agents/shared";

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
const caDir = process.env.OMA_VAULT_CA_DIR ?? "./data/oma-vault-ca";
const port = Number(process.env.OMA_VAULT_PORT ?? 14322);
const tenantId = process.env.OMA_TENANT ?? "default";

mkdirSync(resolve(caDir), { recursive: true });

const sql = await createBetterSqlite3SqlClient(dbPath);
const vaults = createSqliteVaultService({ client: sql });
const creds = createSqliteCredentialService({ client: sql });

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
async function findCredentialForUrl(url: string): Promise<MatchedCred | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  const allVaults = await vaults.list({ tenantId, includeArchived: false });
  for (const vault of allVaults) {
    const vaultCreds = await creds.list({
      tenantId,
      vaultId: vault.id,
      includeArchived: false,
    });
    for (const cred of vaultCreds) {
      if (!cred.auth.mcp_server_url) continue;
      try {
        const credHost = new URL(cred.auth.mcp_server_url).host;
        if (credHost !== host) continue;
      } catch {
        continue;
      }
      const headerSpec = authToHeader(cred.auth);
      if (!headerSpec) continue;
      return {
        vaultId: vault.id,
        credentialId: cred.id,
        injectHeader: headerSpec,
      };
    }
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
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key") continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }

  if (matched) {
    headers[matched.injectHeader.name] = matched.injectHeader.value;
    console.log(
      `[oma-vault] inject ${matched.injectHeader.name} for ${url} (cred=${matched.credentialId})`,
    );
  }

  // Forward to upstream. Read body as buffer to handle binary uploads.
  const bodyBuf = req.body.buffer;
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: bodyBuf.byteLength > 0 ? bodyBuf : undefined,
    redirect: "manual",
  });

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
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
