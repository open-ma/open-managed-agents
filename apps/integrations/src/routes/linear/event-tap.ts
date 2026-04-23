// Linear event-tap consumer — receives every SessionEvent that SessionDO
// fires for a Linear-bound session and, when the bot is currently bound to
// a Linear AgentSession panel, mirrors the relevant ones into Linear
// AgentActivity entries so the panel UI animates with thinking / action /
// response in real time.
//
// Auth: x-internal-secret (set by SessionDO via the event_hooks config in
// /init body). Sessions not bound to Linear simply have no hook configured
// — there's no opt-out logic on this side.
//
// State: we read `linear_oma_panel_binding(oma_session_id)` from D1 to find
// out which panel the bot is currently in. The bot writes that binding via
// the linear_enter_panel / linear_exit_panel MCP tools. Absent binding =
// bot is "off-panel" and we don't mirror anything; the bot is responsible
// for using comment tools if it wants visible output.

import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

const app = new Hono<{ Bindings: Env }>();

interface SessionEvent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

app.post("/event-tap", async (c) => {
  const provided = c.req.header("x-internal-secret");
  if (!provided || provided !== c.env.INTEGRATIONS_INTERNAL_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const sessionId = c.req.query("session");
  if (!sessionId) return c.json({ error: "session query required" }, 400);
  const event = (await c.req.json()) as SessionEvent;

  const container = buildContainer(c.env);
  const binding = await container.panelBindings.get(sessionId);
  if (!binding) {
    return c.json({ ok: true, skipped: "no panel binding" });
  }

  // Elicitation grace: after the bot calls linear_request_input, the model
  // tends to emit a wrap-up sentence ("Question sent, waiting...") that
  // would mirror as a `response` activity and flip Linear's panel from
  // `awaitingInput` to `complete` — destroying the inline reply box. Drop
  // *every* event for ~30s after an elicitation stamp so the panel only
  // sees the elicitation activity itself.
  const ELICITATION_GRACE_MS = 30_000;
  if (binding.lastElicitationAt && Date.now() - binding.lastElicitationAt < ELICITATION_GRACE_MS) {
    return c.json({
      ok: true,
      skipped: "post-elicitation grace window",
      sinceElicitation: Date.now() - binding.lastElicitationAt,
    });
  }

  // Resolve publication via the OMA session record. The session's metadata
  // carries the immutable linear.publicationId stamp, which gives us the
  // installation + access token. We don't write to that metadata anymore —
  // it's read-only from this side.
  const sessRes = await c.env.MAIN.fetch(
    `http://main/v1/internal/sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET", headers: { "x-internal-secret": c.env.INTEGRATIONS_INTERNAL_SECRET } },
  );
  if (!sessRes.ok) return c.json({ ok: true, skipped: "session lookup failed" });
  const session = (await sessRes.json()) as {
    metadata?: { linear?: { publicationId?: string } };
  };
  const publicationId = session.metadata?.linear?.publicationId;
  if (!publicationId) {
    return c.json({ ok: true, skipped: "no publication on session" });
  }

  const content = translateEvent(event);
  if (!content) return c.json({ ok: true, skipped: "event not mirrored" });

  const pub = await container.publications.get(publicationId);
  if (!pub) return c.json({ ok: true, skipped: "publication not found" });
  let accessToken = await container.installations.getAccessToken(pub.installationId);
  if (!accessToken) return c.json({ ok: true, skipped: "no access token" });

  const providers = buildProviders(c.env, container);
  const postActivity = (token: string) =>
    fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) { success }
        }`,
        variables: {
          input: { agentSessionId: binding.panelAgentSessionId, content },
        },
      }),
    });

  let res = await postActivity(accessToken);
  let data = (await res.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
  if (isAuthError(data.errors)) {
    try {
      accessToken = await providers.linear.refreshAccessToken(pub.installationId);
      console.log(
        `[event-tap] refreshed access token for installation=${pub.installationId}`,
      );
    } catch (err) {
      console.warn(
        `[event-tap] token refresh failed for installation=${pub.installationId}: ${(err as Error).message}`,
      );
      return c.json({ ok: false, error: "token_refresh_failed" }, 502);
    }
    res = await postActivity(accessToken);
    data = (await res.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
  }
  if (data.errors) {
    console.warn(`[event-tap] linear errors: ${JSON.stringify(data.errors)}`);
    return c.json({ ok: false }, 502);
  }
  return c.json({ ok: true });
});

/** Map a SessionEvent to a Linear AgentActivity content payload. */
function translateEvent(event: SessionEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "agent.thinking": {
      const text = (event.text ?? "").trim();
      if (!text) return null;
      return { type: "thought", body: truncate(text.replace(/\s+/g, " "), 200) };
    }
    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      return {
        type: "action",
        action: event.name ?? "tool",
        parameter: summarizeArgs(event.input),
      };
    }
    case "agent.message": {
      const blocks = (event as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      if (!text) return null;
      return { type: "response", body: text };
    }
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function summarizeArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input, 200);
  try {
    return truncate(JSON.stringify(input), 200);
  } catch {
    return "";
  }
}

function isAuthError(
  errors: Array<{ extensions?: { code?: string } }> | undefined,
): boolean {
  if (!errors?.length) return false;
  return errors.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
}

export default app;
