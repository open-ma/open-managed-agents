// Internal endpoint hit by the agent worker's Linear panel mirror to
// translate broadcast SessionEvents (agent.thinking / agent.tool_use /
// agent.tool_result) into Linear AgentActivity entries. Auth is the shared
// service-binding header secret (no public exposure).
//
// We funnel mirror traffic through here instead of letting the agent worker
// hit api.linear.app directly so the App OAuth token never crosses the
// worker boundary — same rule as the rest of the linear MCP wiring.

import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";

const app = new Hono<{ Bindings: Env }>();

interface ActivityBody {
  publicationId: string;
  agentSessionId: string;
  content: {
    type: "thought" | "action" | "response" | "elicitation" | "error";
    body?: string;
    action?: string;
    parameter?: string;
    result?: string;
  };
}

app.post("/agent-activity", async (c) => {
  const provided = c.req.header("x-internal-secret");
  if (!provided || provided !== c.env.INTEGRATIONS_INTERNAL_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json()) as ActivityBody;
  if (!body.publicationId || !body.agentSessionId || !body.content?.type) {
    return c.json({ error: "publicationId, agentSessionId, content.type required" }, 400);
  }
  const container = buildContainer(c.env);
  const pub = await container.publications.get(body.publicationId);
  if (!pub) return c.json({ error: "publication not found" }, 404);
  const accessToken = await container.installations.getAccessToken(pub.installationId);
  if (!accessToken) return c.json({ error: "no access token" }, 500);

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      variables: {
        input: { agentSessionId: body.agentSessionId, content: body.content },
      },
    }),
  });
  const data = (await res.json()) as { data?: unknown; errors?: unknown };
  if (data.errors) {
    return c.json({ ok: false, errors: data.errors }, 502);
  }
  return c.json({ ok: true });
});

export default app;
