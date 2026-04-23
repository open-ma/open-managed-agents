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
// Tools (M7 unified design):
//   linear_enter_panel(agentSessionId) — bind this OMA session to a Linear
//     panel; subsequent agent broadcasts (thinking / tool_use / message)
//     mirror to that panel via event-tap.
//   linear_exit_panel() — clear the binding; bot is now silent unless it
//     calls a tool that produces user-visible output.
//   linear_post_comment(body, parentId?, issueId?) — post a comment on an
//     issue; with parentId it's a thread reply.
//   linear_request_input(body) — post an elicitation activity to the
//     currently-bound panel (requires linear_enter_panel first).
//   linear_list_comments(issueId, parentCommentId?) — fetch comment thread
//     state for context.

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
  version: "0.2.0",
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
  /** Persist a record of a comment the bot just authored, so the Linear
   *  Comment webhook can route reply comments back to this OMA session. */
  recordAuthoredComment: (input: {
    commentId: string;
    issueId: string;
  }) => Promise<void>;
  /** Read the OMA session's currently-bound Linear panel id. Null when the
   *  bot is off-panel (between turns or after an explicit exit). */
  getCurrentPanel: () => Promise<string | null>;
  /** Bind / switch the OMA session to a Linear panel. */
  setPanel: (agentSessionId: string) => Promise<void>;
  /** Clear the panel binding. */
  clearPanel: () => Promise<void>;
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
    name: "linear_enter_panel",
    title: "Enter a Linear AgentSession panel",
    description:
      "Bind this conversation to a Linear AgentSession panel. While bound, " +
      "your subsequent reasoning, tool calls, and assistant messages are " +
      "mirrored into that panel as Linear AgentActivity entries — users " +
      "watching the panel see your work in real time.\n\n" +
      "Calling this with a different `agentSessionId` switches the binding. " +
      "Calling `linear_exit_panel` clears it. Until you enter a panel, you " +
      "are silent (assistant text isn't broadcast anywhere on Linear) — use " +
      "the comment tools for explicit user-visible output instead.\n\n" +
      "The panel id is provided in the user message that wakes you up: when " +
      "Linear delegates an issue or a human @-mentions you, the message " +
      "always names the panel as `ag_<uuid>`. Pass that whole id here.",
    inputSchema: {
      type: "object",
      properties: {
        agentSessionId: {
          type: "string",
          description: "The Linear AgentSession id (uuid format).",
        },
      },
      required: ["agentSessionId"],
    },
    handler: async (ctx, args) => {
      const id = String(args.agentSessionId ?? "").trim();
      if (!id) return errorResult("agentSessionId is required");
      await ctx.setPanel(id);
      return okResult(
        `Entered Linear panel ${id}. From this point on, your reasoning ` +
          `and tool calls render in that panel. Call linear_exit_panel to ` +
          `stop mirroring.`,
      );
    },
  },
  {
    name: "linear_exit_panel",
    title: "Exit the current Linear panel",
    description:
      "Clear the panel binding. Subsequent reasoning and assistant messages " +
      "stop appearing in any Linear panel — you go silent. Use this when " +
      "you're done with a panel and want to do background work, or when " +
      "switching focus to a thread comment exchange that's separate from " +
      "the panel.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => {
      await ctx.clearPanel();
      return okResult("Exited Linear panel. You are now silent on Linear.");
    },
  },
  {
    name: "linear_request_input",
    title: "Ask the panel user for input",
    description:
      "Post an elicitation activity to the currently-bound Linear panel. " +
      "Linear renders an inline reply box for the panel creator and marks " +
      "the panel as awaiting input. Their reply arrives back as the next " +
      "user message in this conversation.\n\n" +
      "Requires you to have entered a panel via linear_enter_panel first. " +
      "After this returns, stop generating — anything else you say in the " +
      "same turn will be mirrored to the panel and confuse the UX.",
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
      const panel = await ctx.getCurrentPanel();
      if (!panel) {
        return errorResult(
          "No Linear panel is currently entered. Call linear_enter_panel " +
            "first with the panel id from the user message.",
        );
      }
      const res = await ctx.linearGraphQL({
        query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
        variables: {
          input: {
            agentSessionId: panel,
            content: { type: "elicitation", body },
          },
        },
      });
      if (res.errors) {
        return errorResult(`agentActivityCreate failed: ${JSON.stringify(res.errors)}`);
      }
      return okResult(
        `Question posted to panel ${panel}. Stop generating now — the user's ` +
          `reply will arrive as the next user message.`,
      );
    },
  },
  {
    name: "linear_post_comment",
    title: "Post a Linear comment",
    description:
      "Post a comment on a Linear issue as the bot user.\n\n" +
      "**Top-level comment** (omit `parentId`): starts a new thread on the " +
      "issue. Use this to reach a different person via @-mention.\n\n" +
      "**Thread reply** (pass `parentId`): posts as a sibling reply in an " +
      "existing thread. Linear thread structure is flat (only 2 levels), so " +
      "every reply parents to the original top-level comment.\n\n" +
      "If a human replies in a thread you started (or replied to), their " +
      "reply is delivered back to you as a user message. There is no panel " +
      "involved on this side-channel — your further responses must be " +
      "explicit `linear_post_comment` calls.\n\n" +
      "Body is Markdown. To @-mention a user, use plain `@<displayname>` " +
      "(e.g. `@hrhrngxy`) — Linear server-side parses it into a real " +
      "mention chip + sends a notification.\n\n" +
      "`issueId` defaults to the issue this conversation is bound to.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "Markdown body. To @-mention a teammate, use plain `@<displayname>`.",
        },
        parentId: {
          type: "string",
          description:
            "Parent comment id for a thread reply. Omit for a top-level comment.",
        },
        issueId: {
          type: "string",
          description:
            "Linear issue UUID. Defaults to the issue this conversation is bound to.",
        },
      },
      required: ["body"],
    },
    handler: async (ctx, args) => {
      const body = String(args.body ?? "").trim();
      if (!body) return errorResult("body is required");
      const issueId = String(args.issueId ?? ctx.issueId ?? "").trim();
      if (!issueId) {
        return errorResult(
          "issueId required — no issue is bound to this conversation, so " +
            "the bot must pass it explicitly.",
        );
      }
      const parentId = args.parentId ? String(args.parentId).trim() : null;
      const input: Record<string, unknown> = { issueId, body };
      if (parentId) input.parentId = parentId;
      const res = await ctx.linearGraphQL({
        query: `mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id } }
        }`,
        variables: { input },
      });
      if (res.errors) {
        return errorResult(`commentCreate failed: ${JSON.stringify(res.errors)}`);
      }
      const data = res.data as { commentCreate?: { comment?: { id?: string } } };
      const commentId = data.commentCreate?.comment?.id;
      if (!commentId) {
        return errorResult("commentCreate returned no comment id");
      }
      try {
        await ctx.recordAuthoredComment({ commentId, issueId });
      } catch (err) {
        console.warn(
          `[mcp] recordAuthoredComment failed for ${commentId}: ${(err as Error).message}`,
        );
      }
      const where = parentId
        ? `as a thread reply to ${parentId}`
        : "as a new top-level thread";
      return okResult(
        `Posted comment ${commentId} on issue ${issueId} ${where}. If a ` +
          "human replies in this thread, their reply will arrive here as " +
          "the next user message.",
      );
    },
  },
  {
    name: "linear_list_comments",
    title: "List comments on a Linear issue or thread",
    description:
      "Fetch the recent comment history on a Linear issue, or scoped to a " +
      "single thread. Returns up to 50 comments newest-first with author " +
      "displayname, body, parent comment id, and timestamps.\n\n" +
      "Pass `parentCommentId` to scope the listing to one thread (parent + " +
      "all replies). Without it, returns top-level comments only.\n\n" +
      "Use this to read up before responding when you're woken by a thread " +
      "reply or @-mention with no inline context.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: {
          type: "string",
          description:
            "Linear issue UUID. Defaults to the issue this conversation is bound to.",
        },
        parentCommentId: {
          type: "string",
          description:
            "Optional. If provided, list the parent comment + replies in that thread.",
        },
      },
    },
    handler: async (ctx, args) => {
      const issueId = String(args.issueId ?? ctx.issueId ?? "").trim();
      if (!issueId) {
        return errorResult(
          "issueId required — no issue is bound to this conversation.",
        );
      }
      const parentCommentId = args.parentCommentId ? String(args.parentCommentId).trim() : null;
      const query = parentCommentId
        ? `query($issueId:String!, $parentId:ID){
             issue(id:$issueId){
               comments(first:50, filter:{ or:[ { id:{eq:$parentId} }, { parent:{ id:{eq:$parentId} } } ] }){
                 nodes{ id body createdAt parent{id} user{displayName} }
               }
             }
           }`
        : `query($issueId:String!){
             issue(id:$issueId){
               comments(first:50, filter:{ parent:{ null:true } }){
                 nodes{ id body createdAt parent{id} user{displayName} }
               }
             }
           }`;
      const variables = parentCommentId
        ? { issueId, parentId: parentCommentId }
        : { issueId };
      const res = await ctx.linearGraphQL({ query, variables });
      if (res.errors) {
        return errorResult(`comment listing failed: ${JSON.stringify(res.errors)}`);
      }
      const nodes =
        ((res.data as { issue?: { comments?: { nodes?: Array<{
          id: string;
          body: string;
          createdAt: string;
          parent: { id: string } | null;
          user: { displayName: string } | null;
        }> } } })?.issue?.comments?.nodes) ?? [];
      const formatted = nodes
        .map((n) => {
          const handle = n.user?.displayName ? `@${n.user.displayName}` : "(unknown)";
          const parent = n.parent?.id ? ` (reply to ${n.parent.id})` : "";
          return `- ${handle} · ${n.id} · ${n.createdAt}${parent}\n  ${n.body.split("\n").join("\n  ")}`;
        })
        .join("\n");
      return okResult(formatted || "(no comments)");
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
          "Tools to interact with Linear as the bot user. Token is managed " +
          "server-side; no auth headers needed in tool args. Use linear_enter_panel " +
          "to bind to a Linear AgentSession panel for live mirroring of your " +
          "reasoning, or linear_post_comment to talk in comment threads off-panel.",
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
  // Ask main for the session record. Main owns the CONFIG_KV with session
  // data; integrations doesn't bind that namespace. We only need immutable
  // wiring fields — publication id (mandatory), issue id (optional default
  // for tools), mcp_token (auth check). Everything else lives in D1 now.
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
  const recordAuthoredComment = async (input: {
    commentId: string;
    issueId: string;
  }) => {
    await container.authoredComments.insert({
      commentId: input.commentId,
      omaSessionId: sessionId,
      issueId: input.issueId,
      createdAt: Date.now(),
    });
  };
  const getCurrentPanel = async () => {
    const row = await container.panelBindings.get(sessionId);
    return row?.panelAgentSessionId ?? null;
  };
  const setPanel = async (agentSessionId: string) => {
    await container.panelBindings.set(sessionId, agentSessionId, Date.now());
  };
  const clearPanel = async () => {
    await container.panelBindings.clear(sessionId);
  };

  return {
    sessionId,
    userId: pub.userId,
    publicationId: pub.id,
    installationId: pub.installationId,
    linearGraphQL: linearGraphQLBound,
    recordAuthoredComment,
    getCurrentPanel,
    setPanel,
    clearPanel,
    issueId: linearMeta.issueId ?? null,
  };
}

export default app;
