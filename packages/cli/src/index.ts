import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AgentConfig, ModelCard, SessionMeta } from "@open-managed-agents/api-types";

// ─── Config ───

interface Config {
  baseUrl: string;
  apiKey: string;
  /** When true, commands print machine-readable JSON instead of human tables. */
  json: boolean;
  /** Whether the apiKey came from stored credentials (vs env var). Used by
   *  `oma whoami` so it can show the source — env vars override stored creds. */
  source: "env" | "stored" | "missing";
}

// ─── Stored credentials (~/.config/oma/credentials.json) ───
//
// v2 layout (Pattern A multi-tenant): one user identity, one base_url,
// many tenant entries — each with its own per-tenant token. The
// `active_tenant_id` selects which token apiFetch uses; switch with
// `oma auth tenant use <id>`. Per-command override via --tenant flag
// or OMA_TENANT_ID env var.
//
// v1 layout (single-tenant snapshot, beta.0–beta.3) is auto-migrated on
// read. Existing files keep working.

interface StoredTenantV2 {
  name: string;
  role: string;
  token: string;
  key_id: string;
  created_at: string;
}

interface StoredCredentialsV2 {
  version: 2;
  base_url: string;
  user: { id: string; email: string; name: string | null };
  active_tenant_id: string;
  tenants: Record<string, StoredTenantV2>;
}

interface StoredCredentialsV1 {
  version: 1;
  base_url: string;
  user: { id: string; email: string; name: string | null };
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
  token: string;
  key_id: string;
  created_at: string;
}

type StoredCredentials = StoredCredentialsV2;

function credentialsPath(): string {
  // XDG-style on Linux/macOS; HOME/.config on macOS by default.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "oma", "credentials.json");
}

function migrateV1ToV2(v1: StoredCredentialsV1): StoredCredentialsV2 {
  return {
    version: 2,
    base_url: v1.base_url,
    user: v1.user,
    active_tenant_id: v1.tenant.id,
    tenants: {
      [v1.tenant.id]: {
        name: v1.tenant.name,
        role: v1.tenants.find((t) => t.id === v1.tenant.id)?.role ?? "owner",
        token: v1.token,
        key_id: v1.key_id,
        created_at: v1.created_at,
      },
    },
  };
}

function readCredentials(): StoredCredentials | null {
  const path = credentialsPath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StoredCredentialsV1 | StoredCredentialsV2;
    if (parsed.version === 2) return parsed;
    if (parsed.version === 1) {
      const v2 = migrateV1ToV2(parsed);
      // Persist the migrated file so subsequent reads skip the conversion.
      // Best-effort — read still succeeds even if write fails (read-only fs).
      try { writeCredentials(v2); } catch {}
      return v2;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCredentials(creds: StoredCredentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod again in case the file pre-existed with looser perms.
  try { chmodSync(path, 0o600); } catch {}
}

function clearCredentials(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Resolve the active tenant for THIS invocation: --tenant flag wins,
 *  then OMA_TENANT_ID env var, then the credential file's
 *  active_tenant_id. Validates membership before use elsewhere. */
function resolveActiveTenant(stored: StoredCredentials, cliFlag?: string): string | null {
  return cliFlag || process.env.OMA_TENANT_ID || stored.active_tenant_id || null;
}

function loadConfig(): Config {
  const envBase = process.env.OMA_BASE_URL;
  const envKey = process.env.OMA_API_KEY;
  const envTenant = process.env.OMA_TENANT_ID;
  const stored = readCredentials();
  if (envKey) {
    return {
      baseUrl: envBase || stored?.base_url || "https://openma.dev",
      apiKey: envKey,
      json: false,
      source: "env",
    };
  }
  if (stored) {
    const activeId = envTenant || stored.active_tenant_id;
    const profile = stored.tenants[activeId];
    if (!profile) {
      console.error(`Error: tenant ${activeId} not in credentials. Run: oma auth tenant ls`);
      process.exit(1);
    }
    return {
      baseUrl: envBase || stored.base_url,
      apiKey: profile.token,
      json: false,
      source: "stored",
    };
  }
  console.error("Error: not authenticated.");
  console.error("  Run: oma auth login");
  console.error("  Or:  export OMA_API_KEY=<your-key>  (mint at /api-keys page)");
  process.exit(1);
}

/** Like loadConfig but never exits — for commands that must run pre-auth
 *  (oma auth login itself). Returns a minimal Config with a possibly-empty
 *  apiKey; callers check Config.source before making authenticated calls. */
function loadConfigOptional(): Config {
  const envBase = process.env.OMA_BASE_URL;
  const envKey = process.env.OMA_API_KEY;
  const envTenant = process.env.OMA_TENANT_ID;
  const stored = readCredentials();
  if (envKey) {
    return { baseUrl: envBase || stored?.base_url || "https://openma.dev", apiKey: envKey, json: false, source: "env" };
  }
  if (stored) {
    const activeId = envTenant || stored.active_tenant_id;
    const profile = stored.tenants[activeId];
    if (profile) {
      return { baseUrl: envBase || stored.base_url, apiKey: profile.token, json: false, source: "stored" };
    }
  }
  return { baseUrl: envBase || "https://openma.dev", apiKey: "", json: false, source: "missing" };
}

// ─── API Client ───

async function apiFetch<T = unknown>(config: Config, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-api-key": config.apiKey,
      "content-type": "application/json",
      // Identify as a browser-compatible client. Node's default `node` UA
      // gets rejected by Cloudflare's bot fight rules on api.openma.dev with
      // a 1010 ban; a Mozilla-style UA passes the integrity check while
      // still naming the actual client and product page for log readers.
      "user-agent": "Mozilla/5.0 (compatible; OpenManagedAgents-CLI/0.1; +https://openma.dev)",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Helpers ───

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function table(rows: string[][]) {
  if (!rows.length) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] || "").length)));
  for (const row of rows) {
    console.log(row.map((c, i) => (c || "").padEnd(widths[i])).join("  "));
  }
}

function capsPreview(caps: string[]): string {
  if (!caps.length) return "0";
  if (caps.length <= 2) return caps.join(",");
  return `${caps.slice(0, 2).join(",")}+${caps.length - 2}`;
}

function isPubliclyReachable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return false;
    if (/^192\.168\./.test(u.hostname)) return false;
    if (/^10\./.test(u.hostname)) return false;
    return true;
  } catch {
    return true;
  }
}

// ─── Auth login (browser handoff) ───
//
// CLI starts a loopback HTTP server on a random port, opens the browser to
// the console's /cli/login page, and waits for the page to redirect back
// with a freshly-minted token. The `state` nonce is generated here and
// validated on the callback so a stray inbound request can't inject a token.

