import { createServer } from "node:http";
import { execSync } from "node:child_process";

// ─── Config ───

interface Config {
  baseUrl: string;
  apiKey: string;
}

function loadConfig(): Config {
  const baseUrl = process.env.OMA_BASE_URL || "http://localhost:8787";
  const apiKey = process.env.OMA_API_KEY || "";
  if (!apiKey) {
    console.error("Error: OMA_API_KEY environment variable is required");
    console.error("  export OMA_API_KEY=your-api-key");
    console.error("\n  Generate one at: " + baseUrl + " → API Keys");
    process.exit(1);
  }
  return { baseUrl, apiKey };
}

// ─── API Client ───

async function api<T = unknown>(config: Config, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-api-key": config.apiKey,
      "content-type": "application/json",
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

// ─── Commands: Agents ───

async function agentsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; model: any; created_at: string }> }>(config, "/v1/agents?limit=100");
  if (!data.length) { console.log("No agents. Create one with: oma agents create"); return; }
  table([
    ["NAME", "ID", "MODEL", "CREATED"],
    ...data.map(a => [a.name, a.id, typeof a.model === "string" ? a.model : a.model?.id || "", new Date(a.created_at).toLocaleDateString()]),
  ]);
}

async function agentsCreate(config: Config, args: string[]) {
  const name = flag(args, "--name") || args.find(a => !a.startsWith("--"));
  const model = flag(args, "--model") || "claude-sonnet-4-6";
  const system = flag(args, "--system") || "";
  if (!name) { console.error("Usage: oma agents create <name> [--model <id>] [--system <prompt>]"); process.exit(1); }
  const agent = await api<{ id: string; name: string }>(config, "/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name, model, system, tools: [{ type: "agent_toolset_20260401" }] }),
  });
  console.log(`Agent created: ${agent.name} (${agent.id})`);
}

async function agentsGet(config: Config, id: string) {
  const a = await api<any>(config, `/v1/agents/${id}`);
  console.log(`Name:    ${a.name}`);
  console.log(`ID:      ${a.id}`);
  console.log(`Model:   ${typeof a.model === "string" ? a.model : a.model?.id}`);
  console.log(`Version: v${a.version}`);
  if (a.description) console.log(`Desc:    ${a.description}`);
  if (a.system) console.log(`System:  ${a.system.slice(0, 100)}${a.system.length > 100 ? "..." : ""}`);
}

async function agentsDelete(config: Config, id: string) {
  await api(config, `/v1/agents/${id}`, { method: "DELETE" });
  console.log(`Agent deleted: ${id}`);
}

// ─── Commands: Sessions ───

async function sessionsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; title: string; agent_id: string; status: string; created_at: string }> }>(config, "/v1/sessions?limit=20");
  if (!data.length) { console.log("No sessions."); return; }
  table([
    ["TITLE", "ID", "STATUS", "AGENT", "CREATED"],
    ...data.map(s => [s.title || "Untitled", s.id, s.status || "idle", s.agent_id, new Date(s.created_at).toLocaleDateString()]),
  ]);
}

async function sessionsCreate(config: Config, args: string[]) {
  const agentId = flag(args, "--agent");
  const envId = flag(args, "--env");
  const title = flag(args, "--title") || "";
  if (!agentId || !envId) { console.error("Usage: oma sessions create --agent <id> --env <id> [--title <text>]"); process.exit(1); }
  const session = await api<{ id: string }>(config, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ agent: agentId, environment_id: envId, title }),
  });
  console.log(`Session created: ${session.id}`);
}

