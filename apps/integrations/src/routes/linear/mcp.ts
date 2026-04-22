// Linear MCP server — OMA-hosted MCP exposing agent-as-human style Linear
// tools. Replaces `https://mcp.linear.app/mcp` for OMA sessions: instead of
// the bot directly using Linear's hosted MCP (which requires the App OAuth
// token to reach the sandbox), all Linear API access is funneled through
// here so the token never crosses the worker boundary.
//
// URL: /linear/mcp/:sessionId
// Auth: Authorization: Bearer <per-session-uuid>. The UUID is generated at
//       OMA session create, stored in session metadata, and written to a
//       vault static_bearer credential for integrations.openma.dev so the
//       sandbox outbound MITM auto-injects it.
//
// Per-request flow:
//   1. Validate path sessionId + bearer against the OMA session record
//   2. Resolve session → publication → installation → App OAuth token
//      (decrypted in-memory, never logged)
//   3. Dispatch the JSON-RPC method to a tool handler that uses the token
//      to call Linear's GraphQL API on the bot's behalf
//
// M1 (this file): JSON-RPC plumbing + zero registered tools. M2 lands the
// first real tool (linear_reply).

import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = {
  name: "OMA Linear",
  version: "0.1.0",
} as const;

interface SessionContext {
  sessionId: string;
  userId: string;
  publicationId: string;
  installationId: string;
  /** App OAuth bearer for api.linear.app / mcp.linear.app. */
  accessToken: string;
  /** Mutable per-turn metadata: which Linear AgentSession the agent has
   *  currently "open" for replies, what comment id triggered this turn, etc.
   *  Populated from OMA session metadata.linear at request time. */
  linear: {
    issueId: string | null;
    currentAgentSessionId: string | null;
    triggerCommentId: string | null;
    actor: { id: string | null; displayName: string | null };
  };
}

/**
 * Tool registry. Each handler receives the resolved SessionContext + parsed
 * arguments, returns the JSON-RPC `result` payload (per MCP, that's
 * `{ content: [...], isError?: boolean }`).
 */
type ToolHandler = (
  ctx: SessionContext,
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

// Tool registry — currently empty. Bots reply to Linear by emitting
// regular agent.message text; the event-tap consumer translates each
// SessionEvent (action, message, etc.) into the matching Linear
// AgentActivity. Keeping the MCP server skeleton in place for future
// tools (panel.elicit, side-bar issue lookup, etc.) without bringing
// reply routing back here.
const TOOLS: ToolDescriptor[] = [];

const app = new Hono<{ Bindings: Env }>();

app.post("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!bearer) {
    return jsonRpcError(null, -32001, "missing bearer token");
  }

  // Resolve session + validate token via main worker. We don't read the
  // session record directly — main owns CONFIG_KV. Service binding does the
  // lookup and returns the auth context we need.
  let ctx: SessionContext;
  try {
    ctx = await resolveSessionContext(c.env, sessionId, bearer);
  } catch (err) {
    return jsonRpcError(null, -32001, `auth failed: ${(err as Error).message}`);
  }

  let body: JsonRpcRequest;
  try {
    body = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id ?? null, -32600, "invalid request");
  }

  const id = body.id ?? null;
  switch (body.method) {
    case "initialize":
      return jsonRpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Use these tools to interact with Linear as the bot user. " +
          "Token is managed server-side; no auth headers needed in tool args.",
      });

    case "notifications/initialized":
      // No-op notification — no response expected.
      return new Response(null, { status: 204 });

    case "tools/list":
      return jsonRpcOk(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return jsonRpcError(id, -32601, `unknown tool: ${params.name}`);
      try {
        const result = await tool.handler(ctx, params.arguments ?? {});
        return jsonRpcOk(id, result);
      } catch (err) {
        return jsonRpcError(id, -32603, `tool failed: ${(err as Error).message}`);
      }
    }

    default:
      return jsonRpcError(id, -32601, `method not found: ${body.method}`);
  }
});

function jsonRpcOk<T>(id: JsonRpcId, result: T): Response {
  const body: JsonRpcSuccess<T> = { jsonrpc: "2.0", id, result };
  return Response.json(body);
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const body: JsonRpcError = { jsonrpc: "2.0", id, error: { code, message, data } };
  return Response.json(body);
}

/**
 * Validate the per-session bearer and assemble the resolved context. Looks up
 * the OMA session record (via main worker service binding to CONFIG_KV),
 * verifies the bearer matches the recorded `linear_mcp_token`, then resolves
 * the publication and installation to produce the App OAuth token plus the
 * trigger metadata the tools will need.
 */
async function resolveSessionContext(
  env: Env,
  sessionId: string,
  bearer: string,
): Promise<SessionContext> {
  // Ask main for the session record. Main owns the CONFIG_KV with session
  // data; integrations doesn't bind that namespace.
  const sessionRes = await env.MAIN.fetch(
    `http://main/v1/internal/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: { "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET },
    },
  );
  if (!sessionRes.ok) {
    throw new Error(`session lookup ${sessionRes.status}`);
  }
  const session = (await sessionRes.json()) as {
    id: string;
    metadata?: {
      linear?: {
        publicationId?: string;
        mcp_token?: string;
        issueId?: string | null;
        currentAgentSessionId?: string | null;
        triggerCommentId?: string | null;
        actor?: { id?: string | null; displayName?: string | null };
      };
    };
  };
  const linearMeta = session.metadata?.linear;
  if (!linearMeta?.mcp_token || linearMeta.mcp_token !== bearer) {
    throw new Error("invalid token");
  }
  if (!linearMeta.publicationId) {
    throw new Error("session not linked to a Linear publication");
  }

  const container = buildContainer(env);
  const pub = await container.publications.get(linearMeta.publicationId);
  if (!pub) throw new Error("publication not found");
  const accessToken = await container.installations.getAccessToken(pub.installationId);
  if (!accessToken) throw new Error("App OAuth token not available");

  return {
    sessionId,
    userId: pub.userId,
    publicationId: pub.id,
    installationId: pub.installationId,
    accessToken,
    linear: {
      issueId: linearMeta.issueId ?? null,
      currentAgentSessionId: linearMeta.currentAgentSessionId ?? null,
      triggerCommentId: linearMeta.triggerCommentId ?? null,
      actor: {
        id: linearMeta.actor?.id ?? null,
        displayName: linearMeta.actor?.displayName ?? null,
      },
    },
  };
}

export default app;