async function authLogin(baseUrl: string, requestedTenant?: string): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const port = 19500 + Math.floor(Math.random() * 500);
  const callback = `http://127.0.0.1:${port}/callback`;
  const params = new URLSearchParams({
    callback,
    state,
    hostname: hostname(),
  });
  if (requestedTenant) params.set("tenant", requestedTenant);
  const loginUrl = `${baseUrl}/cli/login?${params.toString()}`;

  interface CallbackToken {
    tenant_id: string;
    tenant_name: string;
    role: string;
    token: string;
    key_id: string;
  }
  type CallbackResult = { tokens: CallbackToken[]; user: string };

  const result = await new Promise<CallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for browser approval."));
    }, 5 * 60_000);

    const server = createServer((req: any, res: any) => {
      try {
        const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const got = u.searchParams;
        const finish = (statusCode: number, page: ReturnType<typeof approvalPage>, action: () => void) => {
          res.writeHead(statusCode, { "Content-Type": "text/html" }).end(page);
          clearTimeout(timeout);
          server.close();
          if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
            (server as { closeAllConnections: () => void }).closeAllConnections();
          }
          action();
        };
        if (got.get("error")) {
          const err = String(got.get("error"));
          return finish(400, approvalPage("Cancelled", `Login was cancelled: ${err}.`), () =>
            reject(new Error(`Login cancelled: ${err}`)),
          );
        }
        if (got.get("state") !== state) {
          return finish(400, approvalPage("State mismatch", "The login response didn't match what this CLI session expected. Please try again."), () =>
            reject(new Error("State mismatch — refusing the callback")),
          );
        }
        // New format (beta.5+): tokens=base64(JSON array). Old format
        // (token=...&tenant=...) used to land here too — kept the parser
        // compatible so the same CLI works against both old and new
        // /cli/login deployments during rollout.
        const tokensB64 = got.get("tokens");
        const userId = got.get("user") ?? "";
        let tokens: CallbackToken[] = [];
        if (tokensB64) {
          try {
            const json = Buffer.from(tokensB64, "base64").toString("utf8");
            tokens = JSON.parse(json) as CallbackToken[];
          } catch {
            return finish(400, approvalPage("Bad payload", "The browser handoff payload was unreadable."), () =>
              reject(new Error("Failed to decode tokens from callback")),
            );
          }
        } else {
          // Legacy single-token format.
          const token = got.get("token");
          const tenant = got.get("tenant");
          const key_id = got.get("key_id");
          if (token && tenant && key_id) {
            tokens = [
              { tenant_id: tenant, tenant_name: "", role: "owner", token, key_id },
            ];
          }
        }
        if (tokens.length === 0) {
          return finish(400, approvalPage("Incomplete callback", "The browser handoff is missing required fields."), () =>
            reject(new Error("Callback missing required fields")),
          );
        }
        return finish(200, approvalPage("Signed in", "You can close this tab and return to your terminal."), () =>
          resolve({ tokens, user: userId }),
        );
      } catch (err) {
        res.writeHead(500).end();
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1");

    console.log(`Opening browser to authorize CLI…`);
    console.log(`  ${loginUrl}\n`);
    console.log(`(If the browser doesn't open, copy the URL above into one manually.)`);
    openBrowser(loginUrl);
  });

  // Use the first minted token to fetch full identity, so the credentials
  // file carries useful display fields for `oma whoami`. All tokens share
  // the same user; we only need one /v1/me call.
  const firstToken = result.tokens[0];
  const tempConfig: Config = { baseUrl, apiKey: firstToken.token, json: false, source: "stored" };
  const me = await apiFetch<{
    user: { id: string; email: string; name: string | null } | null;
    tenant: { id: string; name: string };
    tenants: Array<{ id: string; name: string; role: string }>;
  }>(tempConfig, "/v1/me");

  // Merge with existing credentials so previously-authorized tenants
  // (different login session, different machine sync, etc.) keep their
  // tokens. New tokens for the same tenant overwrite — last login wins,
  // which matches how API key rotation already works server-side.
  const existing = readCredentials();
  const sameUser = existing && existing.user.id === (me.user?.id ?? result.user);
  const tenantsMap: Record<string, StoredTenantV2> = sameUser ? { ...existing!.tenants } : {};
  const now = new Date().toISOString();
  for (const t of result.tokens) {
    // Look up canonical name + role from the membership list returned by
    // /v1/me — the callback's tenant_name was a snapshot at click time.
    const membership = me.tenants.find((m) => m.id === t.tenant_id);
    tenantsMap[t.tenant_id] = {
      name: membership?.name ?? t.tenant_name ?? "",
      role: membership?.role ?? t.role ?? "owner",
      token: t.token,
      key_id: t.key_id,
      created_at: now,
    };
  }
  // Active selection rule:
  //   - If --tenant was passed and is in the minted set, honor it.
  //   - Else if the existing active is still valid (re-authed), keep it.
  //   - Else default to the first minted token.
  const newActive =
    (requestedTenant && tenantsMap[requestedTenant] && requestedTenant) ||
    (sameUser && existing!.tenants[existing!.active_tenant_id] ? existing!.active_tenant_id : "") ||
    result.tokens[0].tenant_id;

  const updated: StoredCredentials = {
    version: 2,
    base_url: baseUrl,
    user: me.user ?? { id: result.user, email: "", name: null },
    active_tenant_id: newActive,
    tenants: tenantsMap,
  };
  writeCredentials(updated);

  const activeProfile = updated.tenants[updated.active_tenant_id];
  console.log(`✓ Signed in as ${me.user?.email ?? me.user?.id}`);
  console.log(`  Active tenant : ${activeProfile.name || updated.active_tenant_id} (${updated.active_tenant_id})`);
  console.log(`  Stored        : ${credentialsPath()}`);
  const totalStored = Object.keys(tenantsMap).length;
  if (totalStored > 1) {
    console.log(`  Authorized for ${totalStored} workspaces — switch with: oma auth tenant use <id>`);
  }
  const totalAvailable = me.tenants.length;
  if (totalAvailable > totalStored) {
    const missing = totalAvailable - totalStored;
    console.log(`  ${missing} more workspace${missing === 1 ? "" : "s"} unauthorized — add with: oma auth login --tenant <id>`);
  }
}

/** Friendly fallback for legacy tenants whose name was generated as
 *  "'s workspace" (empty user.name in old ensureTenant). Once the DB is
 *  fixed those rows go away — this defensively cleans display either way. */
function displayTenantName(t: { id: string; name: string }): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) return t.id;
  return trimmed;
}

function openBrowser(url: string): void {
  try {
    const p = process.platform;
    if (p === "darwin") execSync(`open "${url}"`);
    else if (p === "linux") execSync(`xdg-open "${url}"`);
    else if (p === "win32") execSync(`start "" "${url}"`);
  } catch {
    // The URL is already printed above; user can copy-paste manually.
  }
}

function approvalPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>oma — ${title}</title><style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222}
h1{font-size:20px;margin-bottom:12px} p{color:#555;line-height:1.5}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:32px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

// ─── Command Registry ───

interface Cmd {
  group: string;
  match: string[];
  needsArg?: boolean;
  usage: string;
  desc: string;
  http: string;
  run: (config: Config, args: string[]) => Promise<void> | void;
}

const commands: Cmd[] = [
  // Auth
  {
    group: "Auth", match: ["auth", "login"],
    usage: "oma auth login [--base-url <url>] [--tenant <id>]", desc: "Open browser to authenticate; --tenant pre-picks a workspace",
    http: "POST   /v1/me/cli-tokens (browser handoff via /cli/login)",
    async run(_config, args) {
      const baseUrl = (flag(args, "--base-url") ?? process.env.OMA_BASE_URL ?? "https://openma.dev").replace(/\/+$/, "");
      const tenant = flag(args, "--tenant");
      await authLogin(baseUrl, tenant);
    },
  },
  {
    group: "Auth", match: ["auth", "logout"],
    usage: "oma auth logout", desc: "Delete stored credentials (does not revoke the token; use `oma keys revoke <id>` for that)",
    http: "(local file delete)",
    async run() {
      const removed = clearCredentials();
      console.log(removed ? `Cleared ${credentialsPath()}` : "No stored credentials.");
    },
  },
  {
    group: "Auth", match: ["whoami"],
    usage: "oma whoami", desc: "Show current user, active tenant, and base URL",
    http: "GET    /v1/me",
    async run(config) {
      try {
        const me = await apiFetch<{
          user: { id: string; email: string; name: string | null } | null;
          tenant: { id: string; name: string };
          tenants: Array<{ id: string; name: string; role: string }>;
        }>(config, "/v1/me");
        if (config.json) { console.log(JSON.stringify({ ...me, base_url: config.baseUrl, source: config.source }, null, 2)); return; }
        console.log(`Base URL : ${config.baseUrl}`);
        console.log(`Source   : ${config.source === "env" ? "OMA_API_KEY env var" : "stored credentials"}`);
        console.log(`User     : ${me.user?.email ?? me.user?.id ?? "(unknown — legacy key without user_id)"}`);
        // Show tenant only when the user has more than one — single-tenant
        // users don't need to think about which workspace they're in.
        if (me.tenants.length > 1) {
          console.log(`Tenant   : ${displayTenantName(me.tenant)} (${me.tenant.id})`);
          const others = me.tenants.filter((t) => t.id !== me.tenant.id);
          if (others.length) {
            console.log(`Available: ${others.map((t) => t.id).join(", ")} — switch with: oma auth tenant use <id>`);
          }
        }
      } catch (err: any) {
        console.error(`whoami failed: ${err.message}`);
        if (config.source === "stored") {
          console.error("Stored token may have been revoked. Try: oma auth login");
        }
        process.exit(1);
      }
    },
  },
  {
    group: "Auth", match: ["auth", "tenant", "ls"],
    usage: "oma auth tenant ls", desc: "List tenants the current user belongs to",
    http: "GET    /v1/me/tenants",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; role: string }> }>(config, "/v1/me/tenants");
      if (!data.length) { console.log("No tenants on this account."); return; }
      const stored = readCredentials();
      const active = stored?.active_tenant_id;
      table([
        ["", "ID", "NAME", "ROLE", "TOKEN"],
        ...data.map((t) => [
          t.id === active ? "*" : " ",
          t.id,
          t.name || "—",
          t.role,
          stored?.tenants[t.id] ? "stored" : "—",
        ]),
      ]);
      console.log(`\n* = active. "stored" = local token cached. To switch active: oma auth tenant use <id>`);
      console.log(`To add a tenant the CLI hasn't seen yet: oma auth login --tenant <id>`);
    },
  },
  {
    group: "Auth", match: ["auth", "tenant", "use"], needsArg: true,
    usage: "oma auth tenant use <tenant-id>", desc: "Switch active tenant; if not yet authenticated for it, opens browser to mint",
    http: "(local file update — or POST /v1/me/cli-tokens via browser if no cached token)",
    async run(_config, args) {
      const tenantId = args[0];
      if (!tenantId) { console.error("Usage: oma auth tenant use <tenant-id>"); process.exit(1); }
      const stored = readCredentials();
      if (!stored) {
        console.error("No stored credentials. Run: oma auth login");
        process.exit(1);
      }
      if (stored.tenants[tenantId]) {
        // Cached token exists — just flip active. No network call.
        const updated = { ...stored, active_tenant_id: tenantId };
        writeCredentials(updated);
        const profile = stored.tenants[tenantId];
        console.log(`✓ Active tenant: ${profile.name || tenantId} (${tenantId})`);
        return;
      }
      // No cached token for this tenant — kick off browser flow to mint.
      console.log(`No cached token for ${tenantId}. Opening browser to authorize…`);
      await authLogin(stored.base_url, tenantId);
    },
  },
  // Agents
  {
    group: "Agents", match: ["agents", "list"],
    usage: "oma agents list", desc: "List agents",
    http: "GET    /v1/agents?limit=N&order=asc|desc",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; model: any; created_at: string }> }>(config, "/v1/agents?limit=100");
      if (!data.length) { console.log("No agents. Create one with: oma agents create"); return; }
      table([["NAME", "ID", "MODEL", "CREATED"], ...data.map(a => [a.name, a.id, typeof a.model === "string" ? a.model : a.model?.id || "", new Date(a.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "Agents", match: ["agents", "create"],
    usage: "oma agents create <name> [--model <id>]", desc: "Create agent",
    http: "POST   /v1/agents {name, model, system, tools, skills?, mcp_servers?, callable_agents?}",
    async run(config, args) {
      const name = flag(args, "--name") || args.find(a => !a.startsWith("--"));
      const model = flag(args, "--model") || "claude-sonnet-4-6";
      const system = flag(args, "--system") || "";
      if (!name) { console.error("Usage: oma agents create <name> [--model <id>] [--system <prompt>]"); process.exit(1); }
      const agent = await apiFetch<{ id: string; name: string }>(config, "/v1/agents", { method: "POST", body: JSON.stringify({ name, model, system, tools: [{ type: "agent_toolset_20260401" }] }) });
      console.log(`Agent created: ${agent.name} (${agent.id})`);
    },
  },
  {
    group: "Agents", match: ["agents", "get"], needsArg: true,
    usage: "oma agents get <id>", desc: "Get agent details",
    http: "GET    /v1/agents/:id",
    async run(config, args) {
      const a = await apiFetch<any>(config, `/v1/agents/${args[0]}`);
      console.log(`Name:    ${a.name}\nID:      ${a.id}\nModel:   ${typeof a.model === "string" ? a.model : a.model?.id}\nVersion: v${a.version}`);
      if (a.description) console.log(`Desc:    ${a.description}`);
      if (a.system) console.log(`System:  ${a.system.slice(0, 100)}${a.system.length > 100 ? "..." : ""}`);
    },
  },
  {
    group: "Agents", match: ["agents", "delete"], needsArg: true,
    usage: "oma agents delete <id>", desc: "Delete agent",
    http: "DELETE /v1/agents/:id",
    async run(config, args) { await apiFetch(config, `/v1/agents/${args[0]}`, { method: "DELETE" }); console.log(`Agent deleted: ${args[0]}`); },
  },

  // Sessions
  {
    group: "Sessions", match: ["sessions", "list"],
    usage: "oma sessions list", desc: "List sessions",
    http: "GET    /v1/sessions?agent_id=X&limit=N",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; title: string; agent_id: string; status: string; created_at: string }> }>(config, "/v1/sessions?limit=20");
      if (!data.length) { console.log("No sessions."); return; }
      table([["TITLE", "ID", "STATUS", "AGENT", "CREATED"], ...data.map(s => [s.title || "Untitled", s.id, s.status || "idle", s.agent_id, new Date(s.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "Sessions", match: ["sessions", "create"],
    usage: "oma sessions create --agent <id> --env <id> [--title <t>]", desc: "Create session",
    http: "POST   /v1/sessions {agent, environment_id, title?, vault_ids?, resources?}",
    async run(config, args) {
      const agentId = flag(args, "--agent"); const envId = flag(args, "--env"); const title = flag(args, "--title") || "";
      if (!agentId || !envId) { console.error("Usage: oma sessions create --agent <id> --env <id> [--title <text>]"); process.exit(1); }
      const session = await apiFetch<{ id: string }>(config, "/v1/sessions", { method: "POST", body: JSON.stringify({ agent: agentId, environment_id: envId, title }) });
      console.log(`Session created: ${session.id}`);
    },
  },
  {
    group: "Sessions", match: ["sessions", "message"], needsArg: true,
    usage: "oma sessions message <id> <text>", desc: "Send message to session",
    http: "POST   /v1/sessions/:id/events {events:[{type:\"user.message\",content:[{type:\"text\",text:\"...\"}]}]}",
    async run(config, args) {
      const text = args.slice(1).join(" ");
      await apiFetch(config, `/v1/sessions/${args[0]}/events`, { method: "POST", body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }) });
      console.log("Message sent.");
    },
  },

  // Environments
  {
    group: "Environments", match: ["envs", "list"],
    usage: "oma envs list", desc: "List environments",
    http: "GET    /v1/environments",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; status: string }> }>(config, "/v1/environments");
      if (!data.length) { console.log("No environments. Create one with: oma envs create <name>"); return; }
      table([["NAME", "ID", "STATUS"], ...data.map(e => [e.name, e.id, e.status || "ready"])]);
    },
  },
  {
    group: "Environments", match: ["envs", "create"], needsArg: true,
    usage: "oma envs create <name>", desc: "Create environment",
    http: "POST   /v1/environments {name, config:{type:\"cloud\"}}",
    async run(config, args) {
      const env = await apiFetch<{ id: string; name: string }>(config, "/v1/environments", { method: "POST", body: JSON.stringify({ name: args.join(" "), config: { type: "cloud" } }) });
      console.log(`Environment created: ${env.name} (${env.id})`);
    },
  },

  // Model Cards
  {
    group: "Model Cards", match: ["models", "list"],
    usage: "oma models list", desc: "List model cards",
    http: "GET    /v1/model_cards",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; provider: string; model_id: string; api_key_preview: string; is_default: boolean }> }>(config, "/v1/model_cards");
      if (!data.length) { console.log("No model cards. Create one with: oma models create"); return; }
      table([["NAME", "PROVIDER", "MODEL", "KEY", "DEFAULT"], ...data.map(c => [c.name, c.provider, c.model_id, `****${c.api_key_preview || ""}`, c.is_default ? "yes" : ""])]);
    },
  },
  {
    group: "Model Cards", match: ["models", "create"],
    usage: "oma models create --name <n> --model-id <id> --api-key <key> [--provider <p>]", desc: "Create model card",
    http: "POST   /v1/model_cards {name, provider, model_id, api_key, base_url?, is_default?}",
    async run(config, args) {
      const name = flag(args, "--name"); const provider = flag(args, "--provider") || "ant"; const modelId = flag(args, "--model-id"); const apiKey = flag(args, "--api-key"); const baseUrl = flag(args, "--base-url");
      if (!name || !modelId || !apiKey) { console.error("Usage: oma models create --name <name> --model-id <id> --api-key <key> [--provider ant|oai|ant-compatible|oai-compatible] [--base-url <url>]"); process.exit(1); }
      const card = await apiFetch<{ id: string; name: string }>(config, "/v1/model_cards", { method: "POST", body: JSON.stringify({ name, provider, model_id: modelId, api_key: apiKey, base_url: baseUrl }) });
      console.log(`Model card created: ${card.name} (${card.id})`);
    },
  },

  // API Keys
  {
    group: "API Keys", match: ["keys", "list"],
    usage: "oma keys list", desc: "List API keys",
    http: "GET    /v1/api_keys",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; prefix: string; created_at: string }> }>(config, "/v1/api_keys");
      if (!data.length) { console.log("No API keys. Create one with: oma keys create"); return; }
      table([["NAME", "ID", "PREFIX", "CREATED"], ...data.map(k => [k.name, k.id, k.prefix + "...", new Date(k.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "API Keys", match: ["keys", "create"],
    usage: "oma keys create [name]", desc: "Create API key",
    http: "POST   /v1/api_keys {name?} — raw key returned once",
    async run(config, args) {
      const key = await apiFetch<{ id: string; key: string; name: string }>(config, "/v1/api_keys", { method: "POST", body: JSON.stringify({ name: args.join(" ") || "CLI key" }) });
      console.log(`API key created: ${key.name}\n\n  ${key.key}\n\nSave this key — it won't be shown again.`);
    },
  },
  {
    group: "API Keys", match: ["keys", "revoke"], needsArg: true,
    usage: "oma keys revoke <id>", desc: "Revoke API key",
    http: "DELETE /v1/api_keys/:id",
    async run(config, args) { await apiFetch(config, `/v1/api_keys/${args[0]}`, { method: "DELETE" }); console.log(`API key revoked: ${args[0]}`); },
  },

  // Vaults & Credentials
  {
    group: "Vaults", match: ["vaults", "list"],
    usage: "oma vaults list", desc: "List vaults",
    http: "GET    /v1/vaults",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; name: string; created_at: string }> }>(config, "/v1/vaults");
      if (!data.length) { console.log("No vaults. Create one with: oma vaults create <name>"); return; }
      table([["NAME", "ID", "CREATED"], ...data.map(v => [v.name, v.id, new Date(v.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "Vaults", match: ["vaults", "create"], needsArg: true,
    usage: "oma vaults create <name>", desc: "Create vault",
    http: "POST   /v1/vaults {name}",
    async run(config, args) {
      const vault = await apiFetch<{ id: string; name: string }>(config, "/v1/vaults", { method: "POST", body: JSON.stringify({ name: args.join(" ") }) });
      console.log(`Vault created: ${vault.name} (${vault.id})`);
    },
  },
  {
    group: "Vaults", match: ["creds", "list"], needsArg: true,
    usage: "oma creds list <vault-id>", desc: "List credentials",
    http: "GET    /v1/vaults/:id/credentials",
    async run(config, args) {
      const { data } = await apiFetch<{ data: Array<{ id: string; display_name: string; auth: { type: string; mcp_server_url?: string; command_prefixes?: string[] } }> }>(config, `/v1/vaults/${args[0]}/credentials`);
      if (!data.length) { console.log("No credentials in this vault."); return; }
      table([["NAME", "TYPE", "DETAIL"], ...data.map(c => [c.display_name, c.auth.type, c.auth.mcp_server_url || c.auth.command_prefixes?.join(", ") || ""])]);
    },
  },
  {
    group: "Vaults", match: ["secret", "add"],
    usage: "oma secret add --vault <id> --name <n> --cmd <pfx> --env <var> --token <t>", desc: "Add secret credential",
    http: "POST   /v1/vaults/:id/credentials {display_name, auth:{type, command_prefixes, env_var, token}}",
    async run(config, args) {
      const vaultId = flag(args, "--vault"); const name = flag(args, "--name"); const cmd = flag(args, "--cmd"); const envVar = flag(args, "--env"); const token = flag(args, "--token");
      if (!vaultId || !name || !cmd || !envVar || !token) { console.error("Usage: oma secret add --vault <id> --name <name> --cmd <prefixes> --env <var> --token <token>"); process.exit(1); }
      const cred = await apiFetch<{ id: string }>(config, `/v1/vaults/${vaultId}/credentials`, { method: "POST", body: JSON.stringify({ display_name: name, auth: { type: "command_secret", command_prefixes: cmd.split(",").map(s => s.trim()), env_var: envVar, token } }) });
      console.log(`Secret added: ${name} (${cred.id})`);
    },
  },

  // Skills
  {
    group: "Skills", match: ["skills", "list"],
    usage: "oma skills list", desc: "List skills",
    http: "GET    /v1/skills?source=custom|builtin",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; display_title: string; name: string; source: string }> }>(config, "/v1/skills");
      if (!data.length) { console.log("No skills."); return; }
      table([["NAME", "ID", "SOURCE"], ...data.map(s => [s.display_title || s.name, s.id, s.source])]);
    },
  },
  {
    group: "Skills", match: ["skills", "install"], needsArg: true,
    usage: "oma skills install <slug>", desc: "Install from ClawHub",
    http: "POST   /v1/clawhub/install {slug}",
    async run(config, args) {
      console.log(`Installing ${args[0]} from ClawHub...`);
      const skill = await apiFetch<{ id: string; display_title: string }>(config, "/v1/clawhub/install", { method: "POST", body: JSON.stringify({ slug: args[0] }) });
      console.log(`Installed: ${skill.display_title} (${skill.id})`);
    },
  },

  // MCP Connect
  {
    group: "MCP Servers", match: ["connect"], needsArg: true,
    usage: "oma connect <server|url> --vault <id>", desc: "Connect via OAuth",
    http: "GET    /v1/oauth/authorize?mcp_server_url=X&vault_id=Y (redirect)",
    async run(config, args) {
      const vaultId = flag(args, "--vault");
      if (!vaultId) { console.error("Usage: oma connect <server> --vault <vault-id>"); process.exit(1); }
      await connectMcp(config, resolveServerUrl(args[0]), vaultId);
    },
  },

  // Linear integration
  {
    group: "Linear", match: ["linear", "list"],
    usage: "oma linear list", desc: "List connected Linear workspaces",
    http: "GET    /v1/integrations/linear/installations",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; workspace_name: string; install_kind: string; created_at: number }> }>(config, "/v1/integrations/linear/installations");
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No Linear workspaces connected. Publish an agent with: oma linear publish <agent-id> --env <env-id>"); return; }
      table([["WORKSPACE", "INSTALLATION ID", "KIND", "CREATED"], ...data.map(i => [i.workspace_name, i.id, i.install_kind, new Date(i.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "Linear", match: ["linear", "pubs"], needsArg: true,
    usage: "oma linear pubs <installation-id>", desc: "List agents published to a workspace",
    http: "GET    /v1/integrations/linear/installations/:id/publications",
    async run(config, args) {
      const { data } = await apiFetch<{ data: Array<{ id: string; agent_id: string; persona: { name: string }; status: string; capabilities: string[] }> }>(config, `/v1/integrations/linear/installations/${args[0]}/publications`);
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No publications. Publish with: oma linear publish <agent-id> --env <env-id>"); return; }
      table([["PERSONA", "PUBLICATION ID", "AGENT", "STATUS", "CAPS"], ...data.map(p => [p.persona.name, p.id, p.agent_id, p.status, capsPreview(p.capabilities)])]);
    },
  },
  {
    group: "Linear", match: ["linear", "get"], needsArg: true,
    usage: "oma linear get <publication-id>", desc: "Show one publication",
    http: "GET    /v1/integrations/linear/publications/:id",
    async run(config, args) {
      const p = await apiFetch<any>(config, `/v1/integrations/linear/publications/${args[0]}`);
      if (config.json) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log(`Persona:        ${p.persona.name}\nID:             ${p.id}\nAgent:          ${p.agent_id}\nEnvironment:    ${p.environment_id}\nInstallation:   ${p.installation_id}\nMode:           ${p.mode}\nStatus:         ${p.status}\nGranularity:    ${p.session_granularity}\nCapabilities:   ${p.capabilities.join(", ")}`);
    },
  },
  {
    group: "Linear", match: ["linear", "publish"], needsArg: true,
    usage: "oma linear publish <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]", desc: "Step 1: register agent → returns Linear App config",
    http: "POST   /v1/integrations/linear/start-a1 {agentId, environmentId, personaName, personaAvatarUrl?, returnUrl}",
    async run(config, args) {
      const agentId = args[0];
      const envId = flag(args, "--env");
      const persona = flag(args, "--persona") || "";
      const avatar = flag(args, "--avatar") || null;
      if (!envId) { console.error("Usage: oma linear publish <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]"); process.exit(1); }
      // Persona name defaults to the agent's name when omitted.
      let personaName = persona;
      if (!personaName) {
        const agent = await apiFetch<{ name: string }>(config, `/v1/agents/${agentId}`).catch(() => null);
        personaName = agent?.name || agentId;
      }
      const r = await apiFetch<{ formToken: string; suggestedAppName: string; callbackUrl: string; webhookUrl: string }>(
        config,
        "/v1/integrations/linear/start-a1",
        { method: "POST", body: JSON.stringify({ agentId, environmentId: envId, personaName, personaAvatarUrl: avatar, returnUrl: `${config.baseUrl}/integrations/linear` }) },
      );
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nStep 1 complete. Now register a Linear OAuth App (Linear → Settings → API → New OAuth app):\n`);
      console.log(`  App name:        ${r.suggestedAppName}`);
      console.log(`  Callback URL:    ${r.callbackUrl}`);
      console.log(`  Webhook URL:     ${r.webhookUrl}`);
      console.log(`  Webhook secret:  (generated by Linear — see step 2)`);
      // The callback/webhook URLs come from server config (PUBLIC_BASE_URL on
      // the integrations gateway), NOT from OMA_BASE_URL. They must be
      // publicly reachable HTTPS for Linear to call them — Linear's "New
      // OAuth application" form rejects http:// outright at submit time, so
      // local-dev URLs can't even be saved on Linear's side.
      if (!isPubliclyReachable(r.callbackUrl) || !r.callbackUrl.startsWith("https://")) {
        console.log(`\n⚠  Linear requires HTTPS on a publicly-reachable host for callback/webhook URLs.`);
        console.log(`The URLs above point at a local / non-HTTPS origin — Linear's form will reject them.`);
        console.log(`Fix: deploy the integrations worker (or run a tunnel like cloudflared/ngrok) and set`);
        console.log(`GATEWAY_ORIGIN to that public HTTPS host before publishing.`);
      }
      console.log(`\nStep 2 — submit the credentials Linear gives you:\n`);
      console.log(`  oma linear submit <FORM_TOKEN> \\\n    --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET> --webhook-secret <lin_wh_…>\n`);
      console.log(`The webhook secret is on the same Linear App page, under "Webhooks → Signing secret"`);
      console.log(`(starts with \`lin_wh_\`). Linear auto-generates it and ignores any value you paste in,`);
      console.log(`so OMA can't predict it — you have to copy it back here.\n`);
      console.log(`Form token (expires ~30 min):\n  ${r.formToken}\n`);
      console.log(`Or, to send the Linear App registration to a workspace admin instead:`);
      console.log(`  oma linear handoff ${r.formToken}`);
      console.log(`\nFor scripts, re-run with --json to get the raw response.`);
    },
  },
  {
    group: "Linear", match: ["linear", "submit"], needsArg: true,
    usage: "oma linear submit <form-token> --client-id <id> --client-secret <secret> --webhook-secret <lin_wh_…>", desc: "Step 2: validate creds → returns OAuth install URL",
    http: "POST   /v1/integrations/linear/credentials {formToken, clientId, clientSecret, webhookSecret}",
    async run(config, args) {
      const formToken = args[0];
      const clientId = flag(args, "--client-id");
      const clientSecret = flag(args, "--client-secret");
      const webhookSecret = flag(args, "--webhook-secret");
      if (!clientId || !clientSecret || !webhookSecret) {
        console.error(
          "Usage: oma linear submit <form-token> --client-id <id> --client-secret <secret> --webhook-secret <lin_wh_…>\n" +
          "  webhook-secret is the 'Signing secret' on the Linear App's Webhooks panel.",
        );
        process.exit(1);
      }
      const r = await apiFetch<{ url: string; appId: string; callbackUrl: string; webhookUrl: string }>(
        config,
        "/v1/integrations/linear/credentials",
        { method: "POST", body: JSON.stringify({ formToken, clientId, clientSecret, webhookSecret }) },
      ).catch((err: Error) => {
        // Server now returns {"error":"form_token_invalid", details, remediation}
        // for JWT failures; older deploys still return the raw "JwtSigner.verify"
        // detail under credentials_failed. Handle both.
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma linear publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nStep 2 complete. Open this URL in a browser to authorize the install in Linear:\n`);
      console.log(`  ${r.url}\n`);
      console.log(`After approval Linear redirects to the callback; the publication then transitions to 'live'.`);
      console.log(`Verify with: oma linear list && oma linear pubs <installation-id>`);
    },
  },
  {
    group: "Linear", match: ["linear", "handoff"], needsArg: true,
    usage: "oma linear handoff <form-token>", desc: "Step 2 alt: 7-day shareable URL for an admin",
    http: "POST   /v1/integrations/linear/handoff-link {formToken}",
    async run(config, args) {
      const r = await apiFetch<{ url: string; expiresInDays: number }>(
        config,
        "/v1/integrations/linear/handoff-link",
        { method: "POST", body: JSON.stringify({ formToken: args[0] }) },
      ).catch((err: Error) => {
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma linear publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nSend this URL to your Linear workspace admin:\n  ${r.url}\nExpires in ${r.expiresInDays} days.`);
    },
  },
  {
    group: "Linear", match: ["linear", "update"], needsArg: true,
    usage: "oma linear update <publication-id> [--persona <name>] [--avatar <url>] [--caps <a,b,c>]", desc: "Update persona / capabilities of a publication",
    http: "PATCH  /v1/integrations/linear/publications/:id {persona?, capabilities?}",
    async run(config, args) {
      const id = args[0];
      const personaName = flag(args, "--persona");
      const avatarRaw = flag(args, "--avatar");
      const capsRaw = flag(args, "--caps");
      const patch: Record<string, unknown> = {};
      if (personaName !== undefined || avatarRaw !== undefined) {
        patch.persona = {
          ...(personaName !== undefined ? { name: personaName } : {}),
          // --avatar "" clears the avatar (sends null), --avatar <url> sets it.
          ...(avatarRaw !== undefined ? { avatarUrl: avatarRaw === "" ? null : avatarRaw } : {}),
        };
      }
      if (capsRaw !== undefined) {
        patch.capabilities = capsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (!Object.keys(patch).length) {
        console.error("Nothing to update. Pass at least --persona, --avatar, or --caps.");
        process.exit(1);
      }
      const updated = await apiFetch<any>(config, `/v1/integrations/linear/publications/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (config.json) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(`Updated: ${updated.persona.name} (${updated.id}) — caps: ${updated.capabilities.length}`);
    },
  },
  {
    group: "Linear", match: ["linear", "unpublish"], needsArg: true,
    usage: "oma linear unpublish <publication-id>", desc: "Mark a publication unpublished",
    http: "DELETE /v1/integrations/linear/publications/:id",
    async run(config, args) {
      try {
        await apiFetch(config, `/v1/integrations/linear/publications/${args[0]}`, { method: "DELETE" });
      } catch (err: any) {
        if (/^404 /.test(err.message)) {
          console.error(`No publication with id ${args[0]}.`);
          console.error(`Find valid publication ids with: oma linear list && oma linear pubs <installation-id>`);
          process.exit(1);
        }
        throw err;
      }
      console.log(`Unpublished: ${args[0]}`);
    },
  },

  // GitHub integration — mirrors `oma linear *` shape exactly.
  {
    group: "GitHub", match: ["github", "list"],
    usage: "oma github list", desc: "List connected GitHub installations",
    http: "GET    /v1/integrations/github/installations",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; workspace_name: string; bot_login: string; created_at: number }> }>(config, "/v1/integrations/github/installations");
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No GitHub installations. Publish an agent with: oma github publish <agent-id> --env <env-id>"); return; }
      table([["ORG/USER", "INSTALLATION ID", "BOT LOGIN", "CREATED"], ...data.map(i => [i.workspace_name, i.id, i.bot_login, new Date(i.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "GitHub", match: ["github", "pubs"], needsArg: true,
    usage: "oma github pubs <installation-id>", desc: "List agents published to a GitHub install",
    http: "GET    /v1/integrations/github/installations/:id/publications",
    async run(config, args) {
      const { data } = await apiFetch<{ data: Array<{ id: string; agent_id: string; persona: { name: string }; status: string; capabilities: string[] }> }>(config, `/v1/integrations/github/installations/${args[0]}/publications`);
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No publications. Publish with: oma github publish <agent-id> --env <env-id>"); return; }
      table([["PERSONA", "PUBLICATION ID", "AGENT", "STATUS", "CAPS"], ...data.map(p => [p.persona.name, p.id, p.agent_id, p.status, capsPreview(p.capabilities)])]);
    },
  },
  {
    group: "GitHub", match: ["github", "get"], needsArg: true,
    usage: "oma github get <publication-id>", desc: "Show one GitHub publication",
    http: "GET    /v1/integrations/github/publications/:id",
    async run(config, args) {
      const p = await apiFetch<any>(config, `/v1/integrations/github/publications/${args[0]}`);
      if (config.json) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log(`Persona:        ${p.persona.name}\nID:             ${p.id}\nAgent:          ${p.agent_id}\nEnvironment:    ${p.environment_id}\nInstallation:   ${p.installation_id}\nMode:           ${p.mode}\nStatus:         ${p.status}\nGranularity:    ${p.session_granularity}\nCapabilities:   ${p.capabilities.join(", ")}`);
    },
  },
  {
    group: "GitHub", match: ["github", "bind"], needsArg: true,
    usage: "oma github bind <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]", desc: "Bind agent to GitHub via App Manifest (one-click)",
    http: "POST   /v1/integrations/github/start-a1 {agentId, environmentId, personaName, personaAvatarUrl?, returnUrl}",
    async run(config, args) {
      const agentId = args[0];
      const envId = flag(args, "--env");
      const persona = flag(args, "--persona") || "";
      const avatar = flag(args, "--avatar") || null;
      if (!envId) { console.error("Usage: oma github bind <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]"); process.exit(1); }
      let personaName = persona;
      if (!personaName) {
        const agent = await apiFetch<{ name: string }>(config, `/v1/agents/${agentId}`).catch(() => null);
        personaName = agent?.name || agentId;
      }
      const r = await apiFetch<{
        formToken: string;
        appOmaId: string;
        suggestedAppName: string;
        setupUrl: string;
        webhookUrl: string;
        manifestStartUrl: string;
        recommendedPermissions: Record<string, string>;
        recommendedSubscriptions: string[];
      }>(
        config,
        "/v1/integrations/github/start-a1",
        { method: "POST", body: JSON.stringify({ agentId, environmentId: envId, personaName, personaAvatarUrl: avatar, returnUrl: `${config.baseUrl}/integrations/github` }) },
      );
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nBinding "${r.suggestedAppName}" to GitHub.`);
      if (!isPubliclyReachable(r.setupUrl) || !r.setupUrl.startsWith("https://")) {
        console.log(`\n⚠  GitHub requires HTTPS on a publicly-reachable host for Setup / Webhook URLs.`);
        console.log(`The gateway URL above is local / non-HTTPS — GitHub will reject it.`);
        console.log(`Fix: deploy the integrations worker (or run a tunnel like cloudflared/ngrok)`);
        console.log(`and set GATEWAY_ORIGIN to that public HTTPS host before retrying.`);
      }
      console.log(`\n→ Open this URL to register the GitHub App in one click:\n`);
      console.log(`   ${r.manifestStartUrl}\n`);
      console.log(`After confirming on GitHub you'll bounce through to "Install on org" automatically.`);
      console.log(`Verify with:  oma github list && oma github pubs <installation-id>\n`);
      console.log(`Manual fallback (if you want to register the App by hand instead):`);
      console.log(`  oma github submit ${r.formToken} --app-id <ID> --private-key-file <PEM> --webhook-secret <SECRET>`);
    },
  },
  {
    group: "GitHub", match: ["github", "submit"], needsArg: true,
    usage: "oma github submit <form-token> --app-id <id> (--private-key <pem> | --private-key-file <path>) --webhook-secret <secret> [--client-id X] [--client-secret Y]", desc: "Step 2: validate App credentials → returns install URL",
    http: "POST   /v1/integrations/github/credentials {formToken, appId, privateKey, webhookSecret, clientId?, clientSecret?}",
    async run(config, args) {
      const formToken = args[0];
      const appId = flag(args, "--app-id");
      const privateKeyInline = flag(args, "--private-key");
      const privateKeyFile = flag(args, "--private-key-file");
      const webhookSecret = flag(args, "--webhook-secret");
      const clientId = flag(args, "--client-id");
      const clientSecret = flag(args, "--client-secret");
      if (!appId || !webhookSecret || (!privateKeyInline && !privateKeyFile)) {
        console.error(
          "Usage: oma github submit <form-token> --app-id <id> --private-key-file <path> --webhook-secret <secret>\n" +
          "  --private-key-file points at the .pem you downloaded from the App's settings page.",
        );
        process.exit(1);
      }
      let privateKey: string;
      if (privateKeyInline) {
        privateKey = privateKeyInline.replace(/\\n/g, "\n");
      } else {
        const fs = await import("node:fs/promises");
        privateKey = await fs.readFile(privateKeyFile!, "utf8");
      }
      const r = await apiFetch<{ url: string; appOmaId: string; appSlug: string; botLogin: string; setupUrl: string; webhookUrl: string }>(
        config,
        "/v1/integrations/github/credentials",
        { method: "POST", body: JSON.stringify({ formToken, appId, privateKey, webhookSecret, clientId, clientSecret }) },
      ).catch((err: Error) => {
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma github publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        if (/credentials_mismatch|appId mismatch/i.test(err.message)) {
          console.error(`appId / private key mismatch. Both must come from the same GitHub App's settings page.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nStep 2 complete. Bot will appear as @${r.botLogin}.`);
      console.log(`\nOpen this URL in a browser and pick which org / repos to install on:\n`);
      console.log(`  ${r.url}\n`);
      console.log(`After approval GitHub redirects to the setup URL; the publication transitions to 'live'.`);
      console.log(`Verify with: oma github list && oma github pubs <installation-id>`);
    },
  },
  {
    group: "GitHub", match: ["github", "handoff"], needsArg: true,
    usage: "oma github handoff <form-token>", desc: "Step 2 alt: 7-day shareable URL for an org owner",
    http: "POST   /v1/integrations/github/handoff-link {formToken}",
    async run(config, args) {
      const r = await apiFetch<{ url: string; expiresInDays: number }>(
        config,
        "/v1/integrations/github/handoff-link",
        { method: "POST", body: JSON.stringify({ formToken: args[0] }) },
      ).catch((err: Error) => {
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma github publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nSend this URL to your GitHub org owner:\n  ${r.url}\nExpires in ${r.expiresInDays} days.`);
    },
  },
  {
    group: "GitHub", match: ["github", "update"], needsArg: true,
    usage: "oma github update <publication-id> [--persona <name>] [--avatar <url>] [--caps <a,b,c>]", desc: "Update persona / capabilities of a GitHub publication",
    http: "PATCH  /v1/integrations/github/publications/:id {persona?, capabilities?}",
    async run(config, args) {
      const id = args[0];
      const personaName = flag(args, "--persona");
      const avatarRaw = flag(args, "--avatar");
      const capsRaw = flag(args, "--caps");
      const patch: Record<string, unknown> = {};
      if (personaName !== undefined || avatarRaw !== undefined) {
        patch.persona = {
          ...(personaName !== undefined ? { name: personaName } : {}),
          ...(avatarRaw !== undefined ? { avatarUrl: avatarRaw === "" ? null : avatarRaw } : {}),
        };
      }
      if (capsRaw !== undefined) {
        patch.capabilities = capsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (!Object.keys(patch).length) {
        console.error("Nothing to update. Pass at least --persona, --avatar, or --caps.");
        process.exit(1);
      }
      const updated = await apiFetch<any>(config, `/v1/integrations/github/publications/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (config.json) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(`Updated: ${updated.persona.name} (${updated.id}) — caps: ${updated.capabilities.length}`);
    },
  },
  {
    group: "GitHub", match: ["github", "unpublish"], needsArg: true,
    usage: "oma github unpublish <publication-id>", desc: "Mark a GitHub publication unpublished",
    http: "DELETE /v1/integrations/github/publications/:id",
    async run(config, args) {
      try {
        await apiFetch(config, `/v1/integrations/github/publications/${args[0]}`, { method: "DELETE" });
      } catch (err: any) {
        if (/^404 /.test(err.message)) {
          console.error(`No publication with id ${args[0]}.`);
          console.error(`Find valid publication ids with: oma github list && oma github pubs <installation-id>`);
          process.exit(1);
        }
        throw err;
      }
      console.log(`Unpublished: ${args[0]}`);
    },
  },

  // Slack integration — mirrors Linear's surface (A1 per-publication App).
  {
    group: "Slack", match: ["slack", "list"],
    usage: "oma slack list", desc: "List connected Slack workspaces",
    http: "GET    /v1/integrations/slack/installations",
    async run(config) {
      const { data } = await apiFetch<{ data: Array<{ id: string; workspace_name: string; install_kind: string; created_at: number }> }>(config, "/v1/integrations/slack/installations");
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No Slack workspaces connected. Publish an agent with: oma slack publish <agent-id> --env <env-id>"); return; }
      table([["WORKSPACE", "INSTALLATION ID", "KIND", "CREATED"], ...data.map(i => [i.workspace_name, i.id, i.install_kind, new Date(i.created_at).toLocaleDateString()])]);
    },
  },
  {
    group: "Slack", match: ["slack", "pubs"], needsArg: true,
    usage: "oma slack pubs <installation-id>", desc: "List agents published to a workspace",
    http: "GET    /v1/integrations/slack/installations/:id/publications",
    async run(config, args) {
      const { data } = await apiFetch<{ data: Array<{ id: string; agent_id: string; persona: { name: string }; status: string; capabilities: string[] }> }>(config, `/v1/integrations/slack/installations/${args[0]}/publications`);
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data.length) { console.log("No publications. Publish with: oma slack publish <agent-id> --env <env-id>"); return; }
      table([["PERSONA", "PUBLICATION ID", "AGENT", "STATUS", "CAPS"], ...data.map(p => [p.persona.name, p.id, p.agent_id, p.status, capsPreview(p.capabilities)])]);
    },
  },
  {
    group: "Slack", match: ["slack", "get"], needsArg: true,
    usage: "oma slack get <publication-id>", desc: "Show one publication",
    http: "GET    /v1/integrations/slack/publications/:id",
    async run(config, args) {
      const p = await apiFetch<any>(config, `/v1/integrations/slack/publications/${args[0]}`);
      if (config.json) { console.log(JSON.stringify(p, null, 2)); return; }
      console.log(`Persona:        ${p.persona.name}\nID:             ${p.id}\nAgent:          ${p.agent_id}\nEnvironment:    ${p.environment_id}\nInstallation:   ${p.installation_id}\nMode:           ${p.mode}\nStatus:         ${p.status}\nGranularity:    ${p.session_granularity}\nCapabilities:   ${p.capabilities.join(", ")}`);
    },
  },
  {
    group: "Slack", match: ["slack", "publish"], needsArg: true,
    usage: "oma slack publish <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]", desc: "Step 1: register agent → returns Slack App config",
    http: "POST   /v1/integrations/slack/start-a1 {agentId, environmentId, personaName, personaAvatarUrl?, returnUrl}",
    async run(config, args) {
      const agentId = args[0];
      const envId = flag(args, "--env");
      const persona = flag(args, "--persona") || "";
      const avatar = flag(args, "--avatar") || null;
      if (!envId) { console.error("Usage: oma slack publish <agent-id> --env <env-id> [--persona <name>] [--avatar <url>]"); process.exit(1); }
      let personaName = persona;
      if (!personaName) {
        const agent = await apiFetch<{ name: string }>(config, `/v1/agents/${agentId}`).catch(() => null);
        personaName = agent?.name || agentId;
      }
      const r = await apiFetch<{ formToken: string; suggestedAppName: string; callbackUrl: string; webhookUrl: string; manifestLaunchUrl?: string | null }>(
        config,
        "/v1/integrations/slack/start-a1",
        { method: "POST", body: JSON.stringify({ agentId, environmentId: envId, personaName, personaAvatarUrl: avatar, returnUrl: `${config.baseUrl}/integrations/slack` }) },
      );
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      if (r.manifestLaunchUrl) {
        console.log(`\nStep 1 complete. One-click setup — open this URL to have Slack create the App for you:\n`);
        console.log(`  ${r.manifestLaunchUrl}\n`);
        console.log(`Slack will pre-fill name, scopes, events, and redirect URL from a manifest.`);
        console.log(`Confirm Create on Slack, then come back and paste the secrets it shows you.\n`);
        console.log(`Or set up manually:`);
      } else {
        console.log(`\nStep 1 complete. Now create a Slack App (https://api.slack.com/apps → Create New App → From scratch):\n`);
      }
      console.log(`  App name:             ${r.suggestedAppName}`);
      console.log(`  Redirect URL:         ${r.callbackUrl}`);
      console.log(`  Events Request URL:   ${r.webhookUrl}`);
      console.log(`\nIn the App settings:`);
      console.log(`  • OAuth & Permissions → paste Redirect URL`);
      console.log(`  • Event Subscriptions → paste Events Request URL, wait for green "Verified" check`);
      console.log(`  • Subscribe to bot events: app_mention, message.channels, message.im,`);
      console.log(`    message.groups, message.mpim, tokens_revoked, app_uninstalled`);
      // Slack will reject any non-HTTPS or non-publicly-reachable URL when verifying.
      if (!isPubliclyReachable(r.callbackUrl) || !r.callbackUrl.startsWith("https://")) {
        console.log(`\n⚠  Slack requires HTTPS on a publicly-reachable host for Redirect / Events URLs.`);
        console.log(`The URLs above point at a local / non-HTTPS origin — Slack's Verify button will fail.`);
        console.log(`Fix: deploy the integrations worker (or run a tunnel like cloudflared/ngrok) and set`);
        console.log(`GATEWAY_ORIGIN to that public HTTPS host before publishing.`);
      }
      console.log(`\nStep 2 — submit the credentials Slack gives you (Basic Information page):\n`);
      console.log(`  oma slack submit <FORM_TOKEN> \\\n    --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET> --signing-secret <SIGNING_SECRET>\n`);
      console.log(`The Signing Secret is on the same Basic Information page; Slack uses it to`);
      console.log(`sign every webhook event.\n`);
      console.log(`Form token (expires ~60 min):\n  ${r.formToken}\n`);
      console.log(`Or, to send the Slack App registration to a workspace admin instead:`);
      console.log(`  oma slack handoff ${r.formToken}`);
      console.log(`\nFor scripts, re-run with --json to get the raw response.`);
    },
  },
  {
    group: "Slack", match: ["slack", "submit"], needsArg: true,
    usage: "oma slack submit <form-token> --client-id <id> --client-secret <secret> --signing-secret <secret>", desc: "Step 2: validate creds → returns OAuth install URL",
    http: "POST   /v1/integrations/slack/credentials {formToken, clientId, clientSecret, signingSecret}",
    async run(config, args) {
      const formToken = args[0];
      const clientId = flag(args, "--client-id");
      const clientSecret = flag(args, "--client-secret");
      const signingSecret = flag(args, "--signing-secret");
      if (!clientId || !clientSecret || !signingSecret) {
        console.error(
          "Usage: oma slack submit <form-token> --client-id <id> --client-secret <secret> --signing-secret <secret>\n" +
          "  signing-secret is the 'Signing Secret' on the Slack App's Basic Information page.",
        );
        process.exit(1);
      }
      const r = await apiFetch<{ url: string; appId: string; callbackUrl: string; webhookUrl: string }>(
        config,
        "/v1/integrations/slack/credentials",
        { method: "POST", body: JSON.stringify({ formToken, clientId, clientSecret, signingSecret }) },
      ).catch((err: Error) => {
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma slack publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nStep 2 complete. Open this URL in a browser to authorize the install in Slack:\n`);
      console.log(`  ${r.url}\n`);
      console.log(`After approval Slack redirects to the callback; the publication then transitions to 'live'.`);
      console.log(`Verify with: oma slack list && oma slack pubs <installation-id>`);
    },
  },
  {
    group: "Slack", match: ["slack", "handoff"], needsArg: true,
    usage: "oma slack handoff <form-token>", desc: "Step 2 alt: 7-day shareable URL for an admin",
    http: "POST   /v1/integrations/slack/handoff-link {formToken}",
    async run(config, args) {
      const r = await apiFetch<{ url: string; expiresInDays: number }>(
        config,
        "/v1/integrations/slack/handoff-link",
        { method: "POST", body: JSON.stringify({ formToken: args[0] }) },
      ).catch((err: Error) => {
        if (/form_token_invalid|JwtSigner\.verify/i.test(err.message)) {
          console.error(`Form token rejected. Re-run \`oma slack publish <agent-id> --env <env-id>\` to mint a fresh token.`);
          process.exit(1);
        }
        throw err;
      });
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`\nSend this URL to your Slack workspace admin:\n  ${r.url}\nExpires in ${r.expiresInDays} days.`);
    },
  },
  {
    group: "Slack", match: ["slack", "update"], needsArg: true,
    usage: "oma slack update <publication-id> [--persona <name>] [--avatar <url>] [--caps <a,b,c>]", desc: "Update persona / capabilities of a publication",
    http: "PATCH  /v1/integrations/slack/publications/:id {persona?, capabilities?}",
    async run(config, args) {
      const id = args[0];
      const personaName = flag(args, "--persona");
      const avatarRaw = flag(args, "--avatar");
      const capsRaw = flag(args, "--caps");
      const patch: Record<string, unknown> = {};
      if (personaName !== undefined || avatarRaw !== undefined) {
        patch.persona = {
          ...(personaName !== undefined ? { name: personaName } : {}),
          ...(avatarRaw !== undefined ? { avatarUrl: avatarRaw === "" ? null : avatarRaw } : {}),
        };
      }
      if (capsRaw !== undefined) {
        patch.capabilities = capsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (!Object.keys(patch).length) {
        console.error("Nothing to update. Pass at least --persona, --avatar, or --caps.");
        process.exit(1);
      }
      const updated = await apiFetch<any>(config, `/v1/integrations/slack/publications/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (config.json) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(`Updated: ${updated.persona.name} (${updated.id}) — caps: ${updated.capabilities.length}`);
    },
  },
  {
    group: "Slack", match: ["slack", "unpublish"], needsArg: true,
    usage: "oma slack unpublish <publication-id>", desc: "Mark a publication unpublished",
    http: "DELETE /v1/integrations/slack/publications/:id",
    async run(config, args) {
      try {
        await apiFetch(config, `/v1/integrations/slack/publications/${args[0]}`, { method: "DELETE" });
      } catch (err: any) {
        if (/^404 /.test(err.message)) {
          console.error(`No publication with id ${args[0]}.`);
          console.error(`Find valid publication ids with: oma slack list && oma slack pubs <installation-id>`);
          process.exit(1);
        }
        throw err;
      }
      console.log(`Unpublished: ${args[0]}`);
    },
  },

  // Memory
  {
    group: "Memory", match: ["memory", "reconcile"],
    usage: "oma memory reconcile [--store <id>] [--limit N] [--all]",
    desc: "Re-embed memories whose Vectorize sync is stale (vector_synced_at IS NULL).",
    http: "POST   /v1/memory_stores/_reconcile {store_id?, limit?}",
    async run(config, args) {
      const storeId = flag(args, "--store");
      const limitStr = flag(args, "--limit");
      const all = args.includes("--all");
      const limit = limitStr ? Number(limitStr) : 200;
      if (!storeId && !all) {
        console.error("Specify either --store <id> or --all (drains all stores in the tenant).");
        process.exit(1);
      }
      let totalScanned = 0, totalFixed = 0, totalFailing = 0;
      const errors: Array<{ memory_id: string; error: string }> = [];
      for (let pass = 1; pass <= 100; pass++) {
        const body: { store_id?: string; limit?: number } = { limit };
        if (storeId) body.store_id = storeId;
        const result = await apiFetch<{
          scanned: number; fixed: number; still_failing: number;
          sample_errors: Array<{ memory_id: string; error: string }>;
        }>(config, "/v1/memory_stores/_reconcile", {
          method: "POST",
          body: JSON.stringify(body),
        });
        totalScanned += result.scanned;
        totalFixed += result.fixed;
        totalFailing = result.still_failing; // last pass's failing count
        for (const e of result.sample_errors) if (errors.length < 10) errors.push(e);
        if (config.json) {
          console.log(JSON.stringify({ pass, ...result }));
        } else {
          console.log(`pass ${pass}: scanned=${result.scanned} fixed=${result.fixed} failing=${result.still_failing}`);
        }
        // Stop when this batch had nothing to do, or when we made no progress.
        if (result.scanned === 0) break;
        if (result.fixed === 0 && result.still_failing > 0) {
          console.error("No progress this pass — remaining rows keep failing. Stopping.");
          break;
        }
      }
      if (config.json) {
        console.log(JSON.stringify({ totals: { scanned: totalScanned, fixed: totalFixed, failing: totalFailing }, errors }));
      } else {
        console.log(`\nDone. scanned=${totalScanned} fixed=${totalFixed} still_failing=${totalFailing}`);
        if (errors.length) {
          console.log("\nSample errors:");
          for (const e of errors) console.log(`  ${e.memory_id}: ${e.error}`);
        }
      }
    },
  },
];

// ─── API Endpoints not covered by CLI commands ───

const extraEndpoints: { group: string; http: string }[] = [
  { group: "Agents", http: "POST   /v1/agents/:id                          Update agent" },
  { group: "Agents", http: "GET    /v1/agents/:id/versions                 List versions" },
  { group: "Agents", http: "POST   /v1/agents/:id/archive                  Archive agent" },
  { group: "Sessions", http: "GET    /v1/sessions/:id                        Get session (status, usage)" },
  { group: "Sessions", http: "GET    /v1/sessions/:id/events?limit=N         Get events (JSON)" },
  { group: "Sessions", http: "GET    /v1/sessions/:id/stream                 Stream events (SSE)" },
  { group: "Sessions", http: "POST   /v1/sessions/:id/archive                Archive session" },
  { group: "Sessions", http: "DELETE /v1/sessions/:id                        Delete session" },
  { group: "Sessions", http: "POST   /v1/sessions/:id/files                  Promote sandbox file {path}" },
  { group: "Sessions", http: "POST   /v1/sessions/:id/resources              Add resource {type, file_id?, memory_store_id?}" },
  { group: "Sessions", http: "GET    /v1/sessions/:id/threads                List threads (multi-agent)" },
  { group: "Environments", http: "GET    /v1/environments/:id                    Get environment" },
  { group: "Environments", http: "PUT    /v1/environments/:id                    Update environment" },
  { group: "Environments", http: "DELETE /v1/environments/:id                    Delete environment" },
  { group: "Model Cards", http: "GET    /v1/model_cards/:id                     Get model card" },
  { group: "Model Cards", http: "POST   /v1/model_cards/:id                     Update model card" },
  { group: "Model Cards", http: "DELETE /v1/model_cards/:id                     Delete model card" },
  { group: "Model Cards", http: "POST   /v1/models/list                         Fetch provider models {provider, api_key}" },
  { group: "Vaults", http: "DELETE /v1/vaults/:id                          Delete vault" },
  { group: "Vaults", http: "DELETE /v1/vaults/:id/credentials/:cid         Delete credential" },
  { group: "Linear", http: "PATCH  /v1/integrations/linear/publications/:id  Update persona / capabilities" },
  { group: "GitHub", http: "PATCH  /v1/integrations/github/publications/:id  Update persona / capabilities" },
  { group: "OAuth", http: "GET    /v1/oauth/callback                      OAuth callback (internal)" },
  { group: "OAuth", http: "POST   /v1/oauth/refresh                       Refresh token {vault_id, credential_id}" },
  { group: "Skills", http: "POST   /v1/skills                              Create skill {files:[{filename,content}]}" },
  { group: "Skills", http: "GET    /v1/skills/:id                          Get skill" },
  { group: "Skills", http: "DELETE /v1/skills/:id                          Delete skill" },
  { group: "Skills", http: "POST   /v1/skills/:id/versions                 Create new version {files}" },
  { group: "Skills", http: "GET    /v1/skills/:id/versions                 List versions" },
  { group: "Files", http: "POST   /v1/files                               Upload (multipart or JSON {filename,content,encoding?})" },
  { group: "Files", http: "GET    /v1/files?scope_id=X&limit=N            List files (cursor-paginated)" },
  { group: "Files", http: "GET    /v1/files/:id                           Get file metadata" },
  { group: "Files", http: "GET    /v1/files/:id/content                   Download file content" },
  { group: "Files", http: "DELETE /v1/files/:id                           Delete file" },
  { group: "Memory", http: "POST   /v1/memory_stores                       Create store {name}" },
  { group: "Memory", http: "GET    /v1/memory_stores                       List stores" },
  { group: "Memory", http: "DELETE /v1/memory_stores/:id                   Delete store" },
  { group: "Memory", http: "POST   /v1/memory_stores/:id/memories          Write memory {path, content} (max 100KB)" },
  { group: "Memory", http: "GET    /v1/memory_stores/:id/memories?prefix=X List memories (metadata)" },
  { group: "Memory", http: "GET    /v1/memory_stores/:id/memories/:mid     Get memory with content" },
  { group: "Memory", http: "DELETE /v1/memory_stores/:id/memories/:mid     Delete memory" },
  { group: "Memory", http: "POST   /v1/memory_stores/_reconcile {store_id?,limit?}  Re-embed stale rows" },
  { group: "Evals", http: "POST   /v1/evals/runs                          Create eval run {agent_id, environment_id, tasks:[...]}" },
  { group: "Evals", http: "GET    /v1/evals/runs                          List eval runs" },
  { group: "Evals", http: "GET    /v1/evals/runs/:id                      Get eval run results" },
  { group: "ClawHub", http: "GET    /v1/clawhub/search?q=X                  Search ClawHub registry" },
];

// ─── MCP Connect ───

const KNOWN_SERVERS: Record<string, string> = {
  airtable: "https://mcp.airtable.com/mcp",
  amplitude: "https://mcp.amplitude.com/mcp",
  apollo: "https://mcp.apollo.io/mcp",
  asana: "https://mcp.asana.com/v2/mcp",
  atlassian: "https://mcp.atlassian.com/v1/mcp",
  clickup: "https://mcp.clickup.com/mcp",
  github: "https://api.githubcopilot.com/mcp/",
  intercom: "https://mcp.intercom.com/mcp",
  linear: "https://mcp.linear.app/mcp",
  notion: "https://mcp.notion.com/mcp",
  sentry: "https://mcp.sentry.dev/mcp",
  slack: "https://mcp.slack.com/mcp",
};

function resolveServerUrl(nameOrUrl: string): string {
  if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) return nameOrUrl;
  const url = KNOWN_SERVERS[nameOrUrl.toLowerCase()];
  if (!url) {
    console.error(`Unknown server: ${nameOrUrl}. Known: ${Object.keys(KNOWN_SERVERS).join(", ")}`);
    process.exit(1);
  }
  return url;
}

async function connectMcp(config: Config, mcpServerUrl: string, vaultId: string) {
  const port = 19284 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://localhost:${port}/callback`;
  const authUrl = `${config.baseUrl}/v1/oauth/authorize?mcp_server_url=${encodeURIComponent(mcpServerUrl)}&vault_id=${encodeURIComponent(vaultId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`Opening browser...\n  ${authUrl}\n`);
  try {
    const p = process.platform;
    if (p === "darwin") execSync(`open "${authUrl}"`);
    else if (p === "linux") execSync(`xdg-open "${authUrl}"`);
    else if (p === "win32") execSync(`start "${authUrl}"`);
  } catch {}

  return new Promise<void>((resolve) => {
    const server = createServer((req: any, res: any) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      if (url.pathname === "/callback") {
        const service = url.searchParams.get("service");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Connected${service ? ` to ${service}` : ""}!</h2><script>window.close()</script></body></html>`);
        console.log(`Connected to ${service || mcpServerUrl}`);
        server.close();
        resolve();
      }
    });
    server.listen(port);
    setTimeout(() => { console.log("Timed out."); server.close(); resolve(); }, 300000);
  });
}

// ─── API Reference (derived from commands + extras) ───

function apiRef(resource?: string) {
  const groups = new Map<string, string[]>();
  for (const c of commands) {
    const list = groups.get(c.group) || [];
    list.push(`  ${c.http}`);
    groups.set(c.group, list);
  }
  for (const e of extraEndpoints) {
    const list = groups.get(e.group) || [];
    list.push(`  ${e.http}`);
    groups.set(e.group, list);
  }

  const normalized = resource?.toLowerCase();
  const groupAlias: Record<string, string> = {
    agents: "Agents", sessions: "Sessions", environments: "Environments",
    models: "Model Cards", vaults: "Vaults", oauth: "OAuth",
    skills: "Skills", files: "Files", memory: "Memory",
    keys: "API Keys", evals: "Evals", clawhub: "ClawHub",
    "mcp": "MCP Servers", linear: "Linear", github: "GitHub", integrations: "Linear",
  };

  if (normalized && groupAlias[normalized]) {
    const name = groupAlias[normalized];
    const lines = groups.get(name);
    if (lines) { console.log(`\n${name}\n${lines.join("\n")}\n`); return; }
  }

  console.log(`\noma api — HTTP API Quick Reference\nAuth: all /v1/* endpoints require x-api-key header\n`);
  for (const [name, lines] of groups) {
    console.log(`${name}\n${lines.join("\n")}\n`);
  }

  if (normalized && !groupAlias[normalized]) {
    console.log(`Unknown resource: ${resource}\nAvailable: ${Object.keys(groupAlias).join(", ")}`);
  }
}

// ─── Usage (derived from commands) ───

function usage() {
  console.log(`\noma — Open Managed Agents CLI\n\nUsage:`);
  let lastGroup = "";
  for (const c of commands) {
    if (c.group !== lastGroup) { console.log(`\n  ${c.group}:`); lastGroup = c.group; }
    console.log(`    ${c.usage.padEnd(42)} ${c.desc}`);
  }
  console.log(`
  API Reference:
    oma api                                    Show all HTTP endpoints
    oma api <resource>                         Show endpoints for a resource

Environment:
  OMA_BASE_URL   API base (default: https://openma.dev)
  OMA_API_KEY    API key — overrides stored credentials when set
  XDG_CONFIG_HOME  Base dir for credentials (default: ~/.config)

Stored credentials live at ~/.config/oma/credentials.json (created by
'oma auth login', mode 0600). Delete with 'oma auth logout'.
`);
}

// ─── Main ───

async function main() {
  let args = process.argv.slice(2);
  if (!args.length || ["-h", "--help", "help"].includes(args[0])) { usage(); process.exit(0); }
  if (args[0] === "api") { apiRef(args[1]); return; }

  // Strip --json from args so subcommand matchers don't see it.
  const wantJson = args.includes("--json");
  args = args.filter((a) => a !== "--json");

  // Pre-auth commands: `auth login` runs before any credentials exist;
  // `auth logout` is a local file delete and shouldn't error if logged out.
  // Both bypass the strict loadConfig that exits on missing key.
  const isPreAuth =
    (args[0] === "auth" && (args[1] === "login" || args[1] === "logout"));
  const config = isPreAuth ? loadConfigOptional() : loadConfig();
  config.json = wantJson;

  // Matcher: track the best partial match so we can give a useful hint when
  // the user typed a real subcommand but forgot the required positional.
  let needsArgMatch: Cmd | null = null;
  for (const c of commands) {
    const verbMatch = c.match.length === 1
      ? args[0] === c.match[0]
      : args[0] === c.match[0] && args[1] === c.match[1];
    if (!verbMatch) continue;
    if (c.needsArg && !args[c.match.length]) {
      needsArgMatch = c;
      continue;
    }
    const rest = args.slice(c.match.length);
    return c.run(config, rest);
  }

  if (needsArgMatch) {
    console.error(`${needsArgMatch.usage}\n  ${needsArgMatch.desc}`);
    process.exit(1);
  }
  console.error(`Unknown command: ${args.join(" ")}`);
  usage();
  process.exit(1);
}

main().catch((err: any) => { console.error(err.message); process.exit(1); });
