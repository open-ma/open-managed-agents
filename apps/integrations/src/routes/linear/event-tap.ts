// Linear event-tap consumer — receives every SessionEvent that SessionDO
// fires for a Linear-bound session, translates relevant ones into
// Linear AgentActivity entries so the panel UI animates with thinking /
// action / response in real time, just like the official Linear agent.
//
// Auth: x-internal-secret (set by SessionDO via the event_hooks config in
// /init body). Sessions not bound to Linear simply have no hook configured
// — there's no opt-out logic on this side.

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
  metadata?: { linear?: { publicationId?: string; agentSessionId?: string | null } };
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

  // Resolve current Linear context for this session. The session record
  // metadata.linear holds publicationId + currentAgentSessionId; the latter
  // updates per turn (set by main worker when each Linear event arrives).
  const sessRes = await c.env.MAIN.fetch(
    `http://main/v1/internal/sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET", headers: { "x-internal-secret": c.env.INTEGRATIONS_INTERNAL_SECRET } },
  );
  if (!sessRes.ok) return c.json({ ok: true, skipped: "session lookup failed" });
  const session = (await sessRes.json()) as {
    metadata?: { linear?: { publicationId?: string; currentAgentSessionId?: string | null } };
  };
  const linear = session.metadata?.linear;
  if (!linear?.publicationId || !linear.currentAgentSessionId) {
    return c.json({ ok: true, skipped: "no linear context" });
  }

  const content = translateEvent(event);
  if (!content) return c.json({ ok: true, skipped: "event not mirrored" });

  const container = buildContainer(c.env);
  const providers = buildProviders(c.env, container);
  const pub = await container.publications.get(linear.publicationId);
  if (!pub) return c.json({ ok: true, skipped: "publication not found" });
  let accessToken = await container.installations.getAccessToken(pub.installationId);
  if (!accessToken) return c.json({ ok: true, skipped: "no access token" });

  // If the bot just posted an elicitation, Linear has already flipped the
  // AgentSession to `awaitingInput`. The bot may still emit a final assistant
  // message (it doesn't always honor the "stop generating" instruction in the
  // tool's success payload). Mirroring that as a `response` activity would
  // make Linear treat the turn as complete and hide the inline reply box.
  // Drop the mirror in that case so the panel stays open for the user.
  if (content.type === "response") {
    const status = await fetchAgentSessionStatus(
      accessToken,
      linear.currentAgentSessionId,
    );
    // null = transient lookup failure → allow mirror; awaitingInput → drop;
    // unauthenticated → triggers the same lazy refresh path the mutation
    // below uses, so we don't bail on a stale token here.
    if (status === "awaitingInput") {
      console.log(
        `[event-tap] drop response for session=${sessionId} agentSession=${linear.currentAgentSessionId} (status=awaitingInput)`,
      );
      return c.json({ ok: true, skipped: "panel awaiting user input" });
    }
    if (status === "unauthenticated") {
      try {
        accessToken = await providers.linear.refreshAccessToken(pub.installationId);
        console.log(`[event-tap] refreshed access token for installation=${pub.installationId}`);
      } catch (err) {
        console.warn(
          `[event-tap] token refresh failed for installation=${pub.installationId}: ${(err as Error).message}`,
        );
        return c.json({ ok: false, error: "token_refresh_failed" }, 502);
      }
      const refreshed = await fetchAgentSessionStatus(accessToken, linear.currentAgentSessionId);
      if (refreshed === "awaitingInput") {
        console.log(
          `[event-tap] drop response for session=${sessionId} agentSession=${linear.currentAgentSessionId} (status=awaitingInput, post-refresh)`,
        );
        return c.json({ ok: true, skipped: "panel awaiting user input" });
      }
    }
  }

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
          input: { agentSessionId: linear.currentAgentSessionId, content },
        },
      }),
    });

  let res = await postActivity(accessToken);
  let data = (await res.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
  if (isAuthError(data.errors)) {
    try {
      accessToken = await providers.linear.refreshAccessToken(pub.installationId);
      console.log(
        `[event-tap] refreshed access token for installation=${pub.installationId} (mutation 401)`,
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

/** Map a SessionEvent to a Linear AgentActivity content payload.
 *
 *  Single pipe — every Linear-bound side-effect for this session goes
 *  through here, in broadcast order. There's no special "reply" tool: the
 *  bot's natural agent.message events become response activities, the
 *  same way agent.tool_use becomes action activities.
 *
 *  Returns null for events we don't surface (tool_result is just
 *  stdout/stderr noise).
 */
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
      // Bot's user-facing text. Pull plain text from content blocks.
      const content = (event as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = content
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

/** Fetch the current AgentSession.status. Returns null on any failure other
 *  than auth — the caller should treat null as "not awaitingInput" (i.e.
 *  allow the mirror to proceed) so a transient Linear hiccup doesn't
 *  black-hole bot responses. Returns the literal "unauthenticated" when
 *  Linear says the token is dead, so the caller can refresh and retry. */
async function fetchAgentSessionStatus(
  accessToken: string,
  agentSessionId: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `query($id: String!) { agentSession(id: $id) { status } }`,
        variables: { id: agentSessionId },
      }),
    });
    const data = (await res.json()) as {
      data?: { agentSession?: { status?: string } };
      errors?: Array<{ extensions?: { code?: string } }>;
    };
    if (isAuthError(data.errors)) return "unauthenticated";
    return data.data?.agentSession?.status ?? null;
  } catch (err) {
    console.warn(`[event-tap] status fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/** Linear surfaces dead-token errors with extensions.code=AUTHENTICATION_ERROR.
 *  Both the GraphQL response (HTTP 200, errors[]) and a hypothetical raw 401
 *  are signs the access token needs refresh — this helper normalizes only the
 *  GraphQL-level case since `fetch` returns 200 even when Linear rejects auth. */
function isAuthError(
  errors: Array<{ extensions?: { code?: string } }> | undefined,
): boolean {
  if (!errors?.length) return false;
  return errors.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
}

export default app;
