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
import { buildProviders } from "../../providers";

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
  /** Auth-aware GraphQL client bound to this installation. Wrap raw fetches
   *  with this so a 401 from Linear (24h token expiry) auto-refreshes via
   *  the stored refresh_token + retries once. Tool handlers should never
   *  build their own fetch with `accessToken` directly. */
  linearGraphQL: (payload: {
    query: string;
    variables?: Record<string, unknown>;
  }) => Promise<{ data?: unknown; errors?: unknown }>;
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

// Tool registry. Replies happen automatically via the event-tap (bot's
// natural agent.message becomes a panel response). Tools here are for
// behaviors the bot needs to *opt in* to — like asking the panel user a
// follow-up question (elicitation) or posting a top-level comment.
const TOOLS: ToolDescriptor[] = [
  {
    name: "linear_request_input",
    title: "Ask the user for input",
    description:
      "Ask the user who triggered this Linear AgentSession a follow-up " +
      "question. Use this when you need a confirmation or extra info from " +
      "the user before continuing — the panel renders an inline reply box " +
      "for them and Linear marks the session as awaiting input. Their " +
      "response will arrive as the next user message in this session.\n\n" +
      "Pass `body` as the question text. Don't use this for status updates " +
      "or final answers — those are just regular assistant messages.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Question text rendered in the panel.",
        },
      },
      required: ["body"],
    },
    handler: async (ctx, args) => {
      const body = String(args.body ?? "").trim();
      if (!body) return errorResult("body is required");
      if (!ctx.linear.currentAgentSessionId) {
        return errorResult(
          "linear_request_input only works inside a Linear AgentSession " +
            "(Delegate panel or @-mention panel). No agentSession bound to " +
            "this OMA session.",
        );
      }
      const res = await ctx.linearGraphQL({
        query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
        variables: {
          input: {
            agentSessionId: ctx.linear.currentAgentSessionId,
            content: { type: "elicitation", body },
          },
        },
      });
      return res.errors
        ? errorResult(`agentActivityCreate failed: ${JSON.stringify(res.errors)}`)
        : okResult(
            "Question posted to panel. Stop generating now — the user's " +
              "reply will arrive as the next user message.",
          );
    },
  },
];

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

async function linearGraphQL(
  accessToken: string,
  payload: { query: string; variables?: Record<string, unknown> },
): Promise<{ data?: unknown; errors?: unknown }> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { data?: unknown; errors?: unknown };
}

/** Build a GraphQL caller bound to one installation. Issues the call with the
 *  current access token; on a Linear AUTHENTICATION_ERROR (their way of saying
 *  "the 24h OAuth token is dead") it refreshes via the provider, persists the
 *  new tokens, mutates the captured `state` so subsequent calls in this same
 *  request reuse the fresh token, and retries once. Other errors pass through
 *  untouched. */
function buildAuthAwareGraphQL(args: {
  installationId: string;
  state: { token: string };
  refresh: () => Promise<string>;
}): (payload: { query: string; variables?: Record<string, unknown> }) => Promise<{
  data?: unknown;
  errors?: unknown;
}> {
  return async (payload) => {
    const first = await linearGraphQL(args.state.token, payload);
    if (!isAuthError((first.errors as Array<{ extensions?: { code?: string } }>) ?? undefined)) {
      return first;
    }
    try {
      args.state.token = await args.refresh();
      console.log(`[mcp] refreshed access token for installation=${args.installationId}`);
    } catch (err) {
      console.warn(
        `[mcp] token refresh failed for installation=${args.installationId}: ${(err as Error).message}`,
      );
      return first;
    }
    return linearGraphQL(args.state.token, payload);
  };
}

function isAuthError(
  errors: Array<{ extensions?: { code?: string } }> | undefined,
): boolean {
  if (!errors?.length) return false;
  return errors.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
}

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
  const providers = buildProviders(env, container);
  const pub = await container.publications.get(linearMeta.publicationId);
  if (!pub) throw new Error("publication not found");
  const accessToken = await container.installations.getAccessToken(pub.installationId);
  if (!accessToken) throw new Error("App OAuth token not available");

  // Capture the token in a mutable cell so the auth-aware caller can swap it
  // in-place if a refresh fires mid-request. Subsequent tool calls in the
  // same context then see the fresh value too.
  const tokenState = { token: accessToken };
  const linearGraphQLBound = buildAuthAwareGraphQL({
    installationId: pub.installationId,
    state: tokenState,
    refresh: () => providers.linear.refreshAccessToken(pub.installationId),
  });

  return {
    sessionId,
    userId: pub.userId,
    publicationId: pub.id,
    installationId: pub.installationId,
    accessToken,
    linearGraphQL: linearGraphQLBound,
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
