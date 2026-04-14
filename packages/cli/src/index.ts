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

// ─── Commands ───

async function vaultsList(config: Config) {
  const { data } = await api<{ data: Array<{ id: string; name: string; created_at: string }> }>(
    config, "/v1/vaults"
  );
  if (!data.length) {
    console.log("No vaults found. Create one with: oma vaults create <name>");
    return;
  }
  console.log("Vaults:\n");
  for (const v of data) {
    console.log(`  ${v.name}`);
    console.log(`    ID: ${v.id}`);
    console.log(`    Created: ${v.created_at}\n`);
  }
}

async function vaultsCreate(config: Config, name: string) {
  const vault = await api<{ id: string; name: string }>(
    config, "/v1/vaults", {
      method: "POST",
      body: JSON.stringify({ name }),
    }
  );
  console.log(`Vault created: ${vault.name} (${vault.id})`);
}

async function credsList(config: Config, vaultId: string) {
  const { data } = await api<{ data: Array<{
    id: string; display_name: string;
    auth: { type: string; mcp_server_url?: string; command_prefixes?: string[]; env_var?: string };
  }> }>(config, `/v1/vaults/${vaultId}/credentials`);

  if (!data.length) {
    console.log("No credentials in this vault.");
    return;
  }
  console.log("Credentials:\n");
  for (const c of data) {
    const detail = c.auth.mcp_server_url || c.auth.command_prefixes?.join(", ") || "";
    console.log(`  ${c.display_name}  [${c.auth.type}]`);
    console.log(`    ID: ${c.id}`);
    if (detail) console.log(`    ${c.auth.mcp_server_url ? "URL" : "Commands"}: ${detail}`);
    if (c.auth.env_var) console.log(`    Env: ${c.auth.env_var}`);
    console.log();
  }
}

async function secretsAdd(config: Config, opts: {
  vaultId: string;
  name: string;
  commandPrefixes: string[];
  envVar: string;
  token: string;
}) {
  const cred = await api<{ id: string; display_name: string }>(
    config, `/v1/vaults/${opts.vaultId}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        display_name: opts.name,
        auth: {
          type: "command_secret",
          command_prefixes: opts.commandPrefixes,
          env_var: opts.envVar,
          token: opts.token,
        },
      }),
    }
  );
  console.log(`Secret added: ${cred.display_name} (${cred.id})`);
}

async function connect(config: Config, mcpServerUrl: string, vaultId: string) {
  // Start a temporary local server to receive the OAuth callback
  const port = 19284 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl = `${config.baseUrl}/v1/oauth/authorize?mcp_server_url=${encodeURIComponent(mcpServerUrl)}&vault_id=${encodeURIComponent(vaultId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`Opening browser for authorization...\n`);
  console.log(`  If the browser doesn't open, visit:`);
  console.log(`  ${authUrl}\n`);

  // Open browser
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open "${authUrl}"`);
    else if (platform === "linux") execSync(`xdg-open "${authUrl}"`);
    else if (platform === "win32") execSync(`start "${authUrl}"`);
  } catch {
    // Browser open failed, user can manually visit the URL
  }

  // Wait for callback
  return new Promise<void>((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      if (url.pathname === "/callback") {
        const oauthStatus = url.searchParams.get("oauth");
        const service = url.searchParams.get("service");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Connected${service ? ` to ${service}` : ""}!</h2><p>You can close this tab.</p><script>window.close()</script></body></html>`);

        if (oauthStatus === "success") {
          console.log(`Connected to ${service || mcpServerUrl}`);
        } else {
          console.log("Authorization completed.");
        }

        server.close();
        resolve();
      }
    });

    server.listen(port, () => {
      // Waiting for callback...
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      console.log("Timed out waiting for authorization.");
      server.close();
      resolve();
    }, 300000);
  });
}

// ─── MCP Registry (for name → URL lookup) ───

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
  if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
    return nameOrUrl;
  }
  const url = KNOWN_SERVERS[nameOrUrl.toLowerCase()];
  if (!url) {
    console.error(`Unknown MCP server: ${nameOrUrl}`);
    console.error(`Known servers: ${Object.keys(KNOWN_SERVERS).join(", ")}`);
    console.error(`Or pass a full URL: https://mcp.example.com/mcp`);
    process.exit(1);
  }
  return url;
}

// ─── CLI Parser ───

function usage() {
  console.log(`
oma — Open Managed Agents CLI

Usage:
  oma vaults list                      List vaults
  oma vaults create <name>             Create a vault
  oma creds list <vault-id>            List credentials in a vault
  oma connect <server> --vault <id>    Connect MCP server via OAuth
  oma secret add --vault <id> \\
    --name <name> \\
    --cmd <prefixes> \\
    --env <var> \\
    --token <token>                    Add a CLI secret to a vault

Environment:
  OMA_BASE_URL   API base URL (default: http://localhost:8787)
  OMA_API_KEY    API key (required)

MCP Servers:
  ${Object.entries(KNOWN_SERVERS).map(([k, v]) => `${k.padEnd(12)} ${v}`).join("\n  ")}
  Or pass any URL: oma connect https://mcp.example.com/mcp --vault <id>
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    usage();
    process.exit(0);
  }

  const config = loadConfig();
  const cmd = args[0];
  const sub = args[1];

  if (cmd === "vaults" && sub === "list") {
    await vaultsList(config);
  } else if (cmd === "vaults" && sub === "create" && args[2]) {
    await vaultsCreate(config, args.slice(2).join(" "));
  } else if (cmd === "creds" && sub === "list" && args[2]) {
    await credsList(config, args[2]);
  } else if (cmd === "connect" && args[1]) {
    const vaultIdx = args.indexOf("--vault");
    if (vaultIdx === -1 || !args[vaultIdx + 1]) {
      console.error("Usage: oma connect <server> --vault <vault-id>");
      process.exit(1);
    }
    const mcpUrl = resolveServerUrl(args[1]);
    await connect(config, mcpUrl, args[vaultIdx + 1]);
  } else if (cmd === "secret" && sub === "add") {
    const flag = (name: string) => {
      const idx = args.indexOf(name);
      return idx !== -1 ? args[idx + 1] : undefined;
    };
    const vaultId = flag("--vault");
    const name = flag("--name");
    const cmdPrefixes = flag("--cmd");
    const envVar = flag("--env");
    const token = flag("--token");
    if (!vaultId || !name || !cmdPrefixes || !envVar || !token) {
      console.error("Usage: oma secret add --vault <id> --name <name> --cmd <prefixes> --env <var> --token <token>");
      process.exit(1);
    }
    await secretsAdd(config, {
      vaultId,
      name,
      commandPrefixes: cmdPrefixes.split(",").map(s => s.trim()),
      envVar,
      token,
    });
  } else {
    console.error(`Unknown command: ${args.join(" ")}`);
    usage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
