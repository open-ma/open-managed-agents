// OMA-hosted Linear MCP — minimal companion to Linear's hosted MCP at
// mcp.linear.app/mcp.
//
// This server exposes ONE tool:
//   - linear_graphql: raw GraphQL escape hatch (single op, OMA's auth).
//
// Everything else (issue read/write, state changes, comments, labels,
// attachments, users, etc.) is handled by Linear's hosted MCP — both PAT
// and OAuth-app developer tokens are accepted there, Bearer-wrapped, by
// the outbound MITM in apps/agent. Bots get ~30 hosted tools + this one
// escape hatch.
//
// URL: /linear/mcp/:sessionId
// Auth: Authorization: Bearer <per-session-uuid>. The UUID is generated at
//       OMA session create, stored in session metadata, and written to a
//       vault static_bearer credential for integrations.openma.dev so the
//       sandbox outbound MITM auto-injects it.
//
// Reply routing: when a human comments on an issue with an active OMA
// session, Linear's Comment.create webhook fires; the LinearProvider
// webhook handler looks up linear_issue_sessions by issueId and resumes
// the bound session. No per-comment authored_comments tracking required.

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

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = {
  name: "OMA Linear",
  version: "0.3.0",
} as const;

interface SessionContext {
  sessionId: string;
  userId: string;
  publicationId: string;
  installationId: string;
  /** Auth-aware GraphQL client bound to this installation. Auto-refreshes
   *  on Linear AUTHENTICATION_ERROR; tool handlers should never bypass. */
  linearGraphQL: (payload: {
    query: string;
    variables?: Record<string, unknown>;
  }) => Promise<{ data?: unknown; errors?: unknown }>;
  /** Issue the bot was originally bound to (per_issue session granularity).
   *  Used as a fallback default when tool calls don't pass issueId. */
  issueId: string | null;
}

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

const TOOLS: ToolDescriptor[] = [
  {
    name: "linear_graphql",
    title: "Raw Linear GraphQL escape hatch",
    description:
      "Run a single GraphQL query or mutation against Linear directly. Use " +
      "this for operations not covered by the curated tools above — creating " +
      "sub-issues, adding labels, attaching files, fetching team workflows, " +
      "etc.\n\n" +
      "Restrictions: exactly one operation per call (no multi-op documents). " +
      "Auth uses the publication's installation token, so the bot's effective " +
      "permissions are the OAuth app's scopes (read, write, app:assignable, " +
      "app:mentionable) — for personal-token installations, the PAT owner's " +
      "permissions.\n\n" +
      "Returns raw JSON. Errors come back as a structured `errors` array.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query or mutation source. Single operation only.",
        },
        variables: {
          type: "object",
          description: "Optional GraphQL variables map.",
        },
      },
      required: ["query"],
    },
    handler: async (ctx, args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return errorResult("query required");
      // Crude single-op enforcement: count top-level operation tokens.
      // Misses some pathological inputs (e.g. operations inside fragments)
      // but blocks the common multi-op accidents. Linear's server will
      // reject anything truly invalid anyway.
      const opMatches = query.match(/\b(query|mutation|subscription)\b/g) ?? [];
      if (opMatches.length > 1) {
        return errorResult("multi-operation documents are not allowed; submit one operation per call");
      }
      const variables =
        args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
          ? (args.variables as Record<string, unknown>)
          : undefined;
      const res = await ctx.linearGraphQL({ query, variables });
      // Always return as JSON text — bots are good at parsing JSON. Mark
      // isError when GraphQL `errors` is non-empty so the bot can branch.
      const isError = Array.isArray(res.errors) && res.errors.length > 0;
      const text = JSON.stringify({ data: res.data ?? null, errors: res.errors ?? null }, null, 2);
      return isError ? errorResult(text) : okResult(text);
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
      // PAT (`lin_api_…`) MUST be raw; OAuth tokens MUST be `Bearer <token>`.
      // Linear returns INPUT_ERROR if you Bearer-wrap a PAT.
      authorization: accessToken.startsWith("lin_api_")
        ? accessToken
        : `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { data?: unknown; errors?: unknown };
}

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
          "OMA-side Linear escape hatch. Most issue/comment/state operations " +
          "should go through Linear's hosted MCP (mcp.linear.app/mcp), which " +
          "is also attached to this session. Use this server's `linear_graphql` " +
          "tool only when hosted MCP doesn't cover what you need.",
      });

    case "notifications/initialized":
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

async function resolveSessionContext(
  env: Env,
  sessionId: string,
  bearer: string,
): Promise<SessionContext> {
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
    linearGraphQL: linearGraphQLBound,
    issueId: linearMeta.issueId ?? null,
  };
}

export default app;

// Test-only exports.
export const __testInternals = { TOOLS };