async function sessionsMessage(config: Config, sessionId: string, text: string) {
  await api(config, `/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
  });
  console.log("Message sent.");
}

// ─── Commands: Environments ───

async function envsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; status: string }> }>(config, "/v1/environments");
  if (!data.length) { console.log("No environments. Create one with: oma envs create <name>"); return; }
  table([
    ["NAME", "ID", "STATUS"],
    ...data.map(e => [e.name, e.id, e.status || "ready"]),
  ]);
}

async function envsCreate(config: Config, name: string) {
  const env = await api<{ id: string; name: string }>(config, "/v1/environments", {
    method: "POST",
    body: JSON.stringify({ name, config: { type: "cloud" } }),
  });
  console.log(`Environment created: ${env.name} (${env.id})`);
}

// ─── Commands: Model Cards ───

async function modelCardsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; provider: string; model_id: string; api_key_preview: string; is_default: boolean }> }>(config, "/v1/model_cards");
  if (!data.length) { console.log("No model cards. Create one with: oma models create"); return; }
  table([
    ["NAME", "PROVIDER", "MODEL", "KEY", "DEFAULT"],
    ...data.map(c => [c.name, c.provider, c.model_id, `****${c.api_key_preview || ""}`, c.is_default ? "yes" : ""]),
  ]);
}

async function modelCardsCreate(config: Config, args: string[]) {
  const name = flag(args, "--name");
  const provider = flag(args, "--provider") || "ant";
  const modelId = flag(args, "--model-id");
  const apiKey = flag(args, "--api-key");
  const baseUrl = flag(args, "--base-url");
  if (!name || !modelId || !apiKey) {
    console.error("Usage: oma models create --name <name> --model-id <id> --api-key <key> [--provider ant|oai|ant-compatible|oai-compatible] [--base-url <url>]");
    process.exit(1);
  }
  const card = await api<{ id: string; name: string }>(config, "/v1/model_cards", {
    method: "POST",
    body: JSON.stringify({ name, provider, model_id: modelId, api_key: apiKey, base_url: baseUrl }),
  });
  console.log(`Model card created: ${card.name} (${card.id})`);
}

// ─── Commands: API Keys ───

async function apiKeysList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; prefix: string; created_at: string }> }>(config, "/v1/api_keys");
  if (!data.length) { console.log("No API keys. Create one with: oma keys create"); return; }
  table([
    ["NAME", "ID", "PREFIX", "CREATED"],
    ...data.map(k => [k.name, k.id, k.prefix + "...", new Date(k.created_at).toLocaleDateString()]),
  ]);
}

async function apiKeysCreate(config: Config, name: string) {
  const key = await api<{ id: string; key: string; name: string }>(config, "/v1/api_keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(`API key created: ${key.name}`);
  console.log(`\n  ${key.key}\n`);
  console.log("Save this key — it won't be shown again.");
}

async function apiKeysRevoke(config: Config, id: string) {
  await api(config, `/v1/api_keys/${id}`, { method: "DELETE" });
  console.log(`API key revoked: ${id}`);
}

// ─── Commands: Vaults ───

async function vaultsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; created_at: string }> }>(config, "/v1/vaults");
  if (!data.length) { console.log("No vaults. Create one with: oma vaults create <name>"); return; }
  table([
    ["NAME", "ID", "CREATED"],
    ...data.map(v => [v.name, v.id, new Date(v.created_at).toLocaleDateString()]),
  ]);
}

async function vaultsCreate(config: Config, name: string) {
  const vault = await api<{ id: string; name: string }>(config, "/v1/vaults", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(`Vault created: ${vault.name} (${vault.id})`);
}

async function credsList(config: Config, vaultId: string) {
  const { data } = await api<{ data: Array<{
    id: string; display_name: string;
    auth: { type: string; mcp_server_url?: string; command_prefixes?: string[]; env_var?: string };
  }> }>(config, `/v1/vaults/${vaultId}/credentials`);
  if (!data.length) { console.log("No credentials in this vault."); return; }
  table([
    ["NAME", "TYPE", "DETAIL"],
    ...data.map(c => [c.display_name, c.auth.type, c.auth.mcp_server_url || c.auth.command_prefixes?.join(", ") || ""]),
  ]);
}

async function secretAdd(config: Config, args: string[]) {
  const vaultId = flag(args, "--vault");
  const name = flag(args, "--name");
  const cmd = flag(args, "--cmd");
  const envVar = flag(args, "--env");
  const token = flag(args, "--token");
  if (!vaultId || !name || !cmd || !envVar || !token) {
    console.error("Usage: oma secret add --vault <id> --name <name> --cmd <prefixes> --env <var> --token <token>");
    process.exit(1);
  }
  const cred = await api<{ id: string }>(config, `/v1/vaults/${vaultId}/credentials`, {
    method: "POST",
    body: JSON.stringify({
      display_name: name,
      auth: { type: "command_secret", command_prefixes: cmd.split(",").map(s => s.trim()), env_var: envVar, token },
    }),
  });
  console.log(`Secret added: ${name} (${cred.id})`);
}

// ─── Commands: Skills ───

async function skillsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; display_title: string; name: string; source: string }> }>(config, "/v1/skills");
  if (!data.length) { console.log("No skills."); return; }
  table([
    ["NAME", "ID", "SOURCE"],
    ...data.map(s => [s.display_title || s.name, s.id, s.source]),
  ]);
}

async function skillsInstall(config: Config, slug: string) {
  console.log(`Installing ${slug} from ClawHub...`);
  const skill = await api<{ id: string; display_title: string }>(config, "/v1/clawhub/install", {
    method: "POST",
    body: JSON.stringify({ slug }),
  });
  console.log(`Installed: ${skill.display_title} (${skill.id})`);
}

// ─── Commands: Connect MCP ───

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

async function connect(config: Config, mcpServerUrl: string, vaultId: string) {
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
    const server = createServer((req, res) => {
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

// ─── CLI ───

function usage() {
  console.log(`
oma — Open Managed Agents CLI

Usage:
  Agents:
    oma agents list                           List agents
    oma agents create <name> [--model <id>]   Create agent
    oma agents get <id>                       Get agent details
    oma agents delete <id>                    Delete agent

  Sessions:
    oma sessions list                         List sessions
    oma sessions create --agent <id> --env <id> [--title <t>]
    oma sessions message <id> <text>          Send message to session

  Environments:
    oma envs list                             List environments
    oma envs create <name>                    Create environment

  Model Cards:
    oma models list                           List model cards
    oma models create --name <n> --model-id <id> --api-key <key> [--provider <p>]

  API Keys:
    oma keys list                             List API keys
    oma keys create [name]                    Create API key
    oma keys revoke <id>                      Revoke API key

  Vaults & Credentials:
    oma vaults list                           List vaults
    oma vaults create <name>                  Create vault
    oma creds list <vault-id>                 List credentials
    oma secret add --vault <id> --name <n> --cmd <pfx> --env <var> --token <t>

  Skills:
    oma skills list                           List skills
    oma skills install <slug>                 Install from ClawHub

  MCP Servers:
    oma connect <server|url> --vault <id>     Connect via OAuth

Environment:
  OMA_BASE_URL   API base (default: http://localhost:8787)
  OMA_API_KEY    API key (required)
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ["-h", "--help", "help"].includes(args[0])) { usage(); process.exit(0); }

  const config = loadConfig();
  const [cmd, sub] = args;

  // agents
  if (cmd === "agents" && sub === "list") return agentsList(config);
  if (cmd === "agents" && sub === "create") return agentsCreate(config, args.slice(2));
  if (cmd === "agents" && sub === "get" && args[2]) return agentsGet(config, args[2]);
  if (cmd === "agents" && sub === "delete" && args[2]) return agentsDelete(config, args[2]);

  // sessions
  if (cmd === "sessions" && sub === "list") return sessionsList(config);
  if (cmd === "sessions" && sub === "create") return sessionsCreate(config, args.slice(2));
  if (cmd === "sessions" && sub === "message" && args[2] && args[3]) return sessionsMessage(config, args[2], args.slice(3).join(" "));

  // environments
  if (cmd === "envs" && sub === "list") return envsList(config);
  if (cmd === "envs" && sub === "create" && args[2]) return envsCreate(config, args.slice(2).join(" "));

  // model cards
  if (cmd === "models" && sub === "list") return modelCardsList(config);
  if (cmd === "models" && sub === "create") return modelCardsCreate(config, args.slice(2));

  // api keys
  if (cmd === "keys" && sub === "list") return apiKeysList(config);
  if (cmd === "keys" && sub === "create") return apiKeysCreate(config, args.slice(2).join(" ") || "CLI key");
  if (cmd === "keys" && sub === "revoke" && args[2]) return apiKeysRevoke(config, args[2]);

  // vaults
  if (cmd === "vaults" && sub === "list") return vaultsList(config);
  if (cmd === "vaults" && sub === "create" && args[2]) return vaultsCreate(config, args.slice(2).join(" "));
  if (cmd === "creds" && sub === "list" && args[2]) return credsList(config, args[2]);
  if (cmd === "secret" && sub === "add") return secretAdd(config, args.slice(2));

  // skills
  if (cmd === "skills" && sub === "list") return skillsList(config);
  if (cmd === "skills" && sub === "install" && args[2]) return skillsInstall(config, args[2]);

  // connect
  if (cmd === "connect" && args[1]) {
    const vaultId = flag(args, "--vault");
    if (!vaultId) { console.error("Usage: oma connect <server> --vault <vault-id>"); process.exit(1); }
    return connect(config, resolveServerUrl(args[1]), vaultId);
  }

  console.error(`Unknown command: ${args.join(" ")}`);
  usage();
  process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
