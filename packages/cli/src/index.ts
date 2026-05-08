import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AgentConfig, ModelCard, SessionMeta } from "@open-managed-agents/api-types";
import { currentProfile } from "./bridge/lib/platform.js";

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
  // Profile suffix mirrors paths() in bridge/lib/platform.ts. Default
  // (no OMA_PROFILE) → credentials.json. Profile=staging →
  // credentials.staging.json. Same OMA_PROFILE env var routes both
  // sides; set once via --profile or env, applies to cli auth + bridge.
  // currentProfile() validates the slug and throws on bad input — we
  // want that error to surface here so a typoed --profile doesn't
  // silently route to a junk path.
  const profile = currentProfile();
  const file = profile ? `credentials.${profile}.json` : "credentials.json";
  return join(base, "oma", file);
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

/** Common fetch wrapper used by both apiFetch and rawStream. Honors
 *  Retry-After on 503 so a freshly-built env (or one that needs its
 *  service binding lazy-healed in the gateway) doesn't surface as a
 *  hard failure to the operator. Caps each wait at 30s and retries
 *  up to 3 times; longer outages bubble through.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, init);
    if (res.ok || res.status !== 503) return res;
    const retryAfter = res.headers.get("retry-after");
    if (!retryAfter || attempt >= maxRetries) return res;
    const seconds = Math.min(Math.max(parseInt(retryAfter, 10) || 0, 1), 30);
    await res.body?.cancel().catch(() => undefined);
    await new Promise(r => setTimeout(r, seconds * 1000));
    attempt += 1;
  }
}

async function apiFetch<T = unknown>(config: Config, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const res = await fetchWithRetry(url, {
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

// ─── SSE helpers ───
//
// Two streaming endpoints, two helpers:
//
//   streamChat   — POST /v1/sessions/:id/messages with one user turn,
//                  read text/event-stream until session.status_idle,
//                  render text deltas inline + thinking deltas dimmed
//                  + tool calls as one-line headers. Auto-closes on
//                  the FIRST status_idle (server scopes the SSE to the
//                  just-posted turn). Drops back to the prompt when done.
//
//   tailSession  — GET /v1/sessions/:id/events/stream, never closes;
//                  prints every event as one JSON line. Pipe into jq.

async function rawStream(
  config: Config,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetchWithRetry(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      "x-api-key": config.apiKey,
      "user-agent": "Mozilla/5.0 (compatible; OpenManagedAgents-CLI/0.1; +https://openma.dev)",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res;
}

async function* parseSSE(res: Response): AsyncIterable<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { yield JSON.parse(line.slice(6)) as Record<string, unknown>; }
      catch { /* malformed — skip */ }
    }
  }
}

// ANSI styling — only when stdout is a tty; piped output stays plain so
// `oma sessions chat ... | tee transcript.txt` produces a clean file.
const tty = !!process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);

