/**
 * MCPTransport implementation for the AI SDK MCP client that routes all
 * traffic through the main worker via a CF service binding RPC instead of
 * directly fetching the upstream MCP server. This is the cloud-agent
 * counterpart to the local-runtime path's `/v1/mcp-proxy/<sid>/<server>`
 * URL: same forwarding logic, same vault-injection step, but invoked by
 * RPC because the cloud agent has no apiKey to authenticate the HTTP
 * endpoint with — and we don't want to invent one just for this.
 *
 * The architectural property this preserves: the agent's DO (the harness)
 * never holds plaintext vault credentials. It knows only `(tenantId,
 * sessionId, serverName)` and asks main to do the call. Main owns the
 * vault, looks up the credential live on each call (no DO-side snapshot),
 * injects the bearer token, and forwards. A prompt-injection attack that
 * compromises generation in the agent's loop cannot exfiltrate any
 * credential — there is none to exfiltrate.
 *
 * Why a custom transport instead of using AI SDK's built-in
 * `transport: { type: 'http', url, headers }`? Because that built-in uses
 * `fetch()` against the URL, and there's no way to make the AI SDK fetch
 * go through `env.MAIN_MCP.mcpForward(...)` (a service binding RPC) instead
 * of the public HTTPS path. Implementing the small `MCPTransport` interface
 * (start/send/close + onmessage callback) gives us the routing control we
 * need without giving up any of the AI SDK MCP client's higher-level API.
 *
 * Wire format: MCP-over-HTTP exchanges JSON-RPC messages. The server can
 * respond with either application/json (single response) or
 * text/event-stream (one or more SSE events, each carrying a JSON-RPC
 * message). We parse both and dispatch each parsed message via
 * `onmessage`. Linear MCP returns SSE; most others return plain JSON.
 */

import type { Service } from "@cloudflare/workers-types";
// `Service` is intentionally unused — referenced via interface comment
// only. Keep the import so future extension to the real Service shape is
// type-safe without breaking the build now.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Service = Service;

/** Subset of @ai-sdk/mcp's JSONRPCMessage shape we touch. The full type
 *  is a complex Zod-derived union; we only ever serialize/deserialize, so
 *  carrying the structural minimum keeps us decoupled from SDK upgrades. */
export interface JSONRPCMessageLike {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpForwardResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Service-binding RPC stub shape — the call signature matches
 *  `McpProxyRpc.mcpForward` in apps/main/src/index.ts. We don't extend the
 *  full `Service` interface (which requires fetch/connect) because we only
 *  ever invoke the RPC method; CF service bindings to a `WorkerEntrypoint`
 *  expose the class methods directly without forcing us to declare the
 *  ambient ones. */
interface MainMcpBinding {
  mcpForward(opts: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  }): Promise<McpForwardResult>;
}

export interface BindingMCPTransportOptions {
  binding: MainMcpBinding;
  tenantId: string;
  sessionId: string;
  serverName: string;
}

export class BindingMCPTransport {
  #opts: BindingMCPTransportOptions;
  #closed = false;

  onmessage?: (message: JSONRPCMessageLike) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(opts: BindingMCPTransportOptions) {
    this.#opts = opts;
  }

  async start(): Promise<void> {
    // Stateless transport — no persistent connection to open. Each send()
    // is an isolated RPC; the upstream's session continuity (if any) is
    // handled per-request by the MCP server itself via Mcp-Session-Id
    // headers, which we forward verbatim through the binding.
  }

  async send(message: JSONRPCMessageLike): Promise<void> {
    if (this.#closed) return;

    let result: McpForwardResult;
    try {
      result = await this.#opts.binding.mcpForward({
        tenantId: this.#opts.tenantId,
        sessionId: this.#opts.sessionId,
        serverName: this.#opts.serverName,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
      });
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (result.status >= 400) {
      this.onerror?.(
        new Error(
          `MCP forward failed: HTTP ${result.status} ${result.body.slice(0, 200)}`,
        ),
      );
      return;
    }

    // Notifications (no `id`) get an empty 202 / no body — nothing to
    // dispatch. Only requests/responses produce body content.
    if (!result.body || result.body.length === 0) return;

    const contentType = (result.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      this.#parseSseAndDispatch(result.body);
    } else {
      this.#parseJsonAndDispatch(result.body);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }

  /** Parse SSE-formatted body (Linear MCP, FastMCP, anything spec-compliant
   *  with streamable-HTTP transport). Each event block looks like:
   *    event: message
   *    data: {"jsonrpc":"2.0","id":1,"result":...}
   *    \n\n
   *  We only care about `data:` lines for `event: message` (the only event
   *  type MCP currently uses on the response stream). Multi-line `data:`
   *  blocks are concatenated per spec. */
  #parseSseAndDispatch(body: string): void {
    const blocks = body.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const lines = trimmed.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) continue;
      const json = dataLines.join("\n");
      this.#dispatchOne(json);
    }
  }

  /** Parse plain JSON body. Could be a single message or (per JSON-RPC 2.0
   *  batch spec) an array of messages. */
  #parseJsonAndDispatch(body: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      this.onerror?.(
        new Error(`MCP response not valid JSON: ${(err as Error).message}; body=${body.slice(0, 200)}`),
      );
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of messages) {
      this.onmessage?.(m as JSONRPCMessageLike);
    }
  }

  #dispatchOne(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      this.onerror?.(
        new Error(`SSE data not valid JSON: ${(err as Error).message}; data=${json.slice(0, 200)}`),
      );
      return;
    }
    this.onmessage?.(parsed as JSONRPCMessageLike);
  }
}
