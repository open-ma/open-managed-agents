// Linear MCP server — OMA-hosted MCP exposing agent-as-first-class-citizen
// Linear tools. The bot is responsible for ALL Linear-visible output via
// explicit tool calls — there is no auto-mirror of internal reasoning.
//
// URL: /linear/mcp/:sessionId
// Auth: Authorization: Bearer <per-session-uuid>. The UUID is generated at
//       OMA session create, stored in session metadata, and written to a
//       vault static_bearer credential for integrations.openma.dev so the
//       sandbox outbound MITM auto-injects it.
//
// Tools:
//   linear_say(body, panelId, kind, action?, parameter?)
//     Post an AgentActivity to a Linear panel. kind=thought keeps panel
//     active; kind=action shows a tool-call card; kind=elicitation flips
//     the panel to awaitingInput with an inline reply box; kind=response
//     finalizes the panel (turn done). Without calling this, the bot is
//     silent in the panel — there is no implicit mirror of internal
//     reasoning.
//
//   linear_post_comment(body, parentId?, issueId?)
//     Post a Linear comment (top-level or thread reply). Independent of any
//     panel; can be used by off-panel bots too.
//
//   linear_get_issue(issueId?, parentCommentId?)
//     Read an issue's full state plus its comment history.

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
  /** Persist a record of a comment the bot just authored, so the Linear
   *  Comment webhook can route reply comments back to this OMA session. */
  recordAuthoredComment: (input: {
    commentId: string;
    issueId: string;
  }) => Promise<void>;
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
    name: "linear_say",
    title: "Speak in a Linear panel",
    description:
      "Post an AgentActivity to a Linear AgentSession panel — this is how " +
      "the bot speaks visibly in a panel. Without calling this, the bot is " +
      "silent in the panel; internal reasoning is private to the model.\n\n" +
      "**`kind` controls panel UX (and panel state):**\n" +
      "- `thought` (default): shows as a thinking line. Panel stays `active`. " +
      "Use for progress narration (\"checking the code...\", \"running tests\").\n" +
      "- `action`: shows as a tool-call card. Pass `action` (label) and " +
      "optional `parameter`. Panel stays `active`.\n" +
      "- `elicitation`: shows as a question with an inline reply box. Panel " +
      "flips to `awaitingInput`. The user's reply arrives as the next user " +
      "message in this conversation.\n" +
      "- `response`: shows as the bot's final answer. **Panel flips to " +
      "`complete` — Linear treats this as turn over, no further activity " +
      "renders in the UI.** Only use when truly done.\n\n" +
      "**Sequence rules:**\n" +
      "- After `kind=elicitation`, don't post more activities to the same " +
      "panel until the user replies — Linear is showing the input box and " +
      "you'd override that state.\n" +
      "- After `kind=response`, the panel is dead — further calls succeed " +
      "in API but UI doesn't render. Don't call elicitation/anything on a " +
      "complete panel; Linear will spawn a new panel for the user's next " +
      "interaction instead.\n\n" +
      "**`panelId`** is the Linear AgentSession id (UUID), named in the " +
      "user message that woke you up.\n\n" +
      "Note: Linear renders panel activities inline in the issue's comment " +
      "thread too. Even in-panel \"thoughts\" become public comments visible " +
      "to all subscribers — don't say things you wouldn't put in a comment.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Markdown body shown in the panel." },
        panelId: { type: "string", description: "Linear AgentSession id (UUID)." },
        kind: {
          type: "string",
          enum: ["thought", "action", "elicitation", "response"],
          description:
            "Activity kind. `thought` (default) keeps panel active. `action` " +
            "shows tool-call card. `elicitation` opens a reply box. " +
            "`response` finalizes the panel.",
        },
        action: {
          type: "string",
          description: "Required when kind=action. Short tool/operation label.",
        },
        parameter: {
          type: "string",
          description:
            "Optional when kind=action. Short summary of args (≤200 chars).",
        },
      },
      required: ["body", "panelId"],
    },
    handler: async (ctx, args) => {
      const body = String(args.body ?? "").trim();
      if (!body) return errorResult("body is required");
      const panelId = String(args.panelId ?? "").trim();
      if (!panelId) return errorResult("panelId is required");
      const kind = (String(args.kind ?? "thought").toLowerCase() as
        | "thought"
        | "action"
        | "elicitation"
        | "response");
      if (!["thought", "action", "elicitation", "response"].includes(kind)) {
        return errorResult(`unknown kind: ${kind}`);
      }
      let content: Record<string, unknown>;
      if (kind === "action") {
        const action = String(args.action ?? "").trim();
        if (!action) return errorResult("action label required when kind=action");
        const parameter = args.parameter ? String(args.parameter) : "";
        content = { type: "action", action, parameter };
      } else {
        content = { type: kind, body };
      }
      const res = await ctx.linearGraphQL({
        query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
        variables: {
          input: { agentSessionId: panelId, content },
        },
      });
      if (res.errors) {
        return errorResult(`agentActivityCreate failed: ${JSON.stringify(res.errors)}`);
      }
      const note =
        kind === "response"
          ? `Posted (kind=response). Panel ${panelId} is now finalized; further linear_say calls won't render.`
          : kind === "elicitation"
          ? `Posted (kind=elicitation). Panel ${panelId} is now awaitingInput. The user's reply will arrive as the next user message — don't post more activities to this panel until then.`
          : `Posted (kind=${kind}) to panel ${panelId}.`;
      return okResult(note);
    },
  },
  {
    name: "linear_post_comment",
    title: "Post a Linear comment",
    description:
      "Post a comment on a Linear issue as the bot user. Independent of any " +
      "panel — works whether or not you're bound to one.\n\n" +
      "**Top-level comment** (omit `parentId`): starts a new thread on the " +
      "issue. Use this to reach a different person via @-mention.\n\n" +
      "**Thread reply** (pass `parentId`): posts as a sibling reply in an " +
      "existing thread. Linear thread structure is flat (only 2 levels), so " +
      "every reply parents to the original top-level comment.\n\n" +
      "If a human replies in a thread you started (or replied to), their " +
      "reply is delivered back to you as a user message.\n\n" +
      "Body is Markdown. To @-mention a user, use plain `@<displayname>` " +
      "(e.g. `@hrhrngxy`) — Linear server-side parses it into a real " +
      "mention chip + sends a notification.\n\n" +
      "`issueId` defaults to the issue this conversation is bound to.\n\n" +
      "**Post once.** A single tool call posts a single comment. Do NOT " +
      "follow up with extra confirmation comments — \"Comment posted!\" or " +
      "\"Done!\" follow-ups create duplicate noise in the thread.",
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
      const issueIdRaw = String(args.issueId ?? ctx.issueId ?? "").trim();
      if (!issueIdRaw) {
        return errorResult(
          "issueId required — no issue is bound to this conversation, so " +
            "the bot must pass it explicitly.",
        );
      }
      // Resolve identifier (e.g. "OPE-38") → UUID. Linear's commentCreate
      // accepts both, but we store the UUID in linear_authored_comments so
      // future reply-routing lookups by issue UUID work consistently.
      const issueId = await resolveIssueUuid(ctx, issueIdRaw);
      if (!issueId) {
        return errorResult(`could not resolve issueId "${issueIdRaw}" to a Linear issue`);
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
    name: "linear_get_issue",
    title: "Read a Linear issue (header + comments)",
    description:
      "Fetch a Linear issue's current state plus its comment history. " +
      "Returns identifier, title, description, status, priority, labels, " +
      "assignee, creator, urls, plus up to 50 comments (newest-first).\n\n" +
      "Pass `parentCommentId` to scope the comment listing to a single " +
      "thread (parent comment + all its replies). Without it, returns the " +
      "full top-level comment list.\n\n" +
      "`issueId` defaults to the issue this conversation is bound to.\n\n" +
      "Use this any time you want to (re-)check issue state — when you wake " +
      "up with only thread context, when state may have changed since you " +
      "last looked, or when you need to read past comments before replying.",
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
            "Optional. Scope the comment listing to one thread (parent + replies).",
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
      const parentCommentId = args.parentCommentId
        ? String(args.parentCommentId).trim()
        : null;
      // GraphQL safety: parentCommentId is interpolated into the query body
      // below (Linear's `comments(filter:...)` doesn't accept Variables for the
      // ID equality predicates we need). Reject anything that isn't a UUID so
      // the LLM-supplied value can't smuggle sibling selections into the query.
      if (parentCommentId && !UUID_RE.test(parentCommentId)) {
        return errorResult(
          `parentCommentId must be a UUID, got: ${parentCommentId}`,
        );
      }
      const commentsClause = parentCommentId
        ? `comments(first:50, filter:{ or:[ { id:{eq:"${parentCommentId}"} }, { parent:{ id:{eq:"${parentCommentId}"} } } ] }){ nodes{ id body createdAt parent{id} user{displayName} } }`
        : `comments(first:50, filter:{ parent:{ null:true } }){ nodes{ id body createdAt parent{id} user{displayName} } }`;
      const res = await ctx.linearGraphQL({
        query: `query($id:String!){
          issue(id:$id){
            id identifier title description url
            createdAt updatedAt
            priority priorityLabel
            state{ name type }
            assignee{ displayName }
            creator{ displayName }
            labels(first:20){ nodes{ name } }
            team{ key name }
            ${commentsClause}
          }
        }`,
        variables: { id: issueId },
      });
      if (res.errors) {
        return errorResult(`issue lookup failed: ${JSON.stringify(res.errors)}`);
      }
      const issue =
        (res.data as { issue?: {
          id: string;
          identifier: string;
          title: string;
          description: string | null;
          url: string;
          createdAt: string;
          updatedAt: string;
          priority: number;
          priorityLabel: string;
          state: { name: string; type: string } | null;
          assignee: { displayName: string } | null;
          creator: { displayName: string } | null;
          labels: { nodes: Array<{ name: string }> };
          team: { key: string; name: string } | null;
          comments: { nodes: Array<{
            id: string;
            body: string;
            createdAt: string;
            parent: { id: string } | null;
            user: { displayName: string } | null;
          }> };
        } } )?.issue;
      if (!issue) return errorResult(`issue ${issueId} not found`);
      const labels = issue.labels.nodes.map((l) => l.name).join(", ") || "(none)";
      const comments = issue.comments.nodes
        .map((n) => {
          const handle = n.user?.displayName ? `@${n.user.displayName}` : "(unknown)";
          const parent = n.parent?.id ? ` (reply to ${n.parent.id})` : "";
          return `- ${handle} · ${n.id} · ${n.createdAt}${parent}\n  ${n.body.split("\n").join("\n  ")}`;
        })
        .join("\n");
      const lines = [
        `# ${issue.identifier}: ${issue.title}`,
        ``,
        `- **Team:** ${issue.team ? `${issue.team.name} (${issue.team.key})` : "?"}`,
        `- **Status:** ${issue.state?.name ?? "?"}${issue.state ? ` (${issue.state.type})` : ""}`,
        `- **Priority:** ${issue.priorityLabel} (${issue.priority})`,
        `- **Creator:** ${issue.creator?.displayName ? `@${issue.creator.displayName}` : "?"}`,
        `- **Assignee:** ${issue.assignee?.displayName ? `@${issue.assignee.displayName}` : "(unassigned)"}`,
        `- **Labels:** ${labels}`,
        `- **Created:** ${issue.createdAt}`,
        `- **Updated:** ${issue.updatedAt}`,
        `- **URL:** ${issue.url}`,
        ``,
        `## Description`,
        issue.description || "(empty)",
        ``,
        parentCommentId
          ? `## Thread (parent=${parentCommentId})`
          : `## Top-level comments`,
        comments || "(none)",
      ];
      return okResult(lines.join("\n"));
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

/** UUID detector — Linear issue UUIDs match this; identifiers (OPE-38) don't. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a Linear issue identifier (OPE-38) to its UUID. Pass-through if
 *  already a UUID. Returns null on lookup failure. We store UUIDs in
 *  authored_comments so reply-routing by issue id stays consistent regardless
 *  of which form the bot used at post time. */
async function resolveIssueUuid(
  ctx: { linearGraphQL: (p: { query: string; variables?: Record<string, unknown> }) => Promise<{ data?: unknown; errors?: unknown }> },
  identifierOrUuid: string,
): Promise<string | null> {
  if (UUID_RE.test(identifierOrUuid)) return identifierOrUuid;
  const res = await ctx.linearGraphQL({
    query: `query($id:String!){ issue(id:$id){ id } }`,
    variables: { id: identifierOrUuid },
  });
  return ((res.data as { issue?: { id?: string } } | undefined)?.issue?.id) ?? null;
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
          "Linear tools. The bot owns ALL panel-visible output: nothing is " +
          "auto-mirrored. Use linear_say(kind=\"thought\") to narrate, " +
          "linear_say(kind=\"elicitation\") to ask the panel creator a " +
          "question (renders an inline reply box), " +
          "linear_say(kind=\"response\") to finalize the panel, " +
          "linear_post_comment to talk in comment threads, " +
          "linear_get_issue to read issue + thread context.",
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

  return {
    sessionId,
    userId: pub.userId,
    publicationId: pub.id,
    installationId: pub.installationId,
    linearGraphQL: linearGraphQLBound,
    recordAuthoredComment,
    issueId: linearMeta.issueId ?? null,
  };
}

export default app;
