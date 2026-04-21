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

async function apiFetch<T = unknown>(config: Config, path: string, init?: RequestInit): Promise<T> {
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
      if (!data.length) { console.log("No publications. Publish with: oma linear publish <agent-id> --env <env-id>"); return; }
      table([["PERSONA", "PUBLICATION ID", "AGENT", "STATUS", "CAPS"], ...data.map(p => [p.persona.name, p.id, p.agent_id, p.status, String(p.capabilities.length)])]);
    },
  },
  {
    group: "Linear", match: ["linear", "get"], needsArg: true,
    usage: "oma linear get <publication-id>", desc: "Show one publication",
    http: "GET    /v1/integrations/linear/publications/:id",
    async run(config, args) {
      const p = await apiFetch<any>(config, `/v1/integrations/linear/publications/${args[0]}`);
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
      const r = await apiFetch<{ formToken: string; suggestedAppName: string; callbackUrl: string; webhookUrl: string; webhookSecret: string }>(
        config,
        "/v1/integrations/linear/start-a1",
        { method: "POST", body: JSON.stringify({ agentId, environmentId: envId, personaName, personaAvatarUrl: avatar, returnUrl: `${config.baseUrl}/integrations/linear` }) },
      );
      console.log(`\nStep 1 complete. Now register a Linear OAuth App (Linear → Settings → API → New OAuth app):\n`);
      console.log(`  App name:        ${r.suggestedAppName}`);
      console.log(`  Callback URL:    ${r.callbackUrl}`);
      console.log(`  Webhook URL:     ${r.webhookUrl}`);
      console.log(`  Webhook secret:  ${r.webhookSecret}`);
      console.log(`\nThen run step 2 with the clientId/clientSecret Linear gives you:\n`);
      console.log(`  oma linear submit ${r.formToken} \\\n    --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>\n`);
      console.log(`Form token expires in ~30 min. To send the registration to a Linear admin instead:`);
      console.log(`  oma linear handoff ${r.formToken}`);
    },
  },
  {
    group: "Linear", match: ["linear", "submit"], needsArg: true,
    usage: "oma linear submit <form-token> --client-id <id> --client-secret <secret>", desc: "Step 2: validate creds → returns OAuth install URL",
    http: "POST   /v1/integrations/linear/credentials {formToken, clientId, clientSecret}",
    async run(config, args) {
      const formToken = args[0];
      const clientId = flag(args, "--client-id");
      const clientSecret = flag(args, "--client-secret");
      if (!clientId || !clientSecret) { console.error("Usage: oma linear submit <form-token> --client-id <id> --client-secret <secret>"); process.exit(1); }
      const r = await apiFetch<{ url: string; appId: string; callbackUrl: string; webhookUrl: string }>(
        config,
        "/v1/integrations/linear/credentials",
        { method: "POST", body: JSON.stringify({ formToken, clientId, clientSecret }) },
      );
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
      );
      console.log(`\nSend this URL to your Linear workspace admin:\n  ${r.url}\nExpires in ${r.expiresInDays} days.`);
    },
  },
  {
    group: "Linear", match: ["linear", "unpublish"], needsArg: true,
    usage: "oma linear unpublish <publication-id>", desc: "Mark a publication unpublished",
    http: "DELETE /v1/integrations/linear/publications/:id",
    async run(config, args) {
      await apiFetch(config, `/v1/integrations/linear/publications/${args[0]}`, { method: "DELETE" });
      console.log(`Unpublished: ${args[0]}`);
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
    "mcp": "MCP Servers", linear: "Linear", integrations: "Linear",
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
  OMA_BASE_URL   API base (default: http://localhost:8787)
  OMA_API_KEY    API key (required)
`);
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ["-h", "--help", "help"].includes(args[0])) { usage(); process.exit(0); }
  if (args[0] === "api") { apiRef(args[1]); return; }

  const config = loadConfig();

  for (const c of commands) {
    const match = c.match.length === 1
      ? args[0] === c.match[0]
      : args[0] === c.match[0] && args[1] === c.match[1];
    if (!match) continue;
    if (c.needsArg && !args[c.match.length]) continue;
    const rest = args.slice(c.match.length);
    return c.run(config, rest);
  }

  console.error(`Unknown command: ${args.join(" ")}`);
  usage();
  process.exit(1);
}

main().catch((err: any) => { console.error(err.message); process.exit(1); });