async function streamChat(config: Config, sessionId: string, text: string): Promise<void> {
  const res = await rawStream(config, `/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ content: text }),
  });
  let textOpen = false;       // are we mid-message-text on the current line?
  let thinkOpen = false;      // are we mid-thinking on stderr?
  for await (const ev of parseSSE(res)) {
    const t = ev.type as string;
    switch (t) {
      case "agent.message_chunk":
        process.stdout.write(String(ev.delta ?? ""));
        textOpen = true;
        break;
      case "agent.message_stream_end":
      case "agent.message":
        if (textOpen) { process.stdout.write("\n"); textOpen = false; }
        break;
      case "agent.thinking_chunk":
        if (!thinkOpen) {
          process.stderr.write(dim("💭 "));
          thinkOpen = true;
        }
        process.stderr.write(dim(String(ev.delta ?? "")));
        break;
      case "agent.thinking_stream_end":
      case "agent.thinking":
        if (thinkOpen) { process.stderr.write("\n"); thinkOpen = false; }
        break;
      case "agent.tool_use_input_stream_start":
        process.stdout.write(cyan(`→ tool: ${(ev as { tool_name?: string }).tool_name ?? "?"}`) + dim(" preparing…\n"));
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use":
        process.stdout.write(cyan(`→ tool: ${ev.name}`) + " " + dim(JSON.stringify(ev.input ?? {})) + "\n");
        break;
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const out = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content ?? "");
        const trimmed = out.length > 280 ? out.slice(0, 280) + "…" : out;
        process.stdout.write(dim("← ") + trimmed + "\n");
        break;
      }
      case "session.warning":
        process.stderr.write(yellow(`⚠ ${ev.source}: ${ev.message}`) + "\n");
        break;
      case "session.error":
        process.stderr.write(yellow(`✗ error: ${ev.error}`) + "\n");
        break;
      case "session.status_idle":
        if (textOpen) { process.stdout.write("\n"); textOpen = false; }
        return;
    }
  }
}

async function tailSession(config: Config, sessionId: string): Promise<void> {
  const res = await rawStream(config, `/v1/sessions/${sessionId}/events/stream`, {
    headers: { accept: "text/event-stream" },
  });
  for await (const ev of parseSSE(res)) {
    process.stdout.write(JSON.stringify(ev) + "\n");
  }
}

// ─── Helpers ───

function flag(args: string[], name: string): string | undefined {
  // Accepts both `--name value` and `--name=value` forms.
  const eqPrefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(eqPrefix)) return args[i].slice(eqPrefix.length);
  }
  return undefined;
}

/**
 * Read memory content from either --content <string> or --from-file <path>.
 * Returns undefined if neither was specified, throws if both were.
 * `--from-file -` reads stdin.
 */
function readContentArg(args: string[]): string | undefined {
  const inline = flag(args, "--content");
  const fromFile = flag(args, "--from-file");
  if (inline !== undefined && fromFile !== undefined) {
    console.error("Pass either --content or --from-file, not both.");
    process.exit(1);
  }
  if (inline !== undefined) return inline;
  if (fromFile !== undefined) {
    if (fromFile === "-") {
      // Sync read from stdin. Acceptable for CLI use where the user is piping.
      const fs = require("fs") as typeof import("fs");
      return fs.readFileSync(0, "utf8");
    }
    const fs = require("fs") as typeof import("fs");
    return fs.readFileSync(fromFile, "utf8");
  }
  return undefined;
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
    http: "POST   /v1/agents {name, model, system, tools, skills?, mcp_servers?, multiagent?, _oma?:{runtime_binding,harness,...}}",
    async run(config, args) {
      const name = flag(args, "--name") || args.find(a => !a.startsWith("--"));
      const model = flag(args, "--model") || "claude-sonnet-4-6";
      const system = flag(args, "--system") || "";
      if (!name) { console.error("Usage: oma agents create <name> [--model <id>] [--system <prompt>] [--runtime <id> --acp-agent <agent-id>]"); process.exit(1); }
      // Local-runtime agent: routes turns to a user-registered `oma bridge daemon`
      // running an ACP-compatible child (Claude Code etc.). Both flags must be
      // present to opt in — partial config silently drops the binding.
      const runtimeId = flag(args, "--runtime");
      const acpAgentId = flag(args, "--acp-agent");
      const useAcpProxy = !!(runtimeId && acpAgentId);
      const body: Record<string, unknown> = {
        name, model, system, tools: [{ type: "agent_toolset_20260401" }],
      };
      if (useAcpProxy) {
        body._oma = {
          harness: "acp-proxy",
          runtime_binding: { runtime_id: runtimeId, acp_agent_id: acpAgentId },
        };
      }
      const agent = await apiFetch<{ id: string; name: string }>(config, "/v1/agents", { method: "POST", body: JSON.stringify(body) });
      console.log(`Agent created: ${agent.name} (${agent.id})${useAcpProxy ? `  [acp-proxy → ${acpAgentId} on ${runtimeId.slice(0, 8)}…]` : ""}`);
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

  // Runtimes — user-registered local machines running `oma bridge daemon`.
  // Used as the spawn host for ACP-proxy agents (claude-code etc.).
  {
    group: "Runtimes", match: ["runtime", "list"],
    usage: "oma runtime list", desc: "List registered local runtimes",
    http: "GET    /v1/runtimes",
    async run(config) {
      const { runtimes } = await apiFetch<{ runtimes: Array<{
        id: string; hostname: string; os: string; status: string;
        version: string; agents: Array<{ id: string }>; last_heartbeat: number | null;
      }> }>(config, "/v1/runtimes");
      if (config.json) { console.log(JSON.stringify(runtimes, null, 2)); return; }
      if (!runtimes.length) {
        console.log("No runtimes. Register one with `oma bridge setup` on the target machine.");
        return;
      }
      table([
        ["ID", "HOSTNAME", "OS", "STATUS", "VER", "AGENTS", "HEARTBEAT"],
        ...runtimes.map((r) => [
          r.id.slice(0, 8) + "…",
          r.hostname,
          r.os,
          r.status,
          r.version,
          r.agents.map((a) => a.id).join(",") || "—",
          r.last_heartbeat ? new Date(r.last_heartbeat * 1000).toISOString().slice(11, 19) : "—",
        ]),
      ]);
    },
  },
  {
    group: "Runtimes", match: ["runtime", "rm"], needsArg: true,
    usage: "oma runtime rm <id>", desc: "Revoke a runtime + all its tokens",
    http: "DELETE /v1/runtimes/:id",
    async run(config, args) {
      await apiFetch(config, `/v1/runtimes/${args[0]}`, { method: "DELETE" });
      console.log(`Runtime revoked: ${args[0]}`);
      console.log("The daemon will stop reconnecting after a few backoff cycles.");
    },
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
    usage: "oma sessions message <id> <text>", desc: "Fire-and-forget user message (no streaming back)",
    http: "POST   /v1/sessions/:id/events {events:[{type:\"user.message\",content:[{type:\"text\",text:\"...\"}]}]}",
    async run(config, args) {
      const text = args.slice(1).join(" ");
      await apiFetch(config, `/v1/sessions/${args[0]}/events`, { method: "POST", body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }) });
      console.log("Message sent.");
    },
  },
  {
    group: "Sessions", match: ["sessions", "chat"], needsArg: true,
    usage: "oma sessions chat <id> <text>", desc: "Send a turn AND stream the reply token-by-token",
    http: "POST   /v1/sessions/:id/messages {content:\"...\"}  (text/event-stream)",
    async run(config, args) {
      const text = args.slice(1).join(" ");
      if (!text) { console.error("Usage: oma sessions chat <id> <text>"); process.exit(1); }
      await streamChat(config, args[0], text);
    },
  },
  {
    group: "Sessions", match: ["sessions", "tail"], needsArg: true,
    usage: "oma sessions tail <id>", desc: "Tail a session's full event stream (never closes)",
    http: "GET    /v1/sessions/:id/events/stream  (text/event-stream)",
    async run(config, args) {
      await tailSession(config, args[0]);
    },
  },
  {
    group: "Sessions", match: ["sessions", "logs"], needsArg: true,
    usage: "oma sessions logs <id>", desc: "Dump the full persisted event log as JSON",
    http: "GET    /v1/sessions/:id/events?limit=1000",
    async run(config, args) {
      const { data } = await apiFetch<{ data: Array<{ seq: number; type: string; data: unknown; ts: number }> }>(
        config,
        `/v1/sessions/${args[0]}/events?limit=1000&order=asc`,
      );
      for (const e of data) console.log(JSON.stringify(e));
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
      const { data } = await apiFetch<{ data: Array<{ id: string; model_id: string; model: string; provider: string; api_key_preview: string; is_default: boolean }> }>(config, "/v1/model_cards");
      if (!data.length) { console.log("No model cards. Create one with: oma models create"); return; }
      table([["MODEL_ID", "PROVIDER", "WIRE MODEL", "KEY", "DEFAULT"], ...data.map(c => [c.model_id, c.provider, c.model === c.model_id ? "(same)" : c.model, `****${c.api_key_preview || ""}`, c.is_default ? "yes" : ""])]);
    },
  },
  {
    group: "Model Cards", match: ["models", "create"],
    usage: "oma models create --model-id <id> --api-key <key> [--model <wire>] [--provider <p>]", desc: "Create model card",
    http: "POST   /v1/model_cards {model_id, provider, model?, api_key, base_url?, is_default?}",
    async run(config, args) {
      const modelId = flag(args, "--model-id"); const provider = flag(args, "--provider") || "ant"; const model = flag(args, "--model"); const apiKey = flag(args, "--api-key"); const baseUrl = flag(args, "--base-url");
      if (!modelId || !apiKey) { console.error("Usage: oma models create --model-id <id> --api-key <key> [--model <wire>] [--provider ant|oai|ant-compatible|oai-compatible] [--base-url <url>]"); process.exit(1); }
      const card = await apiFetch<{ id: string; model_id: string }>(config, "/v1/model_cards", { method: "POST", body: JSON.stringify({ model_id: modelId, provider, model, api_key: apiKey, base_url: baseUrl }) });
      console.log(`Model card created: ${card.model_id} (${card.id})`);
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
  {
    group: "Linear", match: ["linear", "install-pat"], needsArg: false,
    usage: "oma linear install-pat --pat <token> --agent <id> --env <id> [--persona <name>]",
    desc: "Install Linear via Personal API Key (Symphony-equivalent — no OAuth dance)",
    http: "POST   /v1/integrations/linear/personal-token {agentId, environmentId, personaName, patToken}",
    async run(config, args) {
      const pat = flag(args, "--pat") ?? process.env.LINEAR_API_KEY ?? "";
      const agentId = flag(args, "--agent") ?? "";
      const envId = flag(args, "--env") ?? "";
      const persona = flag(args, "--persona") || "Linear bot (PAT)";
      if (!pat || !agentId || !envId) {
        console.error("Usage: oma linear install-pat --pat <token> --agent <id> --env <id> [--persona <name>]");
        console.error("  --pat may also be supplied via LINEAR_API_KEY env var.");
        process.exit(1);
      }
      const result = await apiFetch<{ publicationId: string }>(
        config,
        "/v1/integrations/linear/personal-token",
        {
          method: "POST",
          body: JSON.stringify({
            agentId,
            environmentId: envId,
            personaName: persona,
            personaAvatarUrl: null,
            patToken: pat,
          }),
        },
      );
      if (config.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Installed via PAT. Publication: ${result.publicationId}`);
      console.log(`Next: configure autopilot rules with`);
      console.log(`  oma linear rules create ${result.publicationId} --label bot-ready`);
    },
  },
  {
    group: "Linear", match: ["linear", "rules", "list"], needsArg: true,
    usage: "oma linear rules list <publication-id>", desc: "List dispatch rules for a publication",
    http: "GET    /v1/integrations/linear/publications/:id/dispatch-rules",
    async run(config, args) {
      const { rules } = await apiFetch<{ rules: Array<any> }>(
        config,
        `/v1/integrations/linear/publications/${args[0]}/dispatch-rules`,
      );
      if (config.json) { console.log(JSON.stringify(rules, null, 2)); return; }
      if (!rules.length) { console.log("No rules. Create with: oma linear rules create <pub-id> --label <name>"); return; }
      table([
        ["RULE ID", "NAME", "EN", "LABEL", "STATES", "MAX", "POLL", "LAST"],
        ...rules.map((r: any) => [
          r.id, r.name, r.enabled ? "y" : "n",
          r.filter_label ?? "-",
          (r.filter_states ?? []).join(",") || "-",
          String(r.max_concurrent),
          `${r.poll_interval_seconds}s`,
          r.last_polled_at ? new Date(r.last_polled_at).toLocaleTimeString() : "never",
        ]),
      ]);
    },
  },
  {
    group: "Linear", match: ["linear", "rules", "create"], needsArg: true,
    usage: "oma linear rules create <publication-id> [--name <s>] [--label <s>] [--states <Todo,...>] [--project <id>] [--max <n>] [--poll <s>]",
    desc: "Create a dispatch rule. At least one of --label, --states, --project required.",
    http: "POST   /v1/integrations/linear/publications/:id/dispatch-rules",
    async run(config, args) {
      const pubId = args[0];
      const name = flag(args, "--name") || "Auto-pickup";
      const label = flag(args, "--label") || null;
      const statesRaw = flag(args, "--states") || "";
      const states = statesRaw ? statesRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
      const project = flag(args, "--project") || null;
      const maxC = parseInt(flag(args, "--max") || "5", 10);
      const poll = parseInt(flag(args, "--poll") || "600", 10);
      if (!label && !states && !project) {
        console.error("At least one of --label, --states, --project is required (matching everything is a footgun).");
        process.exit(1);
      }
      const r = await apiFetch<any>(
        config,
        `/v1/integrations/linear/publications/${pubId}/dispatch-rules`,
        {
          method: "POST",
          body: JSON.stringify({
            name, filter_label: label, filter_states: states,
            filter_project_id: project, max_concurrent: maxC, poll_interval_seconds: poll,
          }),
        },
      );
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`Created rule ${r.id} (${r.name}). Cron picks up issues matching this rule next tick (~1 min).`);
    },
  },
  {
    group: "Linear", match: ["linear", "rules", "patch"], needsArg: true,
    usage: "oma linear rules patch <publication-id> <rule-id> [--enabled true|false] [--label <s>] [--states <Todo,...>] [--max <n>] [--poll <s>]",
    desc: "Update a dispatch rule. Pass only fields to change.",
    http: "PATCH  /v1/integrations/linear/publications/:id/dispatch-rules/:ruleId",
    async run(config, args) {
      const pubId = args[0];
      const ruleId = args[1];
      if (!pubId || !ruleId) { console.error("Usage: oma linear rules patch <publication-id> <rule-id> [...flags]"); process.exit(1); }
      const patch: any = {};
      const name = flag(args, "--name"); if (name !== undefined) patch.name = name;
      const enabled = flag(args, "--enabled"); if (enabled !== undefined) patch.enabled = enabled === "true";
      const label = flag(args, "--label"); if (label !== undefined) patch.filter_label = label || null;
      const statesRaw = flag(args, "--states");
      if (statesRaw !== undefined) patch.filter_states = statesRaw ? statesRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
      const project = flag(args, "--project"); if (project !== undefined) patch.filter_project_id = project || null;
      const maxC = flag(args, "--max"); if (maxC !== undefined) patch.max_concurrent = parseInt(maxC, 10);
      const poll = flag(args, "--poll"); if (poll !== undefined) patch.poll_interval_seconds = parseInt(poll, 10);
      const r = await apiFetch<any>(
        config,
        `/v1/integrations/linear/publications/${pubId}/dispatch-rules/${ruleId}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      if (config.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`Updated rule ${r.id}.`);
    },
  },
  {
    group: "Linear", match: ["linear", "rules", "delete"], needsArg: true,
    usage: "oma linear rules delete <publication-id> <rule-id>",
    desc: "Delete a dispatch rule",
    http: "DELETE /v1/integrations/linear/publications/:id/dispatch-rules/:ruleId",
    async run(config, args) {
      const pubId = args[0];
      const ruleId = args[1];
      if (!pubId || !ruleId) { console.error("Usage: oma linear rules delete <publication-id> <rule-id>"); process.exit(1); }
      await apiFetch(
        config,
        `/v1/integrations/linear/publications/${pubId}/dispatch-rules/${ruleId}`,
        { method: "DELETE" },
      );
      console.log(`Deleted rule ${ruleId}.`);
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

  // Memory stores (Anthropic Managed Agents Memory contract)
  {
    group: "Memory", match: ["memory", "stores", "create"], needsArg: true,
    usage: "oma memory stores create <name> [--description <d>]",
    desc: "Create a memory store",
    http: "POST   /v1/memory_stores {name, description?}",
    async run(config, args) {
      const name = args.find((a) => !a.startsWith("--"));
      const description = flag(args, "--description");
      if (!name) {
        console.error("Usage: oma memory stores create <name> [--description <d>]");
        process.exit(1);
      }
      const store = await apiFetch<{ id: string; name: string; description?: string; created_at: string }>(
        config,
        "/v1/memory_stores",
        { method: "POST", body: JSON.stringify({ name, description }) },
      );
      if (config.json) { console.log(JSON.stringify(store, null, 2)); return; }
      console.log(`Created memory store: ${store.name} (${store.id})`);
    },
  },
  {
    group: "Memory", match: ["memory", "stores", "list"],
    usage: "oma memory stores list [--include-archived]",
    desc: "List memory stores",
    http: "GET    /v1/memory_stores?include_archived=bool",
    async run(config, args) {
      const includeArchived = args.includes("--include-archived");
      const { data } = await apiFetch<{
        data: Array<{ id: string; name: string; description?: string; archived_at?: string; created_at: string }>;
      }>(config, `/v1/memory_stores?include_archived=${includeArchived}`);
      if (!data.length) {
        console.log("No memory stores. Create one with: oma memory stores create <name>");
        return;
      }
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      table([
        ["NAME", "ID", "ARCHIVED", "CREATED"],
        ...data.map((s) => [
          s.name,
          s.id,
          s.archived_at ? "yes" : "",
          new Date(s.created_at).toLocaleDateString(),
        ]),
      ]);
    },
  },
  {
    group: "Memory", match: ["memory", "stores", "get"], needsArg: true,
    usage: "oma memory stores get <store-id>",
    desc: "Get a memory store",
    http: "GET    /v1/memory_stores/:id",
    async run(config, args) {
      const id = args[0];
      const store = await apiFetch<unknown>(config, `/v1/memory_stores/${id}`);
      console.log(JSON.stringify(store, null, 2));
    },
  },
  {
    group: "Memory", match: ["memory", "stores", "archive"], needsArg: true,
    usage: "oma memory stores archive <store-id>",
    desc: "Archive a memory store (one-way; can't be unarchived)",
    http: "POST   /v1/memory_stores/:id/archive",
    async run(config, args) {
      const id = args[0];
      const store = await apiFetch<{ id: string; name: string; archived_at: string }>(
        config, `/v1/memory_stores/${id}/archive`, { method: "POST" });
      if (config.json) { console.log(JSON.stringify(store, null, 2)); return; }
      console.log(`Archived: ${store.name} (${store.id})`);
    },
  },
  {
    group: "Memory", match: ["memory", "stores", "delete"], needsArg: true,
    usage: "oma memory stores delete <store-id>",
    desc: "Delete a memory store + all its memories + versions",
    http: "DELETE /v1/memory_stores/:id",
    async run(config, args) {
      const id = args[0];
      await apiFetch(config, `/v1/memory_stores/${id}`, { method: "DELETE" });
      console.log(`Deleted memory store: ${id}`);
    },
  },

  // Memories within a store
  {
    group: "Memory", match: ["memory", "write"], needsArg: true,
    usage: "oma memory write <store-id> <path> (--content <c> | --from-file <f>) [--precondition-sha256 <h>]",
    desc: "Write a memory at a path (creates or updates; max 100KB)",
    http: "POST   /v1/memory_stores/:id/memories {path, content, precondition?}",
    async run(config, args) {
      const storeId = args[0];
      const path = args[1];
      const content = readContentArg(args);
      const sha = flag(args, "--precondition-sha256");
      if (!storeId || !path || content === undefined) {
        console.error("Usage: oma memory write <store-id> <path> (--content <c> | --from-file <f>) [--precondition-sha256 <h>]");
        process.exit(1);
      }
      const body: { path: string; content: string; precondition?: { type: "content_sha256"; content_sha256: string } } = { path, content };
      if (sha) body.precondition = { type: "content_sha256", content_sha256: sha };
      const mem = await apiFetch<{ id: string; path: string; content_sha256: string; etag: string; size_bytes: number }>(
        config, `/v1/memory_stores/${storeId}/memories`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (config.json) { console.log(JSON.stringify(mem, null, 2)); return; }
      console.log(`Wrote memory: ${mem.path} (id=${mem.id}, sha256=${mem.content_sha256.slice(0, 16)}…, size=${mem.size_bytes}B)`);
    },
  },
  {
    group: "Memory", match: ["memory", "read"], needsArg: true,
    usage: "oma memory read <store-id> <memory-id>",
    desc: "Read a memory's full content by ID",
    http: "GET    /v1/memory_stores/:id/memories/:mid",
    async run(config, args) {
      const storeId = args[0];
      const memId = args[1];
      if (!storeId || !memId) {
        console.error("Usage: oma memory read <store-id> <memory-id>");
        process.exit(1);
      }
      const mem = await apiFetch<{ content: string; path: string; content_sha256: string }>(
        config, `/v1/memory_stores/${storeId}/memories/${memId}`);
      if (config.json) { console.log(JSON.stringify(mem, null, 2)); return; }
      // Prefix with --- so users can pipe through without metadata pollution.
      console.error(`# ${mem.path} (sha256=${mem.content_sha256.slice(0, 16)}…)`);
      process.stdout.write(mem.content);
      if (!mem.content.endsWith("\n")) process.stdout.write("\n");
    },
  },
  {
    group: "Memory", match: ["memory", "ls"], needsArg: true,
    usage: "oma memory ls <store-id> [--prefix <p>] [--depth N]",
    desc: "List memories in a store (metadata; no content)",
    http: "GET    /v1/memory_stores/:id/memories?path_prefix=X&depth=N",
    async run(config, args) {
      const storeId = args[0];
      const prefix = flag(args, "--prefix");
      const depth = flag(args, "--depth");
      const qs = new URLSearchParams();
      if (prefix) qs.set("path_prefix", prefix);
      if (depth) qs.set("depth", depth);
      const url = `/v1/memory_stores/${storeId}/memories${qs.toString() ? `?${qs}` : ""}`;
      const { data } = await apiFetch<{ data: Array<{ id: string; path: string; size_bytes: number; updated_at: string }> }>(config, url);
      if (!data.length) { console.log("(empty)"); return; }
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      table([
        ["PATH", "ID", "SIZE", "UPDATED"],
        ...data.map((m) => [m.path, m.id, `${m.size_bytes}B`, new Date(m.updated_at).toLocaleString()]),
      ]);
    },
  },
  {
    group: "Memory", match: ["memory", "update"], needsArg: true,
    usage: "oma memory update <store-id> <memory-id> [--path <p>] [--content <c> | --from-file <f>] [--precondition-sha256 <h>]",
    desc: "Update a memory (rename and/or change content)",
    http: "POST   /v1/memory_stores/:id/memories/:mid {path?, content?, precondition?}",
    async run(config, args) {
      const storeId = args[0];
      const memId = args[1];
      const path = flag(args, "--path");
      const content = readContentArg(args);
      const sha = flag(args, "--precondition-sha256");
      if (!storeId || !memId) {
        console.error("Usage: oma memory update <store-id> <memory-id> [--path <p>] [--content <c> | --from-file <f>] [--precondition-sha256 <h>]");
        process.exit(1);
      }
      if (path === undefined && content === undefined) {
        console.error("Pass at least --path or --content/--from-file.");
        process.exit(1);
      }
      const body: Record<string, unknown> = {};
      if (path !== undefined) body.path = path;
      if (content !== undefined) body.content = content;
      if (sha) body.precondition = { type: "content_sha256", content_sha256: sha };
      const mem = await apiFetch<{ id: string; path: string; content_sha256: string }>(
        config, `/v1/memory_stores/${storeId}/memories/${memId}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (config.json) { console.log(JSON.stringify(mem, null, 2)); return; }
      console.log(`Updated memory: ${mem.path} (sha256=${mem.content_sha256.slice(0, 16)}…)`);
    },
  },
  {
    group: "Memory", match: ["memory", "rm"], needsArg: true,
    usage: "oma memory rm <store-id> <memory-id> [--expected-sha256 <h>]",
    desc: "Delete a memory by ID",
    http: "DELETE /v1/memory_stores/:id/memories/:mid?expected_content_sha256=...",
    async run(config, args) {
      const storeId = args[0];
      const memId = args[1];
      const sha = flag(args, "--expected-sha256");
      if (!storeId || !memId) {
        console.error("Usage: oma memory rm <store-id> <memory-id> [--expected-sha256 <h>]");
        process.exit(1);
      }
      const url = sha
        ? `/v1/memory_stores/${storeId}/memories/${memId}?expected_content_sha256=${encodeURIComponent(sha)}`
        : `/v1/memory_stores/${storeId}/memories/${memId}`;
      await apiFetch(config, url, { method: "DELETE" });
      console.log(`Deleted memory: ${memId}`);
    },
  },

  // Versions
  {
    group: "Memory", match: ["memory", "versions"], needsArg: true,
    usage: "oma memory versions <store-id> [--memory-id <m>]",
    desc: "List version history for a store (or filtered to one memory)",
    http: "GET    /v1/memory_stores/:id/memory_versions?memory_id=...",
    async run(config, args) {
      const storeId = args[0];
      const memId = flag(args, "--memory-id");
      const url = memId
        ? `/v1/memory_stores/${storeId}/memory_versions?memory_id=${encodeURIComponent(memId)}`
        : `/v1/memory_stores/${storeId}/memory_versions`;
      const { data } = await apiFetch<{
        data: Array<{
          id: string;
          memory_id: string;
          operation: string;
          path?: string;
          actor: { type: string; id: string };
          created_at: string;
          redacted?: boolean;
        }>;
      }>(config, url);
      if (!data.length) { console.log("(no versions)"); return; }
      if (config.json) { console.log(JSON.stringify(data, null, 2)); return; }
      table([
        ["VERSION", "MEMORY", "OP", "ACTOR", "PATH", "WHEN"],
        ...data.map((v) => [
          v.id,
          v.memory_id,
          v.operation + (v.redacted ? " (redacted)" : ""),
          `${v.actor.type}:${v.actor.id}`,
          v.path ?? "",
          new Date(v.created_at).toLocaleString(),
        ]),
      ]);
    },
  },
  {
    group: "Memory", match: ["memory", "version"], needsArg: true,
    usage: "oma memory version <store-id> <version-id>",
    desc: "Get a memory version (includes content snapshot for rollback)",
    http: "GET    /v1/memory_stores/:id/memory_versions/:ver_id",
    async run(config, args) {
      const storeId = args[0];
      const verId = args[1];
      if (!storeId || !verId) {
        console.error("Usage: oma memory version <store-id> <version-id>");
        process.exit(1);
      }
      const v = await apiFetch<unknown>(config, `/v1/memory_stores/${storeId}/memory_versions/${verId}`);
      console.log(JSON.stringify(v, null, 2));
    },
  },
  {
    group: "Memory", match: ["memory", "redact"], needsArg: true,
    usage: "oma memory redact <store-id> <version-id>",
    desc: "Redact content of a prior version (refuses live head)",
    http: "POST   /v1/memory_stores/:id/memory_versions/:ver_id/redact",
    async run(config, args) {
      const storeId = args[0];
      const verId = args[1];
      if (!storeId || !verId) {
        console.error("Usage: oma memory redact <store-id> <version-id>");
        process.exit(1);
      }
      const v = await apiFetch<{ id: string; redacted: boolean }>(
        config, `/v1/memory_stores/${storeId}/memory_versions/${verId}/redact`,
        { method: "POST" });
      if (config.json) { console.log(JSON.stringify(v, null, 2)); return; }
      console.log(`Redacted version: ${v.id}`);
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
  { group: "Sessions", http: "GET    /v1/sessions/:id/events/stream          Tail events (SSE; never closes)" },
  { group: "Sessions", http: "POST   /v1/sessions/:id/messages               Chat one-shot: post turn + stream reply (SSE; closes on idle)" },
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
  Bridge (local runtime):
    oma bridge setup [--force] [--no-service]    Pair this machine with OMA + start daemon
    oma bridge status                            Show creds + probe server reachability
    oma bridge agents refresh                    Re-detect agents + offer wrapper installs
    oma bridge uninstall                         Stop service + remove creds
    (oma bridge daemon                           Internal: launched by service mgr / debugging)

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

  // Global --profile <name> flag: must be parsed BEFORE bridge dispatch
  // and BEFORE any code that reads paths()/credentialsPath(), since both
  // resolve OMA_PROFILE at call time. Re-export into env so deeper
  // imports (bridge platform.ts, etc.) see it without arg threading. Same
  // semantics as `OMA_PROFILE=staging oma <cmd>` — the flag is just
  // shorthand. Slug validation happens in currentProfile() at first use.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && i + 1 < args.length) {
      process.env.OMA_PROFILE = args[i + 1];
      args.splice(i, 2);
      // Mirror into process.argv so commands that re-parse argv (bridge
      // subcommands strip args[2..3] below) don't trip over the flag.
      const argvIdx = process.argv.indexOf("--profile");
      if (argvIdx !== -1) process.argv.splice(argvIdx, 2);
      break;
    }
    const eq = args[i].match(/^--profile=(.+)$/);
    if (eq) {
      process.env.OMA_PROFILE = eq[1];
      args.splice(i, 1);
      const argvIdx = process.argv.findIndex((a) => a.startsWith("--profile="));
      if (argvIdx !== -1) process.argv.splice(argvIdx, 1);
      break;
    }
  }

  // Validate the profile slug NOW so a typoed --profile or env var fails
  // with the slug-format error message instead of cascading into a path
  // not-found at first cred lookup. currentProfile() throws on invalid.
  try { currentProfile(); }
  catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(2); }

  // Bridge subcommands (oma bridge {setup,daemon,status,uninstall}) are
  // self-contained — they don't need the api-key config and have their own
  // argv parsing. Dispatch early to keep the main commands array unaware.
  if (args[0] === "bridge") {
    const sub = args[1] ?? "";
    process.argv.splice(2, 2); // strip "bridge" + subname so commands' parseArgs sees flags only
    switch (sub) {
      case "setup": {
        // Default browser-origin to wherever serverUrl points so a single
        // --server-url flips both the API endpoint AND the OAuth redirect.
        // Otherwise --server-url=https://app.staging.openma.dev would open
        // the OAuth dance against prod openma.dev and the resulting code
        // would fail at exchange ("invalid code"). Two separate flags are
        // still useful for split dev setups (web on one host, api on
        // another) — keep --browser-origin as an explicit override.
        const serverUrl = flag(args, "--server-url") ?? "https://openma.dev";
        const { runSetup } = await import("./bridge/commands/setup.js");
        await runSetup({
          serverUrl,
          browserOrigin: flag(args, "--browser-origin") ?? serverUrl,
          noService: args.includes("--no-service"),
          force: args.includes("--force"),
          yes: args.includes("--yes") || args.includes("-y"),
        });
        return;
      }
      case "daemon": {
        const { runDaemon } = await import("./bridge/commands/daemon.js");
        await runDaemon();
        return;
      }
      case "status": {
        const { runStatus } = await import("./bridge/commands/status.js");
        await runStatus();
        return;
      }
      case "uninstall": {
        const { runUninstall } = await import("./bridge/commands/uninstall.js");
        await runUninstall();
        return;
      }
      case "agents": {
        const { runAgents } = await import("./bridge/commands/agents.js");
        await runAgents(args.slice(2));
        return;
      }
      default:
        console.error(
          "oma bridge — pair a local ACP agent with OMA\n\n" +
          "  oma bridge setup [--server-url=…] [--no-service] [--force] [--yes]\n" +
          "                                       Pair + install service + start daemon\n" +
          "  oma bridge status                    Creds + service kind + probe server\n" +
          "  oma bridge agents refresh [--yes]    Re-scan + offer-install wrappers + reload\n" +
          "  oma bridge uninstall                 Stop service + remove creds\n" +
          "  oma bridge daemon                    (internal — launched by service mgr / for debug)\n" +
          "\n" +
          "  Use --profile <name> (or OMA_PROFILE=<name>) to run multiple\n" +
          "  daemons side-by-side (e.g. prod in launchd + staging foreground).\n",
        );
        process.exit(sub ? 1 : 0);
    }
  }

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
    const verbMatch = c.match.every((tok, i) => args[i] === tok);
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
