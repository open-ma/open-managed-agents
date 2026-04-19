/**
 * Spawn stdio-mode MCP servers inside the sandbox container.
 *
 * Why this exists: OMA's MCP adapter is HTTP/SSE only (Cloudflare Workers
 * can't spawn child processes). Many third-party MCP servers ship as stdio
 * packages. The sandbox container CAN spawn processes — so we run the MCP
 * server's built-in SSE transport there, and the existing curl-based MCP
 * tool wiring talks to localhost.
 */
import type { SandboxExecutor } from "../harness/interface";

export interface StdioMcpConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  port: number;
  sse_path?: string;
  ready_timeout_ms?: number;
}

export interface SpawnedMcp {
  name: string;
  /** http://localhost:{port}{sse_path} — feed this into mcp_server.url */
  url: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function waitForPort(
  sandbox: SandboxExecutor,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Read /proc/net/tcp directly — works even when ss/netstat aren't installed
  // and bash /dev/tcp redirection isn't enabled. /proc/net/tcp lists listening
  // sockets in hex; we look for "<port_hex>" with state 0A (LISTEN) bound to
  // 127.0.0.1 (loopback hex 0100007F).
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  while (Date.now() < deadline) {
    const out = await sandbox
      .exec(
        `awk '$2 ~ /:${portHex}$/ && $4 == "0A" {print "FOUND"; exit}' /proc/net/tcp 2>/dev/null || true`,
        5000,
      )
      .catch(() => "");
    if (out.includes("FOUND")) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Spawn each stdio MCP server in the background. Returns the localhost URL
 * each one binds to. Throws if any server fails to bind within its timeout.
 */
export async function spawnStdioMcpServers(
  sandbox: SandboxExecutor,
  servers: StdioMcpConfig[],
): Promise<SpawnedMcp[]> {
  const spawned: SpawnedMcp[] = [];
  for (const cfg of servers) {
    const ssePath = cfg.sse_path || "/sse";
    const url = `http://127.0.0.1:${cfg.port}${ssePath}`;

    // Build env-prefixed background launcher with logging for diagnosis.
    const envPrefix = cfg.env
      ? Object.entries(cfg.env)
          .map(([k, v]) => `${k}=${shellQuote(v)}`)
          .join(" ") + " "
      : "";
    const argsStr = (cfg.args || []).map(shellQuote).join(" ");
    const logPath = `/tmp/mcp-${cfg.name}.log`;
    const pidPath = `/tmp/mcp-${cfg.name}.pid`;

    // nohup so the process survives the bash exec; setsid for clean process group.
    // Redirect both fds, write pid file for later cleanup.
    const spawnCmd =
      `${envPrefix}nohup setsid ${shellQuote(cfg.command)} ${argsStr} ` +
      `> ${logPath} 2>&1 < /dev/null & ` +
      `echo $! > ${pidPath}`;

    await sandbox.exec(spawnCmd, 10_000);

    const ready = await waitForPort(sandbox, cfg.port, cfg.ready_timeout_ms ?? 60_000);
    if (!ready) {
      const log = await sandbox
        .exec(`tail -50 ${logPath} 2>/dev/null || true`, 5000)
        .catch(() => "");
      throw new Error(
        `MCP server "${cfg.name}" did not bind on port ${cfg.port} within ${cfg.ready_timeout_ms ?? 60_000}ms.\n` +
          `Logs (${logPath}):\n${log}`,
      );
    }

    spawned.push({ name: cfg.name, url });
  }
  return spawned;
}
